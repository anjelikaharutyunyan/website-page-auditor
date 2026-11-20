"use strict";

document.getElementById("choosePage").addEventListener("click", async () => {
  const current = await chrome.tabs.getCurrent().catch(() => null);
  if (current && current.id !== undefined) await chrome.tabs.remove(current.id).catch(() => window.close());
  else window.close();
});
