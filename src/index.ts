import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import cors from 'cors';
import { fileURLToPath } from 'url';

const app = express();
const PORT = 3000;

// ══════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════
const CONFIG = {
  MAX_CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
  CHUNK_TIMEOUT: 30000, // 30 seconds
  MAX_RETRY_ATTEMPTS: 3,
  TEMP_FILE_CLEANUP_TIME: 24 * 60 * 60 * 1000, // 24 hours
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024, // 5GB
  KEEP_CORRUPTED_FILES: false, // Delete corrupted files by default
};

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE SETUP
// ══════════════════════════════════════════════════════════════
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ══════════════════════════════════════════════════════════════
// DIRECTORY SETUP
// ══════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
const QUARANTINE_DIR = path.join(__dirname, 'quarantine');
const CHECKSUM_METADATA_DIR = path.join(__dirname, 'checksums');

// Create all required directories
[UPLOAD_DIR, TEMP_DIR, QUARANTINE_DIR, CHECKSUM_METADATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

// ══════════════════════════════════════════════════════════════
// MULTER CONFIGURATION
// ══════════════════════════════════════════════════════════════
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uploadId = req.body.uploadId || crypto.randomBytes(16).toString('hex');
    const chunkNumber = req.body.chunkNumber || '0';
    const timestamp = Date.now();
    cb(null, `${uploadId}-chunk-${chunkNumber}-${timestamp}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: CONFIG.MAX_CHUNK_SIZE + 1024 * 1024, // 1MB buffer
  },
  fileFilter: (req, file, cb) => {
    cb(null, true); // Accept all files
  }
});

// ══════════════════════════════════════════════════════════════
// TYPESCRIPT INTERFACES
// ══════════════════════════════════════════════════════════════
interface UploadMetadata {
  uploadId: string;
  filename: string;
  totalChunks: number;
  fileSize: number;
  receivedChunks: Set<number>;
  createdAt: number;
  lastActivity: number;
  chunkSize?: number;
  expectedChecksum: string;
  checksumAlgorithm: string;
}

interface ChecksumMetadata {
  uploadId: string;
  filename: string;
  originalFilename: string;
  fileSize: number;
  expectedChecksum: string;
  actualChecksum?: string;
  checksumAlgorithm: string;
  verified?: boolean;
  uploadedAt: string;
  verifiedAt?: string;
  calculationTimeMs?: number;
  uploadDurationMs?: number;
  error?: string;
  quarantinePath?: string;
  clientInfo?: {
    chunks: number;
    parallelUploads?: number;
  };
}

// ══════════════════════════════════════════════════════════════
// IN-MEMORY STORAGE (Use Redis/Database in production)
// ══════════════════════════════════════════════════════════════
const uploadSessions = new Map<string, UploadMetadata>();
const chunkLocks = new Map<string, Promise<void>>();

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Calculate SHA-512 checksum of a file
 * Uses streaming to handle large files efficiently
 */
async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath, {
      highWaterMark: 1024 * 1024 // 1MB chunks for reading
    });

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Save checksum metadata to JSON file
 */
async function saveChecksumMetadata(metadata: ChecksumMetadata): Promise<void> {
  const filename = `${metadata.uploadId}.json`;
  const filepath = path.join(CHECKSUM_METADATA_DIR, filename);

  try {
    await fs.promises.writeFile(
      filepath,
      JSON.stringify(metadata, null, 2),
      'utf8'
    );
    console.log(`💾 Saved checksum metadata: ${filename}`);
  } catch (error) {
    console.error(`Failed to save metadata ${filename}:`, error);
  }
}

/**
 * Cleanup session and remove all associated chunks
 */
function cleanupSession(uploadId: string, metadata: UploadMetadata): void {
  console.log(`🧹 Cleaning up session: ${uploadId}`);

  try {
    const files = fs.readdirSync(TEMP_DIR);
    let deletedCount = 0;

    files.forEach(file => {
      if (file.startsWith(`${uploadId}-chunk-`)) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (e) {
          console.error(`Failed to delete ${file}:`, e);
        }
      }
    });

    if (deletedCount > 0) {
      console.log(`🗑️  Deleted ${deletedCount} chunk files`);
    }
  } catch (error) {
    console.error(`Error cleaning up session ${uploadId}:`, error);
  }

  uploadSessions.delete(uploadId);
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ══════════════════════════════════════════════════════════════
// PERIODIC CLEANUP - Runs every hour
// ══════════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [uploadId, metadata] of uploadSessions.entries()) {
    const age = now - metadata.lastActivity;
    if (age > CONFIG.TEMP_FILE_CLEANUP_TIME) {
      const ageMinutes = Math.floor(age / 1000 / 60);
      console.log(`⏰ Session ${uploadId} is stale (${ageMinutes} minutes old)`);
      cleanupSession(uploadId, metadata);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stale sessions`);
  }
}, 60 * 60 * 1000); // Run every hour

// ══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════════════

/**
 * ROOT - Server information
 */
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Chunked File Upload Server with SHA-512 Verification',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      init: 'POST /upload/init',
      chunk: 'POST /upload/chunk',
      complete: 'POST /upload/complete',
      status: 'GET /upload/status/:uploadId',
      cancel: 'DELETE /upload/:uploadId',
      health: 'GET /health',
      active: 'GET /uploads/active'
    },
    config: {
      maxChunkSize: `${CONFIG.MAX_CHUNK_SIZE / 1024 / 1024}MB`,
      maxFileSize: `${CONFIG.MAX_FILE_SIZE / 1024 / 1024 / 1024}GB`,
      checksumAlgorithm: 'SHA-512',
      keepCorruptedFiles: CONFIG.KEEP_CORRUPTED_FILES,
      sessionTimeout: `${CONFIG.TEMP_FILE_CLEANUP_TIME / 1000 / 60 / 60}h`
    }
  });
});

/**
 * INITIALIZE UPLOAD SESSION
 * Creates a new upload session with checksum
 */
app.post('/upload/init', (req: Request, res: Response) => {
  try {
    const { filename, totalChunks, fileSize, chunkSize, checksum, checksumAlgorithm } = req.body;

    // ─────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────
    if (!filename || !totalChunks || !fileSize || !checksum) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['filename', 'totalChunks', 'fileSize', 'checksum'],
        received: {
          filename: !!filename,
          totalChunks: !!totalChunks,
          fileSize: !!fileSize,
          checksum: !!checksum
        }
      });
    }

    // Validate checksum algorithm
    if (checksumAlgorithm && checksumAlgorithm !== 'sha512') {
      return res.status(400).json({
        success: false,
        error: 'Unsupported checksum algorithm',
        supported: ['sha512'],
        received: checksumAlgorithm
      });
    }

    // Parse and validate numeric values
    const parsedTotalChunks = parseInt(totalChunks.toString());
    const parsedFileSize = parseInt(fileSize.toString());

    if (isNaN(parsedTotalChunks) || parsedTotalChunks < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid totalChunks value',
        value: totalChunks
      });
    }

    if (isNaN(parsedFileSize) || parsedFileSize < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid fileSize value',
        value: fileSize
      });
    }

    // Validate chunk size
    const requestedChunkSize = chunkSize || CONFIG.MAX_CHUNK_SIZE;
    if (requestedChunkSize > CONFIG.MAX_CHUNK_SIZE) {
      return res.status(400).json({
        success: false,
        error: 'Chunk size exceeds maximum',
        maxChunkSize: CONFIG.MAX_CHUNK_SIZE,
        requestedChunkSize,
        recommendedChunkSize: CONFIG.MAX_CHUNK_SIZE
      });
    }

    // Validate file size
    if (parsedFileSize > CONFIG.MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds maximum',
        maxFileSize: CONFIG.MAX_FILE_SIZE,
        requestedFileSize: parsedFileSize
      });
    }

    // Validate checksum format (should be 128 hex characters for SHA-512)
    if (!/^[a-f0-9]{128}$/i.test(checksum)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checksum format',
        expected: 'SHA-512 checksum should be 128 hexadecimal characters'
      });
    }

    // ─────────────────────────────────────────────────────────
    // Create Upload Session
    // ─────────────────────────────────────────────────────────
    const uploadId = crypto.randomBytes(16).toString('hex');

    const metadata: UploadMetadata = {
      uploadId,
      filename,
      totalChunks: parsedTotalChunks,
      fileSize: parsedFileSize,
      receivedChunks: new Set<number>(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      chunkSize: requestedChunkSize,
      expectedChecksum: checksum.toLowerCase(),
      checksumAlgorithm: checksumAlgorithm || 'sha512'
    };

    uploadSessions.set(uploadId, metadata);

    // ─────────────────────────────────────────────────────────
    // Log Session Creation
    // ─────────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════');
    console.log(`✨ Upload Session Initialized`);
    console.log(`   📋 Upload ID: ${uploadId}`);
    console.log(`   📄 Filename: ${filename}`);
    console.log(`   📦 Chunks: ${parsedTotalChunks}`);
    console.log(`   📊 Size: ${formatBytes(parsedFileSize)}`);
    console.log(`   🔐 Checksum: ${checksum.substring(0, 32)}...`);
    console.log(`   🔧 Algorithm: ${metadata.checksumAlgorithm.toUpperCase()}`);
    console.log('═══════════════════════════════════════════════════');

    res.json({
      success: true,
      uploadId,
      recommendedChunkSize: CONFIG.MAX_CHUNK_SIZE,
      message: 'Upload session initialized successfully',
      session: {
        filename,
        totalChunks: parsedTotalChunks,
        fileSize: parsedFileSize,
        checksumAlgorithm: metadata.checksumAlgorithm
      }
    });
  } catch (error) {
    console.error('❌ Init error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initialize upload',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * UPLOAD CHUNK
 * Upload a single chunk with concurrent upload support
 */
app.post('/upload/chunk', upload.single('chunk'), async (req: Request, res: Response) => {
  const uploadedFile = req.file;

  try {
    const { uploadId, chunkNumber } = req.body;

    // ─────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────
    if (!uploadId || chunkNumber === undefined || !uploadedFile) {
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }

      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['uploadId', 'chunkNumber', 'chunk'],
        received: {
          uploadId: !!uploadId,
          chunkNumber: chunkNumber !== undefined,
          chunk: !!uploadedFile
        }
      });
    }

    // Get session metadata
    const metadata = uploadSessions.get(uploadId);
    if (!metadata) {
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }

      return res.status(404).json({
        success: false,
        error: 'Upload session not found',
        uploadId,
        hint: 'Session may have expired or been cancelled'
      });
    }

    const chunkNum = parseInt(chunkNumber);

    // Validate chunk number range
    if (isNaN(chunkNum) || chunkNum < 0 || chunkNum >= metadata.totalChunks) {
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }

      return res.status(400).json({
        success: false,
        error: 'Invalid chunk number',
        chunkNumber,
        validRange: `0-${metadata.totalChunks - 1}`,
        totalChunks: metadata.totalChunks
      });
    }

    // Validate chunk is not empty
    if (!uploadedFile.size || uploadedFile.size === 0) {
      if (fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }

      return res.status(400).json({
        success: false,
        error: 'Chunk file is empty'
      });
    }

    // Update last activity timestamp
    metadata.lastActivity = Date.now();

    // ─────────────────────────────────────────────────────────
    // Concurrent Upload Handling with Locks
    // ─────────────────────────────────────────────────────────
    const lockKey = `${uploadId}-${chunkNum}`;

    // Wait for any pending operations on this chunk
    if (chunkLocks.has(lockKey)) {
      await chunkLocks.get(lockKey);
    }

    // Process chunk with lock to prevent race conditions
    const chunkOperation = (async () => {
      try {
        // Check if chunk already received (duplicate detection)
        if (metadata.receivedChunks.has(chunkNum)) {
          console.log(`⚠️  Chunk ${chunkNum} already received (duplicate), skipping`);

          if (uploadedFile && fs.existsSync(uploadedFile.path)) {
            fs.unlinkSync(uploadedFile.path);
          }
          return;
        }

        // Target path for this chunk
        const targetPath = path.join(TEMP_DIR, `${uploadId}-chunk-${chunkNum}`);

        // Check if chunk file already exists from previous attempt
        if (fs.existsSync(targetPath)) {
          console.log(`♻️  Chunk ${chunkNum} file already exists, reusing`);

          if (uploadedFile && fs.existsSync(uploadedFile.path)) {
            fs.unlinkSync(uploadedFile.path);
          }

          metadata.receivedChunks.add(chunkNum);
          return;
        }

        // Move uploaded file to final chunk location
        fs.renameSync(uploadedFile.path, targetPath);

        // Mark chunk as received
        metadata.receivedChunks.add(chunkNum);

        const progress = ((metadata.receivedChunks.size / metadata.totalChunks) * 100).toFixed(1);
        console.log(`✅ Chunk ${chunkNum} received (${metadata.receivedChunks.size}/${metadata.totalChunks} - ${progress}%)`);
      } catch (error) {
        console.error(`❌ Error processing chunk ${chunkNum}:`, error);

        // Cleanup on error
        if (uploadedFile && fs.existsSync(uploadedFile.path)) {
          try {
            fs.unlinkSync(uploadedFile.path);
          } catch (e) {
            console.error('Failed to cleanup uploaded file:', e);
          }
        }

        throw error;
      }
    })();

    // Store the lock promise
    chunkLocks.set(lockKey, chunkOperation);

    // Wait for the operation to complete
    await chunkOperation;

    // Remove the lock
    chunkLocks.delete(lockKey);

    // Check if upload is complete
    const isComplete = metadata.receivedChunks.size === metadata.totalChunks;

    res.json({
      success: true,
      message: 'Chunk uploaded successfully',
      chunkNumber: chunkNum,
      receivedChunks: metadata.receivedChunks.size,
      totalChunks: metadata.totalChunks,
      progress: ((metadata.receivedChunks.size / metadata.totalChunks) * 100).toFixed(2),
      isComplete
    });
  } catch (error) {
    console.error('❌ Chunk upload error:', error);

    // Cleanup uploaded file on error
    if (uploadedFile && fs.existsSync(uploadedFile.path)) {
      try {
        fs.unlinkSync(uploadedFile.path);
      } catch (e) {
        console.error('Failed to cleanup on error:', e);
      }
    }

    res.status(500).json({
      success: false,
      error: 'Failed to upload chunk',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * COMPLETE UPLOAD
 * Merge chunks and verify checksum
 */
app.post('/upload/complete', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { uploadId } = req.body;

    // ─────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────
    if (!uploadId) {
      return res.status(400).json({
        success: false,
        error: 'Missing uploadId'
      });
    }

    const metadata = uploadSessions.get(uploadId);
    if (!metadata) {
      return res.status(404).json({
        success: false,
        error: 'Upload session not found',
        uploadId
      });
    }

    console.log('═══════════════════════════════════════════════════');
    console.log(`🔄 Completing Upload: ${uploadId}`);
    console.log('═══════════════════════════════════════════════════');

    // ─────────────────────────────────────────────────────────
    // Check All Chunks Received
    // ─────────────────────────────────────────────────────────
    if (metadata.receivedChunks.size !== metadata.totalChunks) {
      const receivedArray = Array.from(metadata.receivedChunks).sort((a, b) => a - b);
      const missing = Array.from({ length: metadata.totalChunks }, (_, i) => i)
        .filter(i => !metadata.receivedChunks.has(i));

      console.log(`❌ Not all chunks received`);
      console.log(`   Received: ${receivedArray.length}/${metadata.totalChunks}`);
      console.log(`   Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`);

      return res.status(400).json({
        success: false,
        error: 'Not all chunks uploaded',
        received: metadata.receivedChunks.size,
        total: metadata.totalChunks,
        missingChunks: missing,
        receivedChunks: receivedArray,
        message: `Missing ${missing.length} chunks`
      });
    }

    // ─────────────────────────────────────────────────────────
    // Wait for Pending Chunk Operations
    // ─────────────────────────────────────────────────────────
    const pendingOps = Array.from(chunkLocks.entries())
      .filter(([key]) => key.startsWith(`${uploadId}-`))
      .map(([, promise]) => promise);

    if (pendingOps.length > 0) {
      console.log(`⏳ Waiting for ${pendingOps.length} pending chunk operations...`);
      await Promise.all(pendingOps);
      console.log(`✅ All pending operations completed`);
    }

    // ─────────────────────────────────────────────────────────
    // Generate Unique Filename
    // ─────────────────────────────────────────────────────────
    let finalPath = path.join(UPLOAD_DIR, metadata.filename);
    let finalFilename = metadata.filename;
    let counter = 1;
    const ext = path.extname(metadata.filename);
    const base = path.basename(metadata.filename, ext);

    while (fs.existsSync(finalPath)) {
      finalFilename = `${base}_${counter}${ext}`;
      finalPath = path.join(UPLOAD_DIR, finalFilename);
      counter++;
    }

    if (finalFilename !== metadata.filename) {
      console.log(`⚠️  File exists, using new name: ${finalFilename}`);
    }

    // ─────────────────────────────────────────────────────────
    // Merge Chunks
    // ─────────────────────────────────────────────────────────
    console.log(`🔨 Merging ${metadata.totalChunks} chunks...`);

    const writeStream = fs.createWriteStream(finalPath);
    let totalWritten = 0;

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(TEMP_DIR, `${uploadId}-chunk-${i}`);

      if (!fs.existsSync(chunkPath)) {
        writeStream.close();
        console.error(`❌ Chunk ${i} not found at: ${chunkPath}`);

        return res.status(500).json({
          success: false,
          error: `Chunk ${i} file not found during merge`,
          chunkPath
        });
      }

      try {
        const chunkBuffer = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuffer);
        totalWritten += chunkBuffer.length;

        // Delete chunk after successful write
        fs.unlinkSync(chunkPath);

        // Log progress every 10 chunks or at the end
        if ((i + 1) % 10 === 0 || i === metadata.totalChunks - 1) {
          console.log(`   📝 Merged ${i + 1}/${metadata.totalChunks} chunks`);
        }
      } catch (error) {
        writeStream.close();
        console.error(`❌ Failed to merge chunk ${i}:`, error);

        return res.status(500).json({
          success: false,
          error: `Failed to merge chunk ${i}`,
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Wait for write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    console.log(`✅ All chunks merged successfully`);

    // ─────────────────────────────────────────────────────────
    // Calculate SHA-512 Checksum (No Timeout)
    // ─────────────────────────────────────────────────────────
    console.log(`🔐 Calculating SHA-512 checksum...`);
    const checksumStartTime = Date.now();

    const actualChecksum = await calculateFileChecksum(finalPath);
    const calculationTime = Date.now() - checksumStartTime;

    console.log(`✅ Checksum calculated in ${calculationTime}ms`);
    console.log(`   Expected: ${metadata.expectedChecksum.substring(0, 32)}...`);
    console.log(`   Actual:   ${actualChecksum.substring(0, 32)}...`);

    // ─────────────────────────────────────────────────────────
    // Verify Checksums Match
    // ─────────────────────────────────────────────────────────
    const verified = actualChecksum === metadata.expectedChecksum;
    const finalSize = fs.statSync(finalPath).size;
    const uploadDuration = Date.now() - metadata.createdAt;

    // Prepare checksum metadata
    const checksumMetadata: ChecksumMetadata = {
      uploadId,
      filename: finalFilename,
      originalFilename: metadata.filename,
      fileSize: finalSize,
      expectedChecksum: metadata.expectedChecksum,
      actualChecksum,
      checksumAlgorithm: metadata.checksumAlgorithm,
      verified,
      uploadedAt: new Date(metadata.createdAt).toISOString(),
      verifiedAt: new Date().toISOString(),
      calculationTimeMs: calculationTime,
      uploadDurationMs: uploadDuration,
      clientInfo: {
        chunks: metadata.totalChunks
      }
    };

    // ─────────────────────────────────────────────────────────
    // Handle Checksum Mismatch
    // ─────────────────────────────────────────────────────────
    if (!verified) {
      console.error(`❌ CHECKSUM MISMATCH DETECTED!`);
      console.error(`   Expected: ${metadata.expectedChecksum}`);
      console.error(`   Actual:   ${actualChecksum}`);

      // Handle corrupted file based on configuration
      if (CONFIG.KEEP_CORRUPTED_FILES) {
        const quarantinePath = path.join(
          QUARANTINE_DIR,
          `${path.parse(finalFilename).name}_corrupted_${uploadId}${ext}`
        );
        fs.renameSync(finalPath, quarantinePath);
        checksumMetadata.quarantinePath = quarantinePath;
        console.log(`🚨 Moved corrupted file to quarantine: ${quarantinePath}`);
      } else {
        fs.unlinkSync(finalPath);
        console.log(`🗑️  Deleted corrupted file`);
      }

      checksumMetadata.error = 'Checksum verification failed';
      await saveChecksumMetadata(checksumMetadata);

      // Cleanup session
      uploadSessions.delete(uploadId);

      console.log('═══════════════════════════════════════════════════');

      return res.status(400).json({
        success: false,
        error: 'Checksum verification failed',
        message: 'File integrity check failed. The uploaded file may be corrupted.',
        checksum: {
          algorithm: metadata.checksumAlgorithm,
          expected: metadata.expectedChecksum,
          actual: actualChecksum,
          verified: false
        },
        quarantinePath: CONFIG.KEEP_CORRUPTED_FILES ? checksumMetadata.quarantinePath : undefined,
        details: 'This can happen due to network interruption, storage issues, or memory problems.'
      });
    }

    // ─────────────────────────────────────────────────────────
    // Success - Save Metadata and Respond
    // ─────────────────────────────────────────────────────────
    await saveChecksumMetadata(checksumMetadata);
    uploadSessions.delete(uploadId);

    console.log(`✅ Upload completed successfully!`);
    console.log(`   📄 File: ${finalFilename}`);
    console.log(`   📊 Size: ${formatBytes(finalSize)}`);
    console.log(`   🔐 Checksum: VERIFIED ✓`);
    console.log(`   ⏱️  Total time: ${Math.floor(uploadDuration / 1000)}s`);
    console.log(`   📍 Path: ${finalPath}`);
    console.log('═══════════════════════════════════════════════════');

    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: finalFilename,
      originalFilename: metadata.filename,
      size: finalSize,
      expectedSize: metadata.fileSize,
      sizeMatch: finalSize === metadata.fileSize,
      path: finalPath,
      uploadId,
      checksum: {
        algorithm: metadata.checksumAlgorithm,
        expected: metadata.expectedChecksum,
        actual: actualChecksum,
        verified: true,
        calculationTimeMs: calculationTime
      },
      uploadDurationMs: uploadDuration,
      uploadDurationSeconds: Math.floor(uploadDuration / 1000)
    });
  } catch (error) {
    console.error('❌ Complete upload error:', error);
    console.log('═══════════════════════════════════════════════════');

    res.status(500).json({
      success: false,
      error: 'Failed to complete upload',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET UPLOAD STATUS
 * Check the status of an ongoing upload
 */
app.get('/upload/status/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const metadata = uploadSessions.get(uploadId);

  if (!metadata) {
    return res.status(404).json({
      success: false,
      error: 'Upload session not found',
      uploadId
    });
  }

  const receivedChunksArray = Array.from(metadata.receivedChunks).sort((a, b) => a - b);
  const missingChunks = Array.from({ length: metadata.totalChunks }, (_, i) => i)
    .filter(i => !metadata.receivedChunks.has(i));

  const progress = (metadata.receivedChunks.size / metadata.totalChunks) * 100;
  const isComplete = metadata.receivedChunks.size === metadata.totalChunks;

  res.json({
    success: true,
    uploadId: metadata.uploadId,
    filename: metadata.filename,
    totalChunks: metadata.totalChunks,
    receivedChunks: metadata.receivedChunks.size,
    receivedChunksList: receivedChunksArray,
    missingChunks: missingChunks,
    missingChunksCount: missingChunks.length,
    progress: parseFloat(progress.toFixed(2)),
    isComplete,
    fileSize: metadata.fileSize,
    chunkSize: metadata.chunkSize,
    checksumAlgorithm: metadata.checksumAlgorithm,
    createdAt: new Date(metadata.createdAt).toISOString(),
    lastActivity: new Date(metadata.lastActivity).toISOString(),
    ageSeconds: Math.floor((Date.now() - metadata.createdAt) / 1000),
    idleSeconds: Math.floor((Date.now() - metadata.lastActivity) / 1000)
  });
});

/**
 * CANCEL UPLOAD
 * Cancel upload and cleanup all chunks
 */
app.delete('/upload/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const metadata = uploadSessions.get(uploadId);

  if (!metadata) {
    return res.status(404).json({
      success: false,
      error: 'Upload session not found',
      uploadId
    });
  }

  console.log(`🗑️  Cancelling upload: ${uploadId} (${metadata.filename})`);
  cleanupSession(uploadId, metadata);

  res.json({
    success: true,
    message: 'Upload cancelled successfully',
    uploadId,
    filename: metadata.filename
  });
});

/**
 * HEALTH CHECK
 * Server health and statistics
 */
app.get('/health', (req: Request, res: Response) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    uptimeSeconds,
    activeSessions: uploadSessions.size,
    config: {
      maxChunkSize: `${CONFIG.MAX_CHUNK_SIZE / 1024 / 1024}MB`,
      maxFileSize: `${CONFIG.MAX_FILE_SIZE / 1024 / 1024 / 1024}GB`,
      checksumAlgorithm: 'SHA-512',
      keepCorruptedFiles: CONFIG.KEEP_CORRUPTED_FILES,
      sessionTimeout: `${CONFIG.TEMP_FILE_CLEANUP_TIME / 1000 / 60 / 60}h`
    },
    directories: {
      uploads: UPLOAD_DIR,
      temp: TEMP_DIR,
      quarantine: QUARANTINE_DIR,
      checksums: CHECKSUM_METADATA_DIR
    }
  });
});

/**
 * LIST ACTIVE UPLOADS
 * Get all currently active upload sessions
 */
app.get('/uploads/active', (req: Request, res: Response) => {
  const sessions = Array.from(uploadSessions.values()).map(metadata => {
    const progress = ((metadata.receivedChunks.size / metadata.totalChunks) * 100).toFixed(1);
    const ageMinutes = Math.floor((Date.now() - metadata.createdAt) / 1000 / 60);
    const idleMinutes = Math.floor((Date.now() - metadata.lastActivity) / 1000 / 60);

    return {
      uploadId: metadata.uploadId,
      filename: metadata.filename,
      progress: `${progress}%`,
      chunks: `${metadata.receivedChunks.size}/${metadata.totalChunks}`,
      size: formatBytes(metadata.fileSize),
      checksumAlgorithm: metadata.checksumAlgorithm,
      ageMinutes,
      idleMinutes,
      createdAt: new Date(metadata.createdAt).toISOString(),
      lastActivity: new Date(metadata.lastActivity).toISOString()
    };
  });

  res.json({
    success: true,
    total: sessions.length,
    sessions
  });
});

/**
 * 404 HANDLER
 * Handle undefined routes
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    hint: 'Try GET / for available endpoints'
  });
});

/**
 * ERROR HANDLER
 * Global error handling middleware
 */
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('❌ Server error:', err);

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: err.message || 'Unknown error',
    path: req.path
  });
});

// ══════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 Chunked File Upload Server with SHA-512 Verification');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
  console.log(`📦 Temp directory: ${TEMP_DIR}`);
  console.log(`🚨 Quarantine directory: ${QUARANTINE_DIR}`);
  console.log(`💾 Metadata directory: ${CHECKSUM_METADATA_DIR}`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`⚙️  Max chunk size: ${CONFIG.MAX_CHUNK_SIZE / 1024 / 1024}MB`);
  console.log(`⚙️  Max file size: ${CONFIG.MAX_FILE_SIZE / 1024 / 1024 / 1024}GB`);
  console.log(`🔐 Checksum: SHA-512 (always enabled)`);
  console.log(`🗑️  Keep corrupted files: ${CONFIG.KEEP_CORRUPTED_FILES}`);
  console.log(`⏰ Session timeout: ${CONFIG.TEMP_FILE_CLEANUP_TIME / 1000 / 60 / 60}h`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log('Available endpoints:');
  console.log('  GET    /               - Server information');
  console.log('  POST   /upload/init    - Initialize upload session');
  console.log('  POST   /upload/chunk   - Upload chunk');
  console.log('  POST   /upload/complete - Complete upload & verify');
  console.log('  GET    /upload/status/:uploadId - Get upload status');
  console.log('  DELETE /upload/:uploadId - Cancel upload');
  console.log('  GET    /health         - Health check');
  console.log('  GET    /uploads/active - List active uploads');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\n✅ Server is ready to accept connections\n');
});