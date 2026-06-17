try {
  chrome.runtime.sendMessage({
    type: "agent_browser_page_seen",
    url: window.location.href,
    title: document.title || "",
    timestamp: new Date().toISOString(),
  }).catch(() => {});
} catch {
  // The bridge wakeup is best-effort; page scripts must never be affected.
}
