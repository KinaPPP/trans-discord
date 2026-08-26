// Google翻訳とDeepLの両方でだいたい共通して使える主要言語コード
// （DeepL側は送信時に大文字化するので、ここは小文字のコードで統一する）
// 表示名はi18nメッセージ（lang_xx）から取得する
const LANGUAGE_CODES = [
  "ja", "en", "zh", "ko", "fr", "de", "es", "pt", "it", "ru", "th", "vi", "id",
];

const DEFAULT_SETTINGS = {
  translationProvider: "google",
  deeplApiKey: "",
  geminiApiKey: "",
  geminiTone: "auto",
  sourceLang: "auto",
  targetLang: "ja",
  skipNativeLanguage: true,
  skipShortMessages: true,
};

const providerSelect = document.getElementById("providerSelect");
const deeplKeyInput = document.getElementById("deeplKeyInput");
const geminiKeyInput = document.getElementById("geminiKeyInput");
const geminiToneSelect = document.getElementById("geminiToneSelect");
const sourceLangSelect = document.getElementById("sourceLangSelect");
const targetLangSelect = document.getElementById("targetLangSelect");
const skipNativeLanguageToggle = document.getElementById("skipNativeLanguageToggle");
const skipShortMessagesToggle = document.getElementById("skipShortMessagesToggle");

// 翻訳元セレクトを構築（自動検出 + 言語一覧）
const autoOption = document.createElement("option");
autoOption.value = "auto";
autoOption.textContent = chrome.i18n.getMessage("lang_auto");
sourceLangSelect.appendChild(autoOption);
LANGUAGE_CODES.forEach((code) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = chrome.i18n.getMessage(`lang_${code}`);
  sourceLangSelect.appendChild(opt);
});

// 翻訳先セレクトを構築（ブラウザの言語設定に合わせる + 言語一覧）
const browserOption = document.createElement("option");
browserOption.value = "browser";
browserOption.textContent = chrome.i18n.getMessage("lang_browser");
targetLangSelect.appendChild(browserOption);
LANGUAGE_CODES.forEach((code) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = chrome.i18n.getMessage(`lang_${code}`);
  targetLangSelect.appendChild(opt);
});

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  providerSelect.value = result.translationProvider;
  deeplKeyInput.value = result.deeplApiKey;
  geminiKeyInput.value = result.geminiApiKey;
  geminiToneSelect.value = result.geminiTone;
  sourceLangSelect.value = result.sourceLang;
  targetLangSelect.value = result.targetLang;
  skipNativeLanguageToggle.checked = result.skipNativeLanguage;
  skipShortMessagesToggle.checked = result.skipShortMessages;
});

providerSelect.addEventListener("change", () => {
  chrome.storage.local.set({ translationProvider: providerSelect.value });
});

deeplKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ deeplApiKey: deeplKeyInput.value.trim() });
});

geminiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ geminiApiKey: geminiKeyInput.value.trim() });
});

geminiToneSelect.addEventListener("change", () => {
  chrome.storage.local.set({ geminiTone: geminiToneSelect.value });
});

sourceLangSelect.addEventListener("change", () => {
  chrome.storage.local.set({ sourceLang: sourceLangSelect.value });
});

targetLangSelect.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: targetLangSelect.value });
});

skipNativeLanguageToggle.addEventListener("change", () => {
  chrome.storage.local.set({ skipNativeLanguage: skipNativeLanguageToggle.checked });
});

skipShortMessagesToggle.addEventListener("change", () => {
  chrome.storage.local.set({ skipShortMessages: skipShortMessagesToggle.checked });
});

// --- DeepL使用量表示 ---
const deeplUsageBox = document.getElementById("deeplUsageBox");
const deeplUsageRefreshButton = document.getElementById("deeplUsageRefreshButton");

async function fetchDeeplUsage(apiKey) {
  const isFree = apiKey.endsWith(":fx");
  const base = isFree ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const res = await fetch(`${base}/v2/usage`, {
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json(); // { character_count, character_limit }
}

async function refreshDeeplUsage() {
  const apiKey = deeplKeyInput.value.trim();
  if (!apiKey) {
    deeplUsageBox.textContent = chrome.i18n.getMessage("options_deeplUsageEmptyKey");
    return;
  }

  deeplUsageBox.textContent = chrome.i18n.getMessage("options_deeplUsageChecking");
  try {
    const usage = await fetchDeeplUsage(apiKey);
    const remaining = usage.character_limit - usage.character_count;
    const percent = Math.round(
      (usage.character_count / usage.character_limit) * 100
    );
    deeplUsageBox.textContent = chrome.i18n.getMessage("options_deeplUsageResult", [
      usage.character_count.toLocaleString(),
      usage.character_limit.toLocaleString(),
      String(percent),
      remaining.toLocaleString(),
    ]);
  } catch (err) {
    deeplUsageBox.textContent = chrome.i18n.getMessage("options_deeplUsageError");
  }
}

deeplUsageRefreshButton.addEventListener("click", refreshDeeplUsage);

// ページを開いたとき、既にキーが設定済みなら自動で一度取得する
chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  if (result.deeplApiKey) refreshDeeplUsage();
});
