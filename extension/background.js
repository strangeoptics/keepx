const API_URL = "http://localhost:3000/api/tweets";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "SAVE_TWEET") {
    return false;
  }

  (async () => {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload)
      });

      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await response.json()
        : { text: await response.text() };

      if (!response.ok) {
        sendResponse({ ok: false, status: response.status, data });
        return;
      }

      sendResponse({ ok: true, status: response.status, data });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});
