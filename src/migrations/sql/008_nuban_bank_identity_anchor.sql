-- Migration 008: NUBAN Bank Identity Anchor & Reconciliation Flow
-- Anchors seller identity to CBN/NIBSS verified bank accounts and prevents money mule spoofing

-- 1. Alter businesses table
ALTER TABLE businesses
ADD COLUMN bank_name VARCHAR(100) NULL AFTER rc_number,
ADD COLUMN bank_code VARCHAR(10) NULL AFTER bank_name,
ADD COLUMN verified_account_number VARCHAR(20) NULL AFTER bank_code,
ADD COLUMN verified_account_name VARCHAR(255) NULL AFTER verified_account_number,
ADD COLUMN is_bank_verified BOOLEAN DEFAULT FALSE AFTER verified_account_name,
ADD COLUMN bank_verified_at TIMESTAMP NULL AFTER is_bank_verified;

-- 2. Alter payment_records table
ALTER TABLE payment_records
ADD COLUMN destination_bank_name VARCHAR(100) NULL AFTER recipient_institution,
ADD COLUMN destination_account_number VARCHAR(20) NULL AFTER destination_bank_name,
ADD COLUMN destination_account_name VARCHAR(255) NULL AFTER destination_account_number,
ADD COLUMN beneficiary_match_confirmed BOOLEAN DEFAULT FALSE AFTER destination_account_name;

-- 3. Create bank_verification_logs table
CREATE TABLE IF NOT EXISTS bank_verification_logs (
  id VARCHAR(36) PRIMARY KEY,
  business_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  bank_code VARCHAR(10) NOT NULL,
  resolved_name VARCHAR(255) NOT NULL,
  match_score DECIMAL(5,2) NOT NULL,
  status ENUM('passed', 'mismatch_rejected', 'corporate_flagged') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bank_logs_business_id (business_id),
  INDEX idx_bank_logs_user_id (user_id),
  INDEX idx_bank_logs_account (account_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
