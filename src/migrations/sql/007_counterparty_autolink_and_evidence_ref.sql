-- Migration 007: Counterparty Auto-link & Evidence Reference Extension
-- Facilitates zero-friction counterparty invitation via phone and links uploaded proof to ledger records

-- 1. Add invited_phone to deals
ALTER TABLE deals 
ADD COLUMN invited_phone VARCHAR(32) NULL AFTER counterparty_business_id;

ALTER TABLE deals 
ADD INDEX idx_deals_invited_phone (invited_phone);

-- 2. Add invited_phone to deal_invitations and allow NULL invited_email
ALTER TABLE deal_invitations 
MODIFY COLUMN invited_email VARCHAR(255) NULL;

ALTER TABLE deal_invitations 
ADD COLUMN invited_phone VARCHAR(32) NULL AFTER invited_email;

ALTER TABLE deal_invitations 
ADD INDEX idx_invitations_invited_phone (invited_phone);

-- 3. Add evidence_id to payment_records
ALTER TABLE payment_records 
ADD COLUMN evidence_id VARCHAR(64) NULL AFTER reference_no;

-- 4. Add evidence_id to delivery_records
ALTER TABLE delivery_records 
ADD COLUMN evidence_id VARCHAR(64) NULL AFTER delivery_reference;
