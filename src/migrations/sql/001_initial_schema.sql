-- ==============================================================================
-- Digital Watchdog Database Migration: 001_initial_schema.sql
-- Description: Core schema definition for Digital Watchdog B2B Trust & Escrow
-- Author: Lead Database Architect & Backend Engineer
-- ==============================================================================

-- 1. Users Table
CREATE TABLE IF NOT EXISTS `users` (
  `id` VARCHAR(36) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `full_name` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Businesses Table
CREATE TABLE IF NOT EXISTS `businesses` (
  `id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `rc_number` VARCHAR(100) DEFAULT NULL,
  `address` TEXT DEFAULT NULL,
  `verification_status` ENUM('unverified', 'pending', 'verified') NOT NULL DEFAULT 'unverified',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_businesses_rc_number` (`rc_number`),
  KEY `idx_businesses_verification_status` (`verification_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Business Members (Pivot Table with Role & Constraints)
CREATE TABLE IF NOT EXISTS `business_members` (
  `id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `business_id` VARCHAR(36) NOT NULL,
  `role` ENUM('owner', 'staff') NOT NULL DEFAULT 'staff',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_business_user` (`business_id`, `user_id`),
  KEY `idx_business_members_user` (`user_id`),
  KEY `idx_business_members_business` (`business_id`),
  CONSTRAINT `fk_business_members_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_business_members_business` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Deals Table
CREATE TABLE IF NOT EXISTS `deals` (
  `id` VARCHAR(36) NOT NULL,
  `reference_no` VARCHAR(100) NOT NULL,
  `creator_business_id` VARCHAR(36) NOT NULL,
  `counterparty_business_id` VARCHAR(36) DEFAULT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `amount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'NGN',
  `status` ENUM('draft', 'awaiting_acceptance', 'active', 'disputed', 'completed', 'cancelled', 'terminated') NOT NULL DEFAULT 'draft',
  `current_version` INT NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deals_reference_no` (`reference_no`),
  KEY `idx_deals_creator_business` (`creator_business_id`),
  KEY `idx_deals_counterparty_business` (`counterparty_business_id`),
  KEY `idx_deals_status` (`status`),
  CONSTRAINT `fk_deals_creator_business` FOREIGN KEY (`creator_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_deals_counterparty_business` FOREIGN KEY (`counterparty_business_id`) REFERENCES `businesses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Deal Invitations Table
CREATE TABLE IF NOT EXISTS `deal_invitations` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `invited_email` VARCHAR(255) NOT NULL,
  `token` VARCHAR(255) NOT NULL,
  `status` ENUM('pending', 'accepted', 'declined') NOT NULL DEFAULT 'pending',
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_invitations_token` (`token`),
  KEY `idx_deal_invitations_deal` (`deal_id`),
  KEY `idx_deal_invitations_email` (`invited_email`),
  CONSTRAINT `fk_deal_invitations_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Agreement Versions Table
CREATE TABLE IF NOT EXISTS `agreement_versions` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `version_number` INT NOT NULL,
  `terms_text` LONGTEXT NOT NULL,
  `created_by_business_id` VARCHAR(36) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_version` (`deal_id`, `version_number`),
  KEY `idx_agreement_versions_deal` (`deal_id`),
  KEY `idx_agreement_versions_creator_biz` (`created_by_business_id`),
  CONSTRAINT `fk_agreement_versions_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_agreement_versions_creator_biz` FOREIGN KEY (`created_by_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Agreement Acceptances Table
CREATE TABLE IF NOT EXISTS `agreement_acceptances` (
  `id` VARCHAR(36) NOT NULL,
  `version_id` VARCHAR(36) NOT NULL,
  `business_id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `accepted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_version_business` (`version_id`, `business_id`),
  KEY `idx_agreement_acceptances_version` (`version_id`),
  KEY `idx_agreement_acceptances_business` (`business_id`),
  KEY `idx_agreement_acceptances_user` (`user_id`),
  CONSTRAINT `fk_acceptances_version` FOREIGN KEY (`version_id`) REFERENCES `agreement_versions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_acceptances_business` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_acceptances_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Obligations Table
CREATE TABLE IF NOT EXISTS `obligations` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `responsible_business_id` VARCHAR(36) NOT NULL,
  `type` ENUM('payment', 'delivery', 'inspection', 'document', 'service') NOT NULL,
  `due_date` TIMESTAMP NOT NULL,
  `status` ENUM('not_started', 'in_progress', 'submitted_for_review', 'completed', 'overdue', 'disputed', 'cancelled') NOT NULL DEFAULT 'not_started',
  `completion_date` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_obligations_deal` (`deal_id`),
  KEY `idx_obligations_responsible_biz` (`responsible_business_id`),
  KEY `idx_obligations_status` (`status`),
  KEY `idx_obligations_due_date` (`due_date`),
  CONSTRAINT `fk_obligations_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_obligations_responsible_biz` FOREIGN KEY (`responsible_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Evidence Records Table
CREATE TABLE IF NOT EXISTS `evidence_records` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `obligation_id` VARCHAR(36) DEFAULT NULL,
  `submitted_by_business_id` VARCHAR(36) NOT NULL,
  `submitted_by_user_id` VARCHAR(36) NOT NULL,
  `file_path` TEXT NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_size` INT NOT NULL,
  `mime_type` VARCHAR(100) NOT NULL,
  `verification_tier` ENUM('submitted', 'verified') NOT NULL DEFAULT 'submitted',
  `notes` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_evidence_deal` (`deal_id`),
  KEY `idx_evidence_obligation` (`obligation_id`),
  KEY `idx_evidence_submitted_biz` (`submitted_by_business_id`),
  KEY `idx_evidence_submitted_user` (`submitted_by_user_id`),
  CONSTRAINT `fk_evidence_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_evidence_obligation` FOREIGN KEY (`obligation_id`) REFERENCES `obligations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_evidence_submitted_biz` FOREIGN KEY (`submitted_by_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_evidence_submitted_user` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Payment Records Table
CREATE TABLE IF NOT EXISTS `payment_records` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `obligation_id` VARCHAR(36) DEFAULT NULL,
  `expected_amount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `reported_amount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'NGN',
  `payer_business_id` VARCHAR(36) NOT NULL,
  `recipient_business_id` VARCHAR(36) NOT NULL,
  `reference_no` VARCHAR(100) DEFAULT NULL,
  `status` ENUM('reported', 'acknowledged', 'confirmed') NOT NULL DEFAULT 'reported',
  `paid_at` TIMESTAMP NULL DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_payments_deal` (`deal_id`),
  KEY `idx_payments_obligation` (`obligation_id`),
  KEY `idx_payments_payer` (`payer_business_id`),
  KEY `idx_payments_recipient` (`recipient_business_id`),
  KEY `idx_payments_status` (`status`),
  KEY `idx_payments_reference_no` (`reference_no`),
  CONSTRAINT `fk_payments_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_obligation` FOREIGN KEY (`obligation_id`) REFERENCES `obligations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_payer` FOREIGN KEY (`payer_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_payments_recipient` FOREIGN KEY (`recipient_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Delivery Records Table
CREATE TABLE IF NOT EXISTS `delivery_records` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `obligation_id` VARCHAR(36) DEFAULT NULL,
  `items_json` JSON DEFAULT NULL,
  `dispatch_date` TIMESTAMP NULL DEFAULT NULL,
  `receipt_date` TIMESTAMP NULL DEFAULT NULL,
  `delivery_reference` VARCHAR(100) DEFAULT NULL,
  `status` ENUM('dispatched', 'delivered', 'acknowledged_with_discrepancy', 'confirmed') NOT NULL DEFAULT 'dispatched',
  `notes` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_deal` (`deal_id`),
  KEY `idx_delivery_obligation` (`obligation_id`),
  KEY `idx_delivery_status` (`status`),
  KEY `idx_delivery_reference` (`delivery_reference`),
  CONSTRAINT `fk_delivery_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_delivery_obligation` FOREIGN KEY (`obligation_id`) REFERENCES `obligations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Disputes Table
CREATE TABLE IF NOT EXISTS `disputes` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `obligation_id` VARCHAR(36) DEFAULT NULL,
  `raised_by_business_id` VARCHAR(36) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `description` TEXT NOT NULL,
  `status` ENUM('open', 'awaiting_response', 'under_review', 'resolution_proposed', 'resolved', 'unresolved') NOT NULL DEFAULT 'open',
  `resolution_terms` TEXT DEFAULT NULL,
  `resolved_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_disputes_deal` (`deal_id`),
  KEY `idx_disputes_obligation` (`obligation_id`),
  KEY `idx_disputes_raised_by` (`raised_by_business_id`),
  KEY `idx_disputes_status` (`status`),
  CONSTRAINT `fk_disputes_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_disputes_obligation` FOREIGN KEY (`obligation_id`) REFERENCES `obligations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_disputes_raised_by` FOREIGN KEY (`raised_by_business_id`) REFERENCES `businesses` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Activity Logs Table
CREATE TABLE IF NOT EXISTS `activity_logs` (
  `id` VARCHAR(36) NOT NULL,
  `deal_id` VARCHAR(36) NOT NULL,
  `actor_user_id` VARCHAR(36) DEFAULT NULL,
  `actor_business_id` VARCHAR(36) DEFAULT NULL,
  `event_type` VARCHAR(100) NOT NULL,
  `details_json` JSON DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_activity_logs_deal` (`deal_id`),
  KEY `idx_activity_logs_user` (`actor_user_id`),
  KEY `idx_activity_logs_business` (`actor_business_id`),
  KEY `idx_activity_logs_event_type` (`event_type`),
  KEY `idx_activity_logs_created_at` (`created_at`),
  CONSTRAINT `fk_activity_logs_deal` FOREIGN KEY (`deal_id`) REFERENCES `deals` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_activity_logs_user` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_activity_logs_business` FOREIGN KEY (`actor_business_id`) REFERENCES `businesses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Webhook Endpoints Table
CREATE TABLE IF NOT EXISTS `webhook_endpoints` (
  `id` VARCHAR(36) NOT NULL,
  `business_id` VARCHAR(36) NOT NULL,
  `url` TEXT NOT NULL,
  `secret_key` VARCHAR(255) NOT NULL,
  `events_json` JSON DEFAULT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_endpoints_business` (`business_id`),
  KEY `idx_webhook_endpoints_active` (`is_active`),
  CONSTRAINT `fk_webhook_endpoints_business` FOREIGN KEY (`business_id`) REFERENCES `businesses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Webhook Deliveries Table
CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id` VARCHAR(36) NOT NULL,
  `endpoint_id` VARCHAR(36) NOT NULL,
  `event_type` VARCHAR(100) NOT NULL,
  `payload_json` JSON NOT NULL,
  `response_status` INT DEFAULT NULL,
  `response_body` TEXT DEFAULT NULL,
  `attempt_count` INT NOT NULL DEFAULT 1,
  `status` ENUM('success', 'failed') NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_deliveries_endpoint` (`endpoint_id`),
  KEY `idx_webhook_deliveries_status` (`status`),
  KEY `idx_webhook_deliveries_event_type` (`event_type`),
  CONSTRAINT `fk_webhook_deliveries_endpoint` FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
