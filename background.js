const cache = new Map();
const queue = [];
let isRunning = false;
let consecutiveFailures = 0;

// 翻訳エンジン・言語ペアの設定（オプションページから変更可能）
let translationProvider = "google"; // "google" | "deepl"
let deeplApiKey = "";
let sourceLang = "auto"; // "auto" または言語コード（例: "en"）
let targetLang = "ja"; // "browser"（ブラウザの言語設定）または言語コード

const SETTINGS_DEFAULTS = {
  translationProvider: "google",
  deeplApiKey: "",
  sourceLang: "auto",
  targetLang: "ja",
};

chrome.storage.local.get(SETTINGS_DEFAULTS, (result) => {
  translationProvider = result.translationProvider;
  deeplApiKey = result.deeplApiKey;
  sourceLang = result.sourceLang;
  targetLang = result.targetLang;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.translationProvider) {
    translationProvider = changes.translationProvider.newValue;
  }
  if (changes.deeplApiKey) {
    deeplApiKey = changes.deeplApiKey.newValue;
  }
  if (changes.sourceLang) {
    sourceLang = changes.sourceLang.newValue;
  }
  if (changes.targetLang) {
    targetLang = changes.targetLang.newValue;
  }
});

const BASE_DELAY = 250;
const MAX_DELAY = 30000; // 最大30秒まで間隔を広げる

function getDelay() {
  if (consecutiveFailures === 0) return BASE_DELAY;
  return Math.min(BASE_DELAY * 2 ** consecutiveFailures, MAX_DELAY);
}

// "browser"指定時はブラウザのUI言語（例: "ja-JP" → "ja"）を実際の翻訳先言語として使う
function resolveTargetLang() {
  if (targetLang === "browser") {
    const uiLang = chrome.i18n.getUILanguage() || "ja";
    return uiLang.split("-")[0];
  }
  return targetLang;
}

async function translateWithGoogle(text) {
  const tl = resolveTargetLang();
  const sl = sourceLang === "auto" ? "auto" : sourceLang;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    referrer: "https://translate.google.com/",
  });

  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`HTTP_${res.status}`);

  const data = await res.json();
  if (data && Array.isArray(data[0])) {
    return data[0].map((chunk) => (chunk && chunk[0] ? chunk[0] : "")).join("");
  }
  // CAPTCHAページ等でJSON構造が崩れているケースもここに含める
  throw new Error("UNEXPECTED_FORMAT");
}

async function translateWithDeepL(text, apiKey) {
  // 無料キーは末尾が ":fx"。エンドポイントのホストが異なる
  const isFree = apiKey.endsWith(":fx");
  const base = isFree ? "https://api-free.deepl.com" : "https://api.deepl.com";

  const tl = resolveTargetLang().toUpperCase();
  const params = { text, target_lang: tl };
  if (sourceLang !== "auto") {
    params.source_lang = sourceLang.toUpperCase();
  }

  const res = await fetch(`${base}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  if (!res.ok) throw new Error(`DEEPL_HTTP_${res.status}`);

  const data = await res.json();
  if (data && Array.isArray(data.translations) && data.translations[0]) {
    return data.translations[0].text;
  }
  throw new Error("DEEPL_UNEXPECTED_FORMAT");
}

async function translateText(text) {
  if (translationProvider === "deepl" && deeplApiKey) {
    try {
      return await translateWithDeepL(text, deeplApiKey);
    } catch (deeplErr) {
      console.log(
        "[トランス☆ディスコ] DeepL失敗、Google翻訳にフォールバック:",
        deeplErr.message
      );
      return await translateWithGoogle(text);
    }
  }
  return await translateWithGoogle(text);
}

async function processQueue() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;

  while (queue.length > 0) {
    const { text, sendResponse } = queue.shift();
    const cacheKey = `${translationProvider}:${sourceLang}:${targetLang}:${text}`;

    if (cache.has(cacheKey)) {
      sendResponse({ success: true, text: cache.get(cacheKey) });
      continue;
    }

    try {
      const translatedText = await translateText(text);
      cache.set(cacheKey, translatedText);
      sendResponse({ success: true, text: translatedText });
      consecutiveFailures = 0; // 成功したらリセット
    } catch (err) {
      consecutiveFailures++;
      sendResponse({ success: false, error: err.message });
    }

    // 失敗が続くほど待機時間を指数的に延ばす（Google翻訳側のレート制限対策）
    await new Promise((resolve) => setTimeout(resolve, getDelay()));
  }

  isRunning = false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    queue.push({ text: request.text, sendResponse });
    processQueue();
    return true;
  }
});
