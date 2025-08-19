const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { circularStringify } = require("../utils/helper");

const getMessages = async (client, channelId, limit = 10, offsetId = 0) => {
  if (!client || !channelId) {
    throw new Error("Client and channelId are required");
  }

  try {
    const result = await client.getMessages(channelId, { limit, offsetId });
    return result;
  } catch (error) {
    throw new Error(`Failed to get messages: ${error.message}`);
  }
};

const getMessageDetail = async (client, channelId, messageIds) => {
  if (!client || !channelId || !messageIds) {
    throw new Error("Client, channelId, and messageIds are required");
  }

  try {
    const result = await client.getMessages(channelId, { ids: messageIds });
    return result;
  } catch (error) {
    throw new Error(`Failed to get message details: ${error.message}`);
  }
};

/**
 * Download message media with progress display
 * @param {Object} client Telegram client
 * @param {Object} message Telegram message
 * @param {string} mediaPath Local file save path
 * @param {number} fileIndex Current file number (1-based)
 * @param {number} totalFiles Total files in this batch
 */
const downloadMessageMedia = async (client, message, mediaPath, fileIndex = 1, totalFiles = 1) => {
  try {
    if (!client || !message || !mediaPath) {
      logger.error("Client, message, and mediaPath are required");
      return false;
    }

    if (message.media) {
      if (message.media.webpage) {
        const url = message.media.webpage.url;
        if (url) {
          const urlPath = path.join(mediaPath, `../${message.id}_url.txt`);
          fs.writeFileSync(urlPath, url);
        }

        mediaPath = path.join(
          mediaPath,
          `../${message?.media?.webpage?.id}_image.jpeg`
        );
      }

      if (message.media.poll) {
        const pollPath = path.join(mediaPath, `../${message.id}_poll.json`);
        fs.writeFileSync(
          pollPath,
          circularStringify(message.media.poll, null, 2)
        );
      }

      const fileName = path.basename(mediaPath);

      await client.downloadMedia(message, {
        outputFile: mediaPath,
        workers: 12, // Increased workers for parallel downloads
        chunkSize: 4 * 1024 * 1024, // Increased chunk size to 4MB
        progressCallback: (downloaded, total) => {
          if (total > 0) {
            const percent = ((downloaded / total) * 100).toFixed(2);
            process.stdout.write(
              `\r[File ${fileIndex}/${totalFiles}] ${fileName}: ${percent}%`
            );
          }
          if (downloaded === total) {
            process.stdout.write(
              `\n✅ Completed: ${fileName} (${fileIndex}/${totalFiles})\n`
            );
          }
        },
      });

      return true;
    } else {
      logger.error("No media found in the message");
      return false;
    }

  } catch (err) {
    logger.error("Error in downloadMessageMedia()");
    console.error(err);
    return false;
  }
};

module.exports = {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
};
