
"use strict";

/**
 * GitHub 日本語化メインロジック
 * - 内蔵辞書での置換
 * - 任意の翻訳 API（DeepL / Google Cloud / Azure）による補完（オプション）
 * - MutationObserver で動的に更新される DOM に追従
 * - コードや差分など翻訳すべきでない領域は除外
 */

const defaultConfiguration = {
  isEnabledOnGithub: true,
  useTranslationApi: false,
  translationProvider: "None", // "None" | "DeepL" | "Google" | "Azure"
  translationApiKey: "",
  translationRegion: "", // Azure で必要
  translationAggressiveness: "balanced", // "conservative" | "balanced" | "aggressive"
};

let currentConfiguration = { ...defaultConfiguration };

// 1. 初期化
(async function initializeJapaneseTranslator() {
  try {
    document.documentElement.setAttribute("lang", "ja");
    const stored = await chrome.storage.sync.get(defaultConfiguration);
    currentConfiguration = { ...defaultConfiguration, ...stored };
    if (!currentConfiguration.isEnabledOnGithub) return;

    startObservingAndTranslating();

    // キーボードショートカット（Alt+J）で強制翻訳をトグル
    window.addEventListener("keydown", (event) => {
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "j") {
        currentConfiguration.isEnabledOnGithub = !currentConfiguration.isEnabledOnGithub;
        chrome.storage.sync.set({ isEnabledOnGithub: currentConfiguration.isEnabledOnGithub });
        if (currentConfiguration.isEnabledOnGithub) {
          translateEntireDocumentNow();
        } else {
          location.reload();
        }
      }
    });

    // ポップアップからの明示的なリクエストに応えます。
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === "github-ja-translate-now") {
        translateEntireDocumentNow().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
      }
      if (message && message.type === "github-ja-get-status") {
        sendResponse({ configuration: currentConfiguration });
        return true;
      }
      if (message && message.type === "github-ja-set-enabled") {
        currentConfiguration.isEnabledOnGithub = Boolean(message.value);
        chrome.storage.sync.set({ isEnabledOnGithub: currentConfiguration.isEnabledOnGithub });
        if (currentConfiguration.isEnabledOnGithub) {
          translateEntireDocumentNow();
        } else {
          location.reload();
        }
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (error) {
    console.error("[github-ja] 初期化に失敗:", error);
  }
})();

// 2. 監視と翻訳の本体
let domObserver = null;
let translatedTextNodeWeakSet = new WeakSet();

function startObservingAndTranslating() {
  translateEntireDocumentNow();
  const observerOptions = { childList: true, subtree: true, characterData: true };
  domObserver = new MutationObserver(debounce(() => {
    if (!currentConfiguration.isEnabledOnGithub) return;
    translateNewOrChangedNodes();
    translateAttributesForInteractiveElements();
  }, 250));
  domObserver.observe(document.documentElement, observerOptions);

  // SPA 遷移に対応（GitHub は pjax を多用）
  window.addEventListener("pjax:end", () => {
    setTimeout(() => translateEntireDocumentNow(), 150);
  });
}

function translateEntireDocumentNow() {
  translateTextNodesIn(document.body);
  translateAttributesForInteractiveElements();
}

function translateNewOrChangedNodes() {
  translateTextNodesIn(document.body, true);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), delay);
  };
}

// 3. テキストノードの走査と翻訳
function translateTextNodesIn(rootNode, onlyUntranslated = false) {
  const treeWalker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parentElement = node.parentElement;
      if (!parentElement) return NodeFilter.FILTER_REJECT;
      if (shouldSkipElement(parentElement)) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      if (onlyUntranslated && translatedTextNodeWeakSet.has(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let currentNode;
  while ((currentNode = treeWalker.nextNode())) {
    const originalText = currentNode.nodeValue;
    const translatedByDictionary = translateByDictionary(originalText);

    let finalText = translatedByDictionary;
    if (currentConfiguration.useTranslationApi && finalText === originalText) {
      // 辞書で変化がなかった場合のみ API を利用
      finalText = translateByOptionalApiSyncPlaceholder(originalText); // API 呼び出しは非同期だが、ここでは占位で同期適用（後から非同期で置換）
    }

    if (finalText && finalText !== originalText) {
      currentNode.nodeValue = finalText;
    }
    translatedTextNodeWeakSet.add(currentNode);
  }

  // 非同期 API の翻訳は最後にまとめて走らせる
  if (currentConfiguration.useTranslationApi) {
    requestAsyncTranslationForVisibleTextNodes();
  }
}

// 4. 属性の翻訳（placeholder、title、aria-label など）
function translateAttributesForInteractiveElements() {
  const selector = [
    "input[placeholder]",
    "textarea[placeholder]",
    "[aria-label]",
    "[title]",
    "button[title]"
  ].join(",");

  document.querySelectorAll(selector).forEach((element) => {
    if (shouldSkipElement(element)) return;

    const attributesToTranslate = ["placeholder", "title", "aria-label"];
    for (const attributeName of attributesToTranslate) {
      const original = element.getAttribute(attributeName);
      if (!original) continue;
      const translated = translateByDictionary(original);
      if (translated !== original) {
        element.setAttribute(attributeName, translated);
      } else if (currentConfiguration.useTranslationApi) {
        translateByOptionalApi(original).then((text) => {
          if (text && text !== original) element.setAttribute(attributeName, text);
        }).catch(() => {});
      }
    }
  });
}

// 5. スキップ条件（コード、差分、テーブルのコード領域など）
function shouldSkipElement(element) {
  if (!element) return true;
  if (element.closest("[data-no-translate]")) return true;
  const tagName = element.tagName.toLowerCase();
  if (["code", "pre", "kbd", "samp", "var", "script", "style", "noscript"].includes(tagName)) return true;
  if (element.closest(".blob-code, .highlight, .diff-table, .CodeMirror, .cm-editor, .react-code-viewer, .js-code-block-container")) return true;
  if (element.closest("svg, math")) return true;
  return false;
}

// 6. 辞書置換（単語境界を考慮）
let compiledDictionaryPatterns = null;

function compileDictionary() {
  if (compiledDictionaryPatterns) return compiledDictionaryPatterns;
  compiledDictionaryPatterns = GITHUB_JA_DICTIONARY_SORTED.map(([english, japanese]) => {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 単語境界を基本としつつ、記号で挟まれるケースも拾う
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    return { pattern, replacement: japanese };
  });
  return compiledDictionaryPatterns;
}

function translateByDictionary(text) {
  const patterns = compileDictionary();
  let output = text;
  for (const { pattern, replacement } of patterns) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

// 7. 翻訳 API（オプション）
//   ここでは非同期呼び出しを集約して重複を抑制します。
let pendingAsyncTextsSet = new Set();
let pendingAsyncTimer = null;

function requestAsyncTranslationForVisibleTextNodes() {
  if (!currentConfiguration.useTranslationApi) return;
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue || "";
      const trimmed = text.trim();
      if (!trimmed) return NodeFilter.FILTER_REJECT;
      if (trimmed.length < 4) return NodeFilter.FILTER_REJECT;
      // 既に辞書で置換済みで日本語っぽい場合は無視
      if (/[ぁ-んァ-ン一-龯]/.test(trimmed)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node;
  while ((node = walker.nextNode())) {
    pendingAsyncTextsSet.add(node.nodeValue);
  }

  if (pendingAsyncTimer) clearTimeout(pendingAsyncTimer);
  pendingAsyncTimer = setTimeout(async () => {
    const texts = Array.from(pendingAsyncTextsSet).slice(0, 50); // バッチ
    pendingAsyncTextsSet.clear();
    if (texts.length === 0) return;
    try {
      const translatedList = await translateListByOptionalApi(texts);
      // 置換を反映
      const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
          const text = node.nodeValue || "";
          if (!text.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node2;
      while ((node2 = walker2.nextNode())) {
        const i = texts.indexOf(node2.nodeValue);
        if (i >= 0) {
          const candidate = translatedList[i];
          if (candidate && candidate !== node2.nodeValue) {
            node2.nodeValue = candidate;
          }
        }
      }
    } catch (e) {
      console.warn("[github-ja] 翻訳 API 呼び出しに失敗:", e);
    }
  }, 300);
}

function translateByOptionalApiSyncPlaceholder(text) {
  // 同期処理では辞書に無い場合はそのまま返し、非同期のバッチ処理に任せます。
  pendingAsyncTextsSet.add(text);
  if (pendingAsyncTimer) {
    // no-op
  }
  return text;
}

// 実際の API 呼び出し
async function translateByOptionalApi(text) {
  const provider = currentConfiguration.translationProvider;
  if (!currentConfiguration.useTranslationApi || provider === "None") {
    return text;
  }
  if (!currentConfiguration.translationApiKey) {
    console.warn("[github-ja] 翻訳 API キーが設定されていません。");
    return text;
  }
  try {
    if (provider === "DeepL") {
      return await translateWithDeepL([text]).then(list => list[0] || text);
    } else if (provider === "Google") {
      return await translateWithGoogle([text]).then(list => list[0] || text);
    } else if (provider === "Azure") {
      return await translateWithAzure([text]).then(list => list[0] || text);
    }
  } catch (e) {
    console.warn("[github-ja] 翻訳 API エラー:", e);
  }
  return text;
}

async function translateListByOptionalApi(textList) {
  const provider = currentConfiguration.translationProvider;
  if (!currentConfiguration.useTranslationApi || provider === "None") {
    return textList;
  }
  if (!currentConfiguration.translationApiKey) {
    return textList;
  }
  if (provider === "DeepL") {
    return await translateWithDeepL(textList);
  } else if (provider === "Google") {
    return await translateWithGoogle(textList);
  } else if (provider === "Azure") {
    return await translateWithAzure(textList);
  } else {
    return textList;
  }
}

// DeepL API (v2)
async function translateWithDeepL(textList) {
  const apiKey = currentConfiguration.translationApiKey.trim();
  const endpoint = apiKey.startsWith("free:") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
  const realKey = apiKey.startsWith("free:") ? apiKey.replace(/^free:/, "") : apiKey;
  const body = new URLSearchParams();
  for (const t of textList) {
    body.append("text", t);
  }
  body.append("target_lang", "JA");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${realKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
  const data = await res.json();
  // { translations: [{text: "..."}] }
  return (data.translations || []).map(x => x.text);
}

// Google Cloud Translation API v2 (simple key)
async function translateWithGoogle(textList) {
  const apiKey = currentConfiguration.translationApiKey.trim();
  const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
  const body = {
    q: textList,
    target: "ja",
    format: "text"
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = await res.json();
  // { data: { translations: [{translatedText: "..."}] } }
  return (data.data?.translations || []).map(x => x.translatedText || "");
}

// Azure Translator Text API v3
async function translateWithAzure(textList) {
  const apiKey = currentConfiguration.translationApiKey.trim();
  const region = currentConfiguration.translationRegion.trim();
  const endpoint = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ja";
  const body = textList.map(t => ({ Text: t }));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      ...(region ? { "Ocp-Apim-Subscription-Region": region } : {}),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Azure Translator HTTP ${res.status}`);
  const data = await res.json();
  // [ { translations: [{ text: "...", to: "ja" }] } ]
  return data.map(item => item.translations?.[0]?.text || "");
}
