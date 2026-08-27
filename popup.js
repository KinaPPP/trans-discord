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

document.getElementById("captchaButton").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=hello",
  });
});

document.getElementById("openOptionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("versionLabel").textContent =
  "ver " + chrome.runtime.getManifest().version;
