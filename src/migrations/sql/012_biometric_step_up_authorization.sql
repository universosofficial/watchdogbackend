-- Migration 012: High-Value Deal Biometric Step-Up Authorization
-- Stores biometric baseline photo paths and logs step-up challenge authorizations for large transactions

ALTER TABLE users 
  ADD COLUMN biometric_baseline_path VARCHAR(255) NULL AFTER biometric_reference;

CREATE TABLE IF NOT EXISTS biometric_authorizations (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  business_id VARCHAR(36) NULL,
  deal_id VARCHAR(36) NULL,
  action_type VARCHAR(50) NOT NULL,
  amount DECIMAL(15,2) NULL,
  similarity_score DECIMAL(5,2) NOT NULL,
  liveness_score DECIMAL(5,2) NOT NULL,
  status ENUM('authorized', 'rejected') DEFAULT 'authorized',
  auth_reference VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bio_auth_user (user_id),
  INDEX idx_bio_auth_deal (deal_id)
);
