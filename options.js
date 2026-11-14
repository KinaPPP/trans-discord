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
  geminiCustomPrompt: "",
  plamoServerType: "lmstudio",
  plamoServerUrl: "http://localhost:1234",
  plamoApiKey: "",
  plamoForm: "auto",
  sourceLang: "auto",
  targetLang: "browser",
  skipNativeLanguage: true,
  skipShortMessages: true,
};

const providerSelect = document.getElementById("providerSelect");
const deeplKeyInput = document.getElementById("deeplKeyInput");
const geminiKeyInput = document.getElementById("geminiKeyInput");
const geminiToneSelect = document.getElementById("geminiToneSelect");
const geminiCustomPromptWrapper = document.getElementById("geminiCustomPromptWrapper");
const geminiCustomPromptInput = document.getElementById("geminiCustomPromptInput");
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

function updateCustomPromptVisibility() {
  geminiCustomPromptWrapper.style.display =
    geminiToneSelect.value === "custom" ? "block" : "none";
}

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  providerSelect.value = result.translationProvider;
  deeplKeyInput.value = result.deeplApiKey;
  geminiKeyInput.value = result.geminiApiKey;
  geminiToneSelect.value = result.geminiTone;
  geminiCustomPromptInput.value = result.geminiCustomPrompt;
  sourceLangSelect.value = result.sourceLang;
  targetLangSelect.value = result.targetLang;
  skipNativeLanguageToggle.checked = result.skipNativeLanguage;
  skipShortMessagesToggle.checked = result.skipShortMessages;
  updateCustomPromptVisibility();
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
  updateCustomPromptVisibility();
});

geminiCustomPromptInput.addEventListener("change", () => {
  chrome.storage.local.set({ geminiCustomPrompt: geminiCustomPromptInput.value.trim() });
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

// --- ローカル翻訳（PLaMo） ---
const PLAMO_DEFAULT_URLS = {
  sts: "http://localhost:5055",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8000",
  ollama: "http://localhost:11434",
};
const plamoServerTypeSelect = document.getElementById("plamoServerTypeSelect");
const plamoServerUrlInput = document.getElementById("plamoServerUrlInput");
const plamoFormSelect = document.getElementById("plamoFormSelect");
const plamoApiKeyInput = document.getElementById("plamoApiKeyInput");

// 合言葉の欄は常に表示し、シンプル翻訳サーバー以外では入力できないようにする（画面の並びを変えないため）
function updateApiKeyState() {
  plamoApiKeyInput.disabled = plamoServerTypeSelect.value !== "sts";
}
const plamoTestButton = document.getElementById("plamoTestButton");
const plamoTestResult = document.getElementById("plamoTestResult");

function showPlamoResult(message, ok) {
  plamoTestResult.textContent = message;
  plamoTestResult.style.color = ok === true ? "#28a745" : ok === false ? "#dc2626" : "#555";
}

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  plamoServerTypeSelect.value = result.plamoServerType;
  plamoServerUrlInput.value = result.plamoServerUrl;
  plamoFormSelect.value = result.plamoForm;
  plamoApiKeyInput.value = result.plamoApiKey;
  updateApiKeyState();
});

plamoApiKeyInput.addEventListener("change", () => {
  const key = plamoApiKeyInput.value.trim();
  plamoApiKeyInput.value = key;
  chrome.storage.local.set({ plamoApiKey: key });
  showPlamoResult("", null);
});

plamoServerTypeSelect.addEventListener("change", () => {
  const type = plamoServerTypeSelect.value;
  // 種類を変えたら、URLもその種類の既定値に合わせる。検出済みのモデル名は使えないので消す
  plamoServerUrlInput.value = PLAMO_DEFAULT_URLS[type];
  chrome.storage.local.set({
    plamoServerType: type,
    plamoServerUrl: PLAMO_DEFAULT_URLS[type],
    plamoModel: "",
  });
  updateApiKeyState();
  showPlamoResult("", null);
});

plamoServerUrlInput.addEventListener("change", () => {
  const url = plamoServerUrlInput.value.trim().replace(/\/+$/, "");
  plamoServerUrlInput.value = url;
  chrome.storage.local.set({ plamoServerUrl: url, plamoModel: "" });
  showPlamoResult("", null);
});

plamoFormSelect.addEventListener("change", () => {
  chrome.storage.local.set({ plamoForm: plamoFormSelect.value });
});

function plamoErrorMessage(code) {
  const map = {
    PLAMO_BAD_URL: "options_plamoErrBadUrl",
    PLAMO_UNREACHABLE: "options_plamoErrUnreachable",
    PLAMO_TIMEOUT: "options_plamoErrUnreachable",
    PLAMO_MODEL_NOT_FOUND: "options_plamoErrNoModel",
    PLAMO_NO_KEY: "options_plamoErrNoKey",
    PLAMO_BAD_KEY: "options_plamoErrBadKey",
    PLAMO_FORBIDDEN:
      plamoServerTypeSelect.value === "ollama"
        ? "options_plamoErrOllamaOrigin"
        : "options_plamoErrForbidden",
  };
  return chrome.i18n.getMessage(map[code] || "options_plamoErrOther", [code || ""]);
}

plamoTestButton.addEventListener("click", () => {
  showPlamoResult(chrome.i18n.getMessage("options_plamoTesting"), null);
  plamoTestButton.disabled = true;
  chrome.runtime.sendMessage(
    {
      action: "plamoTest",
      serverType: plamoServerTypeSelect.value,
      serverUrl: plamoServerUrlInput.value.trim(),
      apiKey: plamoApiKeyInput.value.trim(),
    },
    (response) => {
      plamoTestButton.disabled = false;
      if (response && response.success) {
        const okKey = plamoServerTypeSelect.value === "sts" ? "options_plamoTestOkSts" : "options_plamoTestOk";
        const pausedNote = response.paused ? chrome.i18n.getMessage("options_plamoPausedNote") : "";
        showPlamoResult(chrome.i18n.getMessage(okKey, [response.model]) + pausedNote, true);
      } else {
        showPlamoResult(plamoErrorMessage(response && response.error), false);
      }
    }
  );
});

// --- 困ったときは：Google翻訳のCAPTCHA確認ページを開く ---
document.getElementById("captchaButton").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=hello",
  });
});

document.getElementById("versionLabel").textContent =
  "ver " + chrome.runtime.getManifest().version;
