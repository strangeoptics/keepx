function stripTrailingEllipsis(value) {
  return String(value || "").replace(/(?:\u2026|%E2%80%A6)+$/gi, "").trim();
}

function isVisibleExternalUrl(value) {
  return /^https?:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value);
}

function normalizeUrl(value) {
  const candidate = stripTrailingEllipsis(value);
  if (!candidate) {
    return "";
  }

  try {
    let parsed;
    if (/^https?:\/\//i.test(candidate)) {
      parsed = new URL(candidate);
    } else if (candidate.startsWith("//")) {
      parsed = new URL(`https:${candidate}`);
    } else if (candidate.startsWith("/")) {
      parsed = new URL(candidate, "https://x.com");
    } else if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(candidate)) {
      parsed = new URL(`https://${candidate}`);
    } else {
      return "";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    parsed.pathname = parsed.pathname.replace(/(?:%E2%80%A6|…)+$/gi, "");
    return parsed.toString().replace(/%E2%80%A6/gi, "").replace(/…/g, "");
  } catch (error) {
    return "";
  }
}

function shouldSkipLink(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  const isTwitterHost = /^(www\.)?(x\.com|twitter\.com)$/i.test(parsed.hostname);
  const isTweetStatus = /\/status\/\d+(?:\/|$)/.test(path);

  return (
    path.includes("/photo/") ||
    path.includes("/video/") ||
    path.includes("/analytics") ||
    path.includes("/search") ||
    (isTwitterHost && !isTweetStatus)
  );
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) {
    return [];
  }

  const normalized = [];
  const seenUrls = new Set();

  for (const link of links) {
    if (!link || typeof link !== "object") {
      continue;
    }

    const displayText = stripTrailingEllipsis(link.display_text);
    const url = normalizeUrl(isVisibleExternalUrl(displayText) ? displayText : link.url);
    if (!url || shouldSkipLink(url) || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    normalized.push({
      url,
      title: String(link.title || ""),
      display_text: displayText
    });
  }

  return normalized;
}

module.exports = { normalizeLinks };
