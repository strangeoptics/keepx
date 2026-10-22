const fs = require("fs");
const path = require("path");
const util = require("util");
const { LOG_DIR } = require("../config");

const LOG_FILE = path.join(LOG_DIR, "server.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size >= MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (error) {
    // Datei existiert noch nicht
  }
}

function writeLine(level, args) {
  const message = util.format(...args);
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch (error) {
    // Logging darf den Server nie stoppen
  }
}

// Leitet bestehende console-Aufrufe zusaetzlich in die Logdatei
function installConsoleCapture() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  console.log = (...args) => { original.log(...args); writeLine("INFO", args); };
  console.warn = (...args) => { original.warn(...args); writeLine("WARN", args); };
  console.error = (...args) => { original.error(...args); writeLine("ERROR", args); };
}

function requestLogger(req, res, next) {
  if (!req.originalUrl.startsWith("/api/")) {
    return next();
  }
  const start = Date.now();
  res.on("finish", () => {
    const line = `${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - start}ms`;
    if (res.statusCode >= 500) {
      console.error(line);
    } else if (res.statusCode >= 400) {
      console.warn(line);
    } else {
      console.log(line);
    }
  });
  return next();
}

module.exports = { LOG_FILE, installConsoleCapture, requestLogger };
