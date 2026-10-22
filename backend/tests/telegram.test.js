const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");
const {
  createTelegramApi,
  createTelegramPoller,
  extractTweetUrls,
  processTelegramUpdate
} = require("../services/telegram");

test("extractTweetUrls accepts tweet URLs in text, captions, and entities only", () => {
  const textUrl = "https://twitter.com/first/status/123";
  const captionUrl = "https://mobile.x.com/second/status/456";
  const hiddenUrl = "https://x.com/third/status/789";
  const caption = `🎥 ${captionUrl}`;

  assert.deepEqual(extractTweetUrls({
    text: `New post: ${textUrl}. https://example.com/status/999 https://notx.com/first/status/7 https://example.com/?next=https://x.com/fourth/status/8`,
    entities: [{ type: "url", offset: 10, length: textUrl.length }],
    caption,
    caption_entities: [
      { type: "url", offset: 3, length: captionUrl.length },
      { type: "text_link", offset: 0, length: 5, url: hiddenUrl },
      { type: "text_link", offset: 0, length: 5, url: "ftp://x.com/user/status/999" }
    ]
  }), [
    "https://x.com/first/status/123",
    "https://x.com/second/status/456",
    "https://x.com/third/status/789"
  ]);
});

test("processTelegramUpdate ignores other channels and channel posts without tweet links", async () => {
  let imports = 0;
  const options = {
    channelId: "-100123",
    importTweets: async () => {
      imports += 1;
      return [];
    }
  };

  await processTelegramUpdate({
    channel_post: { chat: { id: "-100999" }, text: "https://x.com/user/status/1" }
  }, options);
  await processTelegramUpdate({
    channel_post: { chat: { id: "-100123" }, text: "No tweet here" }
  }, options);
  assert.equal(imports, 0);
});

test("processTelegramUpdate retries instead of reporting success when an import fails", async () => {
  await assert.rejects(processTelegramUpdate({
    channel_post: {
      chat: { id: "-100123" },
      text: "https://x.com/user/status/1"
    }
  }, {
    channelId: "-100123",
    importTweets: async () => [{ ok: false, error: "temporary failure" }]
  }), /Could not import 1 tweet link/);
});

test("poller retries failed requests and imports before advancing the persisted offset", async () => {
  let requestCount = 0;
  let importCount = 0;
  const offsets = [];
  const warnings = [];
  let poller;
  let resolveSaved;
  const saved = new Promise((resolve) => {
    resolveSaved = resolve;
  });
  const pollPost = {
    update_id: 40,
    channel_post: { chat: { id: "-100123" }, text: "https://x.com/user/status/40" }
  };
  poller = createTelegramPoller({
    token: "test-token",
    channelId: "-100123",
    getLastUpdateId: async () => null,
    saveLastUpdateId: async (updateId) => {
      assert.equal(updateId, 40);
      resolveSaved();
    },
    importTweets: async () => {
      importCount += 1;
      return [{ ok: importCount > 1 }];
    },
    api: {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (offset) => {
        offsets.push(offset);
        requestCount += 1;
        if (requestCount === 1) {
          throw new Error("Telegram API request failed (network error)");
        }
        return [pollPost];
      }
    },
    logger: { warn: (message) => warnings.push(message) },
    retryDelayMs: 1
  });

  await poller.start();
  await saved;
  await poller.stop();
  assert.equal(requestCount, 3);
  assert.equal(importCount, 2);
  assert.deepEqual(offsets, [undefined, undefined, undefined]);
  assert.equal(warnings.length, 2);
});

test("poller refuses to start while a webhook is configured", async () => {
  let pollingStarted = false;
  const poller = createTelegramPoller({
    token: "test-token",
    channelId: "-100123",
    getLastUpdateId: async () => null,
    saveLastUpdateId: async () => {},
    importTweets: async () => [],
    api: {
      getWebhookInfo: async () => ({ url: "https://example.com/webhook" }),
      getUpdates: async () => {
        pollingStarted = true;
        return [];
      }
    }
  });

  await assert.rejects(poller.start(), /webhook is configured/);
  assert.equal(pollingStarted, false);
});

test("poller retries the startup check after a network error", async () => {
  let checks = 0;
  const warnings = [];
  let resolvePolled;
  const polled = new Promise((resolve) => { resolvePolled = resolve; });
  const poller = createTelegramPoller({
    token: "test-token",
    channelId: "-100123",
    getLastUpdateId: async () => null,
    saveLastUpdateId: async () => {},
    importTweets: async () => [],
    api: {
      getWebhookInfo: async () => {
        checks += 1;
        if (checks === 1) throw new Error("Telegram API request failed (network error)");
        return { url: "" };
      },
      getUpdates: async () => {
        resolvePolled();
        return [];
      }
    },
    logger: { warn: (message) => warnings.push(message) },
    retryDelayMs: 1
  });

  await poller.start();
  await polled;
  await poller.stop();
  assert.equal(checks, 2);
  assert.equal(warnings.length, 1);
});

test("Telegram API errors do not reveal the bot token", async () => {
  const originalGet = axios.get;
  const token = "secret-test-token";
  try {
    axios.get = async () => ({
      data: { ok: false, error_code: 409, description: `Rejected ${token}` }
    });
    const api = createTelegramApi(token);
    await assert.rejects(api.getWebhookInfo(), (error) => {
      assert.match(error.message, /error 409/);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  } finally {
    axios.get = originalGet;
  }
});

test("processTelegramUpdate skips permanent failures without blocking the queue", async () => {
  const warnings = [];
  const results = await processTelegramUpdate({
    channel_post: {
      chat: { id: "-100123" },
      text: "https://x.com/user/status/1 https://x.com/user/status/2"
    }
  }, {
    channelId: "-100123",
    importTweets: async () => [
      { url: "https://x.com/user/status/1", ok: false, error: "Tweet nicht gefunden", retryable: false },
      { url: "https://x.com/user/status/2", ok: true, tweet_id: "2", media_saved: 0 }
    ],
    logger: { warn: (msg) => warnings.push(msg) }
  });

  assert.equal(results.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipped permanent failure/);
});
