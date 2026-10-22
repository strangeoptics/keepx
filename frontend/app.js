const API_BASE = "/api";
const MEDIA_BASE = "/media";

const searchInput = document.getElementById("searchInput");
const refreshBtn = document.getElementById("refreshBtn");
const tweetGrid = document.getElementById("tweetGrid");
const statusEl = document.getElementById("status");
const tagFilters = document.getElementById("tagFilters");
const cardTemplate = document.getElementById("tweetCardTemplate");
const imageLightbox = document.getElementById("imageLightbox");
const lightboxImage = document.getElementById("lightboxImage");
const lightboxCloseBtn = document.getElementById("lightboxCloseBtn");
const tweetTextSizeInput = document.getElementById("tweetTextSize");
const tweetTextSizeValue = document.getElementById("tweetTextSizeValue");
const DEFAULT_TWEET_TEXT_SIZE = 14;
const TWEET_TEXT_SIZE_KEY = "keepX.tweetTextSize";
const LEGACY_TWEET_TEXT_SIZE_KEY = "twitterOfflineArchiver.tweetTextSize";

function getSavedTweetTextSize() {
  const savedSetting = localStorage.getItem(TWEET_TEXT_SIZE_KEY);
  const legacySetting = savedSetting === null ? localStorage.getItem(LEGACY_TWEET_TEXT_SIZE_KEY) : null;
  const savedSize = Number(savedSetting ?? legacySetting);
  if (savedSetting === null && legacySetting !== null) {
    localStorage.setItem(TWEET_TEXT_SIZE_KEY, legacySetting);
    localStorage.removeItem(LEGACY_TWEET_TEXT_SIZE_KEY);
  }
  return Number.isInteger(savedSize) && savedSize >= 12 && savedSize <= 24
    ? savedSize
    : DEFAULT_TWEET_TEXT_SIZE;
}

function updateTweetTextSize(size) {
  tweetTextSizeInput.value = String(size);
  tweetTextSizeValue.textContent = `${size} px`;
  document.querySelectorAll(".tweet-text").forEach((element) => {
    element.style.fontSize = `${size}px`;
    updateTweetTextOverflow(element);
  });
}

function updateTweetTextOverflow(tweetText, initialize = false) {
  const toggle = tweetText.nextElementSibling;
  if (!toggle || !toggle.classList.contains("tweet-text-toggle")) return;

  const fontSize = Number.parseFloat(getComputedStyle(tweetText).fontSize);
  const isLong = tweetText.scrollHeight > fontSize * 20 + 1;
  if (!isLong) {
    tweetText.classList.remove("tweet-text-collapsed");
    toggle.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Mehr anzeigen";
    return;
  }

  toggle.classList.remove("hidden");
  if (initialize) toggle.setAttribute("aria-expanded", "false");
  const expanded = toggle.getAttribute("aria-expanded") === "true";
  tweetText.classList.toggle("tweet-text-collapsed", !expanded);
  toggle.textContent = expanded ? "Weniger anzeigen" : "Mehr anzeigen";
}

updateTweetTextSize(getSavedTweetTextSize());

let currentTag = "";
let untaggedOnly = false;
let searchTimer = null;
let knownTags = [];
let tagSuggestionSequence = 0;

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function compactText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatLinkLabel(link) {
  const display = String(link.display_text || "");
  if (display) {
    return display;
  }

  try {
    const parsed = new URL(link.url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "");
    return `${parsed.hostname}${path}`.replace(/\s+/g, " ").trim();
  } catch (error) {
    return link.url;
  }
}

function isListItemLine(line) {
  return /^\s*\d+\.\s+/.test(line);
}

function isLikelyLinkLine(line) {
  const trimmed = line.trim();
  return trimmed === "…" || trimmed === "..." || /^https?:\/\//i.test(trimmed) || /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(trimmed);
}

function createInlineLink(link) {
  const anchor = document.createElement("a");
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  anchor.className = "ml-1 font-normal text-sky-500 hover:text-sky-600 hover:underline decoration-transparent underline-offset-2";
  anchor.textContent = formatLinkLabel(link);
  anchor.title = link.url;
  return anchor;
}

function appendLinkifiedText(parent, text) {
  const pattern = /https?:\/\/[^\s]+/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    if (match.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    anchor.className = "text-sky-500 hover:text-sky-600 hover:underline";
    anchor.textContent = url;
    parent.appendChild(anchor);
    last = match.index + url.length;
    pattern.lastIndex = last;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

function extractNoteUrls(text) {
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const raw = match[0].replace(/[.,;:!?)\]]+$/, "");
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !seen.has(parsed.href)) {
        seen.add(parsed.href);
        urls.push(parsed.href);
      }
    } catch (error) {
      // Ungueltige URLs in Notizen ignorieren
    }
  }
  return urls;
}

function getNoteLinkMeta(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host.includes("gemini.google.") || host === "g.co" || host === "aistudio.google.com" || host === "ais.google.com") {
      return { label: "Gemini", title: "Gemini-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "notebooklm.google.com") {
      return { label: "NotebookLM", title: "NotebookLM oeffnen", isAi: true };
    }
    if (host === "chatgpt.com" || host === "chat.openai.com" || host.endsWith(".openai.com") || host === "openai.com") {
      return { label: "ChatGPT", title: "ChatGPT-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai") || host.endsWith(".anthropic.com")) {
      return { label: "Claude", title: "Claude-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "perplexity.ai" || host.endsWith(".perplexity.ai")) {
      return { label: "Perplexity", title: "Perplexity-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "grok.com" || host.endsWith(".grok.com") || ((host === "x.com" || host === "twitter.com") && parsed.pathname.startsWith("/i/grok"))) {
      return { label: "Grok", title: "Grok-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "copilot.microsoft.com") {
      return { label: "Copilot", title: "Copilot-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "deepseek.com" || host.endsWith(".deepseek.com")) {
      return { label: "DeepSeek", title: "DeepSeek-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) {
      return { label: "Mistral", title: "Mistral-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "poe.com" || host.endsWith(".poe.com")) {
      return { label: "Poe", title: "Poe-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "meta.ai" || host.endsWith(".meta.ai")) {
      return { label: "Meta AI", title: "Meta-AI-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "qwen.ai" || host.endsWith(".qwen.ai") || host === "qwenlm.ai") {
      return { label: "Qwen", title: "Qwen-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "kimi.ai" || host.endsWith(".kimi.ai") || host === "kimi.moonshot.cn") {
      return { label: "Kimi", title: "Kimi-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "phind.com" || host.endsWith(".phind.com")) {
      return { label: "Phind", title: "Phind-Unterhaltung oeffnen", isAi: true };
    }
    if (host === "you.com" || host.endsWith(".you.com")) {
      return { label: "You.com", title: "You.com-Unterhaltung oeffnen", isAi: true };
    }
    const parts = host.split(".");
    const baseName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const cleanName = baseName ? baseName.charAt(0).toUpperCase() + baseName.slice(1) : host;
    return { label: cleanName, title: `${cleanName} oeffnen`, isAi: false };
  } catch (error) {
    return { label: "Link", title: "Recherche-Link oeffnen", isAi: false };
  }
}

function renderTweetText(tweet) {
  const container = document.createElement("div");
  container.className = "whitespace-pre-wrap break-words";

  const lines = compactText(tweet.text || "").split("\n");
  const links = Array.isArray(tweet.links) ? tweet.links : [];
  let linkIndex = 0;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      container.appendChild(document.createElement("br"));
      i += 1;
      continue;
    }

    if (isListItemLine(line)) {
      const row = document.createElement("div");
      row.className = "mb-0.5 leading-snug";
      row.textContent = line.replace(/\s*[–-]\s*$/, " –").replace(/\s+$/, "");

      if (links[linkIndex]) {
        row.appendChild(createInlineLink(links[linkIndex]));
        linkIndex += 1;
      }

      container.appendChild(row);

      i += 1;
      while (i < lines.length && !isListItemLine(lines[i]) && isLikelyLinkLine(lines[i])) {
        i += 1;
      }
      continue;
    }

    const paragraph = document.createElement("div");
    paragraph.className = "mb-0.5 leading-snug";
    appendLinkifiedText(paragraph, line);
    container.appendChild(paragraph);
    i += 1;
  }

  return container;
}

function updateStatus(message) {
  statusEl.textContent = message;
}

function openImageLightbox(imageUrl, altText = "Vergroessertes Tweet-Bild") {
  lightboxImage.src = imageUrl;
  lightboxImage.alt = altText;
  imageLightbox.classList.remove("hidden");
  imageLightbox.classList.add("flex");
  document.body.classList.add("overflow-hidden");
}

function closeImageLightbox() {
  imageLightbox.classList.add("hidden");
  imageLightbox.classList.remove("flex");
  lightboxImage.src = "";
  document.body.classList.remove("overflow-hidden");
}

function buildFilterBar() {
  const fragment = document.createDocumentFragment();

  const allBtn = document.createElement("button");
  allBtn.className = `mb-2 mr-2 rounded-full border px-3 py-1 text-xs font-semibold ${currentTag || untaggedOnly ? "border-slate-300 bg-white text-slate-600" : "border-slate-900 bg-slate-900 text-white"}`;
  allBtn.textContent = "Alle";
  allBtn.addEventListener("click", () => {
    currentTag = "";
    untaggedOnly = false;
    loadTweets({ reset: true });
  });
  fragment.appendChild(allBtn);

  const untaggedBtn = document.createElement("button");
  untaggedBtn.className = `mb-2 mr-2 rounded-full border px-3 py-1 text-xs font-semibold ${untaggedOnly ? "border-amber-600 bg-amber-600 text-white" : "border-amber-200 bg-amber-50 text-amber-700"}`;
  untaggedBtn.textContent = "Ohne Tag";
  untaggedBtn.addEventListener("click", () => {
    currentTag = "";
    untaggedOnly = true;
    loadTweets({ reset: true });
  });
  fragment.appendChild(untaggedBtn);

  knownTags.forEach((tag) => {
    const btn = document.createElement("button");
    const active = !untaggedOnly && currentTag.toLowerCase() === tag.name.toLowerCase();
    btn.className = `mb-2 mr-2 rounded-full border px-3 py-1 text-xs font-semibold ${active ? "border-teal-700 bg-teal-700 text-white" : "border-teal-200 bg-teal-50 text-teal-700"}`;
    btn.textContent = tag.name;
    btn.addEventListener("click", () => {
      currentTag = tag.name;
      untaggedOnly = false;
      loadTweets({ reset: true });
    });
    fragment.appendChild(btn);
  });

  tagFilters.innerHTML = "";
  tagFilters.appendChild(fragment);
}

async function addTag(tweetId, tagName) {
  const response = await fetch(`${API_BASE}/tweets/${encodeURIComponent(tweetId)}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag: tagName })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Tag konnte nicht gespeichert werden");
  if (!data.tag || typeof data.tag.name !== "string") throw new Error("Ungueltige Antwort beim Speichern des Tags");
  return data.tag;
}

async function removeTag(tweetId, tagName) {
  const response = await fetch(`${API_BASE}/tweets/${encodeURIComponent(tweetId)}/tags/${encodeURIComponent(tagName)}`, {
    method: "DELETE"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Tag konnte nicht entfernt werden");
  return data;
}

async function deleteTweet(tweetId) {
  const response = await fetch(`${API_BASE}/tweets/${encodeURIComponent(tweetId)}`, {
    method: "DELETE"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Tweet konnte nicht geloescht werden");
  return data;
}

function removeCardFromGrid(card) {
  card.querySelectorAll("video").forEach((video) => videoObserver.unobserve(video));
  card.remove();
  loadedCount = Math.max(0, loadedCount - 1);
  updateLoadedStatus();
  if (!tweetGrid.children.length) {
    if (nextCursor) {
      loadMoreTweets();
    } else {
      renderTweets([]);
    }
  } else {
    observeSentinel();
  }
}

async function saveTweetNotes(tweetId, notes) {
  const response = await fetch(`${API_BASE}/tweets/${encodeURIComponent(tweetId)}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Notiz konnte nicht gespeichert werden");
  }
}

function renderTweets(tweets, append = false) {
  if (!append) {
    tweetGrid.innerHTML = "";
  }

  if (!tweets.length) {
    if (!append) {
      tweetGrid.innerHTML = '<p class="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">Keine Tweets gefunden.</p>';
    }
    return;
  }

  tweets.forEach((tweet) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.tweetId = tweet.id;
    card.querySelector(".tweet-author-name").textContent = tweet.author_name || "Unbekannt";
    card.querySelector(".tweet-author-handle").textContent = tweet.author_handle ? `@${tweet.author_handle}` : "";
    card.querySelector(".tweet-date").textContent = formatDate(tweet.created_at || tweet.saved_at);
    const tweetText = card.querySelector(".tweet-text");
    tweetText.innerHTML = "";
    tweetText.style.fontSize = `${tweetTextSizeInput.value}px`;
    tweetText.appendChild(renderTweetText(tweet));

    const textToggle = card.querySelector(".tweet-text-toggle");
    textToggle.addEventListener("click", () => {
      const expanded = textToggle.getAttribute("aria-expanded") === "true";
      textToggle.setAttribute("aria-expanded", String(!expanded));
      updateTweetTextOverflow(tweetText);
    });
    tweetText.addEventListener("click", (event) => {
      if (!tweetText.classList.contains("tweet-text-collapsed") || event.target.closest("a")) return;
      textToggle.setAttribute("aria-expanded", "true");
      updateTweetTextOverflow(tweetText);
    });

    const mediaWrap = card.querySelector(".tweet-media");
    if (Array.isArray(tweet.media)) {
      const uniqueMedia = [];
      const seenMediaKeys = new Set();

      tweet.media.forEach((item) => {
        const key = `${item.local_path || ""}|${item.original_url || ""}|${item.media_type || ""}`;
        if (seenMediaKeys.has(key)) {
          return;
        }
        seenMediaKeys.add(key);
        uniqueMedia.push(item);
      });

      if (uniqueMedia.length === 1) {
        mediaWrap.classList.replace("grid-cols-2", "grid-cols-1");
      }

      uniqueMedia.forEach((item) => {
        if (item.media_type === "video") {
          const video = document.createElement("video");
          video.controls = true;
          video.preload = "none";
          video.className = "col-span-2 w-full rounded-lg bg-black";
          video.dataset.src = `${MEDIA_BASE}/${encodeURIComponent(item.local_path)}`;
          mediaWrap.appendChild(video);
          videoObserver.observe(video);
          return;
        }

        const img = document.createElement("img");
        img.loading = "lazy";
        img.className = "max-h-[32rem] w-full cursor-zoom-in rounded-lg object-contain bg-slate-50";
        img.src = `${MEDIA_BASE}/${encodeURIComponent(item.local_path)}`;
        img.alt = "Lokales Tweet-Medium";
        const isCardImage = String(item.original_url || "").includes("/card_img/");
        const cardLink = isCardImage && Array.isArray(tweet.links) ? tweet.links[0] : null;
        if (cardLink) {
          const anchor = document.createElement("a");
          anchor.href = cardLink.url;
          anchor.target = "_blank";
          anchor.rel = "noreferrer noopener";
          anchor.className = "col-span-2 block";
          img.classList.replace("cursor-zoom-in", "cursor-pointer");
          anchor.appendChild(img);
          mediaWrap.appendChild(anchor);
          return;
        }
        img.addEventListener("click", () => openImageLightbox(img.src, img.alt || "Vergroessertes Tweet-Bild"));
        mediaWrap.appendChild(img);
      });
    }

    const tagsWrap = card.querySelector(".tweet-tags");
    const tags = Array.isArray(tweet.tags) ? tweet.tags : [];
    const appendTagPill = (tag) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-rose-100 hover:text-rose-700";
      pill.title = "Tag entfernen";
      pill.textContent = `${tag.name} ×`;
      pill.addEventListener("click", async () => {
        try {
          const data = await removeTag(tweet.id, tag.name);
          const tagIndex = tags.findIndex((item) => item.name.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
          if (tagIndex !== -1) {
            tags.splice(tagIndex, 1);
          }
          pill.remove();
          if (Array.isArray(data.tags)) {
            knownTags = data.tags;
          }
          if (currentTag && !knownTags.some((item) => item.name.toLocaleLowerCase() === currentTag.toLocaleLowerCase())) {
            currentTag = "";
            await loadTweets({ reset: true });
            return;
          }
          buildFilterBar();
          if (currentTag && currentTag.toLocaleLowerCase() === tag.name.toLocaleLowerCase()) {
            removeCardFromGrid(card);
          }

        } catch (err) {
          updateStatus(err.message);
        }
      });
      tagsWrap.appendChild(pill);
    };
    tags.forEach(appendTagPill);

    const form = card.querySelector(".tag-form");
    const input = card.querySelector(".tag-input");
    const suggestions = card.querySelector(".tag-suggestions");
    const suggestionId = `tag-suggestions-${++tagSuggestionSequence}`;
    input.setAttribute("aria-controls", suggestionId);
    suggestions.id = suggestionId;

    let matchingTags = [];
    let activeSuggestion = -1;

    const closeSuggestions = () => {
      suggestions.classList.add("hidden");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeSuggestion = -1;
    };

    const renderSuggestions = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const assignedTags = new Set(tags.map((tag) => tag.name.toLocaleLowerCase()));
      matchingTags = query
        ? knownTags
            .filter((tag) => tag.name.toLocaleLowerCase().includes(query) && !assignedTags.has(tag.name.toLocaleLowerCase()))
            .slice(0, 8)
        : [];
      suggestions.replaceChildren();
      activeSuggestion = -1;

      if (!matchingTags.length) {
        closeSuggestions();
        return;
      }

      matchingTags.forEach((tag, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `${suggestionId}-option-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.className = "block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-teal-50";
        option.textContent = tag.name;
        option.addEventListener("pointerdown", (event) => event.preventDefault());
        option.addEventListener("click", () => {
          input.value = tag.name;
          closeSuggestions();
          input.focus();
        });
        suggestions.appendChild(option);
      });

      suggestions.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
    };

    const setActiveSuggestion = (index) => {
      const options = suggestions.querySelectorAll('[role="option"]');
      if (!options.length) return;
      activeSuggestion = (index + options.length) % options.length;
      options.forEach((option, optionIndex) => {
        const active = optionIndex === activeSuggestion;
        option.setAttribute("aria-selected", String(active));
        option.classList.toggle("bg-teal-50", active);
        option.classList.toggle("text-teal-800", active);
      });
      input.setAttribute("aria-activedescendant", options[activeSuggestion].id);
    };

    input.addEventListener("input", renderSuggestions);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && matchingTags.length) {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion + 1);
      } else if (event.key === "ArrowUp" && matchingTags.length) {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion <= 0 ? matchingTags.length - 1 : activeSuggestion - 1);
      } else if (event.key === "Enter" && activeSuggestion >= 0) {
        event.preventDefault();
        input.value = matchingTags[activeSuggestion].name;
        closeSuggestions();
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
    });
    input.addEventListener("blur", closeSuggestions);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const tagValue = input.value.trim();
      if (!tagValue) return;
      closeSuggestions();
      try {
        const savedTag = await addTag(tweet.id, tagValue);
        if (!tags.some((tag) => tag.name.toLocaleLowerCase() === savedTag.name.toLocaleLowerCase())) {
          tags.push(savedTag);
          appendTagPill(savedTag);
        }
        if (!knownTags.some((tag) => tag.name.toLocaleLowerCase() === savedTag.name.toLocaleLowerCase())) {
          knownTags.push(savedTag);
          knownTags.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
          buildFilterBar();
        }
        input.value = "";
        if (untaggedOnly) {
          removeCardFromGrid(card);
        }
      } catch (err) {
        updateStatus(err.message);
      }
    });

    const notesDetails = card.querySelector(".tweet-notes-details");
    const notesSummary = notesDetails.querySelector("summary");
    const notesForm = card.querySelector(".tweet-notes-form");
    const notesInput = card.querySelector(".tweet-notes");
    const notesLinksWrap = card.querySelector(".tweet-notes-links");
    const notesStatus = card.querySelector(".tweet-notes-status");
    const notesSaveButton = notesForm.querySelector("button[type='submit']");
    const openAiLinkBtn = card.querySelector(".open-ai-link-btn");
    const updateNoteLinksUi = (text) => {
      const urls = extractNoteUrls(text);
      notesLinksWrap.replaceChildren();
      if (!urls.length) {
        notesLinksWrap.classList.add("hidden");
        notesLinksWrap.classList.remove("flex");
        openAiLinkBtn.classList.add("hidden");
        openAiLinkBtn.classList.remove("inline-flex");
        openAiLinkBtn.removeAttribute("href");
        return;
      }

      const items = urls.map((url) => ({ url, ...getNoteLinkMeta(url) }));
      items.forEach((item) => {
        const chip = document.createElement("a");
        chip.href = item.url;
        chip.target = "_blank";
        chip.rel = "noreferrer noopener";
        chip.title = item.title;
        chip.className = item.isAi
          ? "inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100"
          : "inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100";
        chip.textContent = item.label;
        notesLinksWrap.appendChild(chip);
      });
      notesLinksWrap.classList.remove("hidden");
      notesLinksWrap.classList.add("flex");

      const primaryItem = items.find((item) => item.isAi) || items[0];
      openAiLinkBtn.href = primaryItem.url;
      openAiLinkBtn.title = primaryItem.title;
      openAiLinkBtn.setAttribute("aria-label", primaryItem.title);
      openAiLinkBtn.classList.remove("hidden");
      openAiLinkBtn.classList.add("inline-flex");
    };
    const savedNotes = tweet.notes || "";
    const resizeNotesInput = () => {
      notesInput.style.height = "auto";
      notesInput.style.height = `${notesInput.scrollHeight}px`;
    };

    notesInput.value = savedNotes;
    if (savedNotes.trim()) {
      notesDetails.open = true;
      notesSummary.textContent = "Recherche";
    }
    resizeNotesInput();
    updateNoteLinksUi(savedNotes);
    notesInput.addEventListener("input", () => {
      resizeNotesInput();
      updateNoteLinksUi(notesInput.value);
    });
    notesDetails.addEventListener("toggle", () => {
      if (notesDetails.open) resizeNotesInput();
    });
    notesForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      notesSaveButton.disabled = true;
      notesStatus.textContent = "Speichere...";
      notesStatus.classList.remove("text-rose-600");
      notesStatus.classList.add("text-slate-500");
      try {
        await saveTweetNotes(tweet.id, notesInput.value);
        notesStatus.textContent = "Notiz gespeichert";
        notesSummary.textContent = "Recherche";
      } catch (error) {
        notesStatus.textContent = error.message;
        notesStatus.classList.remove("text-slate-500");
        notesStatus.classList.add("text-rose-600");
      } finally {
        notesSaveButton.disabled = false;
      }
    });

    const deleteBtn = card.querySelector(".delete-btn");
    const openOriginalBtn = card.querySelector(".open-original-btn");

    if (tweet.url) {
      openOriginalBtn.href = tweet.url;
    } else {
      openOriginalBtn.classList.add("hidden");
    }

    deleteBtn.addEventListener("click", async () => {
      if (!window.confirm("Diesen Tweet wirklich loeschen?")) return;
      try {
          const data = await deleteTweet(tweet.id);
          if (Array.isArray(data.tags)) {
            knownTags = data.tags;
          }
          if (currentTag && !knownTags.some((item) => item.name.toLocaleLowerCase() === currentTag.toLocaleLowerCase())) {
            currentTag = "";
            await loadTweets({ reset: true });
            return;
          }
          buildFilterBar();
          removeCardFromGrid(card);

      } catch (err) {
        updateStatus(err.message);
      }
    });

    tweetGrid.appendChild(card);
    updateTweetTextOverflow(tweetText, true);
  });
}

// Videos bekommen erst kurz vor dem Sichtbarwerden eine Quelle; metadata genuegt fuer das erste Bild.
const videoObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target;
      video.preload = "metadata";
      video.src = video.dataset.src;
      videoObserver.unobserve(video);
    }
  },
  { rootMargin: "400px" }
);

const PAGE_SIZE = 30;
const loadMoreSentinel = document.getElementById("loadMoreSentinel");
let nextCursor = null;
let loadedCount = 0;
let loadingMore = false;
let requestSeq = 0;

// Ein erneutes observe() loest den Callback sofort aus, falls der Sentinel noch sichtbar ist.
const sentinelObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMoreTweets();
  },
  { rootMargin: "800px" }
);

function observeSentinel() {
  sentinelObserver.unobserve(loadMoreSentinel);
  sentinelObserver.observe(loadMoreSentinel);
}

function buildTweetQuery(extra) {
  const params = new URLSearchParams(extra);
  const q = searchInput.value.trim();
  if (q) params.set("q", q);
  if (untaggedOnly) params.set("untagged", "1");
  else if (currentTag) params.set("tag", currentTag);
  return params;
}

function updateLoadedStatus() {
  updateStatus(`${loadedCount} Tweet(s) geladen`);
}

// reset=false laedt so viele Tweets neu, wie bereits angezeigt werden, damit die Scrollposition erhalten bleibt.
async function loadTweets({ reset = false } = {}) {
  const seq = ++requestSeq;
  const limit = reset ? PAGE_SIZE : Math.max(PAGE_SIZE, loadedCount);
  const scrollY = window.scrollY;
  const anchorCard = reset
    ? null
    : [...tweetGrid.children].find((card) => card.getBoundingClientRect().bottom > 0);
  const anchorTweetId = anchorCard?.dataset.tweetId;
  const anchorTop = anchorCard?.getBoundingClientRect().top;

  updateStatus("Lade Tweets...");

  try {
    const response = await fetch(`${API_BASE}/tweets?${buildTweetQuery({ limit })}`);
    if (!response.ok) {
      throw new Error(`Fehler beim Laden: ${response.status}`);
    }
    const data = await response.json();
    if (seq !== requestSeq) return;

    const tweets = Array.isArray(data.tweets) ? data.tweets : [];
    knownTags = Array.isArray(data.tags) ? data.tags : [];
    if (currentTag && !knownTags.some((tag) => tag.name.toLowerCase() === currentTag.toLowerCase())) {
      currentTag = "";
      return loadTweets({ reset: true });
    }
    loadedCount = tweets.length;
    nextCursor = data.next_cursor || null;
    buildFilterBar();
    renderTweets(tweets);
    if (!reset) {
      const replacementCard = [...tweetGrid.children].find((card) => card.dataset.tweetId === anchorTweetId);
      if (replacementCard && anchorTop !== undefined) {
        window.scrollTo(0, window.scrollY + replacementCard.getBoundingClientRect().top - anchorTop);
      } else {
        window.scrollTo(0, scrollY);
      }
    }
    updateLoadedStatus();
    observeSentinel();
  } catch (error) {
    if (seq !== requestSeq) return;
    updateStatus(`Backend nicht erreichbar (${error.message})`);
    tweetGrid.innerHTML = "";
  }
}

async function loadMoreTweets() {
  if (!nextCursor || loadingMore) return;

  loadingMore = true;
  const seq = requestSeq;
  let failed = false;

  try {
    const response = await fetch(`${API_BASE}/tweets?${buildTweetQuery({ limit: PAGE_SIZE, cursor: nextCursor })}`);
    if (!response.ok) {
      throw new Error(`Fehler beim Laden: ${response.status}`);
    }
    const data = await response.json();
    if (seq !== requestSeq) return;

    const tweets = Array.isArray(data.tweets) ? data.tweets : [];
    renderTweets(tweets, true);
    loadedCount += tweets.length;
    nextCursor = data.next_cursor || null;
    updateLoadedStatus();
  } catch (error) {
    failed = true;
    updateStatus(`Nachladen fehlgeschlagen (${error.message})`);
  } finally {
    loadingMore = false;
    if (!failed) observeSentinel();
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadTweets({ reset: true }), 250);
});

refreshBtn.addEventListener("click", () => loadTweets({ reset: true }));

const settingsDialog = document.getElementById("settingsDialog");
document.getElementById("settingsBtn").addEventListener("click", () => settingsDialog.showModal());
document.getElementById("settingsCloseBtn").addEventListener("click", () => settingsDialog.close());
document.getElementById("resetSettingsBtn").addEventListener("click", () => {
  updateTweetTextSize(DEFAULT_TWEET_TEXT_SIZE);
  localStorage.setItem(TWEET_TEXT_SIZE_KEY, String(DEFAULT_TWEET_TEXT_SIZE));
});
tweetTextSizeInput.addEventListener("input", () => {
  const size = Number(tweetTextSizeInput.value);
  updateTweetTextSize(size);
  localStorage.setItem(TWEET_TEXT_SIZE_KEY, String(size));
});
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

const importDialog = document.getElementById("importDialog");
const importForm = document.getElementById("importForm");
const importUrls = document.getElementById("importUrls");
const importResults = document.getElementById("importResults");
const importSubmitBtn = document.getElementById("importSubmitBtn");

document.getElementById("importBtn").addEventListener("click", () => {
  importResults.innerHTML = "";
  importDialog.showModal();
  importUrls.focus();
});
document.getElementById("importCancelBtn").addEventListener("click", () => importDialog.close());
importDialog.addEventListener("click", (event) => {
  if (event.target === importDialog) importDialog.close();
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const urls = importUrls.value.split(/\s+/).filter(Boolean);
  if (!urls.length) return;

  importSubmitBtn.disabled = true;
  importSubmitBtn.textContent = "Importiere...";
  importResults.innerHTML = "";

  try {
    const response = await fetch(`${API_BASE}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    data.results.forEach((result) => {
      const row = document.createElement("div");
      row.className = `break-all py-0.5 ${result.ok ? (result.skipped ? "text-slate-500" : "text-teal-700") : "text-rose-600"}`;
      row.textContent = result.ok
        ? `${result.skipped ? "Bereits vorhanden" : "OK"}: ${result.url}`
        : `Fehler: ${result.url} (${result.error})`;
      importResults.appendChild(row);
    });

    const failed = data.results.filter((result) => !result.ok).map((result) => result.url);
    importUrls.value = failed.join("\n");
    await loadTweets();
  } catch (error) {
    importResults.textContent = `Import fehlgeschlagen: ${error.message}`;
    importResults.className = "mt-3 max-h-48 overflow-y-auto text-sm text-rose-600";
  } finally {
    importSubmitBtn.disabled = false;
    importSubmitBtn.textContent = "Importieren";
  }
});

const backupDialog = document.getElementById("backupDialog");
const backupImportForm = document.getElementById("backupImportForm");
const backupFileInput = document.getElementById("backupFileInput");
const backupImportResults = document.getElementById("backupImportResults");
const backupImportSubmitBtn = document.getElementById("backupImportSubmitBtn");

document.getElementById("backupBtn").addEventListener("click", () => {
  backupImportResults.textContent = "";
  backupImportResults.className = "mt-3 text-sm";
  backupDialog.showModal();
});
document.getElementById("backupCloseBtn").addEventListener("click", () => backupDialog.close());
backupDialog.addEventListener("click", (event) => {
  if (event.target === backupDialog) backupDialog.close();
});

backupImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = backupFileInput.files && backupFileInput.files[0];
  if (!file) {
    backupImportResults.textContent = "Bitte zuerst eine JSONL-Datei auswaehlen.";
    backupImportResults.className = "mt-3 text-sm text-rose-600";
    return;
  }

  backupImportSubmitBtn.disabled = true;
  backupImportSubmitBtn.textContent = "Importiere...";
  backupImportResults.textContent = "";
  backupImportResults.className = "mt-3 text-sm text-slate-600";

  try {
    const jsonl = await file.text();
    const response = await fetch(`${API_BASE}/backup/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonl })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    backupImportResults.textContent =
      `Import abgeschlossen: ${data.imported} neu importiert, ${data.skipped} bereits vorhanden (uebersprungen).`;
    backupImportResults.className = "mt-3 text-sm text-teal-700";
    backupFileInput.value = "";
    await loadTweets({ reset: true });
  } catch (error) {
    backupImportResults.textContent = `Import fehlgeschlagen: ${error.message}`;
    backupImportResults.className = "mt-3 text-sm text-rose-600";
  } finally {
    backupImportSubmitBtn.disabled = false;
    backupImportSubmitBtn.textContent = "JSONL importieren";
  }
});

lightboxCloseBtn.addEventListener("click", closeImageLightbox);
imageLightbox.addEventListener("click", (event) => {
  if (event.target === imageLightbox) {
    closeImageLightbox();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageLightbox.classList.contains("hidden")) {
    closeImageLightbox();
  }
});

loadTweets();
