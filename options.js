// Google翻訳とDeepLの両方でだいたい共通して使える主要言語コード
// （DeepL側は送信時に大文字化するので、ここは小文字のコードで統一する）
const LANGUAGES = [
  { code: "ja", label: "日本語" },
  { code: "en", label: "英語" },
  { code: "zh", label: "中国語" },
  { code: "ko", label: "韓国語" },
  { code: "fr", label: "フランス語" },
  { code: "de", label: "ドイツ語" },
  { code: "es", label: "スペイン語" },
  { code: "pt", label: "ポルトガル語" },
  { code: "it", label: "イタリア語" },
  { code: "ru", label: "ロシア語" },
  { code: "th", label: "タイ語" },
  { code: "vi", label: "ベトナム語" },
  { code: "id", label: "インドネシア語" },
];

const DEFAULT_SETTINGS = {
  translationProvider: "google",
  deeplApiKey: "",
  sourceLang: "auto",
  targetLang: "ja",
  skipNativeLanguage: true,
  skipShortMessages: true,
};

const providerSelect = document.getElementById("providerSelect");
const deeplKeyInput = document.getElementById("deeplKeyInput");
const sourceLangSelect = document.getElementById("sourceLangSelect");
const targetLangSelect = document.getElementById("targetLangSelect");
const skipNativeLanguageToggle = document.getElementById("skipNativeLanguageToggle");
const skipShortMessagesToggle = document.getElementById("skipShortMessagesToggle");

// 翻訳元セレクトを構築（自動検出 + 言語一覧）
const autoOption = document.createElement("option");
autoOption.value = "auto";
autoOption.textContent = "自動検出";
sourceLangSelect.appendChild(autoOption);
LANGUAGES.forEach(({ code, label }) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = label;
  sourceLangSelect.appendChild(opt);
});

// 翻訳先セレクトを構築（ブラウザの言語設定に合わせる + 言語一覧）
const browserOption = document.createElement("option");
browserOption.value = "browser";
browserOption.textContent = "自動（ブラウザの言語設定）";
targetLangSelect.appendChild(browserOption);
LANGUAGES.forEach(({ code, label }) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = label;
  targetLangSelect.appendChild(opt);
});

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  providerSelect.value = result.translationProvider;
  deeplKeyInput.value = result.deeplApiKey;
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
    deeplUsageBox.textContent = "APIキーを入力すると使用量を確認できます。";
    return;
  }

  deeplUsageBox.textContent = "確認中…";
  try {
    const usage = await fetchDeeplUsage(apiKey);
    const remaining = usage.character_limit - usage.character_count;
    const percent = Math.round(
      (usage.character_count / usage.character_limit) * 100
    );
    deeplUsageBox.textContent = `使用量: ${usage.character_count.toLocaleString()} / ${usage.character_limit.toLocaleString()} 文字（${percent}%、残り ${remaining.toLocaleString()} 文字）`;
  } catch (err) {
    deeplUsageBox.textContent = "使用量を取得できませんでした（APIキーを確認してください）。";
  }
}

deeplUsageRefreshButton.addEventListener("click", refreshDeeplUsage);

// ページを開いたとき、既にキーが設定済みなら自動で一度取得する
chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  if (result.deeplApiKey) refreshDeeplUsage();
});
