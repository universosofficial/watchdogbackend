-- ==============================================================================
-- Digital Watchdog Database Migration: 002_add_original_due_date.sql
-- Description: Add original_due_date column to obligations for deadline extension auditing
-- ==============================================================================

ALTER TABLE `obligations`
ADD COLUMN `original_due_date` TIMESTAMP NULL DEFAULT NULL AFTER `due_date`;
