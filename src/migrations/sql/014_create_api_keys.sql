-- ==============================================================================
-- Digital Watchdog Database Migration: 014_create_api_keys.sql
-- Description: Developer Platform & Marketplace Integration B2B API Keys
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `business_id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(100) NOT NULL DEFAULT 'Default API Key',
  `key_prefix` VARCHAR(32) NOT NULL,
  `key_hash` VARCHAR(64) NOT NULL,
  `environment` ENUM('live', 'test') NOT NULL DEFAULT 'live',
  `scopes_json` JSON DEFAULT NULL,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  `expires_at` TIMESTAMP NULL DEFAULT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_api_keys_business` (`business_id`),
  KEY `idx_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_environment` (`environment`),
  CONSTRAINT `fk_api_keys_business` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_api_keys_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
