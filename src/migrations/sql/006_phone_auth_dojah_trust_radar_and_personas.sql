-- ==============================================================================
-- Digital Watchdog Database Migration: 006_phone_auth_dojah_trust_radar_and_personas.sql
-- Description: Phone-Only Auth, Buyer/Seller Personas, Dojah KYC/KYB & Off-Platform Attestation
-- ==============================================================================

-- 1. Alter users table for Strict Phone-Only Onboarding and Dual Personas
ALTER TABLE `users`
  MODIFY COLUMN `phone` VARCHAR(50) NOT NULL,
  ADD UNIQUE KEY `uq_users_phone` (`phone`),
  MODIFY COLUMN `email` VARCHAR(255) NULL,
  ADD COLUMN `country_code` VARCHAR(3) NOT NULL DEFAULT 'NG' AFTER `phone`,
  ADD COLUMN `default_currency` VARCHAR(5) NOT NULL DEFAULT 'NGN' AFTER `country_code`,
  ADD COLUMN `active_persona` ENUM('buyer', 'seller') NOT NULL DEFAULT 'buyer' AFTER `default_currency`,
  ADD COLUMN `is_id_verified` BOOLEAN NOT NULL DEFAULT FALSE AFTER `active_persona`;

-- 2. Alter businesses table for Global KYB and Algorithmic Trust Radar
ALTER TABLE `businesses`
  ADD COLUMN `country_code` VARCHAR(3) NOT NULL DEFAULT 'NG' AFTER `address`,
  ADD COLUMN `dojah_verification_id` VARCHAR(100) NULL DEFAULT NULL AFTER `tax_identification_number`,
  ADD COLUMN `trust_score` INT NOT NULL DEFAULT 50 AFTER `dojah_verification_id`,
  ADD COLUMN `trust_status` ENUM('safe', 'provisional', 'unsafe') NOT NULL DEFAULT 'provisional' AFTER `trust_score`,
  ADD COLUMN `dispute_count` INT NOT NULL DEFAULT 0 AFTER `covenants_defaulted_count`,
  ADD COLUMN `successful_deals_count` INT NOT NULL DEFAULT 0 AFTER `dispute_count`,
  ADD KEY `idx_businesses_trust_status` (`trust_status`);

-- 3. Alter payment_records for Off-Platform Financial Attestation & Zero-Custody Ledger
ALTER TABLE `payment_records`
  ADD COLUMN `payment_method` VARCHAR(50) NOT NULL DEFAULT 'bank_transfer' AFTER `currency`,
  ADD COLUMN `sending_institution` VARCHAR(100) NULL DEFAULT NULL AFTER `payment_method`,
  ADD COLUMN `recipient_institution` VARCHAR(100) NULL DEFAULT NULL AFTER `sending_institution`,
  ADD COLUMN `external_reference` VARCHAR(150) NULL DEFAULT NULL AFTER `reference_no`,
  ADD COLUMN `transfer_timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `paid_at`,
  ADD COLUMN `reported_by_user_id` VARCHAR(36) NULL DEFAULT NULL AFTER `transfer_timestamp`,
  ADD COLUMN `confirmed_by_user_id` VARCHAR(36) NULL DEFAULT NULL AFTER `reported_by_user_id`,
  ADD COLUMN `confirmed_at` TIMESTAMP NULL DEFAULT NULL AFTER `confirmed_by_user_id`,
  ADD COLUMN `attestation_statement` TEXT NULL DEFAULT NULL AFTER `confirmed_at`,
  MODIFY COLUMN `status` ENUM('reported', 'acknowledged', 'confirmed', 'disputed') NOT NULL DEFAULT 'reported';

-- 4. Ensure otp_verifications has VARCHAR(50) phone
ALTER TABLE `otp_verifications`
  MODIFY COLUMN `phone` VARCHAR(50) NOT NULL;

-- 5. Create Dojah Global Audit Logs Table
CREATE TABLE IF NOT EXISTS `dojah_audit_logs` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `user_id` VARCHAR(36) NOT NULL,
  `business_id` VARCHAR(36) NULL,
  `service_type` VARCHAR(50) NOT NULL,
  `country` VARCHAR(3) NOT NULL DEFAULT 'NG',
  `dojah_reference` VARCHAR(100) NULL,
  `verification_status` ENUM('passed', 'failed', 'flagged') NOT NULL,
  `risk_assessment` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_dojah_logs_user` (`user_id`),
  KEY `idx_dojah_logs_biz` (`business_id`),
  KEY `idx_dojah_logs_status` (`verification_status`),
  CONSTRAINT `fk_dojah_logs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
