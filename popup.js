const DEFAULT_SETTINGS = {
  extensionEnabled: true,
  autoTranslate: true,
};

const toggles = {
  extensionEnabled: document.getElementById("extensionEnabledToggle"),
  autoTranslate: document.getElementById("autoTranslateToggle"),
};

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  Object.keys(toggles).forEach((key) => {
    toggles[key].checked = result[key];
  });
});

Object.keys(toggles).forEach((key) => {
  toggles[key].addEventListener("change", () => {
    chrome.storage.local.set({ [key]: toggles[key].checked });
  });
});

document.getElementById("openOptionsButton").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("versionLabel").textContent =
  "ver " + chrome.runtime.getManifest().version;

const clearCacheButton = document.getElementById("clearCacheButton");
const clearCacheHelp = document.getElementById("clearCacheHelp");

clearCacheButton.addEventListener("click", () => {
  clearCacheButton.disabled = true;
  chrome.runtime.sendMessage({ action: "clearCache" }, (response) => {
    if (response && response.success) {
      clearCacheHelp.textContent = chrome.i18n.getMessage("popup_clearCacheDone");
      setTimeout(() => {
        // i18n.js の置き換えより先にこのスクリプトが読まれるため、元の文言は都度取得する
        clearCacheHelp.textContent = chrome.i18n.getMessage("popup_clearCacheHelpShort");
        clearCacheButton.disabled = false;
      }, 2000);
    } else {
      clearCacheButton.disabled = false;
    }
  });
});

// --- ローカル翻訳（PLaMo）の状態 ---
// 状態ごとの点の色・文字色・文言キー・下の説明文キー
const LOCAL_STATES = {
  unused: { dot: "#d0d0d0", color: "#888", text: "popup_localUnused", help: "popup_localUnusedHelp" },
  checking: { dot: "#888", color: "#555", text: "popup_localChecking", help: "popup_localAutoHelp" },
  ok: { dot: "#28a745", color: "#28a745", text: "popup_localOk", help: "popup_localAutoHelp" },
  stopped: { dot: "#dc2626", color: "#dc2626", text: "popup_localStopped", help: "popup_localFallbackHelp" },
  noModel: { dot: "#dc2626", color: "#dc2626", text: "popup_localNoModel", help: "popup_localFallbackHelp" },
  error: { dot: "#dc2626", color: "#dc2626", text: "popup_localError", help: "popup_localFallbackHelp" },
};

const localStatusDot = document.getElementById("localStatusDot");
const localStatusText = document.getElementById("localStatusText");
const localStatusHelp = document.getElementById("localStatusHelp");
const localCheckButton = document.getElementById("localCheckButton");

function showLocalState(key) {
  const state = LOCAL_STATES[key];
  localStatusDot.style.background = state.dot;
  localStatusText.style.color = state.color;
  localStatusText.textContent = chrome.i18n.getMessage(state.text);
  localStatusHelp.textContent = chrome.i18n.getMessage(state.help);
}

function checkLocalServer() {
  chrome.storage.local.get(
    {
      translationProvider: "google",
      plamoServerType: "lmstudio",
      plamoServerUrl: "http://localhost:1234",
    },
    (settings) => {
      // PLaMoを選んでいないときも欄は残し、ボタンだけ押せなくする（ポップアップの高さを変えないため）
      localCheckButton.disabled = true;
      if (settings.translationProvider !== "plamo") {
        showLocalState("unused");
        return;
      }
      showLocalState("checking");
      chrome.runtime.sendMessage(
        {
          action: "plamoTest",
          serverType: settings.plamoServerType,
          serverUrl: settings.plamoServerUrl,
        },
        (response) => {
          localCheckButton.disabled = false;
          const error = response && response.error;
          if (response && response.success) {
            showLocalState("ok");
          } else if (error === "PLAMO_UNREACHABLE" || error === "PLAMO_TIMEOUT") {
            showLocalState("stopped");
          } else if (error === "PLAMO_MODEL_NOT_FOUND") {
            showLocalState("noModel");
          } else {
            showLocalState("error");
          }
        }
      );
    }
  );
}

localCheckButton.addEventListener("click", checkLocalServer);
checkLocalServer(); // ポップアップを開くたびに自動で確認する
