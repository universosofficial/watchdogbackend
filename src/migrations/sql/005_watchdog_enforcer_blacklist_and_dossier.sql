-- ==============================================================================
-- Digital Watchdog Database Migration: 005_watchdog_enforcer_blacklist_and_dossier.sql
-- Description: Non-Custodial Watchdog Protocol: 7-Day Cure Window, Blacklist Registry & Regulatory Dossier Engine
-- ==============================================================================

-- 1. Alter businesses table to add Watchdog Trust Reputation & Blacklist fields
ALTER TABLE `businesses`
  ADD COLUMN `reputation_status` ENUM('good_standing', 'watchdog_cleared', 'under_cure_review', 'blacklisted') NOT NULL DEFAULT 'good_standing' AFTER `business_tier`,
  ADD COLUMN `covenants_fulfilled_count` INT NOT NULL DEFAULT 0 AFTER `reputation_status`,
  ADD COLUMN `covenants_defaulted_count` INT NOT NULL DEFAULT 0 AFTER `covenants_fulfilled_count`,
  ADD COLUMN `blacklisted_at` TIMESTAMP NULL DEFAULT NULL AFTER `covenants_defaulted_count`,
  ADD COLUMN `blacklist_reason` TEXT DEFAULT NULL AFTER `blacklisted_at`,
  ADD KEY `idx_businesses_reputation_status` (`reputation_status`);

-- 2. Alter deals table to track 7-Day Cure Window & Regulatory Dossier
ALTER TABLE `deals`
  ADD COLUMN `cure_status` ENUM('none', 'cure_period_active', 'cured', 'defaulted_escalated') NOT NULL DEFAULT 'none' AFTER `current_version`,
  ADD COLUMN `cure_deadline` TIMESTAMP NULL DEFAULT NULL AFTER `cure_status`,
  ADD COLUMN `breach_reported_at` TIMESTAMP NULL DEFAULT NULL AFTER `cure_deadline`,
  ADD COLUMN `breach_reason` TEXT DEFAULT NULL AFTER `breach_reported_at`,
  ADD COLUMN `regulatory_dossier_hash` VARCHAR(64) DEFAULT NULL AFTER `breach_reason`,
  ADD COLUMN `regulatory_dossier_json` JSON DEFAULT NULL AFTER `regulatory_dossier_hash`,
  ADD KEY `idx_deals_cure_status` (`cure_status`);

-- 3. Create the Blacklist Records Table (Public Watchdog Default Registry)
CREATE TABLE IF NOT EXISTS `blacklist_records` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `business_id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NULL,
  `reference_no` VARCHAR(100) NOT NULL,
  `business_name` VARCHAR(255) NOT NULL,
  `rc_number` VARCHAR(100) DEFAULT NULL,
  `director_name` VARCHAR(255) DEFAULT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `deal_amount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'NGN',
  `covenant_breached` VARCHAR(255) NOT NULL,
  `default_summary` TEXT NOT NULL,
  `cure_period_expired_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reported_to_fccpc` BOOLEAN NOT NULL DEFAULT TRUE,
  `fccpc_dossier_ref` VARCHAR(100) NOT NULL,
  `reported_to_police_sfu` BOOLEAN NOT NULL DEFAULT FALSE,
  `reported_to_lasrera` BOOLEAN NOT NULL DEFAULT FALSE,
  `reported_to_credit_bureau` BOOLEAN NOT NULL DEFAULT TRUE,
  `status` ENUM('active_default', 'rectified_settled', 'disputed_appeal') NOT NULL DEFAULT 'active_default',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_blacklist_biz` (`business_id`),
  KEY `idx_blacklist_rc` (`rc_number`),
  KEY `idx_blacklist_phone` (`phone`),
  KEY `idx_blacklist_status` (`status`),
  CONSTRAINT `fk_blacklist_biz` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
