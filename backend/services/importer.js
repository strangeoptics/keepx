const axios = require("axios");
const { getTweetById, saveTweetWithMedia } = require("../db");
const { normalizeLinks } = require("./links");
const { downloadMediaFile } = require("./media");

const TWEET_URL_PATTERN = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,50})\/status\/(\d+)/i;
const MAX_IMPORT_URLS = 50;

function isPermanentHttpStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function collectMediaItems(data) {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (item && item.url && !seen.has(item.url)) {
      seen.add(item.url);
      items.push(item);
    }
  };
  const fromMedia = (media) => {
    if (!media) {
      return;
    }
    (Array.isArray(media.all) ? media.all : []).forEach(add);
    (Array.isArray(media.photos) ? media.photos : []).forEach((item) => add({ ...item, type: "photo" }));
    (Array.isArray(media.videos) ? media.videos : []).forEach((item) => add({ ...item, type: "video" }));
  };
  fromMedia(data.media);
  // Bilder von Artikeln und zitierten Tweets liegen ausserhalb von media
  const cover = data.article?.cover_media?.media_info?.original_img_url;
  if (cover) {
    add({ url: cover, type: "photo" });
  }
  if (items.length === 0) {
    fromMedia(data.quote?.media);
  }
  // Link-Vorschaubild, wenn der Tweet sonst keine Medien hat
  if (items.length === 0 && data.card?.image?.url) {
    add({ url: data.card.image.url, type: "photo" });
  }
  return items;
}

function collectTweetLinks(data) {
  const rawLinks = [];
  const cardUrl = data.card?.url ? String(data.card.url).trim() : "";
  const cardTitle = data.card?.title ? String(data.card.title).trim() : "";

  if (Array.isArray(data.raw_text?.facets)) {
    for (const facet of data.raw_text.facets) {
      const url = facet?.replacement || facet?.original;
      if (facet?.type === "url" && url) {
        rawLinks.push({
          url,
          title: url === cardUrl ? cardTitle : "",
          display_text: facet.display || url
        });
      }
    }
  }

  if (Array.isArray(data.entities?.urls)) {
    for (const entity of data.entities.urls) {
      const url = entity?.expanded_url || entity?.url;
      if (url) {
        rawLinks.push({
          url,
          title: entity.title || (url === cardUrl ? cardTitle : ""),
          display_text: entity.display_url || url
        });
      }
    }
  }

  const text = String(data.text || "");
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0].replace(/[),.;!?\]}]+$/, "");
    if (url) {
      rawLinks.push({
        url,
        title: url === cardUrl ? cardTitle : "",
        display_text: url
      });
    }
  }

  if (cardUrl) {
    rawLinks.push({
      url: cardUrl,
      title: cardTitle,
      display_text: data.card?.display_url || cardUrl
    });
  }

  return normalizeLinks(rawLinks);
}

async function fetchTweetVideoUrls(tweetId, authorHandle = "i") {
  const handle = String(authorHandle || "i").replace(/^@/, "").trim() || "i";
  const response = await axios.get(
    `https://api.fxtwitter.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(tweetId)}`,
    {
      timeout: 15000,
      headers: { "User-Agent": "KeepX" }
    }
  );
  const data = response.data && response.data.tweet;
  if (!data) {
    return [];
  }

  return collectMediaItems(data)
    .filter((item) => item && item.url && (item.type === "video" || item.type === "gif"))
    .map((item) => item.url);
}

async function importTweetFromUrl(rawUrl) {
  const match = TWEET_URL_PATTERN.exec(rawUrl);
  if (!match) {
    const error = new Error("Kein gueltiger Tweet-Link");
    error.retryable = false;
    throw error;
  }
  const [, handle, tweetId] = match;

  if (await getTweetById(tweetId)) {
    return { tweet_id: tweetId, skipped: true };
  }

  // fxtwitter liefert Tweet-Daten ohne Login, daher funktioniert der Import ausserhalb von x.com.
  let response;
  try {
    response = await axios.get(`https://api.fxtwitter.com/${handle}/status/${tweetId}`, {
      timeout: 15000,
      headers: { "User-Agent": "KeepX" }
    });
  } catch (error) {
    if (isPermanentHttpStatus(error.response?.status)) {
      error.retryable = false;
    }
    throw error;
  }

  const data = response.data && response.data.tweet;
  if (!data) {
    const apiCode = Number(response.data?.code);
    const error = new Error("Tweet nicht gefunden");
    if (!Number.isInteger(apiCode) || isPermanentHttpStatus(apiCode)) {
      error.retryable = false;
    }
    throw error;
  }

  const createdAt = data.created_timestamp ? new Date(data.created_timestamp * 1000).toISOString() : null;
  const tweet = {
    id: String(data.id || tweetId),
    url: data.url || `https://x.com/${handle}/status/${tweetId}`,
    text: data.text || "",
    author_name: data.author?.name || "",
    author_handle: data.author?.screen_name || handle,
    created_at: createdAt,
    links: collectTweetLinks(data),
    saved_at: new Date().toISOString()
  };

  const mediaItems = collectMediaItems(data);
  const mediaRows = [];
  for (const item of mediaItems) {
    if (!item || !item.url) {
      continue;
    }
    try {
      const record = await downloadMediaFile(item.url, tweet.id, mediaRows.length + 1);
      if (item.type === "video" || item.type === "gif") {
        record.media_type = "video";
      }
      mediaRows.push(record);
    } catch (error) {
      console.warn(`Media download failed for ${item.url}: ${error.message}`);
    }
  }

  await saveTweetWithMedia(tweet, mediaRows);
  return { tweet_id: tweet.id, media_saved: mediaRows.length };
}

async function importTweets(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const result = await importTweetFromUrl(url);
      results.push({ url, ok: true, ...result });
      console.log(`Import ${url}: ${result.skipped ? "uebersprungen (schon vorhanden)" : `ok, ${result.media_saved} Medien`}`);
    } catch (error) {
      console.error(`Import ${url} fehlgeschlagen: ${error.message}`);
      results.push({
        url,
        ok: false,
        error: error.message,
        retryable: error.retryable !== false
      });
    }
  }
  return results;
}

module.exports = {
  MAX_IMPORT_URLS,
  collectTweetLinks,
  fetchTweetVideoUrls,
  importTweets
};
