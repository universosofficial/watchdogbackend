-- Migration 015: User Profile Avatar URL (Cloudinary CDN Storage)
ALTER TABLE users
  ADD COLUMN avatar_url VARCHAR(500) NULL AFTER full_name;
