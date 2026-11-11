-- Migration 009: Biometric Facial Verification & NUBAN Binding Anchor
-- Links 3D WebRTC Live Facial Liveness checks to Central Bank NUBAN profiles

ALTER TABLE users 
  ADD COLUMN is_biometric_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN biometric_confidence DECIMAL(5,2) NULL,
  ADD COLUMN biometric_verified_at TIMESTAMP NULL,
  ADD COLUMN biometric_reference VARCHAR(100) NULL;

ALTER TABLE businesses 
  ADD COLUMN is_biometric_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN biometric_verified_at TIMESTAMP NULL;

ALTER TABLE bank_verification_logs
  ADD COLUMN is_biometric_matched BOOLEAN DEFAULT FALSE;
