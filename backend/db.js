const sqlite3 = require("sqlite3").verbose();
const { DB_PATH } = require("./config");
const { normalizeLinks } = require("./services/links");
const { removeMediaFiles } = require("./services/media");

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

let writeQueue = Promise.resolve();

function withTransaction(work) {
  const next = writeQueue.then(async () => {
    await run("BEGIN TRANSACTION");
    try {
      const result = await work();
      await run("COMMIT");
      return result;
    } catch (error) {
      await run("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  writeQueue = next.catch(() => {});
  return next;
}

function deleteOrphanedTags() {
  return run("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM tweet_tags tt WHERE tt.tag_id = tags.id)");
}

// Tags nur mit Kleinbuchstaben: vorhandene Varianten (z.B. "Islam" und "islam") werden zusammengefuehrt.
async function lowercaseExistingTags() {
  const tags = await all("SELECT id, name FROM tags ORDER BY id ASC");
  if (!tags.some((tag) => tag.name !== tag.name.toLowerCase())) {
    return;
  }

  const keepers = new Map();
  for (const tag of tags) {
    const lower = tag.name.toLowerCase();
    const current = keepers.get(lower);
    if (!current || (tag.name === lower && current.name !== lower)) {
      keepers.set(lower, tag);
    }
  }

  await withTransaction(async () => {
    for (const tag of tags) {
      const lower = tag.name.toLowerCase();
      const keeper = keepers.get(lower);
      if (keeper.id !== tag.id) {
        await run("INSERT OR IGNORE INTO tweet_tags (tweet_id, tag_id) SELECT tweet_id, ? FROM tweet_tags WHERE tag_id = ?", [keeper.id, tag.id]);
        await run("DELETE FROM tags WHERE id = ?", [tag.id]);
      }
    }
    for (const [lower, keeper] of keepers) {
      if (keeper.name !== lower) {
        await run("UPDATE tags SET name = ? WHERE id = ?", [lower, keeper.id]);
      }
    }
  });
}

async function initDb() {
  await exec("PRAGMA foreign_keys = ON;");
  await exec("PRAGMA journal_mode = WAL;");

  await exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      url TEXT,
      text TEXT,
      notes TEXT,
      author_name TEXT,
      author_handle TEXT,
      created_at DATETIME,
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL,
      original_url TEXT,
      local_path TEXT,
      media_type TEXT,
      FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tweet_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      display_text TEXT,
      FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tweet_tags (
      tweet_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (tweet_id, tag_id),
      FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS telegram_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_tweet_id ON media (tweet_id);
    CREATE INDEX IF NOT EXISTS idx_tweet_links_tweet_id ON tweet_links (tweet_id);
    CREATE INDEX IF NOT EXISTS idx_tweet_tags_tag_id ON tweet_tags (tag_id);
    CREATE INDEX IF NOT EXISTS idx_tweets_sort ON tweets (datetime(COALESCE(created_at, saved_at)) DESC, id DESC);
  `);

  const tweetColumns = await all("PRAGMA table_info(tweets)");
  if (!tweetColumns.some((column) => column.name === "notes")) {
    await exec("ALTER TABLE tweets ADD COLUMN notes TEXT");
  }

  await lowercaseExistingTags();
  await deleteOrphanedTags();

  const fts = await get("SELECT sql FROM sqlite_master WHERE name = 'tweets_fts'");
  const ftsCurrent = Boolean(
    fts &&
    fts.sql.includes("trigram") &&
    fts.sql.includes("notes") &&
    fts.sql.includes("author_name") &&
    fts.sql.includes("author_handle")
  );

  // Aeltere Index-Varianten werden verworfen und neu aufgebaut.
  if (!ftsCurrent) {
    await exec(`
      DROP TRIGGER IF EXISTS tweets_fts_ai;
      DROP TRIGGER IF EXISTS tweets_fts_ad;
      DROP TRIGGER IF EXISTS tweets_fts_au;
      DROP TABLE IF EXISTS tweets_fts;
    `);
  }

  await exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5(
      text, notes, author_name, author_handle,
      content='tweets', content_rowid='rowid', tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS tweets_fts_ai AFTER INSERT ON tweets BEGIN
      INSERT INTO tweets_fts(rowid, text, notes, author_name, author_handle)
      VALUES (new.rowid, new.text, new.notes, new.author_name, new.author_handle);
    END;

    CREATE TRIGGER IF NOT EXISTS tweets_fts_ad AFTER DELETE ON tweets BEGIN
      INSERT INTO tweets_fts(tweets_fts, rowid, text, notes, author_name, author_handle)
      VALUES ('delete', old.rowid, old.text, old.notes, old.author_name, old.author_handle);
    END;

    CREATE TRIGGER IF NOT EXISTS tweets_fts_au AFTER UPDATE OF text, notes, author_name, author_handle ON tweets BEGIN
      INSERT INTO tweets_fts(tweets_fts, rowid, text, notes, author_name, author_handle)
      VALUES ('delete', old.rowid, old.text, old.notes, old.author_name, old.author_handle);
      INSERT INTO tweets_fts(rowid, text, notes, author_name, author_handle)
      VALUES (new.rowid, new.text, new.notes, new.author_name, new.author_handle);
    END;
  `);

  // Bestehende Tweets einmalig in den neuen Index uebernehmen.
  if (!ftsCurrent) {
    await exec("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')");
  }
}

async function saveTweetWithMedia(tweet, mediaEntries) {
  const links = normalizeLinks(tweet.links);
  const previousMedia = await withTransaction(async () => {
    const existingMedia = await all("SELECT local_path FROM media WHERE tweet_id = ?", [tweet.id]);

    await run(
      `
      INSERT INTO tweets (id, url, text, author_name, author_handle, created_at, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        text = excluded.text,
        author_name = excluded.author_name,
        author_handle = excluded.author_handle,
        created_at = excluded.created_at
    `,
      [tweet.id, tweet.url, tweet.text, tweet.author_name, tweet.author_handle, tweet.created_at, tweet.saved_at]
    );

    await run("DELETE FROM media WHERE tweet_id = ?", [tweet.id]);
    await run("DELETE FROM tweet_links WHERE tweet_id = ?", [tweet.id]);
    for (const row of mediaEntries) {
      await run(
        "INSERT INTO media (tweet_id, original_url, local_path, media_type) VALUES (?, ?, ?, ?)",
        [tweet.id, row.original_url, row.local_path, row.media_type]
      );
    }

    for (const link of links) {
      await run(
        "INSERT INTO tweet_links (tweet_id, url, title, display_text) VALUES (?, ?, ?, ?)",
        [tweet.id, link.url, link.title || null, link.display_text || null]
      );
    }

    return existingMedia;
  });

  const currentPaths = new Set(mediaEntries.map((row) => row.local_path).filter(Boolean));
  const obsoleteMedia = previousMedia.filter((row) => row.local_path && !currentPaths.has(row.local_path));
  if (obsoleteMedia.length) {
    await removeMediaFiles(obsoleteMedia);
  }
}

// Der Trigram-Index braucht mindestens 3 Zeichen; kuerzere Begriffe werden per LIKE gesucht.
function addSearchConditions(q, conditions, params) {
  const terms = String(q || "").split(/\s+/).filter(Boolean);
  const longTerms = terms.filter((term) => [...term].length >= 3);
  const shortTerms = terms.filter((term) => [...term].length < 3);

  if (longTerms.length) {
    conditions.push("tw.rowid IN (SELECT rowid FROM tweets_fts WHERE tweets_fts MATCH ?)");
    params.push(longTerms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" "));
  }

  for (const term of shortTerms) {
    conditions.push(
      "(tw.text LIKE ? ESCAPE '\\' OR tw.notes LIKE ? ESCAPE '\\' OR tw.author_name LIKE ? ESCAPE '\\' OR tw.author_handle LIKE ? ESCAPE '\\')"
    );
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
}

// Muss dem Ausdruck in idx_tweets_sort entsprechen, damit der Index genutzt wird.
const SORT_KEY_SQL = "datetime(COALESCE(tw.created_at, tw.saved_at))";

function groupByTweetId(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.tweet_id)) {
      groups.set(row.tweet_id, []);
    }
    groups.get(row.tweet_id).push(row);
  }
  return groups;
}

async function getTweets({ q, tag, untagged = false, limit = 30, cursor = null }) {
  const conditions = [];
  const params = [];

  addSearchConditions(q, conditions, params);

  if (untagged) {
    conditions.push("NOT EXISTS (SELECT 1 FROM tweet_tags tt WHERE tt.tweet_id = tw.id)");
  } else if (tag && tag.trim()) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM tweet_tags tt
      JOIN tags tg ON tg.id = tt.tag_id
      WHERE tt.tweet_id = tw.id
      AND LOWER(tg.name) = LOWER(?)
    )`);
    params.push(tag.trim());
  }

  if (typeof cursor === "string" && cursor.indexOf("|") > 0) {
    const separator = cursor.indexOf("|");
    const cursorKey = cursor.slice(0, separator);
    const cursorId = cursor.slice(separator + 1);
    conditions.push(`(${SORT_KEY_SQL} < ? OR (${SORT_KEY_SQL} = ? AND tw.id < ?))`);
    params.push(cursorKey, cursorKey, cursorId);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Eine Zeile mehr holen, um zu erkennen, ob es eine weitere Seite gibt.
  const rows = await all(
    `
    SELECT tw.*, ${SORT_KEY_SQL} AS sort_key
    FROM tweets tw
    ${whereClause}
    ORDER BY ${SORT_KEY_SQL} DESC, tw.id DESC
    LIMIT ?
  `,
    [...params, limit + 1]
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  if (!pageRows.length) {
    return { tweets: [], nextCursor: null };
  }

  const ids = pageRows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const [mediaRows, linkRows, tagRows] = await Promise.all([
    all(`SELECT * FROM media WHERE tweet_id IN (${placeholders}) ORDER BY id ASC`, ids),
    all(
      `SELECT id, tweet_id, url, title, display_text FROM tweet_links WHERE tweet_id IN (${placeholders}) ORDER BY id ASC`,
      ids
    ),
    all(
      `
      SELECT tt.tweet_id, t.id, t.name
      FROM tags t
      JOIN tweet_tags tt ON tt.tag_id = t.id
      WHERE tt.tweet_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE ASC
    `,
      ids
    )
  ]);

  const mediaByTweet = groupByTweetId(mediaRows);
  const linksByTweet = groupByTweetId(linkRows);
  const tagsByTweet = groupByTweetId(tagRows);

  const tweets = pageRows.map(({ sort_key: _sortKey, ...tweet }) => ({
    ...tweet,
    media: mediaByTweet.get(tweet.id) || [],
    links: linksByTweet.get(tweet.id) || [],
    tags: tagsByTweet.get(tweet.id) || []
  }));

  const last = pageRows[pageRows.length - 1];
  return { tweets, nextCursor: hasMore ? `${last.sort_key}|${last.id}` : null };
}

async function addTagToTweet(tweetId, rawTagName) {
  const tagName = (rawTagName || "").trim().toLowerCase();
  if (!tagName) {
    throw new Error("Tag name is required");
  }

  await run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [tagName]);
  const tag = await get("SELECT id, name FROM tags WHERE name = ?", [tagName]);
  if (!tag) {
    throw new Error("Unable to create or fetch tag");
  }

  await run("INSERT OR IGNORE INTO tweet_tags (tweet_id, tag_id) VALUES (?, ?)", [tweetId, tag.id]);
  return tag;
}

async function removeTagFromTweet(tweetId, rawTagName) {
  const tagName = (rawTagName || "").trim().toLowerCase();
  if (!tagName) {
    throw new Error("Tag name is required");
  }

  const tag = await get("SELECT id FROM tags WHERE name = ?", [tagName]);
  if (!tag) {
    return false;
  }

  const result = await run("DELETE FROM tweet_tags WHERE tweet_id = ? AND tag_id = ?", [tweetId, tag.id]);
  if (result.changes > 0) {
    await deleteOrphanedTags();
  }
  return result.changes > 0;
}

function getTweetById(tweetId) {
  return get("SELECT * FROM tweets WHERE id = ?", [tweetId]);
}

function updateTweetNotes(tweetId, notes) {
  return run("UPDATE tweets SET notes = ? WHERE id = ?", [notes, tweetId]);
}

function getTweetMediaPaths(tweetId) {
  return all("SELECT local_path FROM media WHERE tweet_id = ?", [tweetId]);
}

function getAllTags() {
  return all("SELECT id, name FROM tags ORDER BY name COLLATE NOCASE ASC");
}

async function deleteTweet(tweetId) {
  const result = await run("DELETE FROM tweets WHERE id = ?", [tweetId]);
  if (result.changes > 0) {
    await deleteOrphanedTags();
  }
  return result;
}

async function getTelegramLastUpdateId() {
  const row = await get("SELECT value FROM telegram_state WHERE key = 'last_update_id'");
  return row ? Number(row.value) : null;
}

function saveTelegramLastUpdateId(updateId) {
  return run(
    "INSERT INTO telegram_state (key, value) VALUES ('last_update_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(updateId)]
  );
}

const EXPORT_BATCH_SIZE = 500;

async function streamDatabaseJsonl(writeLine) {
  writeLine(JSON.stringify({
    type: "meta",
    version: 1,
    exported_at: new Date().toISOString()
  }));

  const telegramRows = await all("SELECT key, value FROM telegram_state ORDER BY key ASC");
  for (const row of telegramRows) {
    writeLine(JSON.stringify({
      type: "telegram_state",
      key: row.key,
      value: row.value
    }));
  }

  let lastRowid = 0;
  while (true) {
    const pageRows = await all(
      `
      SELECT rowid, id, url, text, notes, author_name, author_handle, created_at, saved_at
      FROM tweets
      WHERE rowid > ?
      ORDER BY rowid ASC
      LIMIT ?
    `,
      [lastRowid, EXPORT_BATCH_SIZE]
    );

    if (!pageRows.length) {
      break;
    }

    const ids = pageRows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const [mediaRows, linkRows, tagRows] = await Promise.all([
      all(
        `SELECT tweet_id, original_url, local_path, media_type FROM media WHERE tweet_id IN (${placeholders}) ORDER BY id ASC`,
        ids
      ),
      all(
        `SELECT tweet_id, url, title, display_text FROM tweet_links WHERE tweet_id IN (${placeholders}) ORDER BY id ASC`,
        ids
      ),
      all(
        `
        SELECT tt.tweet_id, t.name
        FROM tags t
        JOIN tweet_tags tt ON tt.tag_id = t.id
        WHERE tt.tweet_id IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE ASC
      `,
        ids
      )
    ]);

    const mediaByTweet = groupByTweetId(mediaRows);
    const linksByTweet = groupByTweetId(linkRows);
    const tagsByTweet = groupByTweetId(tagRows);

    for (const row of pageRows) {
      writeLine(JSON.stringify({
        type: "tweet",
        id: row.id,
        url: row.url ?? "",
        text: row.text ?? "",
        notes: row.notes ?? null,
        author_name: row.author_name ?? "",
        author_handle: row.author_handle ?? "",
        created_at: row.created_at ?? null,
        saved_at: row.saved_at ?? null,
        tags: (tagsByTweet.get(row.id) || []).map((tag) => tag.name),
        links: (linksByTweet.get(row.id) || []).map((link) => ({
          url: link.url,
          title: link.title ?? null,
          display_text: link.display_text ?? null
        })),
        media: (mediaByTweet.get(row.id) || []).map((media) => ({
          original_url: media.original_url ?? null,
          local_path: media.local_path ?? null,
          media_type: media.media_type ?? null
        }))
      }));
    }

    lastRowid = pageRows[pageRows.length - 1].rowid;
    if (pageRows.length < EXPORT_BATCH_SIZE) {
      break;
    }
  }
}

async function exportDatabaseJsonl() {
  const lines = [];
  await streamDatabaseJsonl((line) => lines.push(line));
  return `${lines.join("\n")}\n`;
}

async function importDatabaseJsonl(jsonlText) {
  const rawLines = String(jsonlText || "").split(/\r?\n/);
  const records = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index].trim();
    if (!line) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_error) {
      throw new Error(`Ungueltiges JSON in Zeile ${index + 1}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Ungueltiger Datensatz in Zeile ${index + 1}`);
    }

    const recordType = parsed.type || (parsed.id !== undefined ? "tweet" : "");
    if (recordType === "meta") {
      continue;
    }
    if (recordType === "telegram_state") {
      const key = String(parsed.key || "").trim();
      if (!key || parsed.value === undefined || parsed.value === null) {
        throw new Error(`Ungueltiger Telegram-Status in Zeile ${index + 1}`);
      }
      records.push({ type: "telegram_state", key, value: String(parsed.value) });
      continue;
    }
    if (recordType === "tweet") {
      const id = String(parsed.id || "").trim();
      if (!id) {
        throw new Error(`Fehlende Tweet-ID in Zeile ${index + 1}`);
      }
      records.push({ ...parsed, type: "tweet", id });
      continue;
    }

    throw new Error(`Unbekannter Datensatz-Typ in Zeile ${index + 1}`);
  }

  return withTransaction(async () => {
    let imported = 0;
    let skipped = 0;
    let telegramStateRestored = 0;
    const tagIdCache = new Map();

    for (const record of records) {
      if (record.type === "telegram_state") {
        if (record.key === "last_update_id") {
          const existing = await get("SELECT value FROM telegram_state WHERE key = 'last_update_id'");
          const incomingNum = Number(record.value);
          const existingNum = existing ? Number(existing.value) : NaN;
          if (!existing || (Number.isFinite(incomingNum) && (!Number.isFinite(existingNum) || incomingNum > existingNum))) {
            await run(
              "INSERT INTO telegram_state (key, value) VALUES ('last_update_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
              [record.value]
            );
            telegramStateRestored += 1;
          }
        } else {
          const result = await run(
            "INSERT OR IGNORE INTO telegram_state (key, value) VALUES (?, ?)",
            [record.key, record.value]
          );
          telegramStateRestored += result.changes;
        }
        continue;
      }

      const insertResult = await run(
        `
        INSERT OR IGNORE INTO tweets (id, url, text, notes, author_name, author_handle, created_at, saved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      `,
        [
          record.id,
          record.url ?? "",
          record.text ?? "",
          typeof record.notes === "string" ? record.notes : null,
          record.author_name ?? "",
          record.author_handle ?? "",
          record.created_at ?? null,
          record.saved_at ?? null
        ]
      );

      if (insertResult.changes === 0) {
        skipped += 1;
        continue;
      }

      imported += 1;

      if (Array.isArray(record.media)) {
        for (const media of record.media) {
          if (!media || typeof media !== "object") {
            continue;
          }
          await run(
            "INSERT INTO media (tweet_id, original_url, local_path, media_type) VALUES (?, ?, ?, ?)",
            [
              record.id,
              media.original_url ?? null,
              media.local_path ?? null,
              media.media_type ?? null
            ]
          );
        }
      }

      if (Array.isArray(record.links)) {
        for (const link of record.links) {
          if (!link || typeof link !== "object") {
            continue;
          }
          const url = String(link.url || "").trim();
          if (!url) {
            continue;
          }
          await run(
            "INSERT INTO tweet_links (tweet_id, url, title, display_text) VALUES (?, ?, ?, ?)",
            [record.id, url, link.title ?? null, link.display_text ?? null]
          );
        }
      }

      if (Array.isArray(record.tags)) {
        for (const rawTag of record.tags) {
          const tagName = String(typeof rawTag === "string" ? rawTag : rawTag?.name || "")
            .trim()
            .toLowerCase();
          if (!tagName) {
            continue;
          }

          let tagId = tagIdCache.get(tagName);
          if (!tagId) {
            await run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [tagName]);
            const tagRow = await get("SELECT id FROM tags WHERE name = ?", [tagName]);
            if (tagRow) {
              tagId = tagRow.id;
              tagIdCache.set(tagName, tagId);
            }
          }

          if (tagId) {
            await run("INSERT OR IGNORE INTO tweet_tags (tweet_id, tag_id) VALUES (?, ?)", [record.id, tagId]);
          }
        }
      }
    }

    return {
      imported,
      skipped,
      telegram_state_restored: telegramStateRestored
    };
  });
}

function closeDb() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  initDb,
  closeDb,
  saveTweetWithMedia,
  getTweets,
  addTagToTweet,
  removeTagFromTweet,
  getTweetById,
  updateTweetNotes,
  getTweetMediaPaths,
  getAllTags,
  deleteTweet,
  getTelegramLastUpdateId,
  saveTelegramLastUpdateId,
  streamDatabaseJsonl,
  exportDatabaseJsonl,
  importDatabaseJsonl
};
