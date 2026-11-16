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
// 発動フラグと未翻訳リストをリセットする。
// 定期チェックに加え、スキャンや送信の直前にも呼んで、移動直後の取り違えを防ぐ
let lastUrl = location.href;
function checkUrlChange() {
  if (location.href === lastUrl) return;
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
setInterval(checkUrlChange, 500);

// URLから、いま開いているサーバー・チャンネル・スレッドのIDを取り出す。
// /channels/サーバー[/チャンネル[/メッセージ]] または /channels/サーバー/親チャンネル/threads/スレッド
function parseChannelPath() {
  const segs = location.pathname.split("/").filter(Boolean);
  if (segs[0] !== "channels") return null;
  const isId = (v) => /^\d+$/.test(v || "");
  const thread = segs[3] === "threads" && isId(segs[4]) ? segs[4] : null;
  return {
    guild: segs[1] || "",
    channel: isId(segs[2]) ? segs[2] : null,
    thread,
  };
}

// 翻訳ボックスが「どのチャンネルで作られたか」の目印（送信直前の照合に使う）。
// フォーラムの投稿を開くと一覧と投稿が並んで表示されるので、/threads/ の形では親チャンネルを目印にする
// （投稿自体が鍵付きかどうかは、送信直前の isSecretChannel() で別途確かめる）
function currentChannelKey() {
  const p = parseChannelPath();
  if (!p) return "";
  return `${p.guild}/${p.channel || ""}`;
}

// 左のチャンネル一覧の項目をIDで探す（本文中のリンク等は対象にしない）
function sidebarItem(id) {
  if (!/^\d+$/.test(id || "")) return null;
  return document.querySelector(`[data-list-item-id="channels___${id}"]`);
}

// スレッドの行の親チャンネル。一覧ではスレッドの行は親チャンネルのすぐ後ろに並ぶので、前にたどって最初のリンクが親
function precedingChannelLink(row) {
  const rows = [...document.querySelectorAll('[data-list-item-id^="channels___"]')];
  for (let i = rows.indexOf(row) - 1; i >= 0; i--) {
    if (rows[i].tagName === "A") return rows[i];
  }
  return null;
}

// svgの中身（path等の形）を比べるための文字列。色やサイズの違いは無視する
function iconShape(svg) {
  return [...svg.querySelectorAll("*")]
    .map((n) =>
      n.tagName + ":" +
      ["d", "x", "y", "width", "height", "href", "mask", "clip-path", "transform", "fill-rule"]
        .map((a) => n.getAttribute(a) || "")
        .join(",")
    )
    .join("|");
}

// 全画面で開いたスレッドが「普通の（公開の）スレッド」だと確かめられるか。
// 公開チャンネルの中のプライベートスレッドは、一覧の行にも読み上げ用の名前にも目印がなく、
// 見出しの「親 > スレッド名」のスレッド名の前のアイコンだけが、鍵付きの形に変わる。
// そこで次がすべてそろったときだけ公開とみなし、どれか欠ければ翻訳しない側に倒す：
//  - 見出しに「親 > スレッド」の形（caret）があり、その後にアイコンとスレッド名がある
//  - そのスレッド名が、一覧のスレッドの行の名前に含まれる（別のスレッドの見出しを見ていない）
//  - アイコンの形が、同じ見出しの右上にある「スレッド」ボタン等のアイコンと同じ（普通のスレッドの形）
function isConfirmedPublicThreadHeader(threadId) {
  const row = sidebarItem(threadId);
  if (!row) return false;
  const rowName = row.getAttribute("aria-label") || "";
  for (const upper of document.querySelectorAll('[class*="upperContainer"]')) {
    const caret = upper.querySelector('[class*="caret"]');
    if (!caret) continue;
    const after = [...upper.querySelectorAll('[class*="channelIcon"], h1, h2, h3')].filter(
      (el) => caret.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const iconWrap = after.find((el) => el.matches('[class*="channelIcon"]'));
    const title = after.find((el) => /^H[1-3]$/.test(el.tagName));
    if (!iconWrap || !title) continue;
    // 見出しには読み上げ専用の「スレッド: 」等が隠れて付いているので、見えている文字だけで比べる
    const visible = title.cloneNode(true);
    visible.querySelectorAll('[class*="hiddenVisually"]').forEach((n) => n.remove());
    const name = visible.textContent.trim();
    if (!name || !isSameThreadName(rowName, name)) continue;
    const icon = iconWrap.querySelector("svg");
    const shape = icon && iconShape(icon);
    if (!shape) continue;
    const section = upper.closest("section") || upper;
    const same = [...section.querySelectorAll("svg")].some(
      (svg) => !svg.closest('[class*="channelIcon"]') && iconShape(svg) === shape
    );
    if (same) return true;
  }
  return false;
}

// 一覧のスレッドの行の名前（「件の未読、名前（スレッド）」「名前 (thread)」など）が、指定した名前そのものか。
// 部分一致だと「スレッド」のような短い名前がどの行にも当たるので、前後の決まった部分を外して完全一致で比べる
function isSameThreadName(rowLabel, name) {
  const title = rowLabel.replace(/\s*[(（][^()（）]*[)）]\s*$/, "").trim();
  return title === name || title.endsWith(`、${name}`) || title.endsWith(`, ${name}`);
}

// 指定したフォーラムの投稿一覧に、指定した投稿のカードが表示されているか。
// リスト表示ではカードに forum-channel-list-<フォーラムID>___<投稿ID>、
// ギャラリー表示ではカードに forum-grid-view___card-…-<投稿ID> の目印が付く。
// ギャラリーにはURLのフォーラム（一覧として開いているフォーラム）の投稿しか並ばないので、
// そのフォーラムの一覧が出ていて、その中に投稿のカードがあれば、そのフォーラムの投稿だと言える
function isForumPostCardShown(guild, forumId, postId) {
  const isId = (v) => /^\d+$/.test(v || "");
  if (!isId(guild) || !isId(forumId) || !isId(postId)) return false;
  if (document.querySelector(`[data-list-item-id="forum-channel-list-${forumId}___${postId}"]`)) return true;
  return [...document.querySelectorAll('[data-grid-item-id^="forum-grid-view___"]')].some((el) =>
    el.getAttribute("data-grid-item-id").endsWith(`-${postId}`)
  );
}

// URLにチャンネルIDが無いとき（サーバーのアイコンから入ったとき）に、一覧で「いま開いている」項目
function currentLinkForGuild(guild) {
  const current = [
    ...document.querySelectorAll('a[data-list-item-id^="channels___"][aria-current="page"]'),
  ].filter((a) => (a.getAttribute("href") || "").startsWith(`/channels/${guild}/`));
  return current.length === 1 ? current[0] : null;
}

// 現在開いているチャンネルがプライベート（DM・鍵付き等）かどうかを判定する。
// 該当する場合はテキストの抽出・翻訳リクエストの発行を一切行わない。
// 判定に使う項目は「URLのIDと一致する一覧の項目」だけにし、見つからなければ翻訳しない側に倒す
// （移動の途中で前のチャンネルの項目が残っていても、取り違えないように）
function isSecretChannel() {
  // 1. DM・グループDM（URLが /channels/@me で始まる）
  if (location.pathname.startsWith("/channels/@me")) return true;
  const p = parseChannelPath();
  if (!p || !/^\d+$/.test(p.guild)) return true;

  // 2. サーバーのアイコンから入ったとき（URLにチャンネルのIDが付かない）は、
  //    一覧で「いま開いている」印（aria-current="page"）が付いた、このサーバーの項目を使う
  if (!p.channel) {
    const current = currentLinkForGuild(p.guild);
    return !current || isLockedItem(current);
  }

  // 3. /親チャンネル/threads/スレッド の形（フォーラムの投稿や、サイドパネルで開いたスレッド）。
  //    ここでは親チャンネルを判定する。スレッドの中身（サイドパネル）は欄ごとの判定（isAllowedPane）で決める
  if (p.thread) {
    const parent = sidebarItem(p.channel);
    if (!parent || parent.tagName !== "A") return true;
    if (isLockedItem(parent)) return true;
    const row = sidebarItem(p.thread);
    if (row && isLockedItem(row)) return true;
    return false;
  }

  // 4. 普通のチャンネル、または一覧のスレッドの行から開いたスレッド（全画面）
  const item = sidebarItem(p.channel);
  if (!item) return true; // 一覧に見当たらないものは、念のため翻訳しない
  if (isLockedItem(item)) return true;
  if (item.tagName !== "A") {
    // スレッドの行：親チャンネルが鍵なしで、見出しから公開のスレッドだと確かめられたときだけ
    const parent = precedingChannelLink(item);
    if (!parent || isLockedItem(parent)) return true;
    if (!isConfirmedPublicThreadHeader(p.channel)) return true;
  }
  return false;
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
// 項目自身の名前は「件の未読、general(テキストチャンネル), プライベートチャンネル（ロック中）」や
// 「タイトル（プライベートスレッド）」のように、名前のあとに種類や状態がかっこ書き・区切りで続くので、
// 最初の開きかっこから後ろを調べる（「lockdown-攻略」のような名前で誤判定しないように。
// 名前の中にかっこがあって誤判定しても、翻訳しない側に倒れるだけなので安全）。
// 中のアイコンの名前（「テキスト(限定) icon」など）はチャンネル名を含まないので、そのまま調べる。
// ※ 公開チャンネルでも「テキスト(アクティブなスレッド) icon」のようにかっこ書きが付くことがあるため、
//   かっこ書きの有無ではなく、鍵付き・限定を表す語で判定する
function isLockedItem(el) {
  const own = el.getAttribute("aria-label") || "";
  const open = own.search(/[(（]/);
  const status = open >= 0 ? own.slice(open) : own.split(/[,，、]/).slice(1).join(",");
  if (LOCK_LABEL_PATTERN.test(status)) return true;
  return [...el.querySelectorAll("[aria-label]")].some((child) => {
    const label = child.getAttribute("aria-label") || "";
    // アイコン以外のボタン（「チャンネルに招待」など）は対象外
    return /icon|アイコン/i.test(label) && LOCK_LABEL_PATTERN.test(label);
  });
}

// 発言が、チャンネルのチャット欄（またはスレッドの欄）の中にあるか。
// 検索結果・受信トレイ・ピン留め・ポップアップに出た発言は、別のチャンネル（鍵付きを含む）の
// ものかもしれないので、読み取らない
function isInChatList(el) {
  if (!el.closest('[data-list-id^="chat-messages"]')) return false;
  // 返信の上に出る引用（元の発言の抜粋）にも同じ message-content-数字 のIDが付くので除外する
  if (el.closest('[id^="message-reply-context-"], [class*="repliedText"]')) return false;
  if (el.closest('[role="dialog"], [class*="searchResult"], [class*="recentMentions"], [class*="popout"], [class*="inbox"]')) {
    return false;
  }
  return isAllowedPane(el);
}

// 要素があるチャット欄が「どのチャンネル（スレッド）の欄か」。
// 発言の行には id="chat-messages-<チャンネルID>-<発言ID>" が付いているので、欄の中の全部の行から読む。
// 行によってIDが食い違うときは、どの欄か確かめられないので null
function chatPaneChannelId(el) {
  const list = el.closest('[data-list-id^="chat-messages"]');
  if (!list) return null;
  const ids = new Set();
  list.querySelectorAll('li[id^="chat-messages-"]').forEach((row) => {
    const m = row.id.match(/^chat-messages-(\d+)-/);
    ids.add(m ? m[1] : "");
  });
  if (ids.size !== 1) return null;
  const [id] = ids;
  return id || null;
}

// 1回のスキャンの間だけ、欄ごとの判定結果を使い回す（発言ごとに一覧や見出しを調べ直さないように）
let paneCache = null;

// チャット欄ごとに、翻訳してよい欄かを判定する。
// スレッドを右側のサイドパネルで開くと、URLはスレッドに、上の見出しは親チャンネルのままになり、
// ページ全体の判定だけでは「どちらの欄がどのチャンネルか」を取り違える。そこで欄ごとに、
// 欄の発言に付いたチャンネルIDから判定する。どの条件も「公開だと確かめられたときだけ許可」にする
function isAllowedPane(el) {
  const list = el.closest('[data-list-id^="chat-messages"]');
  if (!list) return false;
  if (paneCache && paneCache.has(list)) return paneCache.get(list);
  const result = judgePane(list);
  if (paneCache) paneCache.set(list, result);
  return result;
}

function judgePane(list) {
  const paneId = chatPaneChannelId(list);
  const p = parseChannelPath();
  if (!paneId || !p) return false;

  // a. メインの欄（<main> の中）。左のチャンネル一覧の項目で判定する
  if (list.closest("main")) {
    const item = sidebarItem(paneId);
    if (!item || isLockedItem(item)) return false;
    if (item.tagName === "A") {
      // チャンネル。URLのチャンネル（URLにIDが無ければ「いま開いている」項目）と一致すること
      let pageChannel = p.channel;
      if (!pageChannel) {
        const current = currentLinkForGuild(p.guild);
        pageChannel = current ? (current.getAttribute("href") || "").split("/").pop() : null;
      }
      return !!pageChannel && paneId === pageChannel;
    }
    // スレッドを全画面で開いているとき：URLがそのスレッドで、親が鍵なしで、
    // 見出しから公開のスレッドだと確かめられること
    if (p.thread || p.channel !== paneId) return false;
    const parent = precedingChannelLink(item);
    return !!parent && !isLockedItem(parent) && isConfirmedPublicThreadHeader(paneId);
  }

  // b. サイドパネル。フォーラムの投稿だけを翻訳する。
  //    URLが /親/threads/投稿 で、欄がその投稿のもので、その親フォーラムの投稿一覧に
  //    その投稿のカードが表示されていること（テキストチャンネルのスレッドをサイドパネルで開いたときは、メインが普通の
  //    チャット欄になる。パネルでは公開かプライベートか見分けられないので翻訳しない）
  if (!p.thread || paneId !== p.thread) return false;
  if (document.querySelector('main [data-list-id^="chat-messages"]')) return false;
  // パネルの投稿が、本当にURLのフォーラムの投稿か（一覧にその投稿のカードがあるか）を確かめる。
  // チャット内のリンク等で「フォーラム/threads/別チャンネルのスレッド」の形に移ると、
  // Discordはフォーラムの一覧の横に別チャンネルのスレッドを表示してしまうため
  if (!isForumPostCardShown(p.guild, p.channel, p.thread)) return false;
  const parent = sidebarItem(p.channel);
  return !!parent && parent.tagName === "A" && !isLockedItem(parent);
}

// 見出し（フォーラムのタイトル、スレッド名など）を翻訳してよい場所か。
// チャット欄の中なら欄ごとの判定に従う。チャット欄の外は、フォーラムの投稿一覧のカードだけ
// （スレッド一覧のポップアウト、検索結果、一覧の行、見出しのバーなどは読まない）
function isAllowedTitleLocation(el) {
  if (el.closest('[role="dialog"], [class*="searchResult"], [class*="recentMentions"], [class*="popout"], [class*="inbox"]')) {
    return false;
  }
  if (el.closest('[data-list-id^="chat-messages"]')) return isAllowedPane(el);
  const p = parseChannelPath();
  if (!p || p.channel === null) return false;
  const card = el.closest('li[class*="card"]');
  if (!card) return false;
  if (el.closest('[role="complementary"], nav, aside, [class*="upperContainer"]')) return false;
  // そのカードが、フォーラムの投稿一覧（URLのフォーラムのリスト表示、またはギャラリー表示）のものであること
  return !!(
    card.querySelector(`[data-list-item-id^="forum-channel-list-${p.channel}___"]`) ||
    card.closest(`[data-list-id="forum-channel-list-${p.channel}"]`) ||
    card.querySelector('[data-grid-item-id^="forum-grid-view___"]')
  );
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
      "code, pre, .discord-translated-message, .discord-translated-title, [class*='hiddenVisually']"
    )
    .forEach((n) => n.remove());
  // ネタバレ（スポイラー）は中身を送らず「…」に置き換える。
  // 単に消すと「The patch notes say , マジで？」のように文が崩れて誤訳を招くため、
  // 伏せた部分があることだけを翻訳エンジンに伝える（開いた後も目印は残るので同じ扱い）
  clone
    .querySelectorAll("[class*='spoilerContent'], [class*='spoilerMarkdownContent'], [class*='spoilerText']")
    .forEach((n) => {
      if (!clone.contains(n)) return; // 外側のネタバレと一緒に置き換え済み
      n.replaceWith(document.createTextNode("…"));
    });

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
  // 画面に入った時点の「どのチャンネル・どの欄か」を覚えておき、後の照合に使う
  const origin = {
    channelKey: currentChannelKey(),
    paneId: element.closest('[data-list-id^="chat-messages"]') ? chatPaneChannelId(element) || "?" : "",
  };

  // 翻訳元が「自動検出」で、翻訳先と同じ言語の発言には青バーを出さない設定のとき
  if (sourceLang === "auto" && skipNativeLanguage) {
    isInTargetLanguage(rawText, (sameLanguage) => {
      if (!sameLanguage) addTranslationBox(element, rawText, origin);
    });
    return;
  }
  addTranslationBox(element, rawText, origin);
}

// 要素が「いまも」翻訳してよい場所にあるか（登録時と同じチャンネル・同じ欄で、判定も変わっていない）
function isStillAllowed(element, origin) {
  checkUrlChange();
  if (!extensionEnabled || isSecretChannel()) return false;
  if (origin.channelKey !== currentChannelKey()) return false;
  const isTitle = element.dataset.translateType === "title";
  if (isTitle ? !isAllowedTitleLocation(element) : !isInChatList(element)) return false;
  if (origin.paneId) {
    if (origin.paneId === "?" || chatPaneChannelId(element) !== origin.paneId) return false;
  }
  return true;
}

function addTranslationBox(element, rawText, origin) {
  const isTitle = element.dataset.translateType === "title";
  // 判定を待つ間に拡張機能がOFFにされたり、別のチャンネルやDM等に移動した場合は何もしない
  if (!isStillAllowed(element, origin)) return;

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
  container.dataset.channelKey = origin.channelKey;
  container.dataset.paneId = origin.paneId;
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

  // 送る直前に、作ったときと同じチャンネル・同じ欄にいるか・鍵付きでないかを改めて確かめる
  // （移動の途中や、判定が変わった後に、別のチャンネルの発言を送らないように）
  const sourceElement = containerSourceElement.get(container);
  if (
    !sourceElement ||
    !isStillAllowed(sourceElement, {
      channelKey: container.dataset.channelKey || "",
      paneId: container.dataset.paneId || "",
    })
  ) {
    pendingContainers.delete(container);
    container.remove();
    return;
  }

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
  // 発言はチャット欄の、見出しは決まった場所のものだけ（編集後の再登録でも同じ判定を通す）
  if (type === "title" ? !isAllowedTitleLocation(element) : !isInChatList(element)) return;
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
  checkUrlChange(); // 移動直後なら、先に発動フラグ等をリセットしてから判定する
  if (isSecretChannel()) return; // DM・鍵付きチャンネルではスキャンしない

  paneCache = new Map();
  try {
    // 1. チャット本文・メッセージ
    document.querySelectorAll('div[id^="message-content-"]').forEach((el) => {
      if (isInChatList(el)) registerElement(el, "message");
    });

    // 2. フォーラムの投稿一覧のカードのタイトルと、チャット欄の中の大見出し（スレッド名など）。
    //    場所の判定（isAllowedTitleLocation）を通ったものだけ
    document
      .querySelectorAll(
        '[class*="postTitleText"], [class*="mainCard"] h3, [role="article"] h3, [data-text-variant^="heading-xxl"]'
      )
      .forEach((el) => {
        registerElement(el, "title");
      });
  } finally {
    paneCache = null;
  }
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
