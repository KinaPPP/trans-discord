let processedElements = new WeakSet();
let extensionEnabled = true;
let autoTranslate = true;
let skipNativeLanguage = true;
let skipShortMessages = true;
let sourceLang = "auto";
// 自動翻訳ONでも、実際に一斉翻訳を「発動」させるのは最初のクリックがあってから
let autoArmed = false;
// クリック待ち（未翻訳）のまま残っているコンテナ。発動時にまとめて翻訳するために保持
const pendingContainers = new Set();
// タイトルとして拾ったテキストの重複検知用（添付ファイル側に複製される
// アクセシビリティ見出し等、同一テキストの二重表示を防ぐ）
const seenTitleTexts = new Set();
// 翻訳済み要素の編集検知（元要素→監視中のMutationObserver）
const editWatchers = new WeakMap();
// 翻訳ボックス→元の発言/タイトル要素（編集検知の再登録に使う）
const containerSourceElement = new WeakMap();

const DEFAULT_SETTINGS = {
  extensionEnabled: true,
  autoTranslate: true,
  skipNativeLanguage: true,
  skipShortMessages: true,
  sourceLang: "auto",
};

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  extensionEnabled = result.extensionEnabled;
  autoTranslate = result.autoTranslate;
  skipNativeLanguage = result.skipNativeLanguage;
  skipShortMessages = result.skipShortMessages;
  sourceLang = result.sourceLang;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
    if (extensionEnabled) {
      scanTargets(); // OFF→ONにしたら即座に再スキャン
    } else {
      // ON→OFFにしたら既存の翻訳ボックスを全て削除し、
      // 処理済み管理もリセットして次回ON時にきちんと再スキャンされるようにする
      document
        .querySelectorAll(".discord-translated-message, .discord-translated-title")
        .forEach((el) => el.remove());
      processedElements = new WeakSet();
      pendingContainers.clear();
      seenTitleTexts.clear();
    }
  }
  if (changes.autoTranslate) {
    autoTranslate = changes.autoTranslate.newValue;
    // OFFにしたら発動フラグもリセットし、再度ONにしたときは改めてクリックで発動させる
    if (!autoTranslate) autoArmed = false;
  }
  if (changes.skipNativeLanguage) {
    skipNativeLanguage = changes.skipNativeLanguage.newValue;
  }
  if (changes.skipShortMessages) {
    skipShortMessages = changes.skipShortMessages.newValue;
  }
  if (changes.sourceLang) {
    sourceLang = changes.sourceLang.newValue;
  }
});

// チャンネル/スレッド移動（DiscordはSPAなのでページ遷移が起きない）を検知して
// 発動フラグと未翻訳リストをリセットする
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    autoArmed = false;
    pendingContainers.clear();
    seenTitleTexts.clear();

    // DM・鍵付きチャンネルに移動した場合は、念のため既存の翻訳ボックスも消す
    if (isSecretChannel()) {
      document
        .querySelectorAll(".discord-translated-message, .discord-translated-title")
        .forEach((el) => el.remove());
      processedElements = new WeakSet();
    }
  }
}, 500);

// 現在開いているチャンネルがプライベート（DM・鍵付き等）かどうかを判定する。
// 該当する場合はテキストの抽出・翻訳リクエストの発行を一切行わない。
function isSecretChannel() {
  // 1. DM・グループDM（URLが /channels/@me で始まる）
  if (location.pathname.startsWith("/channels/@me")) return true;

  const lockSelectors =
    'svg[aria-label*="プライベート"], svg[aria-label*="Private"], svg[aria-label*="ロック"], svg[aria-label*="Lock"]';

  // 2. 画面上部ヘッダーの鍵アイコン（プライベートチャンネル表示）
  const header = document.querySelector(
    'section[aria-label*="チャンネル"], section[class*="title_"], header[class*="header_"]'
  );
  if (header && header.querySelector(lockSelectors)) return true;

  // 3. チャンネル一覧側で現在選択中のアイテムに鍵アイコンが付いているか
  const selectedChannel = document.querySelector(
    '[data-list-item-id^="channels___"][aria-selected="true"], [class*="selected_"][data-list-item-id^="channels___"]'
  );
  if (selectedChannel && selectedChannel.querySelector(lockSelectors)) return true;

  return false;
}

// 日本語主体の発言には翻訳ボタンを出さないため、極端に短い発言（英字が少ない）にも出さないため
const SHORT_TEXT_THRESHOLD = 6;

function isTranslationCandidate(text) {
  const latinLetters = (text.match(/[a-zA-Z]/g) || []).length;
  const japaneseChars = (
    text.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g) || []
  ).length;
  const kanaChars = (text.match(/[\u3040-\u30FF]/g) || []).length;
  const hanChars = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  const hangulChars = (
    text.match(/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g) || []
  ).length;
  const cyrillicChars = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;

  if (sourceLang === "ja") {
    // 翻訳元を日本語に固定している場合は、日本語主体の発言だけを対象にする
    if (japaneseChars < 2 || japaneseChars <= latinLetters) return false;
  } else if (sourceLang === "zh") {
    // 中国語：漢字はあるがひらがな・カタカナが無い（日本語との簡易的な切り分け）
    if (hanChars < 2 || kanaChars > 0) return false;
  } else if (sourceLang === "ko") {
    // 韓国語：ハングル文字の有無で判定
    if (hangulChars < 2) return false;
  } else if (sourceLang === "ru") {
    // ロシア語：キリル文字の有無で判定
    if (cyrillicChars < 2) return false;
  } else if (sourceLang === "th") {
    // タイ語：タイ文字の有無で判定
    if (thaiChars < 2) return false;
  } else if (sourceLang === "auto") {
    if (latinLetters < 2) return false;
    if (skipNativeLanguage && japaneseChars > latinLetters) return false;
  } else {
    // それ以外（英・仏・独・西・葡・伊・越・尼など）：厳密な言語判定はできないため、
    // ラテン文字主体かどうかの簡易判定で近似する
    if (latinLetters < 2) return false;
    if (japaneseChars > latinLetters) return false;
  }

  if (skipShortMessages && text.trim().length < SHORT_TEXT_THRESHOLD) {
    return false;
  }

  return true;
}

// コードブロックや既存の翻訳ボックス自体を巻き込まないようにしてテキストを抽出
// ブロック要素（div, p, ul, li, h1〜h6等）の境界とbr要素を、確実に改行として
// テキスト化する。innerTextはDiscordの入れ子の深いDOM構造だと、要素の境界に
// 改行を入れてくれないことがある（cloneNodeで切り離した要素は特に顕著）ため、
// 自前でDOMを歩いて構築する。
const BLOCK_TAGS = new Set([
  "DIV", "P", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
]);

function walkTextWithBreaks(node) {
  let text = "";

  function appendBreakIfNeeded() {
    if (text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
  }

  function walk(n) {
    if (n.nodeType === Node.TEXT_NODE) {
      text += n.textContent;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;

    if (n.tagName === "BR") {
      text += "\n";
      return;
    }

    const isBlock = BLOCK_TAGS.has(n.tagName);
    if (isBlock) appendBreakIfNeeded();

    // 箇条書き（li要素）はCSSの::markerで記号が表示されているだけで、実テキストには
    // 含まれていない。そのままでは翻訳エンジンが「リストかどうか」を毎回推測することに
    // なり結果が揺れるため、ここで明示的に先頭へ埋め込んでおく。
    // ※「・」は日本語特有の記号なので、13言語対応に合わせて国際的に標準の
    //   ビュレット記号「•」（ブラウザのデフォルトリスト表示と同じ）を使う。
    if (n.tagName === "LI") text += "• ";

    n.childNodes.forEach(walk);

    if (isBlock) appendBreakIfNeeded();
  }

  walk(node);
  return text;
}

function extractText(element) {
  const clone = element.cloneNode(true);
  clone
    .querySelectorAll(
      // ※ cloneNodeで切り離した要素はレイアウト情報を持たないため、
      //   innerTextの「見た目上隠れているかどうか」の判定が効かない。
      //   そのためDiscordのスクリーンリーダー専用テキスト（hiddenVisually）は
      //   ここで明示的に取り除く。
      "code, pre, .discord-translated-message, .discord-translated-title, [class*='hiddenVisually']"
    )
    .forEach((n) => n.remove());

  const text = walkTextWithBreaks(clone);
  // 連続する空行は2つ（段落の区切り分）までに詰める
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// 画面内に入った要素は「青いエリア（未翻訳）」を表示するだけにとどめる
const visibilityObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target;
        visibilityObserver.unobserve(el);
        prepareTranslation(el);
      }
    });
  },
  { rootMargin: "50px" }
);

function prepareTranslation(element) {
  const isTitle = element.dataset.translateType === "title";
  const rawText = extractText(element);
  if (!rawText || !isTranslationCandidate(rawText)) return;

  // タイトルは、添付ファイル側などに複製された同一テキストを二重表示しないよう
  // 全ページ内で最初の1件だけを対象にする
  if (isTitle) {
    const normalized = rawText.replace(/[\s\u00a0]+/g, " ").trim();
    if (seenTitleTexts.has(normalized)) return;
    seenTitleTexts.add(normalized);
  }

  const container = document.createElement("div");
  container.className = isTitle
    ? "discord-translated-title discord-translate-pending"
    : "discord-translated-message discord-translate-pending";
  container.textContent = ""; // 文言は出さず、青いエリアだけにする（title属性でヒントは残す）
  container.dataset.state = "pending";
  container.dataset.rawText = rawText;
  container.title = "クリックでこの発言だけ翻訳します";
  container.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    handleContainerClick(container);
  });
  getInsertionTarget(element, isTitle).appendChild(container);

  containerSourceElement.set(container, element);
  pendingContainers.add(container);

  // 自動翻訳ONでも、発動済み（誰かが1回クリックした）でなければまだ通信しない
  if (autoTranslate && autoArmed) {
    runTranslation(container);
  }
}

function handleContainerClick(container) {
  if (container.dataset.state === "loading" || container.dataset.state === "done") return;

  // クリックした発言を最優先で翻訳
  runTranslation(container);

  // 自動翻訳ONの状態で初めてクリックされたら、以降は一斉に発動する
  // ※ 内部Setの登録タイミングに頼らず、その時点でDOM上に実在する
  //   未翻訳ボックスを直接検索することで取りこぼしを防ぐ
  if (autoTranslate && !autoArmed) {
    autoArmed = true;
    document
      .querySelectorAll('.discord-translate-pending[data-state="pending"]')
      .forEach((c) => {
        if (c !== container) runTranslation(c);
      });
  }
}

// タイトルは常に元の文章の「下」に翻訳文が来るよう、親要素側に配置する
// （h3の行数制限内に余裕があると同じ行に並んでしまい、表示位置が不安定になるため統一する）
// ※ さらに上の階層まで遡るとカード全体のレイアウト（flex/grid）を崩すことがあるため、1階層のみに留める。
function getInsertionTarget(element, isTitle) {
  if (isTitle && element.parentElement) {
    return element.parentElement;
  }
  return element;
}

// 翻訳済みの発言/タイトルが後から編集された場合に検知し、翻訳をやり直すための監視
function watchForEdits(element, isTitle) {
  if (editWatchers.has(element)) return; // 既に監視中

  let debounceTimer = null;
  const observer = new MutationObserver((mutations) => {
    // 自分が追加した翻訳ボックス自体の変更（読み込み中→訳文表示など）は無視する
    const isOwnChange = mutations.every((m) => {
      const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return (
        node &&
        node.closest &&
        node.closest(".discord-translated-message, .discord-translated-title")
      );
    });
    if (isOwnChange) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleMessageEdited(element, isTitle), 300);
  });

  observer.observe(element, { childList: true, characterData: true, subtree: true });
  editWatchers.set(element, observer);
}

function handleMessageEdited(element, isTitle) {
  const observer = editWatchers.get(element);
  if (observer) observer.disconnect();
  editWatchers.delete(element);

  console.log("[トランス☆ディスコ] 発言の編集を検知、翻訳をやり直します");

  const target = getInsertionTarget(element, isTitle);
  target
    .querySelectorAll(
      ":scope > .discord-translated-message, :scope > .discord-translated-title"
    )
    .forEach((el) => {
      if (el.classList.contains("discord-translated-title") && el.dataset.rawText) {
        const normalized = el.dataset.rawText.replace(/[\s\u00a0]+/g, " ").trim();
        seenTitleTexts.delete(normalized);
      }
      pendingContainers.delete(el);
      el.remove();
    });

  processedElements.delete(element);
  registerElement(element, isTitle ? "title" : "message");
}

function runTranslation(container) {
  if (container.dataset.state === "loading" || container.dataset.state === "done") return;
  const rawText = container.dataset.rawText;
  if (!rawText) return;

  console.log(
    `[トランス☆ディスコ] 翻訳リクエスト送信 (${container.classList.contains("discord-translated-title") ? "タイトル" : "本文"}):`,
    rawText
  );

  container.dataset.state = "loading";
  container.classList.remove("discord-translate-pending");
  container.textContent = "…";

  chrome.runtime.sendMessage(
    { action: "translate", text: rawText },
    (response) => {
      console.log("[トランス☆ディスコ] 翻訳結果:", response);
      if (response && response.success && response.text) {
        const translated = response.text.trim();
        if (translated.toLowerCase() === rawText.toLowerCase()) {
          container.remove();
        } else {
          container.textContent = translated;
          container.dataset.state = "done";
          const sourceElement = containerSourceElement.get(container);
          if (sourceElement) {
            watchForEdits(
              sourceElement,
              container.classList.contains("discord-translated-title")
            );
          }
        }
        pendingContainers.delete(container);
      } else {
        // 失敗時はクリックで再試行できる状態に戻す（pendingContainersには残す）
        container.textContent = "⚠️ 再試行（クリック）";
        container.classList.add("discord-translate-pending");
        container.dataset.state = "pending";
      }
    }
  );
}

function registerElement(element, type = "message") {
  if (!element || processedElements.has(element)) return;
  if (isEffectivelyHidden(element)) return;
  if (type === "title" && isMessageHeaderElement(element)) return;

  const dupSelector =
    ":scope > .discord-translated-message, :scope > .discord-translated-title";
  if (getInsertionTarget(element, type === "title").querySelector(dupSelector))
    return;

  processedElements.add(element);
  element.dataset.translateType = type;
  visibilityObserver.observe(element);
}

// メッセージ自体のヘッダー（時刻＋発言者名）は、Discordが
// aria-labelledbyでmessage-username/timestampを明示しているため、
// この属性を持つ要素はフォーラム投稿タイトル等とは区別して除外する
function isMessageHeaderElement(element) {
  const labelledby = element.getAttribute("aria-labelledby") || "";
  return (
    labelledby.includes("message-username-") &&
    labelledby.includes("message-timestamp-")
  );
}

// スクリーンリーダー専用の隠しテキスト（時刻+発言者名などのメタ情報）を
// 誤って候補にしないための簡易チェック
function isEffectivelyHidden(element) {
  const rect = element.getBoundingClientRect();
  // スクリーンリーダー専用テキストは1px四方などほぼ見えないサイズで実装されることが多い
  if (rect.width <= 1 && rect.height <= 1) return true;
  if (
    typeof element.className === "string" &&
    element.className.includes("hiddenVisually")
  )
    return true;
  return false;
}

function scanTargets() {
  if (!extensionEnabled) return;
  if (isSecretChannel()) return; // DM・鍵付きチャンネルではスキャンしない

  // 1. チャット本文・メッセージ
  document
    .querySelectorAll(
      'div[id^="message-content-"], [class*="messageContent-"]'
    )
    .forEach((el) => {
      registerElement(el, "message");
    });

  // 2. フォーラム一覧のカードタイトル & スレッド見出し（既知パターン）
  document
    .querySelectorAll(
      '[class*="postTitleText"], [class*="mainCard"] h3, [role="article"] h3, [class*="threadName"]'
    )
    .forEach((el) => {
      registerElement(el, "title");
    });

  // 2b. スレッド詳細ヘッダー等の大見出し（data-text-variant属性は比較的安定）
  document
    .querySelectorAll('[data-text-variant^="heading-xxl"]')
    .forEach((el) => {
      registerElement(el, "title");
    });

  // 2c. 上記に該当しない見出し用の暫定フォールバック
  // 左サイドバー等のUI文言を巻き込まないよう、本編領域（role="main"）内に限定する
  document
    .querySelectorAll(
      '[role="main"] h1, [role="main"] h2, [role="main"] h3, [role="main"] [role="heading"]'
    )
    .forEach((el) => {
      registerElement(el, "title");
    });
}

// DOM変化のたびに即scanするのではなく、短い間隔でまとめて実行して負荷を抑える
let scanScheduled = false;
const mutationObserver = new MutationObserver(() => {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    scanTargets();
  }, 150);
});

mutationObserver.observe(document.body, {
  childList: true,
  subtree: true,
});

scanTargets();
