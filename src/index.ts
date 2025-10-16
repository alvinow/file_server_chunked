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

// Configuration
const CONFIG = {
  MAX_CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
  CHUNK_TIMEOUT: 30000,
  MAX_RETRY_ATTEMPTS: 3,
  TEMP_FILE_CLEANUP_TIME: 24 * 60 * 60 * 1000, // 24 hours
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024, // 5GB
};

// Enable CORS with proper configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

// Create directories if they don't exist
[UPLOAD_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

// Configure multer for chunk uploads
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
    // Accept all files
    cb(null, true);
  }
});

// Interface for upload metadata
interface UploadMetadata {
  uploadId: string;
  filename: string;
  totalChunks: number;
  fileSize: number;
  receivedChunks: Set<number>;
  createdAt: number;
  lastActivity: number;
  chunkSize?: number;
}

// Store upload sessions (use Redis/Database in production)
const uploadSessions = new Map<string, UploadMetadata>();

// Chunk processing locks to prevent race conditions
const chunkLocks = new Map<string, Promise<void>>();

// Helper: Cleanup session and remove all chunks
function cleanupSession(uploadId: string, metadata: UploadMetadata): void {
  console.log(`🧹 Cleaning up session: ${uploadId}`);
  
  // Delete all chunks for this upload
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
    
    console.log(`🗑️  Deleted ${deletedCount} chunk files`);
  } catch (error) {
    console.error(`Error cleaning up session ${uploadId}:`, error);
  }
  
  // Remove from active sessions
  uploadSessions.delete(uploadId);
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [uploadId, metadata] of uploadSessions.entries()) {
    const age = now - metadata.lastActivity;
    if (age > CONFIG.TEMP_FILE_CLEANUP_TIME) {
      console.log(`⏰ Session ${uploadId} is stale (${Math.floor(age / 1000 / 60)} minutes old)`);
      cleanupSession(uploadId, metadata);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stale sessions`);
  }
}, 60 * 60 * 1000); // Run every hour

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Chunked File Upload Server',
    version: '1.0.0',
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
      tempCleanupTime: `${CONFIG.TEMP_FILE_CLEANUP_TIME / 1000 / 60 / 60}h`
    }
  });
});

// Initialize upload session
app.post('/upload/init', (req: Request, res: Response) => {
  try {
    const { filename, totalChunks, fileSize, chunkSize } = req.body;

    // Validation
    if (!filename || !totalChunks || !fileSize) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['filename', 'totalChunks', 'fileSize'],
        received: { filename, totalChunks, fileSize }
      });
    }

    // Validate types
    const parsedTotalChunks = parseInt(totalChunks);
    const parsedFileSize = parseInt(fileSize);

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
        error: `Chunk size exceeds maximum`,
        maxChunkSize: CONFIG.MAX_CHUNK_SIZE,
        requestedChunkSize: requestedChunkSize,
        recommendedChunkSize: CONFIG.MAX_CHUNK_SIZE
      });
    }

    // Validate file size
    if (parsedFileSize > CONFIG.MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        error: `File size exceeds maximum`,
        maxFileSize: CONFIG.MAX_FILE_SIZE,
        requestedFileSize: parsedFileSize
      });
    }

    // Generate unique upload ID
    const uploadId = crypto.randomBytes(16).toString('hex');

    // Create session
    const metadata: UploadMetadata = {
      uploadId,
      filename,
      totalChunks: parsedTotalChunks,
      fileSize: parsedFileSize,
      receivedChunks: new Set<number>(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      chunkSize: requestedChunkSize
    };

    uploadSessions.set(uploadId, metadata);

    console.log(`✨ Upload initialized: ${uploadId}`);
    console.log(`   📄 File: ${filename}`);
    console.log(`   📦 Chunks: ${parsedTotalChunks}`);
    console.log(`   📊 Size: ${(parsedFileSize / 1024 / 1024).toFixed(2)}MB`);

    res.json({
      success: true,
      uploadId,
      recommendedChunkSize: CONFIG.MAX_CHUNK_SIZE,
      message: 'Upload session initialized',
      session: {
        filename,
        totalChunks: parsedTotalChunks,
        fileSize: parsedFileSize
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

// Upload chunk with concurrent upload support
app.post('/upload/chunk', upload.single('chunk'), async (req: Request, res: Response) => {
  const uploadedFile = req.file;
  
  try {
    const { uploadId, chunkNumber } = req.body;

    // Validation
    if (!uploadId || chunkNumber === undefined || !uploadedFile) {
      // Cleanup uploaded file if exists
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

    // Get session
    const metadata = uploadSessions.get(uploadId);
    if (!metadata) {
      // Cleanup uploaded file
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

    // Validate chunk number
    if (isNaN(chunkNum) || chunkNum < 0 || chunkNum >= metadata.totalChunks) {
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
      
      return res.status(400).json({
        success: false,
        error: 'Invalid chunk number',
        chunkNumber: chunkNumber,
        validRange: `0-${metadata.totalChunks - 1}`,
        totalChunks: metadata.totalChunks
      });
    }

    // Validate chunk size
    if (!uploadedFile.size || uploadedFile.size === 0) {
      if (fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
      
      return res.status(400).json({
        success: false,
        error: 'Chunk file is empty'
      });
    }

    // Update last activity
    metadata.lastActivity = Date.now();

    // Create lock key for this chunk
    const lockKey = `${uploadId}-${chunkNum}`;

    // Wait for any pending operations on this chunk
    if (chunkLocks.has(lockKey)) {
      console.log(`⏳ Waiting for lock on chunk ${chunkNum}...`);
      await chunkLocks.get(lockKey);
    }

    // Process chunk with lock
    const chunkOperation = (async () => {
      try {
        // Check if chunk already received
        if (metadata.receivedChunks.has(chunkNum)) {
          console.log(`⚠️  Chunk ${chunkNum} already received (duplicate), skipping`);
          
          // Delete duplicate
          if (uploadedFile && fs.existsSync(uploadedFile.path)) {
            fs.unlinkSync(uploadedFile.path);
          }
          return;
        }

        // Target path for chunk
        const targetPath = path.join(TEMP_DIR, `${uploadId}-chunk-${chunkNum}`);

        // Check if chunk file already exists (from previous attempt)
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
        
        // Mark as received
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

    // Store lock
    chunkLocks.set(lockKey, chunkOperation);

    // Wait for completion
    await chunkOperation;

    // Remove lock
    chunkLocks.delete(lockKey);

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

// Complete upload by merging chunks
app.post('/upload/complete', async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.body;

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

    console.log(`🔄 Completing upload: ${uploadId}`);

    // Check if all chunks received
    if (metadata.receivedChunks.size !== metadata.totalChunks) {
      const receivedArray = Array.from(metadata.receivedChunks).sort((a, b) => a - b);
      const missing = Array.from({ length: metadata.totalChunks }, (_, i) => i)
        .filter(i => !metadata.receivedChunks.has(i));
      
      console.log(`❌ Not all chunks received for ${uploadId}`);
      console.log(`   Received: ${receivedArray.join(', ')}`);
      console.log(`   Missing: ${missing.join(', ')}`);
      
      return res.status(400).json({
        success: false,
        error: 'Not all chunks uploaded',
        received: metadata.receivedChunks.size,
        total: metadata.totalChunks,
        missingChunks: missing,
        receivedChunks: receivedArray,
        message: `Missing ${missing.length} chunks: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`
      });
    }

    // Wait for any pending chunk operations
    const pendingOps = Array.from(chunkLocks.entries())
      .filter(([key]) => key.startsWith(`${uploadId}-`))
      .map(([, promise]) => promise);

    if (pendingOps.length > 0) {
      console.log(`⏳ Waiting for ${pendingOps.length} pending chunk operations...`);
      await Promise.all(pendingOps);
      console.log(`✅ All pending operations completed`);
    }

    console.log(`🔨 Merging ${metadata.totalChunks} chunks...`);

    // Generate unique filename if file already exists
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

    // Merge chunks sequentially
    const writeStream = fs.createWriteStream(finalPath);
    let totalWritten = 0;
    const missingChunks: number[] = [];

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(TEMP_DIR, `${uploadId}-chunk-${i}`);

      if (!fs.existsSync(chunkPath)) {
        console.error(`❌ Chunk ${i} not found at: ${chunkPath}`);
        missingChunks.push(i);
        continue;
      }

      try {
        const chunkBuffer = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuffer);
        totalWritten += chunkBuffer.length;

        // Delete chunk after successful write
        fs.unlinkSync(chunkPath);
        
        if ((i + 1) % 10 === 0 || i === metadata.totalChunks - 1) {
          console.log(`   📝 Merged ${i + 1}/${metadata.totalChunks} chunks`);
        }
        
      } catch (error) {
        writeStream.close();
        console.error(`❌ Failed to process chunk ${i}:`, error);
        
        return res.status(500).json({
          success: false,
          error: `Failed to merge chunk ${i}`,
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // If any chunks were missing, abort
    if (missingChunks.length > 0) {
      writeStream.close();
      
      return res.status(500).json({
        success: false,
        error: 'Some chunks were missing during merge',
        missingChunks
      });
    }

    // Close write stream and wait for finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    // Verify final file size
    const finalSize = fs.statSync(finalPath).size;
    const sizeDiff = Math.abs(finalSize - metadata.fileSize);
    const sizeMatch = sizeDiff === 0;

    if (!sizeMatch) {
      console.warn(`⚠️  Size mismatch: expected ${metadata.fileSize}, got ${finalSize} (diff: ${sizeDiff} bytes)`);
    }

    // Cleanup session
    uploadSessions.delete(uploadId);

    console.log(`✅ Upload completed successfully!`);
    console.log(`   📄 File: ${finalFilename}`);
    console.log(`   📊 Size: ${(finalSize / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   📍 Path: ${finalPath}`);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: finalFilename,
      originalFilename: metadata.filename,
      size: finalSize,
      expectedSize: metadata.fileSize,
      sizeMatch,
      path: finalPath,
      uploadId
    });
    
  } catch (error) {
    console.error('❌ Complete upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete upload',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get upload status
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
    createdAt: new Date(metadata.createdAt).toISOString(),
    lastActivity: new Date(metadata.lastActivity).toISOString(),
    ageSeconds: Math.floor((Date.now() - metadata.createdAt) / 1000),
    idleSeconds: Math.floor((Date.now() - metadata.lastActivity) / 1000)
  });
});

// Cancel/Delete upload
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

  console.log(`🗑️  Cancelling upload: ${uploadId}`);
  cleanupSession(uploadId, metadata);

  res.json({
    success: true,
    message: 'Upload cancelled successfully',
    uploadId
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const activeSessions = uploadSessions.size;
  const uptimeSeconds = Math.floor(process.uptime());
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
    uptimeSeconds,
    activeSessions,
    config: {
      maxChunkSize: `${CONFIG.MAX_CHUNK_SIZE / 1024 / 1024}MB`,
      maxFileSize: `${CONFIG.MAX_FILE_SIZE / 1024 / 1024 / 1024}GB`
    }
  });
});

// List active uploads (debugging)
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
      size: `${(metadata.fileSize / 1024 / 1024).toFixed(2)}MB`,
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

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    hint: 'Try GET / for available endpoints'
  });
});

// Error handler
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('❌ Server error:', err);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: err.message || 'Unknown error',
    path: req.path
  });
});

// Start server
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('🚀 Chunked File Upload Server');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
  console.log(`📦 Temp directory: ${TEMP_DIR}`);
  console.log(`⚙️  Max chunk size: ${CONFIG.MAX_CHUNK_SIZE / 1024 / 1024}MB`);
  console.log(`⚙️  Max file size: ${CONFIG.MAX_FILE_SIZE / 1024 / 1024 / 1024}GB`);
  console.log(`⚙️  Session timeout: ${CONFIG.TEMP_FILE_CLEANUP_TIME / 1000 / 60 / 60}h`);
  console.log('═══════════════════════════════════════════════════');
  console.log('Available endpoints:');
  console.log('  POST   /upload/init');
  console.log('  POST   /upload/chunk');
  console.log('  POST   /upload/complete');
  console.log('  GET    /upload/status/:uploadId');
  console.log('  DELETE /upload/:uploadId');
  console.log('  GET    /health');
  console.log('  GET    /uploads/active');
  console.log('═══════════════════════════════════════════════════');
});