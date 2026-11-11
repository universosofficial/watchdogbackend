-- ==============================================================================
-- Digital Watchdog Database Migration: 003_identity_verification_and_tiers.sql
-- Description: Tiered Onboarding, Phone OTP, NIN & CAC Verification Audit Logs
-- ==============================================================================

-- 1. Alter users table
ALTER TABLE `users`
  ADD COLUMN `phone_verified_at` TIMESTAMP NULL AFTER `phone`,
  ADD COLUMN `nin_hash` VARCHAR(64) NULL AFTER `phone_verified_at`,
  ADD COLUMN `bvn_hash` VARCHAR(64) NULL AFTER `nin_hash`,
  ADD COLUMN `kyc_tier` ENUM('tier_1', 'tier_2', 'tier_3') NOT NULL DEFAULT 'tier_1' AFTER `bvn_hash`,
  ADD KEY `idx_users_nin_hash` (`nin_hash`),
  ADD KEY `idx_users_bvn_hash` (`bvn_hash`),
  ADD KEY `idx_users_phone` (`phone`);

-- 2. Alter businesses table
ALTER TABLE `businesses`
  ADD COLUMN `cac_status` ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified' AFTER `verification_status`,
  ADD COLUMN `cac_verified_at` TIMESTAMP NULL AFTER `cac_status`,
  ADD COLUMN `tax_identification_number` VARCHAR(50) NULL AFTER `cac_verified_at`,
  ADD COLUMN `business_tier` ENUM('tier_1', 'tier_2', 'tier_3') NOT NULL DEFAULT 'tier_1' AFTER `tax_identification_number`,
  ADD KEY `idx_businesses_cac_status` (`cac_status`),
  ADD KEY `idx_businesses_business_tier` (`business_tier`);

-- 3. New Table: otp_verifications
CREATE TABLE IF NOT EXISTS `otp_verifications` (
  `id` VARCHAR(36) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `otp_hash` VARCHAR(255) NOT NULL,
  `purpose` ENUM('registration', 'login', 'password_reset') NOT NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `expires_at` TIMESTAMP NOT NULL,
  `consumed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_otp_phone_purpose_expires` (`phone`, `purpose`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. New Table: verification_logs
CREATE TABLE IF NOT EXISTS `verification_logs` (
  `id` VARCHAR(36) NOT NULL,
  `business_id` VARCHAR(36) NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `verification_type` ENUM('nin', 'bvn', 'cac_rc', 'cac_bn', 'tin') NOT NULL,
  `provider` VARCHAR(50) NOT NULL,
  `status` ENUM('success', 'failed', 'mismatch') NOT NULL,
  `response_reference` VARCHAR(100) NULL,
  `metadata_json` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vlogs_user` (`user_id`),
  KEY `idx_vlogs_business` (`business_id`),
  KEY `idx_vlogs_type_status` (`verification_type`, `status`),
  CONSTRAINT `fk_vlogs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vlogs_business` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Seed existing demo accounts with Tier 3 status so existing tests stay intact
UPDATE `users` SET `kyc_tier` = 'tier_3', `phone_verified_at` = NOW() WHERE `email` IN ('owner@alphasupplies.ng', 'procurement@betabuilders.ng');
UPDATE `businesses` SET `cac_status` = 'verified', `cac_verified_at` = NOW(), `business_tier` = 'tier_3' WHERE `rc_number` IS NOT NULL AND `rc_number` != '';
