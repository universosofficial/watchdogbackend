-- Migration 011: Add terms and privacy policy acceptance tracking
ALTER TABLE users 
  ADD COLUMN terms_accepted_at DATETIME NULL AFTER phone_verified_at,
  ADD COLUMN privacy_accepted_at DATETIME NULL AFTER terms_accepted_at,
  ADD COLUMN terms_version VARCHAR(20) DEFAULT '1.0' AFTER privacy_accepted_at;
