const BUTTON_CLASS = "toa-save-btn";
const savedTweetIds = new Set();
const STATUS_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d+)(?:\/|$)/;
const HANDLE_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,50})\/?$/;

// Eingebettete Zitat-Tweets haben einen eigenen User-Name-Block unterhalb des Haupt-Tweets.
function getQuotedTweetRoots(article) {
  const userNames = Array.from(article.querySelectorAll('[data-testid="User-Name"]'));
  if (userNames.length <= 1) {
    return [];
  }

  const mainUserName = userNames[0];
  const pageStatusId = window.location.pathname.match(STATUS_PATH_PATTERN)?.[2] || "";

  return userNames.slice(1).map((quoteUserName) => {
    const isBeforeQuote = (el) =>
      !el.contains(quoteUserName) &&
      Boolean(el.compareDocumentPosition(quoteUserName) & Node.DOCUMENT_POSITION_FOLLOWING);

    const rawQuoteCard = quoteUserName.closest('[role="link"]');
    const quoteLinkCard =
      rawQuoteCard && article.contains(rawQuoteCard) && !rawQuoteCard.contains(mainUserName) ? rawQuoteCard : null;

    // Auf Status-Detailseiten liegt mainUserName im oberen Header, waehrend Text, Zitat,
    // Zeitstempel und Aktionsleiste gemeinsam im darunterliegenden Body-Container liegen.
    const outsideNodes = [
      mainUserName,
      article.querySelector(
        '[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"], [data-testid="bookmark"], [data-testid="removeBookmark"]'
      ),
      article.querySelector(`.${BUTTON_CLASS}`),
      Array.from(article.querySelectorAll('[role="group"]')).pop(),
      ...Array.from(article.querySelectorAll('[data-testid="tweetText"], [data-testid="tweetPhoto"], video, time')).filter(
        isBeforeQuote
      ),
      ...Array.from(article.querySelectorAll("time"))
        .map((timeEl) => timeEl.closest('a[href*="/status/"]'))
        .filter((linkEl) => {
          if (!linkEl) {
            return false;
          }
          if (quoteLinkCard && !quoteLinkCard.contains(linkEl)) {
            return true;
          }
          const linkStatusId = (linkEl.getAttribute("href") || "").match(STATUS_PATH_PATTERN)?.[2] || "";
          return Boolean(pageStatusId && linkStatusId === pageStatusId);
        })
    ].filter(Boolean);

    let current = quoteUserName;
    while (
      current.parentElement &&
      current.parentElement !== article &&
      !outsideNodes.some((node) => current.parentElement.contains(node))
    ) {
      current = current.parentElement;
    }
    return current;
  });
}

function isInsideQuotedTweet(element, quoteRoots) {
  return quoteRoots.some((root) => root.contains(element));
}

function getMainTimeElement(article, quoteRoots = getQuotedTweetRoots(article)) {
  const allTimes = Array.from(article.querySelectorAll("time"));
  const mainTimes = allTimes.filter((el) => !isInsideQuotedTweet(el, quoteRoots));
  const hasStatusLink = (el) =>
    STATUS_PATH_PATTERN.test(el.closest('a[href*="/status/"]')?.getAttribute("href") || "");

  return (
    mainTimes.find(hasStatusLink) ||
    mainTimes[0] ||
    allTimes.find(hasStatusLink) ||
    allTimes[0] ||
    null
  );
}

function getMainStatusHref(article, quoteRoots = getQuotedTweetRoots(article)) {
  const timeEl = getMainTimeElement(article, quoteRoots);
  const timeLinkHref = timeEl?.closest('a[href*="/status/"]')?.getAttribute("href") || "";
  if (STATUS_PATH_PATTERN.test(timeLinkHref)) {
    return timeLinkHref;
  }

  const mainUserName = article.querySelector('[data-testid="User-Name"]');
  const headerLinkHref = mainUserName?.querySelector('a[href*="/status/"]')?.getAttribute("href") || "";
  if (STATUS_PATH_PATTERN.test(headerLinkHref)) {
    return headerLinkHref;
  }

  const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'));
  const mainStatusLink =
    statusLinks.find(
      (anchor) =>
        !isInsideQuotedTweet(anchor, quoteRoots) &&
        !anchor.closest('[data-testid="tweetText"]') &&
        STATUS_PATH_PATTERN.test(anchor.getAttribute("href") || "")
    ) ||
    statusLinks.find(
      (anchor) => !isInsideQuotedTweet(anchor, quoteRoots) && STATUS_PATH_PATTERN.test(anchor.getAttribute("href") || "")
    );
  if (mainStatusLink) {
    return mainStatusLink.getAttribute("href") || "";
  }

  if (STATUS_PATH_PATTERN.test(window.location.pathname)) {
    return window.location.pathname;
  }

  return "";
}

function getTweetId(article) {
  const href = getMainStatusHref(article);
  return href.match(STATUS_PATH_PATTERN)?.[2] || "";
}

function upgradeImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.hostname.toLowerCase() === "pbs.twimg.com" && parsed.pathname.startsWith("/media/")) {
      parsed.searchParams.set("name", "orig");
      return parsed.toString();
    }
    return parsed.toString();
  } catch (_error) {
    return rawUrl;
  }
}

function isVideoUrl(url) {
  return /\.(mp4|webm|mov|m3u8)(\?|#|$)/i.test(url) || /video/i.test(url);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function waitForEvent(target, eventName, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => cleanup(false), timeoutMs);

    const cleanup = (result) => {
      window.clearTimeout(timeout);
      target.removeEventListener(eventName, onEvent);
      resolve(result);
    };

    const onEvent = () => cleanup(true);
    target.addEventListener(eventName, onEvent, { once: true });
  });
}

function waitForVideoSource(videoElement, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const readSource = () =>
      videoElement.currentSrc ||
      videoElement.getAttribute("src") ||
      videoElement.querySelector("source")?.getAttribute("src") ||
      "";

    const initial = readSource();
    if (initial) {
      resolve(initial);
      return;
    }

    const onReady = () => {
      cleanup();
      resolve(readSource());
    };

    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(readSource());
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      videoElement.removeEventListener("loadedmetadata", onReady);
      videoElement.removeEventListener("canplay", onReady);
      videoElement.removeEventListener("loadeddata", onReady);
    };

    videoElement.addEventListener("loadedmetadata", onReady, { once: true });
    videoElement.addEventListener("canplay", onReady, { once: true });
    videoElement.addEventListener("loadeddata", onReady, { once: true });
  });
}

async function fetchBlobMediaAsAsset(mediaUrl, fallbackType = "video/mp4") {
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch media blob: ${response.status}`);
  }

  const blob = await response.blob();
  const mimeType = blob.type || response.headers.get("content-type") || fallbackType;
  const arrayBuffer = await blob.arrayBuffer();

  return {
    media_type: mimeType.startsWith("video/") ? "video" : "image",
    mime_type: mimeType,
    data_base64: arrayBufferToBase64(arrayBuffer)
  };
}

async function recordVideoElement(videoElement, maxDurationMs = 20000) {
  if (!videoElement || typeof videoElement.captureStream !== "function" || typeof MediaRecorder === "undefined") {
    return null;
  }

  const originalMuted = videoElement.muted;
  const originalVolume = videoElement.volume;
  const originalPlaybackRate = videoElement.playbackRate;
  const originalTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
  const wasPaused = videoElement.paused;
  const originalLoop = videoElement.loop;

  let recorder = null;
  let stream = null;
  let stopTimer = null;
  let chunks = [];

  try {
    if (videoElement.readyState < 1) {
      await waitForEvent(videoElement, "loadedmetadata", 3000);
    }

    try {
      videoElement.pause();
      videoElement.currentTime = 0;
      await waitForEvent(videoElement, "seeked", 1500);
    } catch (error) {
      // Some X video streams are not seekable; recording from the current position is still better than nothing.
    }

    videoElement.muted = true;
    videoElement.volume = 0;
    videoElement.loop = false;

    stream = videoElement.captureStream();
    const preferredMimeTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";

    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) {
        chunks.push(event.data);
      }
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start(1000);

    try {
      await videoElement.play();
    } catch (error) {
      // If autoplay/play is blocked, we still try to record whatever is already available.
    }

    const durationMs = Number.isFinite(videoElement.duration)
      ? Math.min(Math.max(videoElement.duration * 1000 + 1500, 2500), maxDurationMs)
      : maxDurationMs;

    stopTimer = window.setTimeout(() => {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);

    await stopped;

    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    if (!blob.size) {
      return null;
    }

    const arrayBuffer = await blob.arrayBuffer();
    return {
      media_type: "video",
      mime_type: blob.type || mimeType || "video/webm",
      data_base64: arrayBufferToBase64(arrayBuffer),
      source_url: videoElement.currentSrc || videoElement.getAttribute("src") || ""
    };
  } catch (error) {
    console.warn("Video recording failed", error);
    return null;
  } finally {
    if (stopTimer) {
      window.clearTimeout(stopTimer);
    }

    if (videoElement) {
      videoElement.pause();
      videoElement.muted = originalMuted;
      videoElement.volume = originalVolume;
      videoElement.playbackRate = originalPlaybackRate;
      videoElement.loop = originalLoop;
      try {
        videoElement.currentTime = originalTime;
      } catch (error) {
        // Ignore seek restore errors.
      }

      if (!wasPaused) {
        try {
          await videoElement.play();
        } catch (error) {
          // Ignore restore play errors.
        }
      }
    }

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (error) {
        // Ignore stop errors during cleanup.
      }
    }

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  }
}

function sendTweetToBackend(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "SAVE_TWEET", payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response || !response.ok) {
        const details = response?.data?.error || response?.error || `HTTP ${response?.status || "unknown"}`;
        reject(new Error(details));
        return;
      }

      resolve(response);
    });
  });
}

function getTweetTextElement(article, quoteRoots = getQuotedTweetRoots(article)) {
  const allTextElements = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
  const mainTextElements = allTextElements.filter((el) => !isInsideQuotedTweet(el, quoteRoots));
  const candidates = mainTextElements.length ? mainTextElements : [];
  return (
    candidates.find((element) => /^de(?:-|$)/i.test(element.getAttribute("lang") || "")) ||
    candidates[0] ||
    null
  );
}

function extractAuthorInfo(article, statusHref) {
  const mainUserName = article.querySelector('[data-testid="User-Name"]');
  let authorName = "";
  let authorHandle = "";

  if (mainUserName) {
    const spans = Array.from(mainUserName.querySelectorAll("span"));
    const nameSpan = spans.find((span) => {
      const text = span.textContent.trim();
      return text && !text.startsWith("@") && text !== "·";
    });
    if (nameSpan) {
      authorName = nameSpan.textContent.trim();
    }

    const anchors = Array.from(mainUserName.querySelectorAll('a[href^="/"]'));
    for (const anchor of anchors) {
      const match = HANDLE_PATH_PATTERN.exec(anchor.getAttribute("href") || "");
      if (match) {
        authorHandle = match[1];
        break;
      }
    }

    if (!authorHandle) {
      const handleSpan = spans.find((span) => /^@[A-Za-z0-9_]{1,50}$/.test(span.textContent.trim()));
      if (handleSpan) {
        authorHandle = handleSpan.textContent.trim().slice(1);
      }
    }
  }

  if (!authorHandle && statusHref) {
    authorHandle = statusHref.match(STATUS_PATH_PATTERN)?.[1] || "";
  }

  return { authorName, authorHandle };
}

function selectScopedMediaElements(article, quoteRoots) {
  const allPhotos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'));
  const allVideos = Array.from(
    article.querySelectorAll('video, [data-testid="videoComponent"] video, [data-testid="videoPlayer"] video')
  );

  const mainPhotos = allPhotos.filter((img) => !isInsideQuotedTweet(img, quoteRoots));
  const mainVideos = allVideos.filter((video) => !isInsideQuotedTweet(video, quoteRoots));

  if (mainPhotos.length || mainVideos.length) {
    return { photoElements: mainPhotos, videoElements: [...new Set(mainVideos)] };
  }

  return { photoElements: allPhotos, videoElements: [...new Set(allVideos)] };
}

async function extractTweetData(article, { captureBlobVideos = false } = {}) {
  const quoteRoots = getQuotedTweetRoots(article);
  const href = getMainStatusHref(article, quoteRoots);
  const statusMatch = href.match(STATUS_PATH_PATTERN);
  const tweetId = statusMatch?.[2] || "";
  const url = statusMatch ? `https://x.com/${statusMatch[1]}/status/${statusMatch[2]}` : "";

  const textEl = getTweetTextElement(article, quoteRoots);
  const { authorName, authorHandle } = extractAuthorInfo(article, href);
  const timeEl = getMainTimeElement(article, quoteRoots);

  const { photoElements, videoElements } = selectScopedMediaElements(article, quoteRoots);
  const mediaUrls = photoElements
    .map((img) => img.getAttribute("src"))
    .filter(Boolean)
    .map(upgradeImageUrl);

  const mediaAssets = [];
  const seenMediaUrls = new Set(mediaUrls);
  const hasVideo = videoElements.length > 0;

  for (let index = 0; index < videoElements.length; index += 1) {
    const videoElement = videoElements[index];
    const videoSource = await waitForVideoSource(videoElement);
    if (!videoSource) {
      continue;
    }

    let absoluteVideoUrl = videoSource;
    try {
      absoluteVideoUrl = new URL(videoSource, window.location.origin).toString();
    } catch (error) {
      absoluteVideoUrl = videoSource;
    }

    if (absoluteVideoUrl.startsWith("blob:")) {
      if (!captureBlobVideos) {
        continue;
      }
      try {
        const recordedAsset = await recordVideoElement(videoElement);
        if (recordedAsset) {
          mediaAssets.push(recordedAsset);
        } else {
          const blobAsset = await fetchBlobMediaAsAsset(
            absoluteVideoUrl,
            videoElement.querySelector("source")?.getAttribute("type") || "video/mp4"
          );
          mediaAssets.push({
            ...blobAsset,
            media_type: "video",
            source_url: absoluteVideoUrl
          });
        }
      } catch (error) {
        console.warn("Failed to extract blob video", error);
      }
      continue;
    }

    if (!seenMediaUrls.has(absoluteVideoUrl)) {
      seenMediaUrls.add(absoluteVideoUrl);
      mediaAssets.push({
        media_type: isVideoUrl(absoluteVideoUrl) ? "video" : "image",
        url: absoluteVideoUrl
      });
    }
  }

  const tweetTextLinks = Array.from(textEl?.querySelectorAll("a[href]") || [])
    .map((anchor) => {
      const rawHref = anchor.getAttribute("href") || "";
      if (!rawHref) {
        return null;
      }

      return {
        url: rawHref,
        display_text: anchor.innerText.trim() || anchor.textContent.trim() || rawHref,
        title: anchor.getAttribute("title") || ""
      };
    })
    .filter(Boolean);

  return {
    id: tweetId,
    url,
    text: textEl ? textEl.innerText.trim() : "",
    author_name: authorName,
    author_handle: authorHandle,
    created_at: timeEl ? timeEl.getAttribute("datetime") : null,
    media_urls: [...new Set(mediaUrls)],
    media_assets: mediaAssets,
    has_video: hasVideo,
    links: tweetTextLinks
  };
}

function setButtonState(button, state) {
  if (state === "saving") {
    button.textContent = "Speichern...";
    button.disabled = true;
    button.classList.add("is-saving");
    button.classList.remove("is-success", "is-error");
    return;
  }

  if (state === "success") {
    button.textContent = "✓ Gespeichert";
    button.disabled = false;
    button.classList.add("is-success");
    button.classList.remove("is-saving", "is-error");
    return;
  }

  if (state === "error") {
    button.textContent = "Fehler";
    button.disabled = false;
    button.classList.add("is-error");
    button.classList.remove("is-saving", "is-success");
    setTimeout(() => {
      button.textContent = "💾 Lokal speichern";
      button.classList.remove("is-error");
    }, 2500);
    return;
  }

  button.textContent = "💾 Lokal speichern";
  button.disabled = false;
  button.classList.remove("is-saving", "is-success", "is-error");
}

async function saveTweet(article, button) {
  setButtonState(button, "saving");

  try {
    const payload = await extractTweetData(article, { captureBlobVideos: false });
    if (!payload.id) {
      console.warn("Could not determine tweet id", payload);
      setButtonState(button, "error");
      return;
    }

    let response = await sendTweetToBackend(payload);

    // Fallback: Nur wenn das Backend ein Blob-Video nicht per fxtwitter laden konnte, im Browser mitschneiden.
    if (payload.has_video && !response.data?.video_saved) {
      const fallbackPayload = await extractTweetData(article, { captureBlobVideos: true });
      if (fallbackPayload.media_assets.length > 0) {
        response = await sendTweetToBackend(fallbackPayload);
      }
    }

    savedTweetIds.add(payload.id);
    setButtonState(button, "success");
    button.title = `Gespeichert (${response.status})`;
  } catch (error) {
    console.error("Save tweet failed", error);
    button.title = error.message || "Speichern fehlgeschlagen";
    setButtonState(button, "error");
  }
}

function injectSaveButton(article) {
  if (article.querySelector(`.${BUTTON_CLASS}`)) {
    return;
  }

  const actionRow = article.querySelector('[role="group"]') || article.querySelector('div[role="group"]');

  const wrapper = document.createElement("div");
  wrapper.className = "toa-save-btn-wrap";

  const button = document.createElement("button");
  button.className = BUTTON_CLASS;
  button.type = "button";
  setButtonState(button, savedTweetIds.has(getTweetId(article)) ? "success" : "idle");

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    saveTweet(article, button);
  });

  wrapper.appendChild(button);
  if (actionRow && actionRow.parentElement) {
    actionRow.parentElement.appendChild(wrapper);
    return;
  }

  article.appendChild(wrapper);
}

function scanTweets() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  tweets.forEach((tweet) => injectSaveButton(tweet));
}

let scanScheduled = false;

function scheduleScanTweets() {
  if (scanScheduled) {
    return;
  }
  scanScheduled = true;
  window.requestAnimationFrame(() => {
    scanScheduled = false;
    scanTweets();
  });
}

const observer = new MutationObserver(() => {
  scheduleScanTweets();
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
  scanTweets();
}
