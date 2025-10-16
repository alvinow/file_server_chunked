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

// Enable CORS
app.use(cors());
app.use(express.json());

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory to store uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

// Create directories if they don't exist
[UPLOAD_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
    cb(null, `${uploadId}-chunk-${chunkNumber}`);
  }
});

const upload = multer({ storage });

// Interface for upload metadata
interface UploadMetadata {
  uploadId: string;
  filename: string;
  totalChunks: number;
  fileSize: number;
  receivedChunks: number[];
}

// Store upload metadata in memory (use Redis/DB for production)
const uploadSessions = new Map<string, UploadMetadata>();

// Initialize upload session
app.post('/upload/init', (req: Request, res: Response) => {
  try {
    const { filename, totalChunks, fileSize } = req.body;

    if (!filename || !totalChunks || !fileSize) {
      return res.status(400).json({
        error: 'Missing required fields: filename, totalChunks, fileSize'
      });
    }

    const uploadId = crypto.randomBytes(16).toString('hex');

    uploadSessions.set(uploadId, {
      uploadId,
      filename,
      totalChunks: parseInt(totalChunks),
      fileSize: parseInt(fileSize),
      receivedChunks: []
    });

    res.json({
      uploadId,
      message: 'Upload session initialized'
    });
  } catch (error) {
    console.error('Init error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

// Upload chunk
app.post('/upload/chunk', upload.single('chunk'), (req: Request, res: Response) => {
  try {
    const { uploadId, chunkNumber } = req.body;
    const file = req.file;

    if (!uploadId || chunkNumber === undefined || !file) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId, chunkNumber, chunk file'
      });
    }

    const metadata = uploadSessions.get(uploadId);
    if (!metadata) {
      // Clean up uploaded chunk
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const chunkNum = parseInt(chunkNumber);
    
    // Validate chunk number
    if (chunkNum < 0 || chunkNum >= metadata.totalChunks) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid chunk number' });
    }

    // Mark chunk as received
    if (!metadata.receivedChunks.includes(chunkNum)) {
      metadata.receivedChunks.push(chunkNum);
      metadata.receivedChunks.sort((a, b) => a - b);
    }

    res.json({
      message: 'Chunk uploaded successfully',
      chunkNumber: chunkNum,
      receivedChunks: metadata.receivedChunks.length,
      totalChunks: metadata.totalChunks,
      isComplete: metadata.receivedChunks.length === metadata.totalChunks
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

// Complete upload by merging chunks
app.post('/upload/complete', async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'Missing uploadId' });
    }

    const metadata = uploadSessions.get(uploadId);
    if (!metadata) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // Check if all chunks are received
    if (metadata.receivedChunks.length !== metadata.totalChunks) {
      return res.status(400).json({
        error: 'Not all chunks uploaded',
        received: metadata.receivedChunks.length,
        total: metadata.totalChunks,
        missing: Array.from({ length: metadata.totalChunks }, (_, i) => i)
          .filter(i => !metadata.receivedChunks.includes(i))
      });
    }

    // Merge chunks
    const finalPath = path.join(UPLOAD_DIR, metadata.filename);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(TEMP_DIR, `${uploadId}-chunk-${i}`);
      
      if (!fs.existsSync(chunkPath)) {
        writeStream.close();
        return res.status(400).json({ error: `Chunk ${i} not found` });
      }

      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
      
      // Delete chunk after writing
      fs.unlinkSync(chunkPath);
    }

    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Clean up session
    uploadSessions.delete(uploadId);

    res.json({
      message: 'File uploaded successfully',
      filename: metadata.filename,
      size: metadata.fileSize,
      path: finalPath
    });
  } catch (error) {
    console.error('Complete upload error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

// Get upload status
app.get('/upload/status/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const metadata = uploadSessions.get(uploadId);

  if (!metadata) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  res.json({
    uploadId: metadata.uploadId,
    filename: metadata.filename,
    totalChunks: metadata.totalChunks,
    receivedChunks: metadata.receivedChunks.length,
    progress: (metadata.receivedChunks.length / metadata.totalChunks) * 100,
    isComplete: metadata.receivedChunks.length === metadata.totalChunks,
    missingChunks: Array.from({ length: metadata.totalChunks }, (_, i) => i)
      .filter(i => !metadata.receivedChunks.includes(i))
  });
});

// Cancel upload
app.delete('/upload/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const metadata = uploadSessions.get(uploadId);

  if (!metadata) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  // Delete all chunks
  for (let i = 0; i < metadata.totalChunks; i++) {
    const chunkPath = path.join(TEMP_DIR, `${uploadId}-chunk-${i}`);
    if (fs.existsSync(chunkPath)) {
      fs.unlinkSync(chunkPath);
    }
  }

  uploadSessions.delete(uploadId);

  res.json({ message: 'Upload cancelled successfully' });
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Chunked upload server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ${UPLOAD_DIR}`);
  console.log(`Temp directory: ${TEMP_DIR}`);
});