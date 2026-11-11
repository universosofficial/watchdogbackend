-- Migration 013: Security Hardening (Cryptographic Audit Chaining, Idempotency, Refresh Tokens)

-- 1. Add cryptographic hash columns to activity_logs
ALTER TABLE activity_logs 
  ADD COLUMN prev_hash VARCHAR(64) NULL AFTER details_json,
  ADD COLUMN log_hash VARCHAR(64) NULL AFTER prev_hash;

CREATE INDEX idx_activity_deal_created ON activity_logs (deal_id, created_at);

-- 2. Create Idempotency Keys Table for Financial and State Mutation Safety
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_status INT NOT NULL,
  response_body LONGTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  INDEX idx_idemp_user (user_id),
  INDEX idx_idemp_expires (expires_at)
);

-- 3. Create User Refresh Tokens Table for Secure Session Rotation
CREATE TABLE IF NOT EXISTS user_refresh_tokens (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  user_agent VARCHAR(255) NULL,
  ip_address VARCHAR(45) NULL,
  is_revoked BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_refresh_user (user_id),
  INDEX idx_refresh_hash (token_hash)
);
