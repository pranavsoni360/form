-- ============================================
-- LOS Dashboard Overhaul — Migration V2
-- Multi-bank tenant system + two-stage approval
-- ============================================

-- 1. Banks (tenants)
CREATE TABLE IF NOT EXISTS banks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    address TEXT,
    logo_url TEXT,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banks_code ON banks(code);
CREATE INDEX IF NOT EXISTS idx_banks_status ON banks(status);

-- 2. Bank users (officers + supervisors)
CREATE TABLE IF NOT EXISTS bank_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('bank_officer', 'bank_supervisor')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bank_users_bank ON bank_users(bank_id);
CREATE INDEX IF NOT EXISTS idx_bank_users_username ON bank_users(username);
CREATE INDEX IF NOT EXISTS idx_bank_users_role ON bank_users(role);

-- 3. Add bank_id to loan_applications
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS bank_id UUID REFERENCES banks(id);
CREATE INDEX IF NOT EXISTS idx_loan_apps_bank ON loan_applications(bank_id);

-- 4. Add system review suggestion columns
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS system_suggestion VARCHAR(20) CHECK (system_suggestion IN ('approve', 'deny', 'review', NULL));
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS system_suggestion_reason TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS system_score DECIMAL(5,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS system_reviewed_at TIMESTAMPTZ;

-- 5. Add two-stage approval columns
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS officer_id UUID REFERENCES bank_users(id);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS officer_reviewed_at TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS officer_notes TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES bank_users(id);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS supervisor_reviewed_at TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS supervisor_notes TEXT;

-- 6. Add disbursement tracking
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS documents_requested_at TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS documents_submitted_at TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS disbursement_initiated_at TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ;

-- 7. Add bank_id to form_tokens
ALTER TABLE form_tokens ADD COLUMN IF NOT EXISTS bank_id UUID REFERENCES banks(id);

-- 8. Update status constraint (drop old, add new with expanded statuses)
ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE loan_applications ADD CONSTRAINT loan_applications_status_check
    CHECK (status IN (
        'draft', 'submitted', 'system_reviewed',
        'officer_approved', 'officer_rejected',
        'documents_submitted',
        'approved', 'supervisor_rejected'
    ));

-- 9. Loan sessions table (was missing from original schema)
CREATE TABLE IF NOT EXISTS loan_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    application_id UUID REFERENCES loan_applications(id),
    session_token VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    otp_hash VARCHAR(128),
    otp_expires_at TIMESTAMPTZ,
    otp_verified BOOLEAN DEFAULT FALSE,
    otp_attempts INTEGER DEFAULT 0,
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_sessions_token ON loan_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_loan_sessions_phone ON loan_sessions(phone);

-- 10. Status transition audit log
CREATE TABLE IF NOT EXISTS status_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES loan_applications(id),
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    changed_by_type VARCHAR(20) NOT NULL CHECK (changed_by_type IN ('system', 'admin', 'bank_officer', 'bank_supervisor', 'customer')),
    changed_by_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_transitions_app ON status_transitions(application_id);

-- 11. Login attempts (brute force protection)
CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) NOT NULL,
    attempts INTEGER DEFAULT 1,
    last_attempt TIMESTAMPTZ DEFAULT NOW(),
    locked_until TIMESTAMPTZ,
    CONSTRAINT uq_login_attempts_username UNIQUE (username)
);

-- 12. Refresh tokens (revocable, DB-backed)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    jti VARCHAR(64) UNIQUE NOT NULL,
    role VARCHAR(30) NOT NULL,
    user_type VARCHAR(20) NOT NULL,
    bank_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- 13. DigiLocker / Aadhaar verification data columns
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS aadhaar_name TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS aadhaar_dob TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS aadhaar_gender VARCHAR(20);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS aadhaar_address TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS aadhaar_photo_b64 TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS pan_name TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS digilocker_request_id VARCHAR(100);

-- 14. Additional form fields (added during development)
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_address TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_address TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS title VARCHAR(20);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS middle_name VARCHAR(255);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS full_name VARCHAR(500);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS qualification VARCHAR(100);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS occupation VARCHAR(100);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS industry_type VARCHAR(100);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS total_work_experience VARCHAR(50);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS experience_current_org VARCHAR(50);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS residential_status VARCHAR(50);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS tenure_stability VARCHAR(50);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS employer_address TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS loan_amount_requested DECIMAL(15,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS repayment_period_years INTEGER;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS purpose_of_loan TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS scheme VARCHAR(100);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS monthly_gross_income DECIMAL(15,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS monthly_deductions DECIMAL(15,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS monthly_emi_existing DECIMAL(15,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS monthly_net_income DECIMAL(15,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS criminal_records BOOLEAN DEFAULT false;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS same_as_current BOOLEAN DEFAULT false;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS highest_step INTEGER DEFAULT 1;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE loan_applications ALTER COLUMN marital_status TYPE VARCHAR(50);
ALTER TABLE loan_applications ALTER COLUMN gender TYPE VARCHAR(20);
ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS chk_step;
ALTER TABLE loan_applications ADD CONSTRAINT chk_step CHECK (current_step BETWEEN 1 AND 5);

-- 15. Agent calling module tables (Postgres-based, no MongoDB)
CREATE TABLE IF NOT EXISTS agent_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID REFERENCES banks(id),
    batch_id VARCHAR(100),
    customer_name VARCHAR(255),
    phone VARCHAR(20) NOT NULL,
    loan_type VARCHAR(100),
    loan_amount DECIMAL(15,2),
    language VARCHAR(20),
    status VARCHAR(30) DEFAULT 'queued',
    room_name VARCHAR(255),
    call_duration INTEGER,
    interested BOOLEAN,
    form_sent BOOLEAN DEFAULT false,
    form_link TEXT,
    category VARCHAR(50),
    transcript JSONB,
    recording_url TEXT,
    collected_data JSONB,
    call_analysis TEXT,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID REFERENCES banks(id),
    filename VARCHAR(255),
    total_records INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status VARCHAR(30) DEFAULT 'uploaded',
    uploaded_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add retry_count to agent_calls (used by batch scheduler)
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Agent ↔ Loan Application cross-references
ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS application_id UUID;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS agent_call_id UUID;
ALTER TABLE agent_batches ADD COLUMN IF NOT EXISTS batch_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_agent_calls_bank ON agent_calls(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_batch ON agent_calls(batch_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_status ON agent_calls(status);
CREATE INDEX IF NOT EXISTS idx_agent_calls_phone ON agent_calls(phone);
CREATE INDEX IF NOT EXISTS idx_agent_batches_bank ON agent_batches(bank_id);
