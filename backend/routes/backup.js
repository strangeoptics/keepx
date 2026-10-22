const express = require("express");
const { streamDatabaseJsonl, importDatabaseJsonl } = require("../db");

const router = express.Router();

async function handleExport(_req, res) {
  const dateStamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="keepx-backup-${dateStamp}.jsonl"`);

  try {
    await streamDatabaseJsonl((line) => {
      res.write(`${line}\n`);
    });
    res.end();
  } catch (error) {
    console.error(`Datenbank-Export fehlgeschlagen: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Datenbank-Export fehlgeschlagen", details: error.message });
    } else {
      res.end();
    }
  }
}

async function handleImport(req, res) {
  const jsonl = typeof req.body === "string" ? req.body : req.body?.jsonl;
  if (typeof jsonl !== "string" || !jsonl.trim()) {
    return res.status(400).json({ error: "Keine JSONL-Daten angegeben" });
  }

  try {
    const result = await importDatabaseJsonl(jsonl);
    console.log(
      `Datenbank-Import abgeschlossen (${result.imported} importiert, ${result.skipped} uebersprungen)`
    );
    return res.json({ ok: true, ...result });
  } catch (error) {
    const isValidationError =
      error.message.startsWith("Ungueltig") ||
      error.message.startsWith("Fehlende") ||
      error.message.startsWith("Unbekannter");
    if (isValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`Datenbank-Import fehlgeschlagen: ${error.message}`);
    return res.status(500).json({ error: "Datenbank-Import fehlgeschlagen", details: error.message });
  }
}

router.get("/", handleExport);
router.get("/export", handleExport);
router.post("/", express.text({ type: ["application/x-ndjson", "text/plain"], limit: "100mb" }), handleImport);
router.post("/import", express.text({ type: ["application/x-ndjson", "text/plain"], limit: "100mb" }), handleImport);

module.exports = router;

