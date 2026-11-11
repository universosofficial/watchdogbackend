-- Migration 010: World Wide Security (WWS) Integration
-- Stores immutable WWS referral receipts and case references on disputes and deals

ALTER TABLE disputes 
  ADD COLUMN IF NOT EXISTS wws_case_reference VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS wws_escalated_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS wws_escalated_by VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS wws_receipt_json JSON NULL;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS wws_case_reference VARCHAR(50) NULL;
