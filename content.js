let processedElements = new WeakSet();
let extensionEnabled = true;
let autoTranslate = true;
let skipNativeLanguage = true;
let skipShortMessages = true;
let sourceLang = "auto";
let targetLang = "browser";
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
  targetLang: "browser",
};

chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
  extensionEnabled = result.extensionEnabled;
  autoTranslate = result.autoTranslate;
  skipNativeLanguage = result.skipNativeLanguage;
  skipShortMessages = result.skipShortMessages;
  sourceLang = result.sourceLang;
  targetLang = result.targetLang;
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
  if (changes.targetLang) {
    targetLang = changes.targetLang.newValue;
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

  // 2. チャンネル一覧の、いま開いているチャンネルの項目。
  //    Discordは項目の読み上げ用の名前に「〇〇(テキストチャンネル), プライベートチャンネル（ロック中）」のように
  //    書き、アイコンには「テキスト(限定) icon」のような名前を付けている
  const currentLink = document.querySelector(`a[href="${location.pathname}"]`);
  const items = [
    currentLink,
    document.querySelector('[data-list-item-id^="channels___"][aria-selected="true"]'),
    document.querySelector('[data-list-item-id^="channels___"][class*="selected"]'),
  ].filter(Boolean);
  for (const item of items) {
    if (isLockedItem(item)) return true;
    const row = item.closest("[data-list-item-id]");
    if (row && row !== item && isLockedItem(row)) return true;
  }

  // 3. スレッド（フォーラムの投稿を含む）を開いているとき。
  //    スレッドはチャンネル一覧に普通のリンクとして載らないので、親のチャンネルを調べる
  if (!currentLink) {
    const parents = findThreadParents();
    // 親が分からないスレッドは、鍵付きの中のものかもしれないので、念のため翻訳しない
    if (parents.length === 0) return true;
    if (parents.some(isLockedItem)) return true;
  }

  return false;
}

// 開いているスレッドの親チャンネル（一覧のリンク）を探す
function findThreadParents() {
  const segs = location.pathname.split("/").filter(Boolean); // ["channels", サーバー, ID, ("threads", スレッドID)]
  const parents = [];
  const linkFor = (id) => id && /^\d+$/.test(id) && document.querySelector(`a[href$="/${id}"][data-list-item-id^="channels___"], a[href$="/${id}"]`);

  // a. URLが /channels/サーバー/親/threads/スレッド の形なら、親のIDが入っている
  const ti = segs.indexOf("threads");
  if (ti > 0) parents.push(linkFor(segs[ti - 1]));

  // b. チャンネル一覧では、スレッドの行は親チャンネルのすぐ後ろに並ぶ。前にたどって最初のリンクが親
  const threadId = segs[segs.length - 1];
  const rows = [...document.querySelectorAll('[data-list-item-id^="channels___"]')];
  const idx = rows.findIndex((r) => r.getAttribute("data-list-item-id") === `channels___${threadId}`);
  for (let i = idx - 1; idx > 0 && i >= 0; i--) {
    if (rows[i].tagName === "A") {
      parents.push(rows[i]);
      break;
    }
  }

  // c. フォーラムの投稿一覧（data-list-id="forum-channel-list-<フォーラムのID>"）が表示されていれば、そのフォーラム
  document.querySelectorAll('[data-list-id^="forum-channel-list-"]').forEach((list) => {
    parents.push(linkFor(list.getAttribute("data-list-id").slice("forum-channel-list-".length)));
  });

  return parents.filter(Boolean);
}

// 鍵付き・限定公開を表す語（Discordの表示言語で変わるため、主な言語ぶん用意する）
const LOCK_LABEL_PATTERN = new RegExp(
  [
    "プライベート", "ロック", "限定", "private", "lock", "limited", // 日本語・英語
    "비공개", "잠금", "제한", // 韓国語
    "私人", "私密", "私有", "專屬", "专属", "锁", "鎖", "受限", "限制", // 中国語
    "privé", "verrouill", "limité", // フランス語
    "privat", "gesperrt", "eingeschränkt", // ドイツ語・北欧語
    "privad", "bloquead", "limitad", // スペイン語・ポルトガル語
    "privato", "bloccat", "limitat", // イタリア語
    "приват", "закрыт", "ограничен", // ロシア語
    "prywatn", "zablokowan", "ograniczon", // ポーランド語
    "özel", "kilitli", "sınırlı", // トルコ語
    "ส่วนตัว", "ล็อก", "จำกัด", // タイ語
    "riêng tư", "khóa", "giới hạn", // ベトナム語
    "pribadi", "terkunci", "terbatas", // インドネシア語
    "besloten", "beperkt", // オランダ語
  ].join("|"),
  "i"
);

// チャンネル一覧の項目が鍵付きかどうか。
// 項目自身の名前は先頭にチャンネル名が入るので、チャンネル名の部分（最初の区切りまで）は除いて調べる
// （「lockdown-攻略」のような公開チャンネル名で誤判定しないように）。
// 中のアイコンの名前（「テキスト(限定) icon」など）はチャンネル名を含まないので、そのまま調べる
function isLockedItem(el) {
  const own = el.getAttribute("aria-label") || "";
  const afterName = own.split(/[,，、]/).slice(1).join(",");
  if (LOCK_LABEL_PATTERN.test(afterName)) return true;
  return [...el.querySelectorAll("[aria-label]")].some((child) => {
    const label = child.getAttribute("aria-label") || "";
    // アイコン以外のボタン（「チャンネルに招待」など）は対象外
    if (!/icon|アイコン/i.test(label)) return false;
    // 普通のチャンネルは「テキスト icon」「Text icon」、鍵付きは「テキスト(限定) icon」「Text (Limited) icon」のように、
    // どの言語でも「かっこ書き」が足される。言葉が分からない言語でも見分けられるよう、かっこ書きの有無で判定する
    // （年齢制限など別の理由のかっこ書きでも、翻訳しない側に倒れるので安全）
    return /[(（].+[)）]/.test(label) || LOCK_LABEL_PATTERN.test(label);
  });
}

// 発言が、チャンネルのチャット欄（またはスレッドの欄）の中にあるか。
// 検索結果・受信トレイ・ピン留め・ポップアップに出た発言は、別のチャンネル（鍵付きを含む）の
// ものかもしれないので、読み取らない
function isInChatList(el) {
  if (!el.closest('[data-list-id^="chat-messages"]')) return false;
  if (el.closest('[role="dialog"], [class*="searchResult"], [class*="recentMentions"], [class*="popout"], [class*="inbox"]')) {
    return false;
  }
  return true;
}

// 極端に短い発言に翻訳ボタンを出さないためのしきい値
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
    // 自動検出：文字の種類を問わず、文字が2つ以上あれば候補にする。
    // 「翻訳先と同じ言語かどうか」の判定は、非同期の isInTargetLanguage で行う
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 2) return false;
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

// ===== 翻訳先と同じ言語の発言かどうかの判定（翻訳元が「自動検出」のとき） =====

// 翻訳先の言語コード（「自動」はブラウザの表示言語）。例: "ja-JP" → "ja"
function resolveTargetLangCode() {
  const code = targetLang === "browser" ? chrome.i18n.getUILanguage() || "ja" : targetLang;
  return code.split("-")[0].toLowerCase();
}

// ラテン文字を使う言語（文字の種類だけでは互いに区別できない）
const LATIN_SCRIPT_LANGS = new Set(["en", "fr", "de", "es", "pt", "it", "vi", "id"]);

// 文字の種類から、いちばん多く使われている文字体系を推定する
function detectScript(text) {
  const count = (re) => (text.match(re) || []).length;
  const kana = count(/[\u3040-\u30FF]/g);
  const han = count(/[\u4E00-\u9FFF]/g);
  const scores = {
    // かなが1つでもあれば漢字も日本語として数える（中国語にかなは無い）。
    // 日本語は1文字あたりの情報量が多く、「STREET FIGHTER 6やりたい」のように英単語が
    // 混ざると文字数で負けやすいため、ラテン文字の4文字分として数える
    ja: kana > 0 ? (kana + han) * 4 : 0,
    han: kana > 0 ? 0 : han, // かなの無い漢字だけの文。日本語か中国語かは決められない
    ko: count(/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g),
    ru: count(/[\u0400-\u04FF]/g),
    th: count(/[\u0E00-\u0E7F]/g),
    latin: count(/[a-zA-Z\u00C0-\u024F]/g),
  };
  const letters = count(/\p{L}/gu);
  const [best, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  // 上のどれにも当てはまらない文字（アラビア文字など）が主体なら「その他」
  if (bestScore === 0 || bestScore * 2 < letters) return "other";
  return best;
}

// 文字の種類と、Chromeの推測（確実ではない場合も含む）を組み合わせて判定する。
// guess は Chrome が一番可能性が高いとした言語コード（無ければ null）
function isTargetByScript(text, target, guess) {
  // かなは日本語にしか無いので、かながあってChromeも日本語と推測したなら日本語とみなす
  if (guess === "ja" && /[\u3040-\u30FF]/.test(text)) return target === "ja";

  const script = detectScript(text);

  if (script === "han") {
    // かなの無い漢字だけの文。長めの文でChromeが中国語と推測したら中国語として扱う。
    // 「了解」「草」のような短い文は日本語とも中国語とも決められないので、どちらも同じ言語扱い
    const han = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
    if (guess === "zh" && han >= 5) return target === "zh";
    if (guess === "ja") return target === "ja";
    return target === "ja" || target === "zh";
  }

  if (script === "latin") {
    // 翻訳先がラテン文字以外の言語なら、ラテン文字の発言は別の言語
    if (!LATIN_SCRIPT_LANGS.has(target)) return false;
    // 翻訳先もラテン文字の言語：ある程度長い文で、Chromeの推測が既知のラテン文字の言語なら採用する
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters >= 15 && guess && LATIN_SCRIPT_LANGS.has(guess)) return guess === target;
    // 短い発言（gg、lol 等）は区別できないので、青バーだらけにならないよう同じ言語扱い
    return true;
  }

  return script === target;
}

// Chromeに内蔵の言語判定（通信なし）と文字の種類を組み合わせて判定する
function isInTargetLanguage(text, callback) {
  const target = resolveTargetLangCode();
  try {
    chrome.i18n.detectLanguage(text, (result) => {
      if (chrome.runtime.lastError || !result) {
        callback(isTargetByScript(text, target, null));
        return;
      }
      const top = result.languages?.[0]?.language;
      const guess = top ? top.split("-")[0].toLowerCase() : null;
      // Chromeが「確実」と判定したときは、それをそのまま使う
      if (result.isReliable && guess) {
        callback(guess === target);
        return;
      }
      callback(isTargetByScript(text, target, guess));
    });
  } catch {
    callback(isTargetByScript(text, target, null));
  }
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
      "code, pre, .discord-translated-message, .discord-translated-title, [class*='hiddenVisually'], [class*='spoilerContent'], [class*='spoilerMarkdownContent'], [class*='spoilerText']"
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
  const rawText = extractText(element);
  if (!rawText || !isTranslationCandidate(rawText)) return;

  // 翻訳元が「自動検出」で、翻訳先と同じ言語の発言には青バーを出さない設定のとき
  if (sourceLang === "auto" && skipNativeLanguage) {
    isInTargetLanguage(rawText, (sameLanguage) => {
      if (!sameLanguage) addTranslationBox(element, rawText);
    });
    return;
  }
  addTranslationBox(element, rawText);
}

function addTranslationBox(element, rawText) {
  const isTitle = element.dataset.translateType === "title";
  // 判定を待つ間に拡張機能がOFFにされたり、DM等に移動した場合は何もしない
  if (!extensionEnabled || isSecretChannel()) return;

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

// 実際に翻訳したエンジン名を薄く添える（フォールバックで別エンジンが訳した場合も分かるように）。
// フォーラムタイトルは文字を足すと折り返しやすく、狭いと訳文が隠れる仕様に触れるため、
// 本文には右下にラベル、タイトルにはマウスを乗せたときのヒントとして出す。
function showEngineLabel(container, engine) {
  if (!engine) return;
  const name = chrome.i18n.getMessage(`engine_${engine}`) || engine;
  // 翻訳前の「クリックで翻訳」のヒントが残らないよう、どちらもエンジン名に置き換える
  container.title = name;
  if (container.classList.contains("discord-translated-title")) return;
  const label = document.createElement("div");
  label.className = "discord-translated-engine";
  label.textContent = name;
  container.appendChild(label);
}

// 訳文が原文と実質的に同じか（ゲーム名だけの発言などは訳しても変わらない）。
// 全角・半角、大文字・小文字、空白、句読点や記号の違いは無視して比べる
function normalizeForCompare(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function isSameText(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function runTranslation(container) {
  if (container.dataset.state === "loading" || container.dataset.state === "done") return;
  const rawText = container.dataset.rawText;
  if (!rawText) return;

  console.log("[トランス☆ディスコ] 翻訳リクエスト送信（本文はログに出しません）");

  container.dataset.state = "loading";
  container.classList.remove("discord-translate-pending");
  container.textContent = "…";

  chrome.runtime.sendMessage(
    { action: "translate", text: rawText },
    (response) => {
      console.log("[トランス☆ディスコ] 翻訳結果:", response && response.success ? `成功（${response.engine}）` : response && response.error);
      if (response && response.success && response.text) {
        const translated = response.text.trim();
        if (isSameText(translated, rawText)) {
          container.remove();
        } else {
          container.textContent = translated;
          container.dataset.state = "done";
          showEngineLabel(container, response.engine);
          const sourceElement = containerSourceElement.get(container);
          if (sourceElement) {
            watchForEdits(
              sourceElement,
              container.classList.contains("discord-translated-title")
            );
          }
        }
        pendingContainers.delete(container);
      } else if (response && response.error === "PLAMO_REFUSED") {
        // パスワード等らしき文字列があるとして断られた発言は、再試行もさせない
        container.textContent = chrome.i18n.getMessage("content_refusedSecret");
        container.dataset.state = "done";
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
      if (isInChatList(el)) registerElement(el, "message");
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
