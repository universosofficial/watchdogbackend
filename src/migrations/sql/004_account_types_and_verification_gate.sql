-- ==============================================================================
-- Digital Watchdog Database Migration: 004_account_types_and_verification_gate.sql
-- Description: Individual (Normal Person) vs Corporate Organization Entity Partition
-- ==============================================================================

-- 1. Alter users table to distinguish Individual vs Corporate accounts
ALTER TABLE `users`
  ADD COLUMN `account_type` ENUM('individual', 'corporate') NOT NULL DEFAULT 'corporate' AFTER `full_name`,
  ADD KEY `idx_users_account_type` (`account_type`);

-- 2. Alter businesses table to indicate entity structure
ALTER TABLE `businesses`
  ADD COLUMN `entity_type` ENUM('individual', 'corporate') NOT NULL DEFAULT 'corporate' AFTER `name`,
  ADD KEY `idx_businesses_entity_type` (`entity_type`);

-- 3. Ensure existing enterprise demo accounts remain corporate
UPDATE `users` 
  SET `account_type` = 'corporate' 
  WHERE `email` IN ('owner@alphasupplies.ng', 'procurement@betabuilders.ng');

UPDATE `businesses` 
  SET `entity_type` = 'corporate' 
  WHERE `rc_number` IS NOT NULL AND `rc_number` != '';
