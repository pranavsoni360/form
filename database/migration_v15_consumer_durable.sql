-- Migration v15: Consumer Durable Loan support
-- Adds product/dealer fields and quotation upload to loan_applications

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS consumer_loan_type  VARCHAR(30) DEFAULT 'personal',
    ADD COLUMN IF NOT EXISTS product_name        VARCHAR(255),
    ADD COLUMN IF NOT EXISTS brand               VARCHAR(100),
    ADD COLUMN IF NOT EXISTS model_number        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS dealer_name         VARCHAR(255),
    ADD COLUMN IF NOT EXISTS dealer_address      TEXT,
    ADD COLUMN IF NOT EXISTS quotation_amount    NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS quotation_url       VARCHAR(500);

-- Default all existing rows to personal loan
UPDATE loan_applications SET consumer_loan_type = 'personal' WHERE consumer_loan_type IS NULL;
