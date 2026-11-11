import crypto from 'crypto';
import pool, { getConnection } from '../config/db.js';
import storageService from '../services/storageService.js';
import ActivityService from '../services/activityService.js';
import { sendSuccess, sendError, AppError } from '../utils/response.js';

/**
 * POST /api/v1/deals/:dealId/evidence
 * Upload file linked to deal and optional obligation
 */
export async function uploadEvidence(req, res, next) {
  try {
    const { dealId } = req.params;
    const { obligation_id, notes } = req.body;

    if (!req.file) {
      return sendError(res, 'No file was provided for upload', 'MISSING_FILE', 400);
    }

    // If obligation_id is specified, verify it belongs to this deal
    if (obligation_id) {
      const [obs] = await pool.query(
        'SELECT id FROM obligations WHERE id = ? AND deal_id = ?',
        [obligation_id, dealId]
      );
      if (obs.length === 0) {
        return sendError(res, 'Specified obligation does not belong to this deal', 'OBLIGATION_MISMATCH', 400);
      }
    }

    // Save file via Pluggable StorageService
    const storedFile = await storageService.saveFile(req.file, dealId);
    const evidenceId = crypto.randomUUID();

    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO evidence_records (
          id, deal_id, obligation_id, submitted_by_business_id, submitted_by_user_id,
          file_path, file_name, file_size, mime_type, verification_tier, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, NOW())`,
        [
          evidenceId,
          dealId,
          obligation_id || null,
          req.businessId,
          req.userId,
          storedFile.filePath,
          storedFile.fileName,
          storedFile.fileSize,
          storedFile.mimeType,
          notes ? notes.trim() : null
        ]
      );

      await ActivityService.logEvent(
        dealId,
        req.userId,
        req.businessId,
        'evidence.submitted',
        {
          evidence_id: evidenceId,
          file_name: storedFile.fileName,
          file_size: storedFile.fileSize,
          mime_type: storedFile.mimeType,
          obligation_id: obligation_id || null,
          verification_tier: 'submitted'
        },
        conn
      );

      await conn.commit();

      return sendSuccess(
        res,
        {
          id: evidenceId,
          deal_id: dealId,
          obligation_id: obligation_id || null,
          file_name: storedFile.fileName,
          file_size: storedFile.fileSize,
          mime_type: storedFile.mimeType,
          verification_tier: 'submitted',
          notes: notes ? notes.trim() : null,
          created_at: new Date().toISOString()
        },
        201
      );
    } catch (err) {
      await conn.rollback();
      await storageService.deleteFile(storedFile.filePath).catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/:dealId/evidence
 * List evidence files submitted for the deal
 */
export async function listEvidence(req, res, next) {
  try {
    const { dealId } = req.params;

    const [rows] = await pool.query(
      `SELECT 
        e.id,
        e.deal_id,
        e.obligation_id,
        e.file_name,
        e.file_size,
        e.mime_type,
        e.verification_tier,
        e.notes,
        e.created_at,
        u.full_name AS submitted_by_user_name,
        u.email AS submitted_by_user_email,
        b.name AS submitted_by_business_name,
        o.title AS obligation_title
      FROM evidence_records e
      LEFT JOIN users u ON e.submitted_by_user_id = u.id
      LEFT JOIN businesses b ON e.submitted_by_business_id = b.id
      LEFT JOIN obligations o ON e.obligation_id = o.id
      WHERE e.deal_id = ?
      ORDER BY e.created_at DESC`,
      [dealId]
    );

    return sendSuccess(res, {
      count: rows.length,
      evidence: rows
    });
  } catch (error) {
    next(error);
  }
}

const SIGNED_MEDIA_SECRET = process.env.JWT_SECRET || 'secure_signed_media_secret_change_in_prod';

/**
 * Generate a cryptographically signed, time-limited URL for secure evidence viewing
 */
export function generatePreSignedEvidenceUrl(dealId, evidenceId, expiresInSeconds = 900) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const data = `${dealId}:${evidenceId}:${expires}`;
  const sig = crypto.createHmac('sha256', SIGNED_MEDIA_SECRET).update(data).digest('hex');
  return {
    url: `/api/v1/deals/${dealId}/evidence/${evidenceId}/download?expires=${expires}&sig=${sig}`,
    expires_at: new Date(expires * 1000).toISOString()
  };
}

/**
 * Validates HMAC signature and expiration on pre-signed media request
 */
function verifyPreSignedEvidenceUrl(dealId, evidenceId, expires, sig) {
  if (!expires || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now > parseInt(expires, 10)) return false; // Expired
  const data = `${dealId}:${evidenceId}:${expires}`;
  const expectedSig = crypto.createHmac('sha256', SIGNED_MEDIA_SECRET).update(data).digest('hex');
  if (sig.length !== expectedSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
}

/**
 * GET /api/v1/deals/:dealId/evidence/:evidenceId/signed-url
 * Generates a 15-minute time-limited pre-signed URL for viewing private receipts
 */
export async function getSignedEvidenceUrl(req, res, next) {
  try {
    const { dealId, evidenceId } = req.params;
    const [rows] = await pool.query(
      'SELECT id FROM evidence_records WHERE id = ? AND deal_id = ?',
      [evidenceId, dealId]
    );

    if (rows.length === 0) {
      return sendError(res, 'Evidence record not found', 'EVIDENCE_NOT_FOUND', 404);
    }

    const signedData = generatePreSignedEvidenceUrl(dealId, evidenceId, 900); // 15 mins
    return sendSuccess(res, signedData);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/deals/:dealId/evidence/:evidenceId/download
 * Stream file securely after tenant isolation check or valid pre-signed signature
 */
export async function downloadEvidence(req, res, next) {
  try {
    const { dealId, evidenceId } = req.params;
    const { expires, sig } = req.query;

    // Check if accessing via pre-signed URL
    if (expires && sig) {
      const isValidSig = verifyPreSignedEvidenceUrl(dealId, evidenceId, expires, sig);
      if (!isValidSig) {
        return sendError(res, 'Signed media URL has expired or has an invalid signature', 'SIGNED_URL_INVALID', 403);
      }
    }

    const [rows] = await pool.query(
      'SELECT * FROM evidence_records WHERE id = ? AND deal_id = ?',
      [evidenceId, dealId]
    );

    if (rows.length === 0) {
      return sendError(res, 'Evidence record not found', 'EVIDENCE_NOT_FOUND', 404);
    }

    const evidence = rows[0];
    const stream = await storageService.getFileStream(evidence.file_path);

    res.setHeader('Content-Type', evidence.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(evidence.file_name)}"`);
    res.setHeader('Content-Length', evidence.file_size);

    stream.pipe(res);
  } catch (error) {
    next(error);
  }
}
