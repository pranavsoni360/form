-- ============================================
-- Agent Calling Module — Postgres Tables
-- Replaces MongoDB los_calls database
-- ============================================

-- Required extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Agent calls (one row per customer call)
CREATE TABLE IF NOT EXISTS agent_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    batch_id VARCHAR(100),
    customer_name VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    loan_type VARCHAR(100) DEFAULT '',
    loan_amount VARCHAR(100) DEFAULT '',
    language VARCHAR(30) DEFAULT 'hindi',
    status VARCHAR(50) NOT NULL DEFAULT 'Pending',
    room_name VARCHAR(255),
    call_duration INTEGER DEFAULT 0,
    interested BOOLEAN DEFAULT false,
    form_sent BOOLEAN DEFAULT false,
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

CREATE INDEX IF NOT EXISTS idx_agent_calls_bank_id ON agent_calls(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_status ON agent_calls(status);
CREATE INDEX IF NOT EXISTS idx_agent_calls_batch_id ON agent_calls(batch_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_bank_status ON agent_calls(bank_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_calls_created_at ON agent_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_calls_room_name ON agent_calls(room_name);
CREATE INDEX IF NOT EXISTS idx_agent_calls_category ON agent_calls(category);

-- 2. Agent batches (one row per uploaded Excel file)
CREATE TABLE IF NOT EXISTS agent_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    filename VARCHAR(500),
    total_records INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    uploaded_by UUID REFERENCES bank_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_batches_bank_id ON agent_batches(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_batches_status ON agent_batches(status);

-- 3. System config (key-value for emergency stop, etc.)
CREATE TABLE IF NOT EXISTS agent_system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default config
INSERT INTO agent_system_config (key, value, updated_at)
VALUES ('emergency_stop', 'false', NOW())
ON CONFLICT (key) DO NOTHING;
