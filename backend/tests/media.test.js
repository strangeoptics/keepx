const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const axios = require("axios");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepx-media-test-"));
process.env.MEDIA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, "test-importer.db");

const { initDb, closeDb } = require("../db");
const { upgradeImageUrl, downloadMediaFile } = require("../services/media");
const { collectTweetLinks, fetchTweetVideoUrls, importTweets } = require("../services/importer");

test.before(async () => {
  await initDb();
});

test.after(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("upgradeImageUrl rewrites pbs.twimg.com media URLs to name=orig", () => {
  assert.equal(
    upgradeImageUrl("https://pbs.twimg.com/media/Gabc123XYAA?format=jpg&name=small"),
    "https://pbs.twimg.com/media/Gabc123XYAA?format=jpg&name=orig"
  );
  assert.equal(
    upgradeImageUrl("https://pbs.twimg.com/media/Gabc123XYAA.png?name=360x360"),
    "https://pbs.twimg.com/media/Gabc123XYAA.png?name=orig"
  );
  assert.equal(
    upgradeImageUrl("https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/abc.mp4"),
    "https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/abc.mp4"
  );
});

test("downloadMediaFile upgrades image quality and derives extension from format query param", async () => {
  const originalGet = axios.get;
  const requestedUrls = [];
  try {
    axios.get = async (url) => {
      requestedUrls.push(url);
      return {
        headers: { "content-type": "image/jpeg" },
        data: Readable.from([Buffer.from("fake-jpeg-data")])
      };
    };

    const result = await downloadMediaFile(
      "https://pbs.twimg.com/media/Gabc123XYAA?format=jpeg&name=medium",
      "tweet99",
      1
    );

    assert.equal(requestedUrls[0], "https://pbs.twimg.com/media/Gabc123XYAA?format=jpeg&name=orig");
    assert.equal(result.local_path, "tweet99_1.jpg");
    assert.equal(result.media_type, "image");
    assert.equal(fs.existsSync(path.join(tmpDir, "tweet99_1.jpg")), true);
  } finally {
    axios.get = originalGet;
  }
});

test("fetchTweetVideoUrls resolves direct video URLs via fxtwitter", async () => {
  const originalGet = axios.get;
  try {
    axios.get = async (url) => {
      assert.equal(url, "https://api.fxtwitter.com/testuser/status/555");
      return {
        data: {
          tweet: {
            media: {
              videos: [{ url: "https://video.twimg.com/ext_tw_video/555/pu/vid/avc1/720x1280/clip.mp4", type: "video" }],
              photos: [{ url: "https://pbs.twimg.com/media/photo1.jpg", type: "photo" }]
            }
          }
        }
      };
    };

    const urls = await fetchTweetVideoUrls("555", "@testuser");
    assert.deepEqual(urls, ["https://video.twimg.com/ext_tw_video/555/pu/vid/avc1/720x1280/clip.mp4"]);
  } finally {
    axios.get = originalGet;
  }
});

test("collectTweetLinks extracts links from facets, entities, text, and card", () => {
  const links = collectTweetLinks({
    text: "1. Erster Beitrag\nhttps://example.com/eins\n2. Zweiter Beitrag\nhttps://example.org/zwei.",
    raw_text: {
      facets: [
        { type: "url", replacement: "https://example.com/eins", display: "example.com/eins" }
      ]
    },
    card: {
      url: "https://example.com/eins",
      title: "Titel Eins"
    }
  });

  assert.deepEqual(links, [
    {
      url: "https://example.com/eins",
      title: "Titel Eins",
      display_text: "example.com/eins"
    },
    {
      url: "https://example.org/zwei",
      title: "",
      display_text: "https://example.org/zwei"
    }
  ]);
});

test("importTweets marks 404/deleted tweets as non-retryable and 503 as retryable", async () => {
  const originalGet = axios.get;
  try {
    axios.get = async (url) => {
      if (url.endsWith("/status/404")) {
        const err = new Error("Request failed with status code 404");
        err.response = { status: 404 };
        throw err;
      }
      const err = new Error("Request failed with status code 503");
      err.response = { status: 503 };
      throw err;
    };

    const results = await importTweets([
      "https://x.com/user/status/404",
      "https://x.com/user/status/503"
    ]);

    assert.equal(results[0].ok, false);
    assert.equal(results[0].retryable, false);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].retryable, true);
  } finally {
    axios.get = originalGet;
  }
});
