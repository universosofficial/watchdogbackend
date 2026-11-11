import multer from 'multer';
import { AppError } from '../utils/response.js';

// Allowed MIME types
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
]);

// 10 MB maximum file size limit
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Memory storage for pluggable pipeline
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type '${file.mimetype}'. Only PDF, PNG, JPG/JPEG, and DOCX documents are supported.`,
        400,
        'INVALID_MIME_TYPE'
      ),
      false
    );
  }
};

export const evidenceUpload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1
  },
  fileFilter
});

const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

export const avatarUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB maximum avatar upload
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_AVATAR_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          `Invalid file format '${file.mimetype}'. Only JPG, PNG, and WebP images are supported for profile avatars.`,
          400,
          'INVALID_IMAGE_TYPE'
        ),
        false
      );
    }
  }
});

export default evidenceUpload;
