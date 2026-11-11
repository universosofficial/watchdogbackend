import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AppError } from '../utils/response.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Storage Provider Interface
 */
export class StorageProvider {
  async saveFile(file, destinationSubdir) {
    throw new Error('Method saveFile() must be implemented');
  }

  async getFileStream(filePath) {
    throw new Error('Method getFileStream() must be implemented');
  }

  async getFileBuffer(filePath) {
    throw new Error('Method getFileBuffer() must be implemented');
  }

  async deleteFile(filePath) {
    throw new Error('Method deleteFile() must be implemented');
  }

  async fileExists(filePath) {
    throw new Error('Method fileExists() must be implemented');
  }
}

/**
 * Local Disk Storage Provider Implementation
 */
export class LocalStorageProvider extends StorageProvider {
  constructor(baseUploadDir) {
    super();
    this.baseUploadDir = baseUploadDir || path.resolve(__dirname, '../../uploads/evidence');
    this.ensureBaseDirectory();
  }

  ensureBaseDirectory(dirPath = this.baseUploadDir) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Save uploaded file to local disk
   * @param {Express.Multer.File|Object|Buffer} file
   * @param {string} destinationSubdir - e.g. deal ID
   * @returns {Promise<{ filePath: string, fileName: string, fileSize: number, mimeType: string }>}
   */
  async saveFile(file, destinationSubdir = '') {
    const targetDir = destinationSubdir
      ? path.join(this.baseUploadDir, destinationSubdir)
      : this.baseUploadDir;

    this.ensureBaseDirectory(targetDir);

    let originalName = 'upload';
    let buffer = null;
    let filePath = null;
    let mimeType = 'application/octet-stream';
    let size = 0;

    if (Buffer.isBuffer(file)) {
      buffer = file;
      size = file.length;
      originalName = `binary_${Date.now()}`;
    } else if (file && typeof file === 'object') {
      originalName = file.originalname || file.name || 'upload';
      buffer = file.buffer || null;
      filePath = file.path || null;
      mimeType = file.mimetype || file.mimeType || 'application/octet-stream';
      size = file.size || (buffer ? buffer.length : 0);
    } else {
      throw new AppError('Invalid file upload content', 400, 'INVALID_FILE_CONTENT');
    }

    const safeOriginalName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueFileName = `${Date.now()}_${safeOriginalName}`;
    const destinationPath = path.join(targetDir, uniqueFileName);

    if (buffer) {
      await fs.promises.writeFile(destinationPath, buffer);
    } else if (filePath) {
      await fs.promises.copyFile(filePath, destinationPath);
      await fs.promises.unlink(filePath).catch(() => {});
    } else {
      throw new AppError('Invalid file upload content', 400, 'INVALID_FILE_CONTENT');
    }

    // Return relative path for portability across environments
    const relativeFilePath = path.relative(this.baseUploadDir, destinationPath).replace(/\\/g, '/');

    return {
      filePath: relativeFilePath,
      absolutePath: destinationPath,
      fileName: originalName,
      fileSize: size,
      mimeType
    };
  }

  /**
   * Stream file from disk
   * @param {string} relativeFilePath
   * @returns {Promise<fs.ReadStream>}
   */
  async getFileStream(relativeFilePath) {
    const fullPath = path.isAbsolute(relativeFilePath)
      ? relativeFilePath
      : (fs.existsSync(path.resolve(process.cwd(), relativeFilePath))
          ? path.resolve(process.cwd(), relativeFilePath)
          : path.join(this.baseUploadDir, relativeFilePath));

    if (!fs.existsSync(fullPath)) {
      throw new AppError('Requested evidence file does not exist on disk', 404, 'FILE_NOT_FOUND');
    }

    return fs.createReadStream(fullPath);
  }

  /**
   * Read full file buffer from disk
   * @param {string} relativeFilePath
   * @returns {Promise<Buffer|null>}
   */
  async getFileBuffer(relativeFilePath) {
    const fullPath = path.isAbsolute(relativeFilePath)
      ? relativeFilePath
      : (fs.existsSync(path.resolve(process.cwd(), relativeFilePath))
          ? path.resolve(process.cwd(), relativeFilePath)
          : path.join(this.baseUploadDir, relativeFilePath));

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    return fs.promises.readFile(fullPath);
  }

  /**
   * Delete file from disk
   * @param {string} relativeFilePath
   */
  async deleteFile(relativeFilePath) {
    const fullPath = path.isAbsolute(relativeFilePath)
      ? relativeFilePath
      : (fs.existsSync(path.resolve(process.cwd(), relativeFilePath))
          ? path.resolve(process.cwd(), relativeFilePath)
          : path.join(this.baseUploadDir, relativeFilePath));

    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath).catch(() => {});
    }
  }

  /**
   * Check if file exists
   * @param {string} relativeFilePath
   */
  async fileExists(relativeFilePath) {
    const fullPath = path.isAbsolute(relativeFilePath)
      ? relativeFilePath
      : (fs.existsSync(path.resolve(process.cwd(), relativeFilePath))
          ? path.resolve(process.cwd(), relativeFilePath)
          : path.join(this.baseUploadDir, relativeFilePath));

    return fs.existsSync(fullPath);
  }
}

/**
 * Cloudinary Storage Provider with Private/Authenticated Fintech Encryption
 */
export class CloudinaryStorageProvider extends StorageProvider {
  constructor(config = {}) {
    super();
    this.cloudName = config.cloudName || process.env.CLOUDINARY_CLOUD_NAME;
    this.apiKey = config.apiKey || process.env.CLOUDINARY_API_KEY;
    this.apiSecret = config.apiSecret || process.env.CLOUDINARY_API_SECRET;

    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      console.warn('[CloudinaryStorageProvider] Missing Cloudinary credentials in .env. Storage operations will require credentials.');
    }

    import('cloudinary').then(({ v2: cloudinary }) => {
      this.cloudinary = cloudinary;
      this.cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true
      });
    }).catch(err => {
      console.error('[CloudinaryStorageProvider] Failed loading cloudinary package:', err);
    });
  }

  async ensureInitialized() {
    if (!this.cloudinary) {
      const { v2: cloudinary } = await import('cloudinary');
      this.cloudinary = cloudinary;
      this.cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true
      });
    }
  }

  /**
   * Parse resource type and public ID from formatted path string
   * e.g. "image:digital_watchdog/deals/123" -> { resourceType: 'image', publicId: 'digital_watchdog/deals/123' }
   */
  parsePathDescriptor(filePath) {
    if (!filePath) return { resourceType: 'auto', publicId: '' };
    if (filePath.startsWith('image:') || filePath.startsWith('raw:') || filePath.startsWith('video:')) {
      const colonIdx = filePath.indexOf(':');
      return {
        resourceType: filePath.slice(0, colonIdx),
        publicId: filePath.slice(colonIdx + 1)
      };
    }

    // Heuristic detection based on extension
    if (filePath.match(/\.(jpe?g|png|webp|gif|svg)$/i)) {
      return { resourceType: 'image', publicId: filePath };
    }
    if (filePath.match(/\.(pdf|txt|docx?|xlsx?|zip|csv|json)$/i)) {
      return { resourceType: 'raw', publicId: filePath };
    }

    return { resourceType: 'auto', publicId: filePath };
  }

  /**
   * Save uploaded file to Cloudinary under authenticated/private access
   * @param {Express.Multer.File|Object|Buffer} file
   * @param {string} destinationSubdir - e.g. deal ID, 'biometrics', 'evidence'
   */
  async saveFile(file, destinationSubdir = 'deals', isPublic = false) {
    await this.ensureInitialized();

    let originalName = 'upload';
    let buffer = null;
    let filePath = null;
    let mimeType = 'application/octet-stream';
    let size = 0;

    if (Buffer.isBuffer(file)) {
      buffer = file;
      size = file.length;
      originalName = `binary_${Date.now()}`;
    } else if (file && typeof file === 'object') {
      originalName = file.originalname || file.name || 'upload';
      buffer = file.buffer || null;
      filePath = file.path || null;
      mimeType = file.mimetype || file.mimeType || 'application/octet-stream';
      size = file.size || (buffer ? buffer.length : 0);
    } else {
      throw new AppError('No readable file content provided for upload', 400, 'INVALID_FILE_CONTENT');
    }

    const isImage = mimeType.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';

    const safeOriginalName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^/.]+$/, '');
    const cleanPublicId = `${Date.now()}_${safeOriginalName}`;

    const isPublicAsset = isPublic || destinationSubdir === 'avatars';
    const uploadOptions = {
      folder: `digital_watchdog/${destinationSubdir}`,
      public_id: cleanPublicId,
      resource_type: resourceType,
      type: isPublicAsset ? 'upload' : 'authenticated',
      overwrite: true
    };

    if (destinationSubdir === 'avatars') {
      uploadOptions.transformation = [
        { width: 500, height: 500, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }
      ];
    }

    return new Promise((resolve, reject) => {
      const uploadStream = this.cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) {
            return reject(new AppError(`Cloudinary Upload Failed: ${error.message}`, 502, 'CLOUDINARY_UPLOAD_ERROR'));
          }

          // Return structured reference with resourceType prefix for unambiguous resolution
          const formattedPath = `${result.resource_type}:${result.public_id}`;

          resolve({
            filePath: formattedPath,
            publicId: result.public_id,
            resourceType: result.resource_type,
            fileName: originalName,
            fileSize: result.bytes || size,
            mimeType,
            format: result.format,
            secureUrl: result.secure_url
          });
        }
      );

      if (buffer) {
        uploadStream.end(buffer);
      } else if (filePath) {
        fs.createReadStream(filePath).pipe(uploadStream);
      } else {
        reject(new AppError('No readable file buffer or path found for upload', 400, 'INVALID_FILE_CONTENT'));
      }
    });
  }

  /**
   * Stream a private file back to client
   */
  async getFileStream(filePath) {
    // Check if it exists locally on disk (backward compatibility for legacy uploads)
    if (fs.existsSync(path.resolve(process.cwd(), filePath))) {
      return fs.createReadStream(path.resolve(process.cwd(), filePath));
    }

    await this.ensureInitialized();
    const { resourceType, publicId } = this.parsePathDescriptor(filePath);
    const signedUrl = this.getSignedDownloadUrl(filePath, 300);

    let res = await fetch(signedUrl);
    if (!res.ok && resourceType === 'auto') {
      // Fallback check with 'raw' resource type
      const fallbackUrl = this.cloudinary.url(publicId, {
        sign_url: true,
        type: 'authenticated',
        resource_type: 'raw',
        secure: true,
        expires_at: Math.floor(Date.now() / 1000) + 300
      });
      const fallbackRes = await fetch(fallbackUrl);
      if (fallbackRes.ok) {
        res = fallbackRes;
      }
    }

    if (!res.ok) {
      throw new AppError(`Could not retrieve file from Cloudinary (HTTP ${res.status})`, res.status, 'CLOUDINARY_STREAM_ERROR');
    }

    const arrayBuffer = await res.arrayBuffer();
    const { Readable } = await import('stream');
    return Readable.from(Buffer.from(arrayBuffer));
  }

  /**
   * Fetch full file as a Buffer
   */
  async getFileBuffer(filePath) {
    // Check if it exists locally on disk
    if (fs.existsSync(path.resolve(process.cwd(), filePath))) {
      return fs.promises.readFile(path.resolve(process.cwd(), filePath));
    }

    try {
      const stream = await this.getFileStream(filePath);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      console.warn(`[CloudinaryStorageProvider] Could not load buffer for ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * Generate an HMAC-signed time-limited URL for direct viewing
   */
  getSignedDownloadUrl(filePath, expiresInSeconds = 900) {
    if (!this.cloudinary) {
      throw new AppError('Cloudinary client not initialized', 500, 'UNINITIALIZED');
    }

    const { resourceType, publicId } = this.parsePathDescriptor(filePath);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

    return this.cloudinary.url(publicId, {
      sign_url: true,
      type: 'authenticated',
      resource_type: resourceType === 'auto' ? 'image' : resourceType,
      secure: true,
      expires_at: expiresAt
    });
  }

  /**
   * Generate an image thumbnail URL (e.g. converting Page 1 of PDF to JPG thumbnail)
   */
  getThumbnailUrl(filePath, width = 400) {
    if (!this.cloudinary) return null;
    const { publicId } = this.parsePathDescriptor(filePath);
    return this.cloudinary.url(publicId, {
      sign_url: true,
      type: 'authenticated',
      resource_type: 'image',
      secure: true,
      transformation: [
        { width, crop: 'scale' },
        { page: 1, format: 'jpg' }
      ],
      expires_at: Math.floor(Date.now() / 1000) + 900
    });
  }

  async deleteFile(filePath) {
    // If local legacy file, delete from disk
    if (fs.existsSync(path.resolve(process.cwd(), filePath))) {
      await fs.promises.unlink(path.resolve(process.cwd(), filePath)).catch(() => {});
      return true;
    }

    await this.ensureInitialized();
    const { resourceType, publicId } = this.parsePathDescriptor(filePath);
    await this.cloudinary.uploader.destroy(publicId, {
      type: 'authenticated',
      resource_type: resourceType === 'auto' ? 'image' : resourceType
    });
    return true;
  }

  async fileExists(filePath) {
    if (fs.existsSync(path.resolve(process.cwd(), filePath))) {
      return true;
    }

    await this.ensureInitialized();
    const { resourceType, publicId } = this.parsePathDescriptor(filePath);
    try {
      const res = await this.cloudinary.api.resource(publicId, {
        type: 'authenticated',
        resource_type: resourceType === 'auto' ? 'image' : resourceType
      });
      return !!res;
    } catch {
      return false;
    }
  }
}

/**
 * Cloud Storage Provider (S3 / Cloudflare R2 Compatible Structure)
 */
export class S3StorageProvider extends StorageProvider {
  constructor(config = {}) {
    super();
    this.bucket = config.bucket || process.env.S3_BUCKET;
    this.region = config.region || process.env.S3_REGION || 'auto';
  }

  async saveFile(file, destinationSubdir) {
    throw new AppError('Cloud S3 Provider not configured. Falling back to local storage provider.', 501, 'NOT_IMPLEMENTED');
  }

  async getFileStream(filePath) {
    throw new AppError('Cloud S3 Provider not configured.', 501, 'NOT_IMPLEMENTED');
  }

  async getFileBuffer(filePath) {
    throw new AppError('Cloud S3 Provider not configured.', 501, 'NOT_IMPLEMENTED');
  }

  async deleteFile(filePath) {
    throw new AppError('Cloud S3 Provider not configured.', 501, 'NOT_IMPLEMENTED');
  }

  async fileExists(filePath) {
    throw new AppError('Cloud S3 Provider not configured.', 501, 'NOT_IMPLEMENTED');
  }
}

// Factory instantiation based on environment
const configuredProvider = process.env.STORAGE_PROVIDER || (process.env.CLOUDINARY_CLOUD_NAME ? 'cloudinary' : 'local');

export const storageService = (configuredProvider === 'cloudinary' && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  ? new CloudinaryStorageProvider()
  : (configuredProvider === 's3' ? new S3StorageProvider() : new LocalStorageProvider());

export default storageService;
