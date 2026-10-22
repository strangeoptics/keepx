const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepx-db-test-"));
const mediaDir = path.join(tmpDir, "media");
fs.mkdirSync(mediaDir, { recursive: true });

process.env.DB_PATH = path.join(tmpDir, "test-tweets.db");
process.env.MEDIA_DIR = mediaDir;

const {
  initDb,
  closeDb,
  saveTweetWithMedia,
  getTweets,
  addTagToTweet,
  removeTagFromTweet,
  updateTweetNotes,
  getAllTags,
  deleteTweet,
  getTelegramLastUpdateId,
  saveTelegramLastUpdateId,
  exportDatabaseJsonl,
  importDatabaseJsonl
} = require("../db");

test.before(async () => {
  await initDb();
});

test.after(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("saveTweetWithMedia serializes concurrent transactions without collision", async () => {
  const saves = Array.from({ length: 8 }, (_, index) => {
    const id = `parallel-${index + 1}`;
    return saveTweetWithMedia(
      {
        id,
        url: `https://x.com/user/status/${id}`,
        text: `Paralleler Tweet Nummer ${index + 1}`,
        author_name: `Autor ${index + 1}`,
        author_handle: `user_${index + 1}`,
        created_at: "2026-10-22T10:00:00.000Z",
        links: [{ url: `https://example.com/${id}`, title: "Link", display_text: "example.com" }],
        saved_at: "2026-10-22T10:00:00.000Z"
      },
      []
    );
  });

  await Promise.all(saves);
  const { tweets } = await getTweets({ q: "Paralleler Tweet", limit: 20 });
  assert.equal(tweets.length, 8);
});

test("saveTweetWithMedia removes orphaned media files when overwriting a tweet", async () => {
  const file1 = path.join(mediaDir, "media-test_1.jpg");
  const file2 = path.join(mediaDir, "media-test_2.jpg");
  const file3 = path.join(mediaDir, "media-test_1.mp4");
  fs.writeFileSync(file1, "img1");
  fs.writeFileSync(file2, "img2");

  const baseTweet = {
    id: "media-test",
    url: "https://x.com/user/status/media-test",
    text: "Tweet mit Medien",
    author_name: "Media User",
    author_handle: "mediauser",
    created_at: "2026-10-22T11:00:00.000Z",
    links: [],
    saved_at: "2026-10-22T11:00:00.000Z"
  };

  await saveTweetWithMedia(baseTweet, [
    { original_url: "https://pbs.twimg.com/media/1.jpg", local_path: "media-test_1.jpg", media_type: "image" },
    { original_url: "https://pbs.twimg.com/media/2.jpg", local_path: "media-test_2.jpg", media_type: "image" }
  ]);

  assert.equal(fs.existsSync(file1), true);
  assert.equal(fs.existsSync(file2), true);

  fs.writeFileSync(file3, "vid1");
  await saveTweetWithMedia(baseTweet, [
    { original_url: "https://video.twimg.com/media/1.mp4", local_path: "media-test_1.mp4", media_type: "video" }
  ]);

  assert.equal(fs.existsSync(file1), false);
  assert.equal(fs.existsSync(file2), false);
  assert.equal(fs.existsSync(file3), true);
});

test("getTweets searches across text, author_name, author_handle, and notes", async () => {
  await saveTweetWithMedia(
    {
      id: "search-1",
      url: "https://x.com/ handle /status/search-1",
      text: "Ein Beitrag ueber Quantenmechanik",
      author_name: "Marie Curie",
      author_handle: "radium_lab",
      created_at: "2026-10-22T12:00:00.000Z",
      links: [],
      saved_at: "2026-10-22T12:00:00.000Z"
    },
    []
  );

  await updateTweetNotes("search-1", "Wichtige Recherche zu NobelpreisXZ");

  const byText = await getTweets({ q: "Quantenmechanik" });
  assert.equal(byText.tweets.some((t) => t.id === "search-1"), true);

  const byAuthorName = await getTweets({ q: "Curie" });
  assert.equal(byAuthorName.tweets.some((t) => t.id === "search-1"), true);

  const byHandle = await getTweets({ q: "radium_lab" });
  assert.equal(byHandle.tweets.some((t) => t.id === "search-1"), true);

  const byNotes = await getTweets({ q: "NobelpreisXZ" });
  assert.equal(byNotes.tweets.some((t) => t.id === "search-1"), true);

  const byShortTermInNotes = await getTweets({ q: "XZ" });
  assert.equal(byShortTermInNotes.tweets.some((t) => t.id === "search-1"), true);

  const byCombinedFields = await getTweets({ q: "Curie NobelpreisXZ" });
  assert.equal(byCombinedFields.tweets.some((t) => t.id === "search-1"), true);
});

test("orphaned tags are cleaned up when removing tags or deleting tweets", async () => {
  await saveTweetWithMedia(
    {
      id: "tag-test-1",
      url: "https://x.com/u/status/tag-test-1",
      text: "Tag Test 1",
      author_name: "User",
      author_handle: "user",
      created_at: "2026-10-22T13:00:00.000Z",
      links: [],
      saved_at: "2026-10-22T13:00:00.000Z"
    },
    []
  );
  await saveTweetWithMedia(
    {
      id: "tag-test-2",
      url: "https://x.com/u/status/tag-test-2",
      text: "Tag Test 2",
      author_name: "User",
      author_handle: "user",
      created_at: "2026-10-22T13:01:00.000Z",
      links: [],
      saved_at: "2026-10-22T13:01:00.000Z"
    },
    []
  );

  await addTagToTweet("tag-test-1", "Politik");
  await addTagToTweet("tag-test-1", "Exklusiv1");
  await addTagToTweet("tag-test-2", "Politik");
  await addTagToTweet("tag-test-2", "Exklusiv2");

  await removeTagFromTweet("tag-test-1", "Exklusiv1");
  let allTags = (await getAllTags()).map((t) => t.name);
  assert.equal(allTags.includes("exklusiv1"), false);
  assert.equal(allTags.includes("politik"), true);

  await deleteTweet("tag-test-2");
  allTags = (await getAllTags()).map((t) => t.name);
  assert.equal(allTags.includes("exklusiv2"), false);
  assert.equal(allTags.includes("politik"), true);

  await deleteTweet("tag-test-1");
  allTags = (await getAllTags()).map((t) => t.name);
  assert.equal(allTags.includes("politik"), false);
});

test("exportDatabaseJsonl and importDatabaseJsonl roundtrip data and skip existing tweets", async () => {
  await saveTweetWithMedia(
    {
      id: "backup-1",
      url: "https://x.com/u/status/backup-1",
      text: "Backup Tweet Eins mit Spezialbegriff77",
      author_name: "Ada Lovelace",
      author_handle: "ada",
      created_at: "2026-10-22T14:00:00.000Z",
      links: [{ url: "https://example.org/ada", title: "Ada", display_text: "example.org/ada" }],
      saved_at: "2026-10-22T14:00:00.000Z"
    },
    [{ original_url: "https://pbs.twimg.com/media/ada.jpg", local_path: "backup-1_1.jpg", media_type: "image" }]
  );
  await updateTweetNotes("backup-1", "Notiz vor Export");
  await addTagToTweet("backup-1", "Informatik");
  await saveTelegramLastUpdateId(9001);

  const exportedJsonl = await exportDatabaseJsonl();
  const lines = exportedJsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "meta");
  assert.equal(lines.some((item) => item.type === "telegram_state" && item.key === "last_update_id" && item.value === "9001"), true);

  const exportedTweet = lines.find((item) => item.type === "tweet" && item.id === "backup-1");
  assert.ok(exportedTweet);
  assert.equal(exportedTweet.notes, "Notiz vor Export");
  assert.deepEqual(exportedTweet.tags, ["informatik"]);
  assert.equal(exportedTweet.links.length, 1);
  assert.equal(exportedTweet.media.length, 1);
  assert.equal(exportedTweet.media[0].local_path, "backup-1_1.jpg");

  // Tweet 1 wird lokal geaendert, um zu pruefen, dass der Import vorhandene Tweets ueberspringt.
  await updateTweetNotes("backup-1", "Geaenderte lokale Notiz");

  const importPayload = [
    JSON.stringify({ type: "meta", version: 1 }),
    JSON.stringify({ type: "telegram_state", key: "last_update_id", value: "9005" }),
    JSON.stringify({
      ...exportedTweet,
      notes: "Alte Notiz aus Backup"
    }),
    JSON.stringify({
      type: "tweet",
      id: "backup-2",
      url: "https://x.com/u/status/backup-2",
      text: "Neuer importierter Tweet mit Suchwort88",
      notes: "Importierte Notiz 2",
      author_name: "Alan Turing",
      author_handle: "turing",
      created_at: "2026-10-22T15:00:00.000Z",
      saved_at: "2026-10-22T15:00:00.000Z",
      tags: ["Kryptographie", "informatik"],
      links: [{ url: "https://example.org/enigma", title: "Enigma", display_text: "example.org/enigma" }],
      media: [{ original_url: "https://video.twimg.com/turing.mp4", local_path: "backup-2_1.mp4", media_type: "video" }]
    })
  ].join("\n");

  const result = await importDatabaseJsonl(importPayload);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.telegram_state_restored, 1);
  assert.equal(await getTelegramLastUpdateId(), 9005);

  const checkExisting = await getTweets({ q: "Spezialbegriff77" });
  const existingTweet = checkExisting.tweets.find((t) => t.id === "backup-1");
  assert.equal(existingTweet.notes, "Geaenderte lokale Notiz");

  const checkImported = await getTweets({ q: "Suchwort88" });
  const importedTweet = checkImported.tweets.find((t) => t.id === "backup-2");
  assert.ok(importedTweet);
  assert.equal(importedTweet.notes, "Importierte Notiz 2");
  assert.deepEqual(importedTweet.tags.map((t) => t.name), ["informatik", "kryptographie"]);
  assert.equal(importedTweet.links.length, 1);
  assert.equal(importedTweet.links[0].url, "https://example.org/enigma");
  assert.equal(importedTweet.media.length, 1);
  assert.equal(importedTweet.media[0].local_path, "backup-2_1.mp4");

  await assert.rejects(
    () => importDatabaseJsonl("{ungueltiges json"),
    /Ungueltiges JSON in Zeile 1/
  );
});


