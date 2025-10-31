
"use strict";

const defaultConfiguration = {
  isEnabledOnGithub: true,
  useTranslationApi: false,
  translationProvider: "None",
  translationApiKey: "",
  translationRegion: "",
  translationAggressiveness: "balanced",
};

const elements = {
  isEnabledOnGithub: document.getElementById("isEnabledOnGithub"),
  useTranslationApi: document.getElementById("useTranslationApi"),
  translationProvider: document.getElementById("translationProvider"),
  translationApiKey: document.getElementById("translationApiKey"),
  translationRegion: document.getElementById("translationRegion"),
  translationAggressiveness: document.getElementById("translationAggressiveness"),
  saveButton: document.getElementById("saveButton"),
  clearButton: document.getElementById("clearButton"),
  testButton: document.getElementById("testButton"),
  status: document.getElementById("status"),
};

async function loadConfiguration() {
  const stored = await chrome.storage.sync.get(defaultConfiguration);
  for (const [key, value] of Object.entries({ ...defaultConfiguration, ...stored })) {
    if (elements[key] instanceof HTMLInputElement && elements[key].type === "checkbox") {
      elements[key].checked = Boolean(value);
    } else if (elements[key]) {
      elements[key].value = value || "";
    }
  }
}
function showStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#ff9999" : "#8b949e";
}

async function saveConfiguration() {
  const configuration = {
    isEnabledOnGithub: elements.isEnabledOnGithub.checked,
    useTranslationApi: elements.useTranslationApi.checked,
    translationProvider: elements.translationProvider.value,
    translationApiKey: elements.translationApiKey.value,
    translationRegion: elements.translationRegion.value,
    translationAggressiveness: elements.translationAggressiveness.value,
  };
  await chrome.storage.sync.set(configuration);
  showStatus("保存しました。GitHub のページを再読み込みしてください。");
}

async function clearConfiguration() {
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(defaultConfiguration);
  await loadConfiguration();
  showStatus("設定を初期化しました。");
}

async function testTranslation() {
  const stored = await chrome.storage.sync.get(defaultConfiguration);
  if (!stored.useTranslationApi || stored.translationProvider === "None") {
    showStatus("翻訳 API は無効です。まず有効化してください。", true);
    return;
    }
  if (!stored.translationApiKey) {
    showStatus("API キーが設定されていません。", true);
    return;
  }
  showStatus("テスト中...");
  try {
    const sample = "Hello, this is a translation test.";
    // content.js と同等のエンドポイントで簡易テスト
    if (stored.translationProvider === "DeepL") {
      const apiKey = stored.translationApiKey.trim();
      const endpoint = apiKey.startsWith("free:") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
      const realKey = apiKey.startsWith("free:") ? apiKey.replace(/^free:/, "") : apiKey;
      const body = new URLSearchParams();
      body.append("text", sample);
      body.append("target_lang", "JA");
      const res = await fetch(endpoint, { method: "POST", headers: { "Authorization": `DeepL-Auth-Key ${realKey}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      showStatus(`成功: ${data.translations?.[0]?.text}`);
    } else if (stored.translationProvider === "Google") {
      const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(stored.translationApiKey.trim())}`;
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: [sample], target: "ja", format: "text" }) });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      showStatus(`成功: ${data.data?.translations?.[0]?.translatedText}`);
    } else if (stored.translationProvider === "Azure") {
      const endpoint = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ja";
      const headers = {
        "Ocp-Apim-Subscription-Key": stored.translationApiKey.trim(),
        "Content-Type": "application/json"
      };
      if (stored.translationRegion.trim()) headers["Ocp-Apim-Subscription-Region"] = stored.translationRegion.trim();
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify([{ Text: sample }]) });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      showStatus(`成功: ${data[0]?.translations?.[0]?.text}`);
    } else {
      showStatus("不明な翻訳提供者です。", true);
    }
  } catch (e) {
    showStatus(`失敗: ${String(e)}`, true);
  }
}

elements.saveButton.addEventListener("click", saveConfiguration);
elements.clearButton.addEventListener("click", clearConfiguration);
elements.testButton.addEventListener("click", testTranslation);

loadConfiguration();
