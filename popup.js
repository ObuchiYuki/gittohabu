
"use strict";

const toggleEnabled = document.getElementById("toggleEnabled");
const translateNowButton = document.getElementById("translateNowButton");

async function init() {
  const defaultConfiguration = { isEnabledOnGithub: true };
  const { isEnabledOnGithub } = await chrome.storage.sync.get(defaultConfiguration);
  toggleEnabled.checked = Boolean(isEnabledOnGithub);
}
init();

toggleEnabled.addEventListener("change", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.sync.set({ isEnabledOnGithub: toggleEnabled.checked });
  if (tab && /https:\/\/(gist\.)?github\.com/.test(tab.url || "")) {
    chrome.tabs.sendMessage(tab.id, { type: "github-ja-set-enabled", value: toggleEnabled.checked });
  }
});

translateNowButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /https:\/\/(gist\.)?github\.com/.test(tab.url || "")) {
    chrome.tabs.sendMessage(tab.id, { type: "github-ja-translate-now" }, (res) => {
      window.close();
    });
  }
});
