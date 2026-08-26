// data-i18n="キー" が付いた要素のテキストを、chrome.i18n.getMessage()の結果に置き換える。
// data-i18n-attr="placeholder" のように指定すると、textContentではなく該当属性を置き換える。
(function () {
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const message = chrome.i18n.getMessage(key);
      if (!message) return;

      const attr = el.getAttribute("data-i18n-attr");
      if (attr) {
        el.setAttribute(attr, message);
      } else {
        el.textContent = message;
      }
    });

    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const message = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
      if (message) el.title = message;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyI18n);
  } else {
    applyI18n();
  }
})();
