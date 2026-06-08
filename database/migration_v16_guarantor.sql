-- Migration v16: Guarantor fields
ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS guarantor_name   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS guarantor_phone  VARCHAR(20);
