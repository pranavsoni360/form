-- ============================================================
-- LOS Form — Schema v3
-- Unified identity (admin / bank_user / vendor_user / customer),
-- vendor tenancy under banks, simplified single-reviewer workflow.
-- Supersedes schema.sql, migration_v2.sql, migration_address_split.sql,
-- migration_agent_tables.sql. Wipe-and-fresh install.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. TENANTS: banks
-- ============================================================
CREATE TABLE banks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    address TEXT,
    logo_url TEXT,
    vendor_limit INTEGER NOT NULL DEFAULT 5,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_banks_code ON banks(code);
CREATE INDEX idx_banks_status ON banks(status);

-- ============================================================
-- 2. TENANTS: vendors (shops/retailers tied to a bank)
-- ============================================================
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    category VARCHAR(100),           -- electronics, furniture, appliances, etc.
    contact_name VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    address TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_by UUID,                 -- users.id (admin or bank_user)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (bank_id, code)
);
CREATE INDEX idx_vendors_bank ON vendors(bank_id);
CREATE INDEX idx_vendors_status ON vendors(status);

-- ============================================================
-- 3. IDENTITY: unified users (admin, bank_user, vendor_user, customer)
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,   -- admin: email; bank/vendor: generated; customer: phone
    password_hash VARCHAR(255),               -- nullable for customer (OTP-only auth)
    full_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'bank_user', 'vendor_user', 'customer')),
    bank_id UUID REFERENCES banks(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    CONSTRAINT chk_user_scope CHECK (
        (role = 'admin'        AND bank_id IS NULL     AND vendor_id IS NULL) OR
        (role = 'bank_user'    AND bank_id IS NOT NULL AND vendor_id IS NULL) OR
        (role = 'vendor_user'  AND bank_id IS NOT NULL AND vendor_id IS NOT NULL) OR
        (role = 'customer'     AND bank_id IS NULL     AND vendor_id IS NULL)
    )
);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_bank ON users(bank_id);
CREATE INDEX idx_users_vendor ON users(vendor_id);
CREATE INDEX idx_users_phone ON users(phone);

-- Deferred FK (vendors.created_by → users.id)
ALTER TABLE vendors
    ADD CONSTRAINT fk_vendors_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- 4. AUTH: refresh tokens + login lockout
-- ============================================================
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jti VARCHAR(64) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL,
    bank_id UUID,
    vendor_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE login_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_attempt TIMESTAMPTZ DEFAULT NOW(),
    locked_until TIMESTAMPTZ
);

-- ============================================================
-- 5. CUSTOMER FORM ACCESS: tokens, OTPs, sessions
-- ============================================================
CREATE TABLE form_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token VARCHAR(128) UNIQUE NOT NULL,
    bank_id UUID REFERENCES banks(id),
    vendor_id UUID REFERENCES vendors(id),

    customer_name VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    loan_id VARCHAR(50) UNIQUE,
    loan_amount DECIMAL(15, 2),
    loan_type VARCHAR(100),
    email VARCHAR(255),
    date_of_birth DATE,
    existing_account_number VARCHAR(50),
    address TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,

    otp_verified BOOLEAN DEFAULT FALSE,
    otp_verified_at TIMESTAMPTZ,

    last_accessed_at TIMESTAMPTZ,
    access_count INTEGER DEFAULT 0,
    form_status VARCHAR(20) DEFAULT 'pending',

    CONSTRAINT chk_form_token_phone CHECK (phone ~ '^\+?[1-9]\d{1,14}$'),
    CONSTRAINT chk_form_token_expires CHECK (expires_at > created_at)
);
CREATE INDEX idx_form_tokens_phone ON form_tokens(phone);
CREATE INDEX idx_form_tokens_token ON form_tokens(token);
CREATE INDEX idx_form_tokens_expires ON form_tokens(expires_at);
CREATE INDEX idx_form_tokens_status ON form_tokens(form_status);

CREATE TABLE otp_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID REFERENCES form_tokens(id) ON DELETE CASCADE,
    phone VARCHAR(15) NOT NULL,
    otp_hash VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    ip_address INET,
    user_agent TEXT,
    CONSTRAINT chk_otp_expires CHECK (expires_at > created_at)
);
CREATE INDEX idx_otp_token_id ON otp_verifications(token_id);
CREATE INDEX idx_otp_expires ON otp_verifications(expires_at);

CREATE TABLE loan_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    application_id UUID,                  -- FK added after loan_applications
    session_token VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    otp_hash VARCHAR(128),
    otp_expires_at TIMESTAMPTZ,
    otp_verified BOOLEAN DEFAULT FALSE,
    otp_attempts INTEGER DEFAULT 0,
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_loan_sessions_token ON loan_sessions(session_token);
CREATE INDEX idx_loan_sessions_phone ON loan_sessions(phone);

-- ============================================================
-- 6. LOAN APPLICATIONS (simplified: single-reviewer, no officer/supervisor split)
-- ============================================================
CREATE TABLE loan_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID REFERENCES form_tokens(id) ON DELETE SET NULL,
    bank_id UUID REFERENCES banks(id),
    vendor_id UUID REFERENCES vendors(id),    -- nullable: NULL = direct bank application
    initiated_by UUID REFERENCES users(id),   -- user who started this (bank_user, vendor_user, or customer)
    agent_call_id UUID,                       -- cross-ref set after agent_calls exists

    -- Identity
    customer_name VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    loan_id VARCHAR(50) UNIQUE,
    customer_type VARCHAR(20),

    -- Name breakdown
    title VARCHAR(20),
    first_name VARCHAR(255),
    middle_name VARCHAR(255),
    last_name VARCHAR(255),
    full_name VARCHAR(500),

    -- Step 1: personal
    email VARCHAR(255),
    date_of_birth DATE,
    gender VARCHAR(20),
    marital_status VARCHAR(50),
    qualification VARCHAR(100),
    occupation VARCHAR(100),

    -- Legacy flat address (kept for backwards compat with form UI)
    address_line1 TEXT,
    address_line2 TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(6),
    current_address TEXT,
    permanent_address TEXT,
    same_as_current BOOLEAN DEFAULT FALSE,

    -- Structured current address (from DigiLocker/Aadhaar)
    current_house TEXT,
    current_street TEXT,
    current_landmark TEXT,
    current_locality TEXT,
    current_pincode VARCHAR(6),
    current_state_code VARCHAR(10),
    current_city_code VARCHAR(10),

    -- Structured permanent address
    permanent_house TEXT,
    permanent_street TEXT,
    permanent_landmark TEXT,
    permanent_locality TEXT,
    permanent_pincode VARCHAR(6),
    permanent_state_code VARCHAR(10),
    permanent_city_code VARCHAR(10),

    -- Step 2: employment
    employment_type VARCHAR(50),
    employer_name VARCHAR(255),
    designation VARCHAR(100),
    industry_type VARCHAR(100),
    total_work_experience VARCHAR(50),
    experience_current_org VARCHAR(50),
    residential_status VARCHAR(50),
    tenure_stability VARCHAR(50),
    employer_address TEXT,
    years_at_job DECIMAL(4, 1),

    -- Financial
    monthly_income DECIMAL(15, 2),
    monthly_gross_income DECIMAL(15, 2),
    monthly_deductions DECIMAL(15, 2),
    monthly_emi_existing DECIMAL(15, 2),
    monthly_net_income DECIMAL(15, 2),
    criminal_records BOOLEAN DEFAULT FALSE,

    -- KYC
    pan_number VARCHAR(255),
    pan_verified BOOLEAN DEFAULT FALSE,
    pan_verification_timestamp TIMESTAMPTZ,
    pan_name TEXT,
    aadhaar_last4 VARCHAR(4),
    aadhaar_number_encrypted TEXT,
    aadhaar_verified BOOLEAN DEFAULT FALSE,
    aadhaar_verification_timestamp TIMESTAMPTZ,
    aadhaar_name TEXT,
    aadhaar_dob TEXT,
    aadhaar_gender VARCHAR(20),
    aadhaar_address TEXT,
    aadhaar_photo_b64 TEXT,
    digilocker_request_id VARCHAR(100),

    -- Loan details
    loan_purpose TEXT,
    purpose_of_loan TEXT,
    requested_loan_amount DECIMAL(15, 2),
    loan_amount_requested DECIMAL(15, 2),
    loan_tenure_months INTEGER,
    repayment_period_years INTEGER,
    scheme VARCHAR(100),

    -- Document URLs
    aadhaar_front_url TEXT,
    aadhaar_back_url TEXT,
    pan_card_url TEXT,
    photo_url TEXT,
    income_proof_url TEXT,
    bank_statement_url TEXT,

    -- Field source tracking (PAN/Aadhaar/VoiceCall/manual)
    field_sources JSONB DEFAULT '{}'::jsonb,

    -- Form metadata
    current_step INTEGER DEFAULT 1,
    highest_step INTEGER DEFAULT 1,
    is_complete BOOLEAN DEFAULT FALSE,
    submitted_at TIMESTAMPTZ,
    last_saved_at TIMESTAMPTZ DEFAULT NOW(),

    -- AI system review
    system_suggestion VARCHAR(20) CHECK (system_suggestion IN ('approve', 'deny', 'review') OR system_suggestion IS NULL),
    system_suggestion_reason TEXT,
    system_score DECIMAL(5, 2),
    system_reviewed_at TIMESTAMPTZ,

    -- Single reviewer (no officer/supervisor split)
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    rejection_reason TEXT,

    -- Disbursement lifecycle
    documents_requested_at TIMESTAMPTZ,
    documents_submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    disbursed_at TIMESTAMPTZ,

    -- Security & compliance
    ip_address INET,
    user_agent TEXT,
    device_fingerprint TEXT,
    geolocation JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT chk_loan_app_pincode CHECK (pincode ~ '^\d{6}$' OR pincode IS NULL),
    CONSTRAINT chk_loan_app_step CHECK (current_step BETWEEN 1 AND 6),
    CONSTRAINT chk_loan_app_status CHECK (status IN (
        'draft', 'submitted', 'system_reviewed',
        'approved', 'rejected',
        'documents_requested', 'documents_submitted', 'disbursed'
    ))
);
CREATE INDEX idx_loan_apps_bank ON loan_applications(bank_id);
CREATE INDEX idx_loan_apps_vendor ON loan_applications(vendor_id);
CREATE INDEX idx_loan_apps_status ON loan_applications(status);
CREATE INDEX idx_loan_apps_phone ON loan_applications(phone);
CREATE INDEX idx_loan_apps_loan_id ON loan_applications(loan_id);
CREATE INDEX idx_loan_apps_submitted ON loan_applications(submitted_at);
CREATE INDEX idx_loan_apps_token ON loan_applications(token_id);

ALTER TABLE loan_sessions
    ADD CONSTRAINT fk_loan_sessions_application
    FOREIGN KEY (application_id) REFERENCES loan_applications(id) ON DELETE SET NULL;

-- ============================================================
-- 7. AUDIT: status transitions + autosave + generic audit log
-- ============================================================
CREATE TABLE status_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by UUID REFERENCES users(id),
    changed_by_role VARCHAR(20) NOT NULL CHECK (changed_by_role IN (
        'system', 'admin', 'bank_user', 'vendor_user', 'customer'
    )),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_status_transitions_app ON status_transitions(application_id);

CREATE TABLE form_autosave_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID REFERENCES loan_applications(id) ON DELETE CASCADE,
    field_name VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);
CREATE INDEX idx_autosave_application_id ON form_autosave_log(application_id);
CREATE INDEX idx_autosave_changed_at ON form_autosave_log(changed_at);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_type VARCHAR(20) NOT NULL,
    user_id UUID,
    phone VARCHAR(15),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    geolocation JSONB,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- ============================================================
-- 8. RATE LIMITING
-- ============================================================
CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    attempt_count INTEGER DEFAULT 1,
    first_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    max_attempts INTEGER DEFAULT 3,
    window_hours INTEGER DEFAULT 168,
    blocked_until TIMESTAMPTZ,
    CONSTRAINT uq_rate_limits UNIQUE (phone, action_type)
);
CREATE INDEX idx_rate_limits_phone ON rate_limits(phone);

-- ============================================================
-- 9. WHATSAPP MESSAGE QUEUE
-- ============================================================
CREATE TABLE whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    message_type VARCHAR(50) NOT NULL,
    message_body TEXT NOT NULL,
    media_url TEXT,
    status VARCHAR(20) DEFAULT 'queued',
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_reason TEXT,
    whatsapp_message_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    token_id UUID REFERENCES form_tokens(id) ON DELETE SET NULL,
    application_id UUID REFERENCES loan_applications(id) ON DELETE SET NULL
);
CREATE INDEX idx_whatsapp_status ON whatsapp_messages(status);
CREATE INDEX idx_whatsapp_phone ON whatsapp_messages(phone);

-- ============================================================
-- 10. CALLING: agent_batches + agent_calls
-- ============================================================
CREATE TABLE agent_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_id VARCHAR(100) UNIQUE,                        -- human-readable string id
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- alias of initiated_by for legacy code
    filename VARCHAR(500),
    total_records INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_agent_batches_bank ON agent_batches(bank_id);
CREATE INDEX idx_agent_batches_vendor ON agent_batches(vendor_id);
CREATE INDEX idx_agent_batches_status ON agent_batches(status);
CREATE INDEX idx_agent_batches_batch_id ON agent_batches(batch_id);

CREATE TABLE agent_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    batch_id VARCHAR(100),                              -- references agent_batches.batch_id (string)
    initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    application_id UUID REFERENCES loan_applications(id) ON DELETE SET NULL,

    customer_name VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    loan_type VARCHAR(100) DEFAULT '',
    loan_amount VARCHAR(100) DEFAULT '',
    language VARCHAR(30) DEFAULT 'hindi',

    status VARCHAR(50) NOT NULL DEFAULT 'Pending',
    room_name VARCHAR(255),
    call_duration INTEGER DEFAULT 0,
    interested BOOLEAN DEFAULT FALSE,
    form_sent BOOLEAN DEFAULT FALSE,
    form_link TEXT,
    category VARCHAR(100) DEFAULT 'Uncategorized',
    transcript JSONB DEFAULT '[]'::jsonb,
    recording_url TEXT,
    collected_data JSONB DEFAULT '{}'::jsonb,
    call_analysis JSONB,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_agent_calls_bank ON agent_calls(bank_id);
CREATE INDEX idx_agent_calls_vendor ON agent_calls(vendor_id);
CREATE INDEX idx_agent_calls_batch ON agent_calls(batch_id);
CREATE INDEX idx_agent_calls_status ON agent_calls(status);
CREATE INDEX idx_agent_calls_phone ON agent_calls(phone);
CREATE INDEX idx_agent_calls_room_name ON agent_calls(room_name);
CREATE INDEX idx_agent_calls_created_at ON agent_calls(created_at);
CREATE INDEX idx_agent_calls_category ON agent_calls(category);

ALTER TABLE loan_applications
    ADD CONSTRAINT fk_loan_apps_agent_call
    FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL;

-- ============================================================
-- 11. AGENT SYSTEM CONFIG (emergency stop, etc.)
-- ============================================================
CREATE TABLE agent_system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO agent_system_config (key, value)
    VALUES ('emergency_stop', 'false')
    ON CONFLICT DO NOTHING;

-- ============================================================
-- 12. TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_banks_updated_at              BEFORE UPDATE ON banks              FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tr_vendors_updated_at            BEFORE UPDATE ON vendors            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tr_loan_apps_updated_at          BEFORE UPDATE ON loan_applications  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tr_agent_calls_updated_at        BEFORE UPDATE ON agent_calls        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================
-- 13. BOOTSTRAP ADMIN USER
-- Default: admin@bank.com / admin123
-- Regenerate the hash (bcrypt.hashpw(b'<pw>', bcrypt.gensalt())) before production.
-- ============================================================
INSERT INTO users (username, password_hash, full_name, email, role)
VALUES (
    'admin@bank.com',
    '$2b$12$Zp4vdD8oK2agzp6uzj0.COU5izxfP0lubq9iUrXe7omrVYgNVGVsK',
    'System Administrator',
    'admin@bank.com',
    'admin'
);
