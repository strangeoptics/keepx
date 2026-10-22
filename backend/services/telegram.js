const axios = require("axios");

const TWEET_LINK_PATTERN =
  /(?<![A-Za-z0-9_@./?&=+-])(?:https?:\/\/|www\.)[^\s<>"']+|(?<![A-Za-z0-9_@./?&=+-])(?:mobile\.)?(?:x|twitter)\.com\/[^\s<>"']+/gi;
const TWEET_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d+)\/?$/;
const POLL_TIMEOUT_SECONDS = 25;
const REQUEST_TIMEOUT_MS = 35000;
const RETRY_DELAY_MS = 5000;

function normalizeTweetUrl(value) {
  const candidate = String(value || "").trim().replace(/[),.;!?]+$/, "");
  if (!candidate) {
    return null;
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch (_error) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(host)) {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }

  const match = TWEET_PATH_PATTERN.exec(parsed.pathname);
  return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
}

function extractTweetUrls(post) {
  const candidates = [];
  for (const [text, entities] of [
    [post?.text || "", post?.entities || []],
    [post?.caption || "", post?.caption_entities || []]
  ]) {
    candidates.push(text);
    for (const entity of entities) {
      if (entity.type === "text_link" && entity.url) {
        candidates.push(entity.url);
      } else if (entity.type === "url" && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
        candidates.push(text.slice(entity.offset, entity.offset + entity.length));
      }
    }
  }

  const urls = new Set();
  for (const candidate of candidates) {
    TWEET_LINK_PATTERN.lastIndex = 0;
    for (const match of String(candidate).matchAll(TWEET_LINK_PATTERN)) {
      const url = normalizeTweetUrl(match[0]);
      if (url) {
        urls.add(url);
      }
    }
    const directUrl = normalizeTweetUrl(candidate);
    if (directUrl) {
      urls.add(directUrl);
    }
  }
  return [...urls];
}

function matchesChannel(chat, channelId) {
  const expected = String(channelId).trim();
  if (expected.startsWith("@")) {
    return String(chat?.username || "").toLowerCase() === expected.slice(1).toLowerCase();
  }
  return String(chat?.id ?? "") === expected;
}

async function processTelegramUpdate(update, { channelId, importTweets, logger = console }) {
  const post = update.channel_post;
  if (!post || !matchesChannel(post.chat, channelId)) {
    return [];
  }

  const urls = extractTweetUrls(post);
  if (!urls.length) {
    return [];
  }

  const results = await importTweets(urls);
  const permanentFailures = results.filter((result) => !result.ok && result.retryable === false);
  for (const failure of permanentFailures) {
    logger.warn(`Telegram import skipped permanent failure for ${failure.url || "tweet"}: ${failure.error || "unknown error"}`);
  }

  const retryableFailures = results.filter((result) => !result.ok && result.retryable !== false);
  if (retryableFailures.length) {
    throw new Error(`Could not import ${retryableFailures.length} tweet link(s) from Telegram update`);
  }
  return results;
}

function createTelegramApi(token) {
  const baseUrl = `https://api.telegram.org/bot${token}`;

  async function call(method, params = {}, signal) {
    let response;
    try {
      response = await axios.get(`${baseUrl}/${method}`, {
        params,
        timeout: REQUEST_TIMEOUT_MS,
        signal
      });
    } catch (error) {
      const status = error.response?.status;
      throw new Error(status
        ? `Telegram API request failed (HTTP ${status})`
        : "Telegram API request failed (network error)");
    }

    if (!response.data?.ok) {
      const code = Number(response.data?.error_code);
      throw new Error(Number.isInteger(code)
        ? `Telegram API rejected the request (error ${code})`
        : "Telegram API returned an invalid response");
    }
    return response.data.result;
  }

  return {
    getWebhookInfo: (signal) => call("getWebhookInfo", {}, signal),
    getUpdates: (offset, signal) => call("getUpdates", {
      offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: JSON.stringify(["channel_post"])
    }, signal)
  };
}

function createTelegramPoller({
  token,
  channelId,
  importTweets,
  getLastUpdateId,
  saveLastUpdateId,
  api = createTelegramApi(token),
  logger = console,
  retryDelayMs = RETRY_DELAY_MS
}) {
  let running = false;
  let loopPromise = null;
  let controller = null;

  async function pollLoop() {
    while (running) {
      controller = new AbortController();
      try {
        const lastUpdateId = await getLastUpdateId();
        const updates = await api.getUpdates(lastUpdateId === null ? undefined : lastUpdateId + 1, controller.signal);
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id)) {
            throw new Error("Telegram update has no valid update_id");
          }
          await processTelegramUpdate(update, { channelId, importTweets, logger });
          await saveLastUpdateId(update.update_id);
        }
      } catch (error) {
        if (running) {
          logger.warn(`Telegram polling failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      } finally {
        controller = null;
      }
    }
  }

  return {
    async start() {
      if (running) {
        return;
      }
      running = true;
      const webhookError = new Error("Telegram webhook is configured; remove it before using polling");
      // Beim Systemstart ist das Netzwerk oft noch nicht bereit: Pruefung wiederholen statt aufgeben.
      while (running) {
        controller = new AbortController();
        try {
          const webhook = await api.getWebhookInfo(controller.signal);
          if (webhook?.url) {
            running = false;
            throw webhookError;
          }
          break;
        } catch (error) {
          if (error === webhookError) {
            throw error;
          }
          if (!running) {
            return;
          }
          logger.warn(`Telegram startup check failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } finally {
          controller = null;
        }
      }
      if (running) {
        loopPromise = pollLoop();
      }
    },
    async stop() {
      running = false;
      controller?.abort();
      if (loopPromise) {
        await loopPromise;
        loopPromise = null;
      }
    }
  };
}

module.exports = {
  createTelegramApi,
  createTelegramPoller,
  extractTweetUrls,
  processTelegramUpdate
};
