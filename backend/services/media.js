const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MEDIA_DIR } = require("../config");

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function upgradeImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() === "pbs.twimg.com" && parsed.pathname.startsWith("/media/")) {
      parsed.searchParams.set("name", "orig");
      return parsed.toString();
    }
  } catch (_error) {
    return rawUrl;
  }
  return rawUrl;
}

function extensionFromUrl(url, fallback = ".jpg") {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    const ext = path.extname(base);
    if (ext && ext.length <= 10) {
      return ext;
    }
    const format = (parsed.searchParams.get("format") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (format && format.length <= 5) {
      return `.${format === "jpeg" ? "jpg" : format}`;
    }
  } catch (err) {
    return fallback;
  }
  return fallback;
}

function extensionFromMimeType(mimeType, fallback = ".bin") {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("video/mp4")) return ".mp4";
  if (type.includes("video/webm")) return ".webm";
  if (type.includes("video/quicktime")) return ".mov";
  if (type.includes("image/jpeg")) return ".jpg";
  if (type.includes("image/png")) return ".png";
  if (type.includes("image/gif")) return ".gif";
  if (type.includes("image/webp")) return ".webp";
  return fallback;
}

function mediaTypeFromUrl(url, contentType = "") {
  const lower = String(contentType || "").toLowerCase();
  if (lower.startsWith("video/")) {
    return "video";
  }
  if (lower.startsWith("image/")) {
    return "image";
  }

  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".m4v"].includes(ext)) {
    return "video";
  }
  return "image";
}

async function downloadMediaFile(url, tweetId, index) {
  const downloadUrl = upgradeImageUrl(url);
  const response = await axios.get(downloadUrl, { responseType: "stream", timeout: 15000 });
  const contentType = response.headers["content-type"] || "";
  const ext = extensionFromUrl(downloadUrl, "") || extensionFromMimeType(contentType, ".bin");
  const fileName = `${sanitizeFilename(tweetId)}_${index}${ext}`;
  const absolutePath = path.join(MEDIA_DIR, fileName);
  const mediaType = mediaTypeFromUrl(downloadUrl, contentType);

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(absolutePath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return {
    original_url: downloadUrl,
    local_path: fileName,
    media_type: mediaType
  };
}

async function saveBinaryMediaAsset(asset, tweetId, index) {
  const mimeType = asset.mime_type || asset.mimeType || "application/octet-stream";
  // Die Endung kommt immer vom MIME-Typ, nie vom Client.
  const fileName = `${sanitizeFilename(tweetId)}_${index}${extensionFromMimeType(mimeType)}`;
  const buffer = Buffer.from(asset.data_base64 || asset.data || "", "base64");

  await fs.promises.writeFile(path.join(MEDIA_DIR, fileName), buffer);

  return {
    original_url: asset.source_url || asset.url || "",
    local_path: fileName,
    media_type: asset.media_type || (mimeType.startsWith("video/") ? "video" : "image")
  };
}

// Einzelne fehlgeschlagene Medien werden uebersprungen, damit der Tweet trotzdem gespeichert wird.
async function collectMedia(tweetId, mediaUrls, mediaAssets) {
  const rows = [];
  const processedSourceUrls = new Set();
  let index = 0;

  for (const mediaUrl of mediaUrls) {
    if (!mediaUrl || typeof mediaUrl !== "string") {
      continue;
    }

    const normalizedUrl = upgradeImageUrl(mediaUrl);
    if (processedSourceUrls.has(normalizedUrl)) {
      continue;
    }

    index += 1;
    try {
      rows.push(await downloadMediaFile(normalizedUrl, tweetId, index));
      processedSourceUrls.add(normalizedUrl);
    } catch (error) {
      console.warn(`Media download failed for ${normalizedUrl}: ${error.message}`);
    }
  }

  for (const asset of mediaAssets) {
    if (!asset || typeof asset !== "object") {
      continue;
    }

    if (asset.data_base64 || asset.data) {
      index += 1;
      try {
        rows.push(await saveBinaryMediaAsset(asset, tweetId, index));
      } catch (error) {
        console.warn(`Binary media save failed for tweet ${tweetId}: ${error.message}`);
      }
      continue;
    }

    const assetUrl = asset.url ? upgradeImageUrl(asset.url) : "";
    if (assetUrl && !processedSourceUrls.has(assetUrl)) {
      index += 1;
      try {
        const row = await downloadMediaFile(assetUrl, tweetId, index);
        row.media_type = asset.media_type || row.media_type;
        rows.push(row);
        processedSourceUrls.add(assetUrl);
      } catch (error) {
        console.warn(`Media download failed for ${assetUrl}: ${error.message}`);
      }
    }
  }

  return rows;
}

async function removeMediaFiles(rows) {
  for (const row of rows) {
    const absolutePath = path.resolve(MEDIA_DIR, row.local_path || "");
    if (absolutePath.startsWith(MEDIA_DIR + path.sep)) {
      await fs.promises.rm(absolutePath, { force: true });
    }
  }
}

module.exports = {
  upgradeImageUrl,
  downloadMediaFile,
  collectMedia,
  removeMediaFiles
};
