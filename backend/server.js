const fs = require("fs");
const { LOG_FILE, installConsoleCapture, requestLogger } = require("./services/logger");

installConsoleCapture();

const express = require("express");
const cors = require("cors");
const { PORT, MEDIA_DIR, FRONTEND_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID } = require("./config");
const { initDb, getTelegramLastUpdateId, saveTelegramLastUpdateId } = require("./db");
const tweetsRouter = require("./routes/tweets");
const importRouter = require("./routes/import");
const backupRouter = require("./routes/backup");
const { importTweets } = require("./services/importer");
const { createTelegramPoller } = require("./services/telegram");

const app = express();
const telegramPoller = TELEGRAM_BOT_TOKEN && TELEGRAM_CHANNEL_ID
  ? createTelegramPoller({
    token: TELEGRAM_BOT_TOKEN,
    channelId: TELEGRAM_CHANNEL_ID,
    importTweets,
    getLastUpdateId: getTelegramLastUpdateId,
    saveLastUpdateId: saveTelegramLastUpdateId
  })
  : null;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: "100mb" }));
app.use("/media", express.static(MEDIA_DIR));
app.use("/", express.static(FRONTEND_DIR));
app.use("/api/tweets", tweetsRouter);
app.use("/api/import", importRouter);
app.use("/api/backup", backupRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "keepx", timestamp: new Date().toISOString() });
});

async function startServer() {
  await initDb();
  const server = app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
    console.log(`Serving media from ${MEDIA_DIR}`);
    console.log(`Logging to ${LOG_FILE}`);
  });

  if (telegramPoller) {
    telegramPoller.start().catch((error) => {
      console.error(`Telegram integration could not start: ${error.message}`);
    });
  } else if (TELEGRAM_BOT_TOKEN || TELEGRAM_CHANNEL_ID) {
    console.warn("Telegram integration is disabled: set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID");
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) {
      process.exit(0);
    }
    shuttingDown = true;
    // Notbremse, falls Polling oder offene Verbindungen das Beenden blockieren.
    setTimeout(() => process.exit(0), 3000).unref();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    await telegramPoller?.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch((error) => {
  console.error("Failed to initialize database", error);
  process.exit(1);
});
