const express = require("express");
const {
  saveTweetWithMedia,
  getTweets,
  addTagToTweet,
  removeTagFromTweet,
  getTweetById,
  updateTweetNotes,
  getTweetMediaPaths,
  getAllTags,
  deleteTweet
} = require("../db");
const { collectMedia, removeMediaFiles } = require("../services/media");
const { fetchTweetVideoUrls } = require("../services/importer");

const router = express.Router();

router.post("/", async (req, res) => {
  const payload = req.body || {};
  const tweetId = String(payload.id || "").trim();

  if (!tweetId) {
    return res.status(400).json({ error: "Tweet id is required" });
  }

  const tweet = {
    id: tweetId,
    url: payload.url || "",
    text: payload.text || "",
    author_name: payload.author_name || "",
    author_handle: payload.author_handle || "",
    created_at: payload.created_at || null,
    links: Array.isArray(payload.links) ? payload.links : [],
    saved_at: new Date().toISOString()
  };

  const mediaUrls = Array.isArray(payload.media_urls) ? payload.media_urls : [];
  const mediaAssets = Array.isArray(payload.media_assets) ? [...payload.media_assets] : [];

  if (payload.has_video && !mediaAssets.some((asset) => asset && (asset.data_base64 || asset.data || asset.url))) {
    try {
      const videoUrls = await fetchTweetVideoUrls(tweetId, tweet.author_handle);
      for (const videoUrl of videoUrls) {
        mediaAssets.push({ media_type: "video", url: videoUrl });
      }
    } catch (error) {
      console.warn(`Video resolution via fxtwitter failed for tweet ${tweetId}: ${error.message}`);
    }
  }

  const mediaRows = await collectMedia(tweetId, mediaUrls, mediaAssets);
  const videoSaved = mediaRows.filter((row) => row.media_type === "video").length;

  try {
    await saveTweetWithMedia(tweet, mediaRows);
    console.log(`Tweet ${tweetId} gespeichert (${mediaRows.length} Medien)`);
    return res.status(201).json({
      ok: true,
      tweet_id: tweetId,
      media_saved: mediaRows.length,
      video_saved: videoSaved
    });
  } catch (error) {
    console.error(`Speichern von Tweet ${tweetId} fehlgeschlagen: ${error.message}`);
    return res.status(500).json({ error: "Failed to save tweet", details: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 500);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const untagged = req.query.untagged === "1";
    const { tweets, nextCursor } = await getTweets({ q: req.query.q, tag: req.query.tag, untagged, limit, cursor });
    // Tags werden nur mit der ersten Seite geliefert.
    const tags = cursor ? undefined : await getAllTags();
    return res.json({ tweets, next_cursor: nextCursor, tags });
  } catch (error) {
    console.error(`Laden der Tweets fehlgeschlagen: ${error.message}`);
    return res.status(500).json({ error: "Failed to fetch tweets", details: error.message });
  }
});

router.post("/:id/tags", async (req, res) => {
  const tweetId = req.params.id;
  const tagName = req.body?.tag;

  if (!(await getTweetById(tweetId))) {
    return res.status(404).json({ error: "Tweet not found" });
  }

  try {
    const tag = await addTagToTweet(tweetId, tagName);
    return res.status(201).json({ ok: true, tag });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.delete("/:id/tags/:tag", async (req, res) => {
  const tweetId = req.params.id;
  const tagName = decodeURIComponent(req.params.tag || "");

  if (!(await getTweetById(tweetId))) {
    return res.status(404).json({ error: "Tweet not found" });
  }

  try {
    const removed = await removeTagFromTweet(tweetId, tagName);
    const tags = await getAllTags();
    return res.json({ ok: true, removed, tags });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.put("/:id/notes", async (req, res) => {
  const tweetId = req.params.id;
  const notes = req.body?.notes;

  if (typeof notes !== "string") {
    return res.status(400).json({ error: "Notes must be a string" });
  }

  try {
    if (!(await getTweetById(tweetId))) {
      return res.status(404).json({ error: "Tweet not found" });
    }

    await updateTweetNotes(tweetId, notes);
    return res.json({ ok: true, notes });
  } catch (error) {
    return res.status(500).json({ error: "Failed to save tweet notes", details: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  const tweetId = req.params.id;

  if (!(await getTweetById(tweetId))) {
    return res.status(404).json({ error: "Tweet not found" });
  }

  try {
    await removeMediaFiles(await getTweetMediaPaths(tweetId));
    await deleteTweet(tweetId);
    const tags = await getAllTags();
    console.log(`Tweet ${tweetId} geloescht`);
    return res.json({ ok: true, deleted: tweetId, tags });
  } catch (error) {
    console.error(`Loeschen von Tweet ${tweetId} fehlgeschlagen: ${error.message}`);
    return res.status(500).json({ error: "Failed to delete tweet", details: error.message });
  }
});

module.exports = router;
