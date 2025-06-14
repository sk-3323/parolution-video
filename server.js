const express = require("express");
const redis = require("redis");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const multer = require("multer");

const app = express();
const PORT = 3000;

app.use(cors({ origin: "*" }));

// Redis client setup
const redisClient = redis.createClient({
  url:
    process.env.REDIS_HOST ||
    "redis://default:vXxAJyFzSxZjQeZqHUcpXUfyvCyBVpbt@shinkansen.proxy.rlwy.net:24455",
});

redisClient.on("error", (err) => {
  console.error("Redis Client Error:", err);
});

redisClient.on("connect", () => {
  console.log("Connected to Redis");
});

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
  }
})();

// Middleware
app.use(express.static(path.join(__dirname, "public"))); // Serve index.html from 'public' folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    console.log(uploadDir, file);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = crypto.randomUUID() + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

// Configure multer for multiple file uploads
const MAX_FILES = 10;
// Configure multer for multiple file uploads
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|avi|mkv|mov|wmv|flv|webm/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit per file
}).array("videos", 10); // Allow up to 10 videos at once
// Upload and cache multiple videos
app.post("/upload", upload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No video files uploaded" });
    }

    const results = [];

    for (const file of req.files) {
      const videoId = crypto.randomUUID();
      const filePath = file.path;
      const fileStats = fs.statSync(filePath);

      const mimeTypeMap = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
        ".wmv": "video/x-ms-wmv",
        ".flv": "video/x-flv",
        ".webm": "video/webm",
      };
      const extension = path.extname(file.originalname).toLowerCase();
      const mimeType = mimeTypeMap[extension] || file.mimetype;

      const metadata = {
        id: videoId,
        originalName: file.originalname,
        filename: file.filename,
        size: fileStats.size,
        uploadTime: new Date().toISOString(),
        mimetype: mimeType,
        path: filePath,
      };

      try {
        // Validate video file
        // await validateVideo(filePath);

        // Cache metadata
        await videoCacheService.cacheVideoMetadata(videoId, metadata);

        // Cache video file in chunks
        const cacheResult = await videoCacheService.cacheVideoFile(
          videoId,
          filePath
        );

        results.push({
          videoId,
          metadata,
          // cached: cacheResult,
        });
      } catch (error) {
        console.error(`Failed to process video ${file.originalname}:`, error);
        results.push({
          videoId,
          metadata,
          error: `Failed to process: ${error.message}`,
        });
      } finally {
        // Clean up file
        // fs.unlinkSync(filePath);
      }
    }

    res.json({
      success: true,
      videos: results,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to process video uploads" });
  }
});
// Video caching service
class VideoCacheService {
  constructor(redisClient) {
    this.redis = redisClient;
    // this.CACHE_EXPIRY = 3600 * 24; // 24 hours
    this.CHUNK_SIZE = 1024 * 1024; // 1MB chunks
  }

  // Generate cache key for video
  generateCacheKey(videoId, chunkIndex = null) {
    return chunkIndex !== null
      ? `video:${videoId}:chunk:${chunkIndex}`
      : `video:${videoId}:metadata`;
  }

  // Cache video metadata
  async cacheVideoMetadata(videoId, metadata) {
    const key = this.generateCacheKey(videoId);
    console.log(key, "call");
    await this.redis.set(key, JSON.stringify(metadata));
  }

  // Get video metadata from cache
  async getVideoMetadata(videoId) {
    const key = this.generateCacheKey(videoId);
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // Cache video file in chunks
  async cacheVideoFile(videoId, filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const totalChunks = Math.ceil(fileBuffer.length / this.CHUNK_SIZE);

    // Cache metadata about chunks
    const chunkMetadata = {
      totalChunks,
      fileSize: fileBuffer.length,
      chunkSize: this.CHUNK_SIZE,
    };

    await this.redis.setEx(
      `video:${videoId}:chunks:metadata`,
      this.CACHE_EXPIRY,
      JSON.stringify(chunkMetadata)
    );

    // Cache each chunk
    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, fileBuffer.length);
      const chunk = fileBuffer.slice(start, end);

      const chunkKey = this.generateCacheKey(videoId, i);
      await this.redis.setEx(chunkKey, this.CACHE_EXPIRY, chunk);
    }

    return { totalChunks, fileSize: fileBuffer.length };
  }

  // Get video chunk from cache
  async getVideoChunk(videoId, chunkIndex) {
    const chunkKey = this.generateCacheKey(videoId, chunkIndex);
    const chunk = await this.redis.get(chunkKey);
    return chunk ? Buffer.from(chunk) : null; // Convert to Buffer if necessary
  }

  // Get all cached video chunks
  async getCachedVideoFile(videoId) {
    const metadataKey = `video:${videoId}:chunks:metadata`;
    const chunkMetadata = await this.redis.get(metadataKey);
    if (!chunkMetadata) {
      console.log(`No chunk metadata found for videoId: ${videoId}`);
      return null;
    }

    const { totalChunks } = JSON.parse(chunkMetadata);
    const chunks = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunk = await this.getVideoChunk(videoId, i);
      if (!chunk) {
        console.log(`Chunk ${i} missing for videoId: ${videoId}`);
        return null; // Cache miss
      }
      chunks.push(chunk);
    }

    const concatenated = Buffer.concat(chunks);
    console.log(
      `Concatenated ${chunks.length} chunks, total size: ${concatenated.length}`
    );
    return concatenated;
  }

  // Check if video is cached
  async isVideoCached(videoId) {
    const metadataExists = await this.redis.exists(
      this.generateCacheKey(videoId)
    );
    const chunksMetadataExists = await this.redis.exists(
      `video:${videoId}:chunks:metadata`
    );
    return metadataExists && chunksMetadataExists;
  }

  // Remove video from cache
  async removeFromCache(videoId) {
    const metadataKey = `video:${videoId}:chunks:metadata`;
    const chunkMetadata = await this.redis.get(metadataKey);

    if (chunkMetadata) {
      const { totalChunks } = JSON.parse(chunkMetadata);

      // Remove all chunks
      for (let i = 0; i < totalChunks; i++) {
        await this.redis.del(this.generateCacheKey(videoId, i));
      }

      // Remove metadata
      await this.redis.del(metadataKey);
    }

    await this.redis.del(this.generateCacheKey(videoId));
  }
}

const videoCacheService = new VideoCacheService(redisClient);

// Routes

// Get video metadata
app.get("/video/:id/metadata", async (req, res) => {
  try {
    const { id } = req.params;
    const metadata = await videoCacheService.getVideoMetadata(id);

    if (!metadata) {
      return res.status(404).json({ error: "Video not found in cache" });
    }

    res.json(metadata);
  } catch (error) {
    console.error("Metadata fetch error:", error);
    res.status(500).json({ error: "Failed to fetch video metadata" });
  }
});

// Stream video from cache
app.get("/video/:id/stream", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if video is cached
    const isCached = await videoCacheService.isVideoCached(id);
    if (!isCached) {
      return res.status(404).json({ error: "Video not found in cache" });
    }

    // Get metadata
    const metadata = await videoCacheService.getVideoMetadata(id);
    if (!metadata) {
      return res.status(404).json({ error: "Video metadata not found" });
    }

    // Get chunk metadata
    const chunkMetadataKey = `video:${id}:chunks:metadata`;
    const chunkMetadata = await redisClient.get(chunkMetadataKey);
    if (!chunkMetadata) {
      return res.status(404).json({ error: "Chunk metadata not found" });
    }
    const { totalChunks, fileSize } = JSON.parse(chunkMetadata);

    // Set headers
    res.set({
      "Content-Type": metadata.mimetype || "video/mp4",
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    });

    // Handle range requests
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      res.status(206);
      res.set({
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": chunksize,
      });

      // Stream only the requested chunks
      const startChunk = Math.floor(start / videoCacheService.CHUNK_SIZE);
      const endChunk = Math.floor(end / videoCacheService.CHUNK_SIZE);

      for (let i = startChunk; i <= endChunk; i++) {
        const chunk = await videoCacheService.getVideoChunk(id, i);
        if (!chunk) {
          return res.status(500).json({ error: `Chunk ${i} not found` });
        }

        const chunkStart = i * videoCacheService.CHUNK_SIZE;
        const chunkEnd = chunkStart + chunk.length - 1;

        // Only send the portion of the chunk within the requested range
        if (chunkEnd >= start && chunkStart <= end) {
          const sliceStart = Math.max(0, start - chunkStart);
          const sliceEnd = Math.min(chunk.length, end - chunkStart + 1);
          res.write(chunk.slice(sliceStart, sliceEnd));
        }
      }
      res.end();
    } else {
      // Stream all chunks for non-range requests
      for (let i = 0; i < totalChunks; i++) {
        const chunk = await videoCacheService.getVideoChunk(id, i);
        if (!chunk) {
          return res.status(500).json({ error: `Chunk ${i} not found` });
        }
        res.write(chunk);
      }
      res.end();
    }
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).json({ error: "Failed to stream video" });
  }
});

// Check cache status
app.get("/video/:id/cache-status", async (req, res) => {
  try {
    const { id } = req.params;
    const isCached = await videoCacheService.isVideoCached(id);

    res.json({
      videoId: id,
      cached: isCached,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Cache status error:", error);
    res.status(500).json({ error: "Failed to check cache status" });
  }
});

// Remove video from cache
app.delete("/video/:id/cache", async (req, res) => {
  try {
    const { id } = req.params;
    await videoCacheService.removeFromCache(id);

    res.json({
      success: true,
      message: "Video removed from cache",
      videoId: id,
    });
  } catch (error) {
    console.error("Cache removal error:", error);
    res.status(500).json({ error: "Failed to remove video from cache" });
  }
});

// Get all cached videos (for debugging)
app.get("/cache/videos", async (req, res) => {
  try {
    const keys = await redisClient.keys("video:*:metadata");
    console.log(keys, "keys");

    const videos = [];

    for (const key of keys) {
      const metadata = await redisClient.get(key);
      if (metadata) {
        videos.push(JSON.parse(metadata));
      }
    }

    const formatted = videos.filter((vid) => Object.keys(vid).length > 4);

    res.json(formatted);
  } catch (error) {
    console.error("Cache list error:", error);
    res.status(500).json({ error: "Failed to list cached videos" });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await redisClient.ping();
    res.json({
      status: "healthy",
      redis: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      redis: "disconnected",
      error: error.message,
    });
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await redisClient.quit();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Video caching server running on port ${PORT}`);
  console.log(`Upload videos: POST /upload`);
  console.log(`Stream video: GET /video/:id/stream`);
  console.log(`Video metadata: GET /video/:id/metadata`);
  console.log(`Cache status: GET /video/:id/cache-status`);
});

module.exports = app;
