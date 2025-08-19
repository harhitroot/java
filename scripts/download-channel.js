"use strict";
const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
} = require("../modules/messages");
const {
  getMediaType,
  getMediaPath,
  checkFileExist,
  appendToJSONArrayFile,
  wait,
} = require("../utils/helper");
const {
  updateLastSelection,
  getLastSelection,
} = require("../utils/file-helper");
const logger = require("../utils/logger");
const { getDialogName, getAllDialogs } = require("../modules/dialoges");
const {
  downloadOptionInput,
  selectInput,
} = require("../utils/input-helper");

// SAFETY IMPROVEMENTS: Reduced parallel downloads and message limits
const MAX_PARALLEL_DOWNLOAD = 12;
const MESSAGE_LIMIT = 8192;
const RATE_LIMIT_DELAY = 1000; // 5 seconds between batches
const DOWNLOAD_DELAY = 500; // 2 seconds between downloads
const MAX_RETRIES = 3;
const BACKOFF_BASE = 1000;

/**
 * Handles downloading media from a Telegram channel with rate limiting
 */
class DownloadChannel {
  constructor() {
    this.outputFolder = null;
    this.downloadableFiles = null;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.rateLimitHit = false;
    this.totalDownloaded = 0;
    this.totalMessages = 0;
    this.totalMediaMessages = 0;
    this.skippedFiles = 0;

    const exportPath = path.resolve(process.cwd(), "./export");
    if (!fs.existsSync(exportPath)) {
      fs.mkdirSync(exportPath);
    }
  }

  static description() {
    return "Download all media from a channel (Rate Limited & Safe)";
  }

  /**
   * SAFETY: Add rate limiting with exponential backoff
   */
  async checkRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    // If we've made too many requests recently, wait longer
    if (this.requestCount > 10 && timeSinceLastRequest < 60000) {
      logger.info("Rate limit protection: Waiting 60 seconds...");
      await this.wait(60000);
      this.requestCount = 0;
    }
    
    this.lastRequestTime = now;
    this.requestCount++;
  }

  /**
   * SAFETY: Enhanced wait function with random delays
   */
  async wait(ms) {
    const randomDelay = Math.random() * 1000; // Add 0-1 second random delay
    const totalDelay = ms + randomDelay;
    logger.info(`Waiting ${Math.round(totalDelay / 1000)} seconds...`);
    await new Promise(resolve => setTimeout(resolve, totalDelay));
  }

  /**
   * SAFETY: Retry mechanism with exponential backoff
   */
  async retryWithBackoff(fn, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.checkRateLimit();
        return await fn();
      } catch (error) {
        logger.warn(`Attempt ${i + 1} failed: ${error.message}`);
        
        if (i === retries - 1) throw error;
        
        const backoffDelay = BACKOFF_BASE * Math.pow(2, i);
        logger.info(`Backing off for ${backoffDelay}ms before retry...`);
        await this.wait(backoffDelay);
      }
    }
  }

  /**
   * Checks if a message contains media
   */
  hasMedia(message) {
    return Boolean(message.media);
  }

  /**
   * Determines if a message's media should be downloaded
   */
  canDownload(message) {
    if (!this.hasMedia(message)) return false;
    const mediaType = getMediaType(message);
    const mediaPath = getMediaPath(message, this.outputFolder);
    const fileExists = checkFileExist(message, this.outputFolder);
    const extension = path.extname(mediaPath).toLowerCase().replace(".", "");
    const allowed =
      this.downloadableFiles?.[mediaType] ||
      this.downloadableFiles?.[extension] ||
      this.downloadableFiles?.all;

    return allowed && !fileExists;
  }

  /**
   * Records messages to a JSON file
   */
  recordMessages(messages) {
    const filePath = path.join(this.outputFolder, "all_message.json");
    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
    }

    const data = messages.map((msg) => ({
      id: msg.id,
      message: msg.message,
      date: msg.date,
      out: msg.out,
      hasMedia: !!msg.media,
      sender: msg.fromId?.userId || msg.peerId?.userId,
      mediaType: this.hasMedia(msg) ? getMediaType(msg) : undefined,
      mediaPath: this.hasMedia(msg)
        ? getMediaPath(msg, this.outputFolder)
        : undefined,
      mediaName: this.hasMedia(msg)
        ? path.basename(getMediaPath(msg, this.outputFolder))
        : undefined,
    }));
    appendToJSONArrayFile(filePath, data);
  }

  /**
   * PROGRESS: Count total messages and media for progress tracking
   */
  async countTotalMessages(client, channelId) {
    try {
      logger.info("Counting total messages for progress tracking...");
      let totalCount = 0;
      let mediaCount = 0;
      let offsetId = 0;
      
      while (true) {
        const messages = await this.retryWithBackoff(async () => {
          return await getMessages(client, channelId, 100, offsetId);
        });
        
        if (!messages.length) break;
        
        for (const msg of messages) {
          totalCount++;
          if (this.hasMedia(msg)) mediaCount++;
        }
        
        offsetId = messages[messages.length - 1].id;
        logger.info(`Counted ${totalCount} messages, ${mediaCount} with media...`);
        
        // Safety delay for counting
        await this.wait(1000);
      }
      
      this.totalMessages = totalCount;
      this.totalMediaMessages = mediaCount;
      logger.info(`Total messages: ${totalCount}, Messages with media: ${mediaCount}`);
      
    } catch (err) {
      logger.warn("Could not count total messages:", err.message);
      this.totalMessages = 0;
      this.totalMediaMessages = 0;
    }
  }

  /**
   * PROGRESS: Show detailed progress information
   */
  showProgress(currentBatchDownloaded, currentBatchSkipped) {
    const totalProcessed = this.totalDownloaded + this.skippedFiles;
    const progressPercentage = this.totalMediaMessages > 0 
      ? Math.round((totalProcessed / this.totalMediaMessages) * 100) 
      : 0;
    
    const remainingMedia = Math.max(0, this.totalMediaMessages - totalProcessed);
    
    logger.info("=".repeat(60));
    logger.info("📊 DOWNLOAD PROGRESS REPORT");
    logger.info("=".repeat(60));
    logger.info(`✅ Total Downloaded: ${this.totalDownloaded} files`);
    logger.info(`⏭️  Total Skipped: ${this.skippedFiles} files`);
    logger.info(`📈 Progress: ${progressPercentage}% (${totalProcessed}/${this.totalMediaMessages})`);
    logger.info(`⏳ Remaining: ${remainingMedia} media files`);
    logger.info(`📦 This batch: ${currentBatchDownloaded} downloaded, ${currentBatchSkipped} skipped`);
    logger.info("=".repeat(60));
  }

  /**
   * SAFETY: Enhanced download with progress tracking
   */
  async downloadChannel(client, channelId, offsetMsgId = 0) {
    try {
      this.outputFolder = path.join(
        process.cwd(),
        "export",
        channelId.toString()
      );

      // PROGRESS: Count total messages on first run
      if (offsetMsgId === 0) {
        await this.countTotalMessages(client, channelId);
      }

      // SAFETY: Get messages with rate limiting
      const messages = await this.retryWithBackoff(async () => {
        return await getMessages(client, channelId, MESSAGE_LIMIT, offsetMsgId);
      });

      if (!messages.length) {
        logger.info("🎉 Download completed! No more messages to process.");
        this.showProgress(0, 0);
        return;
      }

      const ids = messages.map((m) => m.id);
      
      // SAFETY: Get message details with rate limiting
      const details = await this.retryWithBackoff(async () => {
        return await getMessageDetail(client, channelId, ids);
      });

      const downloadQueue = [];
      let currentBatchDownloaded = 0;
      let currentBatchSkipped = 0;

      for (const msg of details) {
        if (this.canDownload(msg)) {
          logger.info(`📥 Queuing download for message ${msg.id} (${currentBatchDownloaded + 1}/${details.filter(m => this.canDownload(m)).length} in batch)`);
          
          // SAFETY: Add individual download delays
          const downloadPromise = this.retryWithBackoff(async () => {
            await this.wait(DOWNLOAD_DELAY);
            const result = await downloadMessageMedia(
              client,
              msg,
              getMediaPath(msg, this.outputFolder)
            );
            this.totalDownloaded++;
            currentBatchDownloaded++;
            logger.info(`✅ Downloaded: ${getMediaPath(msg, this.outputFolder)} | Total: ${this.totalDownloaded}`);
            return result;
          });
          
          downloadQueue.push(downloadPromise);
        } else if (this.hasMedia(msg)) {
          // Count skipped media files
          this.skippedFiles++;
          currentBatchSkipped++;
          logger.info(`⏭️  Skipped message ${msg.id} (already exists or filtered out)`);
        }

        // SAFETY: Process downloads in smaller batches with longer delays
        if (downloadQueue.length >= MAX_PARALLEL_DOWNLOAD) {
          logger.info(`🔄 Processing ${MAX_PARALLEL_DOWNLOAD} downloads safely...`);
          await Promise.all(downloadQueue);
          downloadQueue.length = 0;
          
          // SAFETY: Longer delay between batches
          await this.wait(RATE_LIMIT_DELAY);
        }
      }

      // Process remaining downloads
      if (downloadQueue.length > 0) {
        logger.info(`🔄 Processing final ${downloadQueue.length} downloads...`);
        await Promise.all(downloadQueue);
      }

      this.recordMessages(details);
      updateLastSelection({
        messageOffsetId: messages[messages.length - 1].id,
      });

      // PROGRESS: Show detailed progress
      this.showProgress(currentBatchDownloaded, currentBatchSkipped);

      // SAFETY: Longer delay before next batch
      await this.wait(RATE_LIMIT_DELAY);
      
      await this.downloadChannel(
        client,
        channelId,
        messages[messages.length - 1].id
      );
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
      
      // SAFETY: If rate limited, wait longer before retrying
      if (err.message && err.message.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(err.message.match(/\d+/)?.[0] || "300") * 1000;
        logger.info(`⚠️  Rate limited! Waiting ${waitTime / 1000} seconds...`);
        await this.wait(waitTime);
        
        // Retry the current batch
        return await this.downloadChannel(client, channelId, offsetMsgId);
      }
      
      throw err;
    }
  }

  async configureDownload(options, client) {
    let channelId = options.channelId;
    let downloadableFiles = options.downloadableFiles;
    
    if (!channelId) {
      logger.info("Please select a channel to download media from");
      const allChannels = await getAllDialogs(client);
      const options = allChannels.map((d) => ({
        name: d.name,
        value: d.id,
      }));

      const selectedChannel = await selectInput(
        "Please select a channel",
        options
      );
      channelId = selectedChannel;
    }
    
    if (!downloadableFiles) downloadableFiles = await downloadOptionInput();

    this.downloadableFiles = downloadableFiles;

    const lastSelection = getLastSelection();
    let messageOffsetId = lastSelection.messageOffsetId || 0;

    if (Number(lastSelection.channelId) !== Number(channelId)) {
      messageOffsetId = 0;
    }
    
    updateLastSelection({ messageOffsetId, channelId });
    return { channelId, messageOffsetId };
  }

  /**
   * SAFETY: Enhanced main handler with better error handling
   */
  async handle(options = {}) {
    let client;
    
    try {
      // SAFETY: Initial delay before starting
      await this.wait(1000);
      
      client = await initAuth();
      const { channelId, messageOffsetId } = await this.configureDownload(
        options,
        client
      );

      const dialogName = await getDialogName(client, channelId);
      logger.info(`Starting SAFE download from channel: ${dialogName}`);
      logger.info(`Safety settings: Max parallel: ${MAX_PARALLEL_DOWNLOAD}, Message limit: ${MESSAGE_LIMIT}`);
      
      await this.downloadChannel(client, channelId, messageOffsetId);
      
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
      
      // SAFETY: Wait before retrying or exiting
      await this.wait(30000);
      
    } finally {
      if (client) {
        try {
          await client.disconnect();
        } catch (disconnectErr) {
          logger.warn("Error disconnecting client:", disconnectErr.message);
        }
      }
      process.exit(0);
    }
  }
}

module.exports = DownloadChannel;