const express = require("express");
const { MAX_IMPORT_URLS, importTweets } = require("../services/importer");

const router = express.Router();

router.post("/", async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const unique = [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];

  if (!unique.length) {
    return res.status(400).json({ error: "Keine Links angegeben" });
  }
  if (unique.length > MAX_IMPORT_URLS) {
    return res.status(400).json({ error: `Maximal ${MAX_IMPORT_URLS} Links pro Import` });
  }

  return res.json({ results: await importTweets(unique) });
});

module.exports = router;
