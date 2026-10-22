const path = require("path");

module.exports = {
  PORT: process.env.PORT || 3000,
  DB_PATH: process.env.DB_PATH || path.join(__dirname, "tweets.db"),
  MEDIA_DIR: process.env.MEDIA_DIR || path.join(__dirname, "storage", "media"),
  FRONTEND_DIR: path.join(__dirname, "..", "frontend"),
  LOG_DIR: path.join(__dirname, "logs"),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || ""
};
