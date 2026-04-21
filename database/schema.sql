-- Bank Loan Form System - PostgreSQL Schema
-- Production-grade with encryption, audit trails, and compliance

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- 1. SECURE TOKEN MAPPING
-- ============================================
CREATE TABLE form_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token VARCHAR(128) UNIQUE NOT NULL,
    
    -- Prefilled customer data (from LOS database)
    customer_name VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL UNIQUE,
    loan_id VARCHAR(50) NOT NULL UNIQUE,
    loan_amount DECIMAL(15, 2) NOT NULL,
    loan_type VARCHAR(100),
    
    -- Additional prefilled fields
    email VARCHAR(255),
    date_of_birth DATE,
    existing_account_number VARCHAR(50),
    address TEXT,
    
    -- Token lifecycle
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    
    -- OTP verification
    otp_verified BOOLEAN DEFAULT FALSE,
    otp_verified_at TIMESTAMPTZ,
    
    -- Tracking
    last_accessed_at TIMESTAMPTZ,
    access_count INTEGER DEFAULT 0,
    
    -- Status
    form_status VARCHAR(20) DEFAULT 'pending',
    
    CONSTRAINT chk_phone CHECK (phone ~ '^\+?[1-9]\d{1,14}$'),
    CONSTRAINT chk_expires CHECK (expires_at > created_at)
);

-- ============================================
-- 2. OTP MANAGEMENT
-- ============================================
CREATE TABLE otp_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID REFERENCES form_tokens(id) ON DELETE CASCADE,
    phone VARCHAR(15) NOT NULL,
    
    -- OTP details (store hashed)
    otp_hash VARCHAR(128) NOT NULL,
    
    -- Lifecycle
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    
    -- Security
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    
    -- Tracking
    ip_address INET,
    user_agent TEXT,
    
    CONSTRAINT chk_otp_expires CHECK (expires_at > created_at)
);

-- ============================================
-- 3. FORM SUBMISSIONS (AUTO-SAVED DATA)
-- ============================================
CREATE TABLE loan_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID REFERENCES form_tokens(id) ON DELETE CASCADE,
    
    -- Customer identity
    customer_name VARCHAR(255) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    loan_id VARCHAR(50) NOT NULL UNIQUE,
    
    -- Step 1: Personal Details
    email VARCHAR(255),
    date_of_birth DATE,
    gender VARCHAR(10),
    marital_status VARCHAR(20),
    address_line1 TEXT,
    address_line2 TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(6),
    
    -- Step 2: Employment Details
    employment_type VARCHAR(50),
    employer_name VARCHAR(255),
    designation VARCHAR(100),
    years_at_job DECIMAL(4, 1),
    monthly_income DECIMAL(15, 2),
    
    -- Step 3: KYC Documents (ENCRYPTED)
    pan_number VARCHAR(255),
    pan_verified BOOLEAN DEFAULT FALSE,
    pan_verification_timestamp TIMESTAMPTZ,
    
    aadhaar_last4 VARCHAR(4),
    aadhaar_number_encrypted TEXT,
    aadhaar_verified BOOLEAN DEFAULT FALSE,
    aadhaar_verification_timestamp TIMESTAMPTZ,
    
    -- Step 4: Loan Details
    loan_purpose TEXT,
    requested_loan_amount DECIMAL(15, 2),
    loan_tenure_months INTEGER,
    
    -- Document URLs (Supabase Storage)
    aadhaar_front_url TEXT,
    aadhaar_back_url TEXT,
    pan_card_url TEXT,
    photo_url TEXT,
    income_proof_url TEXT,
    bank_statement_url TEXT,
    
    -- Form metadata
    current_step INTEGER DEFAULT 1,
    is_complete BOOLEAN DEFAULT FALSE,
    submitted_at TIMESTAMPTZ,
    last_saved_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Review workflow
    status VARCHAR(20) DEFAULT 'draft',
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    rejection_reason TEXT,
    
    -- Security & compliance
    ip_address INET,
    user_agent TEXT,
    device_fingerprint TEXT,
    geolocation JSONB,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_pincode CHECK (pincode ~ '^\d{6}$' OR pincode IS NULL),
    CONSTRAINT chk_step CHECK (current_step BETWEEN 1 AND 4)
);

-- ============================================
-- 4. AUTO-SAVE HISTORY (AUDIT TRAIL)
-- ============================================
CREATE TABLE form_autosave_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID REFERENCES loan_applications(id) ON DELETE CASCADE,
    
    -- Changed fields
    field_name VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    
    -- Metadata
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

-- ============================================
-- 5. RATE LIMITING
-- ============================================
CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    
    -- Counters
    attempt_count INTEGER DEFAULT 1,
    first_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Limits
    max_attempts INTEGER DEFAULT 3,
    window_hours INTEGER DEFAULT 168,
    
    blocked_until TIMESTAMPTZ,
    
    CONSTRAINT chk_rate_limit UNIQUE (phone, action_type)
);

-- ============================================
-- 6. ADMIN USERS
-- ============================================
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'reviewer',
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);

-- ============================================
-- 7. AUDIT LOG (ALL ACTIONS)
-- ============================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Who
    user_type VARCHAR(20) NOT NULL,
    user_id UUID,
    phone VARCHAR(15),
    
    -- What
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    
    -- Details
    details JSONB,
    
    -- Where/When
    ip_address INET,
    user_agent TEXT,
    geolocation JSONB,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 8. WHATSAPP MESSAGE QUEUE
-- ============================================
CREATE TABLE whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    message_type VARCHAR(50) NOT NULL,
    
    -- Message content
    message_body TEXT NOT NULL,
    media_url TEXT,
    
    -- Status
    status VARCHAR(20) DEFAULT 'queued',
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_reason TEXT,
    
    -- Meta data
    whatsapp_message_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Reference
    token_id UUID REFERENCES form_tokens(id) ON DELETE SET NULL,
    application_id UUID REFERENCES loan_applications(id) ON DELETE SET NULL
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX idx_form_tokens_phone ON form_tokens(phone);
CREATE INDEX idx_form_tokens_token ON form_tokens(token);
CREATE INDEX idx_form_tokens_expires ON form_tokens(expires_at);
CREATE INDEX idx_form_tokens_status ON form_tokens(form_status);

CREATE INDEX idx_otp_token_id ON otp_verifications(token_id);
CREATE INDEX idx_otp_expires ON otp_verifications(expires_at);

CREATE INDEX idx_applications_token_id ON loan_applications(token_id);
CREATE INDEX idx_applications_loan_id ON loan_applications(loan_id);
CREATE INDEX idx_applications_phone ON loan_applications(phone);
CREATE INDEX idx_applications_status ON loan_applications(status);
CREATE INDEX idx_applications_submitted ON loan_applications(submitted_at);

CREATE INDEX idx_autosave_application_id ON form_autosave_log(application_id);
CREATE INDEX idx_autosave_changed_at ON form_autosave_log(changed_at);

CREATE INDEX idx_rate_limits_phone ON rate_limits(phone);
CREATE INDEX idx_rate_limits_action ON rate_limits(action_type);

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

CREATE INDEX idx_whatsapp_status ON whatsapp_messages(status);
CREATE INDEX idx_whatsapp_phone ON whatsapp_messages(phone);

-- ============================================
-- AUTO-UPDATE TIMESTAMP TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_loan_applications_updated_at
BEFORE UPDATE ON loan_applications
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- INSERT TEST ADMIN USER
-- ============================================
INSERT INTO admin_users (email, password_hash, full_name, role)
VALUES (
    'admin@bank.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7JmZ.7Q8SO',
    'Bank Admin',
    'admin'
);