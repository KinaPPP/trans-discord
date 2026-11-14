// メモリ上のMapをメインに使いつつ、Service Worker再起動をまたいでも
// ブラウザを閉じるまでは保持されるよう chrome.storage.session と同期する。
// 件数上限を設けたLRU（あまり使われていない古いものから捨てる）方式。
const cache = new Map();
const CACHE_STORAGE_KEY = "translationCache";
const CACHE_LIMIT = 1000;
let persistTimer = null;

async function loadCacheFromSession() {
  try {
    const result = await chrome.storage.session.get(CACHE_STORAGE_KEY);
    const saved = result[CACHE_STORAGE_KEY];
    if (saved) {
      // 保存時の順序（古い→新しい）をそのままMapの挿入順として復元する
      Object.entries(saved).forEach(([key, value]) => cache.set(key, value));
    }
  } catch (err) {
    console.warn("[トランス☆ディスコ] キャッシュの復元に失敗:", err);
  }
}
// 起動直後からのリクエストが復元前にキャッシュを見に行かないよう、
// この読み込み完了をprocessQueue側で待ってから処理を始める
const cacheReady = loadCacheFromSession();

function persistCache() {
  clearTimeout(persistTimer);
  // 短時間に連続する書き込みをまとめるための簡易デバウンス
  persistTimer = setTimeout(() => {
    chrome.storage.session
      .set({ [CACHE_STORAGE_KEY]: Object.fromEntries(cache) })
      .catch((err) => console.warn("[トランス☆ディスコ] キャッシュの保存に失敗:", err));
  }, 1000);
}

function getCache(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  // アクセスされたものを最新扱いにする（Mapの末尾に移動＝LRUの「直近使用」扱い）
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCache(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  persistCache();
}

function clearCache() {
  cache.clear();
  clearTimeout(persistTimer);
  return chrome.storage.session.remove(CACHE_STORAGE_KEY);
}

const queue = [];
let isRunning = false;
let consecutiveFailures = 0;

const SETTINGS_DEFAULTS = {
  translationProvider: "google", // "google" | "deepl" | "gemini" | "plamo"
  deeplApiKey: "",
  geminiApiKey: "",
  geminiTone: "auto", // "auto" | "frank" | "polite" | "cat" | "ojousama" | "kansai" | "custom"
  geminiCustomPrompt: "",
  plamoServerType: "lmstudio", // "sts"（シンプル翻訳サーバー） | "lmstudio" | "llamacpp" | "ollama"
  plamoServerUrl: "http://localhost:1234",
  plamoForm: "auto", // "auto" | "polite" | "plain"（日本語訳のときだけ有効）
  plamoModel: "", // 接続テストまたは初回翻訳時に、サーバーから自動検出して保存する
  plamoApiKey: "", // シンプル翻訳サーバーの合言葉（接続アプリごとに発行されたもの）
  sourceLang: "auto", // "auto" または言語コード（例: "en"）
  targetLang: "browser", // "browser"（ブラウザの言語設定）または言語コード
};

// Manifest V3のService Workerは操作が無いと終了し、次のメッセージで再起動する。
// 起動時に一度だけ設定を読んでキャッシュする方式だと、再起動直後の読み込みが
// 完了する前にリクエストが来た場合に古い/初期値の設定で処理されてしまうため、
// 毎回のリクエストごとに chrome.storage.local から読み直す。
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_DEFAULTS, resolve);
  });
}

const BASE_DELAY = 250;
const MAX_DELAY = 30000; // 最大30秒まで間隔を広げる

function getDelay() {
  if (consecutiveFailures === 0) return BASE_DELAY;
  return Math.min(BASE_DELAY * 2 ** consecutiveFailures, MAX_DELAY);
}

// "browser"指定時はブラウザのUI言語（例: "ja-JP" → "ja"）を実際の翻訳先言語として使う
function resolveTargetLang(targetLang) {
  if (targetLang === "browser") {
    const uiLang = chrome.i18n.getUILanguage() || "ja";
    return uiLang.split("-")[0];
  }
  return targetLang;
}

// ===== パスワードやトークンらしき文字列の検査 =====
// 外部の翻訳サービス（Google・DeepL・Gemini）に送る前に、拡張機能自身でも調べる。
// シンプル翻訳サーバーが止まっていても、怪しい発言が外部に出ないようにするため。
// ※ すべてを見抜くことはできない補助的な守り。シンプル翻訳サーバーの secrets.js と同じ規則。
const SECRET_PHRASE_PATTERNS = [
  /(?:password|passwd|passcode|パスワード|パスコード|暗証番号)\s*[:=：]\s*(?!(?:reset|here|please|is|it|the|a|an|and|or|not|forgot|change|update)\b)\S/i,
  /\b(?:pass|pw|pwd)\s*[:=：]\s*(?=\S*[A-Za-z])(?=\S*[0-9!@#$%^&*])\S{4,}/i,
  /(?:パスワード|暗証番号)\s*(?:は|わ)\s*[「『"']?[\x21-\x7E]{4,}/,
  /\bpass(?:word|code)?\s+is\s+["'`]?(?=[\x21-\x7E]*[0-9!@#$%^&*])[\x21-\x7E]{4,}/i,
];
const SECRET_TOKEN_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b[0-9a-f]{40,}\b/i,
];

function hasRandomToken(text) {
  const candidates = text.match(/[A-Za-z0-9+/_=-]{32,}/g) || [];
  return candidates.some((s) => {
    const lower = (s.match(/[a-z]/g) || []).length;
    const upper = (s.match(/[A-Z]/g) || []).length;
    const digit = (s.match(/[0-9]/g) || []).length;
    return lower >= 4 && upper >= 4 && digit >= 4;
  });
}

function looksSecret(text) {
  if (typeof text !== "string" || !text) return false;
  const normalized = text.normalize("NFKC");
  const urls = normalized.match(/https?:\/\/\S+/g) || [];
  if (urls.some((u) => SECRET_TOKEN_PATTERNS.some((re) => re.test(u)))) return true;
  const withoutUrls = normalized.replace(/https?:\/\/\S+/g, " ");
  return (
    SECRET_PHRASE_PATTERNS.some((re) => re.test(withoutUrls)) ||
    SECRET_TOKEN_PATTERNS.some((re) => re.test(withoutUrls)) ||
    hasRandomToken(withoutUrls)
  );
}

async function translateWithGoogle(text, settings) {
  console.log("[トランス☆ディスコ] Google翻訳へ送信します。");
  const tl = resolveTargetLang(settings.targetLang);
  const sl = settings.sourceLang === "auto" ? "auto" : settings.sourceLang;
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

async function translateWithDeepL(text, settings) {
  console.log("[トランス☆ディスコ] DeepLへ送信します。");
  const apiKey = settings.deeplApiKey;
  // 無料キーは末尾が ":fx"。エンドポイントのホストが異なる
  const isFree = apiKey.endsWith(":fx");
  const base = isFree ? "https://api-free.deepl.com" : "https://api.deepl.com";

  const tl = resolveTargetLang(settings.targetLang).toUpperCase();
  const params = { text, target_lang: tl };
  if (settings.sourceLang !== "auto") {
    params.source_lang = settings.sourceLang.toUpperCase();
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

// 言語コード → 日本語での言語名（Geminiへの指示文で使う）
const LANG_NAMES = {
  ja: "日本語",
  en: "英語",
  zh: "中国語",
  ko: "韓国語",
  fr: "フランス語",
  de: "ドイツ語",
  es: "スペイン語",
  pt: "ポルトガル語",
  it: "イタリア語",
  ru: "ロシア語",
  th: "タイ語",
  vi: "ベトナム語",
  id: "インドネシア語",
};

const GEMINI_MODEL = "gemini-3.5-flash-lite"; // gemini-2.5-flash-liteは新規ユーザー向け提供終了のため移行

const TONE_PRESETS = {
  frank: "文末を「〜だね」「〜だよ」「〜かも」など、親しみやすい会話調に必ず統一してください。",
  polite: "文末を「〜です」「〜ます」など、落ち着いた敬体に必ず統一してください。",
  cat: `【最重要ルール】
・文末・語尾は必ず「〜にゃ」「〜だにゃ」「〜かにゃ？」「〜にゃ〜」に変換してください。
・すべての文を例外なく猫口調にしてください。内容の意味は変えないでください。

【変換の例】
・This is a bug -> これはバグだにゃ！
・I cleared it without issues -> 問題なくクリアできたにゃ〜
・What do you think? -> どう思うかにゃ？`,
  ojousama: `【最重要ルール】
・優雅なお嬢様言葉（〜ですわ、〜ますわ、〜ですの？、〜よろしくてよ）に必ず変換してください。内容の意味は変えないでください。

【変換の例】
・This is a bug -> こちらはバグですわ！
・I cleared it -> わたくし、クリアいたしましたわ`,
  kansai: `【最重要ルール】
・語尾やイントネーションを必ず関西弁（「〜やで」「〜やねん」「せやから」等）に変換してください。内容の意味は変えないでください。

【変換の例】
・This is a bug -> これバグやで！
・I cleared it without issues -> 問題なくクリアできたわ`,
};

function buildGeminiSystemPrompt(settings) {
  const targetName = LANG_NAMES[resolveTargetLang(settings.targetLang)] || "日本語";
  const sourceInstruction =
    settings.sourceLang !== "auto" && LANG_NAMES[settings.sourceLang]
      ? `入力された【${LANG_NAMES[settings.sourceLang]}】のテキストを、`
      : "入力されたテキスト（言語は自動判別）を、";

  let toneInstruction = "";
  if (settings.geminiTone === "custom" && settings.geminiCustomPrompt) {
    toneInstruction = settings.geminiCustomPrompt.trim();
  } else if (TONE_PRESETS[settings.geminiTone]) {
    toneInstruction = TONE_PRESETS[settings.geminiTone];
  }

  // 「〜しないでください」という否定形の指示は、長文の中では推論時に薄れやすい。
  // 特に日本語は「見出し＋直後の1文」を1つの文脈としてまとめようとする補正が
  // 強く働くため、否定文ではなく宣言的なルール＋具体例（Few-shot）で対策する。
  const structureRules = `【最重要：テキスト構造と改行の絶対ルール】
1. 原文の「行の構造（行数・改行位置）」を完全に1対1で維持してください。
2. 見出し行と箇条書き行を絶対に1行に結合（マージ）しないでください。
3. 「•」などの記号で始まる行は、必ず新しい行（改行後）から開始してください。

【変換例（構造の維持）】
入力:
New Items
• Item A: Description
• Item B: Description

出力:
${targetName === "日本語" ? "新アイテム" : "New Items相当の見出し"}
• アイテムA: 説明
• アイテムB: 説明`;

  // 口調指示はプロンプトの一番最後（AIが最も強く意識する位置）に置く。
  // 「正確な翻訳者として振る舞え」という指示と混ぜると、AIが
  // 標準的で無難な口調に補正してしまい、口調指示が無視されやすくなるため。
  return (
    `あなたはゲームコミュニティ専門の優秀な翻訳者です。${sourceInstruction}` +
    `自然な【${targetName}】に翻訳してください。ゲーム用語、スラング、ネットミームの文脈を正しく汲み取ってください。\n\n` +
    `${structureRules}\n\n` +
    `前置きや解説、挨拶は一切出力せず、翻訳結果のテキストのみを出力してください。` +
    (toneInstruction ? `\n\n${toneInstruction}` : "")
  );
}

function resolveGeminiTemperature(settings) {
  // 標準口調（おまかせ）は正確さ優先で低め、口調変更ありの場合は
  // 崩しを許容するため少し引き上げる
  return settings.geminiTone === "auto" ? 0.2 : 0.4;
}

// ゲームコミュニティの会話には暴力・グロテスク表現を含む用語が
// 日常的に出てくる（例: Flayed, Martyr, kill 等）ため、翻訳が
// 意図せずセーフティフィルターでブロックされないよう緩和しておく
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// Geminiの無料枠は「1分あたり15リクエスト」が上限。429を受け取ってから
// リトライ待ちするのは翻訳表示が遅くなるだけなので、直近60秒の送信回数を
// 自分で数えておき、上限に近づいたら最初から他のエンジンに回す。
const GEMINI_RATE_WINDOW_MS = 60_000;
const GEMINI_RATE_LIMIT_SAFE = 12; // 実際の上限（15/分）より少し手前で止める
let geminiRequestTimestamps = [];

function canUseGeminiNow() {
  const now = Date.now();
  geminiRequestTimestamps = geminiRequestTimestamps.filter(
    (t) => now - t < GEMINI_RATE_WINDOW_MS
  );
  return geminiRequestTimestamps.length < GEMINI_RATE_LIMIT_SAFE;
}

function recordGeminiRequest() {
  geminiRequestTimestamps.push(Date.now());
}

async function translateWithGemini(text, settings) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const systemPrompt = buildGeminiSystemPrompt(settings);

  recordGeminiRequest();

  console.log(
    "[トランス☆ディスコ] Geminiへ送信します。口調設定:",
    settings.geminiTone,
    "/ 実際のシステムプロンプト:",
    systemPrompt
  );
  const res = await fetch(url, {
    method: "POST",
    // APIキーはURLに入れず、ヘッダーで送る（URLはログなどに残りやすいため）
    headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      safetySettings: GEMINI_SAFETY_SETTINGS,
      generationConfig: {
        // 標準は正確さ優先で低め、口調プリセット使用時は崩しを許容するため引き上げる
        temperature: resolveGeminiTemperature(settings),
        maxOutputTokens: 1000,
      },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error("[トランス☆ディスコ] Gemini HTTPエラー:", res.status, errorBody);
    throw new Error(`GEMINI_HTTP_${res.status}`);
  }

  const data = await res.json();

  // parts配列内で最初に空でないtextを持つ要素を採用する
  // （thinking機能等でparts[0]が空/別内容になるケースへの対策）
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p) => p.text && p.text.trim().length > 0);
  if (textPart) {
    return textPart.text.trim();
  }

  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason) {
    console.warn("[トランス☆ディスコ] Gemini終了ステータス:", finishReason, data);
  }
  throw new Error(`GEMINI_EMPTY_RESPONSE${finishReason ? `_${finishReason}` : ""}`);
}

// ===== ローカル翻訳（PLaMo 3 Translate） =====
// 利用者が自分のPCで起動した LM Studio / llama.cpp / Ollama に送る。
// モデルは同梱せず、翻訳はPC内で完結する（Built with PLaMo）。

// PLaMo 3 Translate の対応言語コード（公式モデルカード記載の53言語）
const PLAMO_LANGS = new Set([
  "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn", "ca", "ceb",
  "de", "es", "et", "eu", "fa", "fr", "gu", "he", "hi", "hr", "hu", "hy", "id", "it",
  "jv", "ka", "kk", "km", "lt", "lv", "ml", "mr", "ms", "my", "ne", "nl", "pa", "pl",
  "ru", "si", "sk", "sl", "sr", "sw", "ta", "te", "th", "tl", "ur", "uz", "vi",
]);

// トランス☆ディスコの言語コード → PLaMoの言語コード。対応外なら null
function toPlamoLang(code) {
  if (code === "zh") return "zh-hans";
  return PLAMO_LANGS.has(code) ? code : null;
}

// サーバーの種類ごとの既定URL
const PLAMO_DEFAULT_URLS = {
  sts: "http://localhost:5055",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8000",
  ollama: "http://localhost:11434",
};

const PLAMO_STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];
const PLAMO_TIMEOUT_MS = 60_000; // 初回はモデル読み込みで時間がかかることがあるため長め

// 拡張機能の権限（host_permissions）で許可しているのは自分のPCだけ
function normalizePlamoUrl(rawUrl) {
  let url;
  try {
    url = new URL((rawUrl || "").trim());
  } catch {
    throw new Error("PLAMO_BAD_URL");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("PLAMO_BAD_URL");
  }
  return url.origin;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PLAMO_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 別の場所への転送（リダイレクト）には従わない（自分のPCの外へ送られないように）
    return await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("PLAMO_TIMEOUT");
    // サーバー未起動・ポート違いなど
    throw new Error("PLAMO_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
}

// サーバーに読み込まれているモデル一覧から、PLaMo翻訳モデルを探す
async function detectPlamoModel(serverType, origin) {
  const isOllama = serverType === "ollama";
  const res = await fetchWithTimeout(
    isOllama ? `${origin}/api/tags` : `${origin}/v1/models`,
    {},
    10_000
  );
  if (res.status === 403) throw new Error("PLAMO_FORBIDDEN");
  if (!res.ok) throw new Error(`PLAMO_HTTP_${res.status}`);
  const data = await res.json();
  const names = isOllama
    ? (data.models || []).map((m) => m.name || m.model)
    : (data.data || []).map((m) => m.id);
  const found =
    names.find((n) => /plamo.*translate/i.test(n || "")) ||
    names.find((n) => /plamo/i.test(n || ""));
  if (!found) {
    // llama-server は1モデルしか載せないので、名前に plamo が無くてもそれを使う
    if (serverType === "llamacpp" && names.length > 0) return names[0];
    throw new Error("PLAMO_MODEL_NOT_FOUND");
  }
  return found;
}

// PFML3形式のプロンプトを組み立てる（公式モデルカードの書式どおり。BOSはサーバー側が付与）
function buildPlamoPrompt(text, sourceLang, targetLang, form) {
  // 原文に制御用の記号列が紛れていても書式が壊れないよう無害化する
  const safeText = text.replace(/<\|plamo:/g, "<​|plamo:");
  let prompt = "<|plamo:tag|>dataset<|plamo:msg|>translation";
  prompt += "<|plamo:tag|>input";
  if (sourceLang) prompt += `<|plamo:key|>lang<|plamo:val|>${sourceLang}`;
  prompt += `<|plamo:msg|>${safeText}`;
  prompt += `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${targetLang}`;
  if (form) prompt += `<|plamo:key|>form<|plamo:val|>${form}`;
  prompt += "<|plamo:msg|>";
  return prompt;
}

async function translateWithPlamo(text, settings) {
  const serverType = PLAMO_DEFAULT_URLS[settings.plamoServerType]
    ? settings.plamoServerType
    : "lmstudio";
  const origin = normalizePlamoUrl(settings.plamoServerUrl);

  const targetLang = toPlamoLang(resolveTargetLang(settings.targetLang));
  if (!targetLang) throw new Error("PLAMO_UNSUPPORTED_LANG");
  // 翻訳元が自動、またはPLaMo非対応の言語なら指定せずモデルに判定させる
  const sourceLang =
    settings.sourceLang === "auto" ? null : toPlamoLang(settings.sourceLang);
  const form =
    targetLang === "ja" && ["polite", "plain"].includes(settings.plamoForm)
      ? settings.plamoForm
      : null;

  if (serverType === "sts") return translateWithSts(origin, text, sourceLang, targetLang, form, settings.plamoApiKey);

  let model = settings.plamoModel;
  if (!model) {
    model = await detectPlamoModel(serverType, origin);
    chrome.storage.local.set({ plamoModel: model });
  }

  const prompt = buildPlamoPrompt(text, sourceLang, targetLang, form);
  console.log("[トランス☆ディスコ] PLaMoへ送信します。", { serverType, origin, model });

  // チャット用テンプレートを通さず、PFML3の文字列をそのまま渡す必要がある。
  // Ollamaは /v1/completions にもテンプレートを当てるため /api/generate + raw を使う
  const maxTokens = 2048;
  const res =
    serverType === "ollama"
      ? await fetchWithTimeout(`${origin}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            raw: true,
            stream: false,
            options: { temperature: 0, num_predict: maxTokens, stop: PLAMO_STOP },
          }),
        })
      : await fetchWithTimeout(`${origin}/v1/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            temperature: 0,
            max_tokens: maxTokens,
            stop: PLAMO_STOP,
            stream: false,
          }),
        });

  if (res.status === 403) throw new Error("PLAMO_FORBIDDEN");
  if (res.status === 404 || res.status === 400) {
    // モデルを入れ替えた等で保存済みの名前が古い可能性がある。次回は検出し直す
    chrome.storage.local.set({ plamoModel: "" });
    throw new Error(`PLAMO_HTTP_${res.status}`);
  }
  if (!res.ok) {
    console.error("[トランス☆ディスコ] PLaMo HTTPエラー:", res.status, await res.text());
    throw new Error(`PLAMO_HTTP_${res.status}`);
  }

  const data = await res.json();
  let output = serverType === "ollama" ? data.response : data.choices?.[0]?.text;
  if (typeof output !== "string") throw new Error("PLAMO_UNEXPECTED_FORMAT");
  // 停止トークンが出力に残るサーバーがあっても、そこで切る
  for (const stop of PLAMO_STOP) {
    const idx = output.indexOf(stop);
    if (idx !== -1) output = output.slice(0, idx);
  }
  output = output.trim();
  if (!output) throw new Error("PLAMO_EMPTY_RESPONSE");
  return output;
}

// シンプル翻訳サーバー（LibreTranslate互換の窓口）で翻訳する。
// PLaMo専用の書式の組み立てや辞書はサーバー側が受け持つ
async function translateWithSts(origin, text, sourceLang, targetLang, form, apiKey) {
  if (!apiKey) throw new Error("PLAMO_NO_KEY");
  const res = await fetchWithTimeout(`${origin}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ q: text, source: sourceLang || "auto", target: targetLang, ...(form ? { form } : {}) }),
  });
  // パスワード等らしき文字列があるとして断られた発言は、他のエンジンにも回さない
  if (res.status === 422) throw new Error("PLAMO_REFUSED");
  if (res.status === 403) throw new Error("PLAMO_BAD_KEY");
  if (res.status === 503) throw new Error("PLAMO_PAUSED_OR_UNAVAILABLE");
  if (!res.ok) throw new Error(`PLAMO_HTTP_${res.status}`);
  const data = await res.json();
  const output = typeof data.translatedText === "string" ? data.translatedText.trim() : "";
  if (!output) throw new Error("PLAMO_EMPTY_RESPONSE");
  return output;
}

// 詳細設定の「接続テスト」とポップアップの状態表示用：
// サーバーに届くか、PLaMoモデル（シンプル翻訳サーバーなら合言葉）が使えるかを確認する
async function testPlamoConnection(serverType, rawUrl, apiKey) {
  const type = PLAMO_DEFAULT_URLS[serverType] ? serverType : "lmstudio";
  const origin = normalizePlamoUrl(rawUrl);
  if (type === "sts") {
    // 翻訳エンジンを起動させずに、合言葉だけを確かめる
    if (!apiKey) throw new Error("PLAMO_NO_KEY");
    const res = await fetchWithTimeout(`${origin}/whoami`, { headers: { Authorization: `Bearer ${apiKey}` } }, 10_000);
    if (res.status === 403) throw new Error("PLAMO_BAD_KEY");
    if (!res.ok) throw new Error(`PLAMO_HTTP_${res.status}`);
    const data = await res.json();
    return { model: data.name, paused: !!data.paused };
  }
  const model = await detectPlamoModel(type, origin);
  await chrome.storage.local.set({ plamoModel: model });
  return { model, paused: false };
}

async function translateText(text, settings) {
  console.log("[トランス☆ディスコ] 使用する翻訳エンジン:", settings.translationProvider);

  const providers = {
    google: {
      id: "google",
      name: "Google翻訳",
      available: true,
      fn: () => translateWithGoogle(text, settings),
    },
    deepl: {
      id: "deepl",
      name: "DeepL",
      available: Boolean(settings.deeplApiKey),
      fn: () => translateWithDeepL(text, settings),
    },
    gemini: {
      id: "gemini",
      name: "Gemini",
      available: Boolean(settings.geminiApiKey),
      // レート制限に近い場合は、実際に送って429を受け取るより先にスキップする
      fn: () => {
        if (!canUseGeminiNow()) {
          console.log(
            "[トランス☆ディスコ] Geminiのレート制限（1分15回）に近いため、送信せずスキップします"
          );
          throw new Error("GEMINI_RATE_LIMIT_GUARD");
        }
        return translateWithGemini(text, settings);
      },
    },
    plamo: {
      id: "plamo",
      name: "PLaMo",
      // ローカル翻訳は、選択中のときだけ使う（サーバー未起動のPCで毎回待たされないように）
      available: settings.translationProvider === "plamo",
      fn: () => translateWithPlamo(text, settings),
    },
  };

  // 選択中のエンジンを最優先に、キーが設定されている他の有料エンジンを予備として並べ、
  // 最後にキー不要のGoogle翻訳を保険として置く連鎖を組み立てる（重複は除去）
  const order = [settings.translationProvider, "deepl", "gemini", "google"].filter(
    (id, index, arr) => arr.indexOf(id) === index
  );
  let chain = order.map((id) => providers[id]).filter((p) => p && p.available);

  // パスワードやトークンらしき文字列を含む発言は、自分のPCの中で訳せるローカル翻訳（PLaMo）だけに回す。
  // ローカル翻訳が使えないときは、どこにも送らずに終える
  if (looksSecret(text)) {
    chain = chain.filter((p) => p.id === "plamo");
    if (chain.length === 0) throw new Error("PLAMO_REFUSED");
  }

  let lastError;
  for (const { id, name, fn } of chain) {
    try {
      const translatedText = await fn();
      return { engine: id, text: translatedText };
    } catch (err) {
      // 秘密情報らしいとして断られた発言は、外部のエンジンに回さずに終える
      if (err.message === "PLAMO_REFUSED") throw err;
      // 怪しい発言をローカル翻訳だけに回している場合も、失敗したらそこで終える
      if (looksSecret(text)) throw new Error("PLAMO_REFUSED");
      lastError = err;
      console.log(`[トランス☆ディスコ] ${name}失敗、次のエンジンを試します:`, err.message);
    }
  }
  throw lastError;
}

async function processQueue() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;

  await cacheReady; // Service Worker起動直後、セッションからのキャッシュ復元を待つ

  while (queue.length > 0) {
    const { text, sendResponse } = queue.shift();
    // リクエストのたびに最新の設定を読み直す（Service Worker再起動直後のレース対策）
    const settings = await getSettings();
    // ※ エンジンIDをキーに含める。フォールバックで代打翻訳された結果を
    //   「選択中エンジンの結果」として固定してしまわないよう、書き込み時は
    //   実際に翻訳したエンジンのキーを使う（下記参照）。
    const buildCacheKey = (engineId) =>
      `${engineId}:${settings.sourceLang}:${settings.targetLang}:${settings.geminiTone}:${settings.plamoForm}:${settings.geminiCustomPrompt}:${text}`;
    const primaryCacheKey = buildCacheKey(settings.translationProvider);

    console.log(
      "[トランス☆ディスコ] キュー処理開始 / エンジン:",
      settings.translationProvider,
      "/ 口調:",
      settings.geminiTone
    );

    const cachedValue = getCache(primaryCacheKey);
    if (cachedValue !== undefined) {
      console.log("[トランス☆ディスコ] キャッシュから返答（新規リクエストは送っていません）");
      sendResponse({ success: true, text: cachedValue, engine: settings.translationProvider });
      continue;
    }

    try {
      const { engine, text: translatedText } = await translateText(text, settings);
      if (engine === settings.translationProvider) {
        setCache(primaryCacheKey, translatedText);
      } else {
        // フォールバックで別エンジンが翻訳した場合は、そのエンジン自身の結果として
        // 保存する（＝選択中エンジンのキャッシュにはしない）。次回はレート制限に
        // 余裕があれば、改めて選択中エンジンで翻訳し直される。
        console.log(
          `[トランス☆ディスコ] ${engine}による代打翻訳の結果を保存（選択中エンジンのキャッシュにはしません）`
        );
        setCache(buildCacheKey(engine), translatedText);
      }
      sendResponse({ success: true, text: translatedText, engine });
      consecutiveFailures = 0; // 成功したらリセット
    } catch (err) {
      if (err.message !== "PLAMO_REFUSED") consecutiveFailures++;
      sendResponse({ success: false, error: err.message });
    }

    // 失敗が続くほど待機時間を指数的に延ばす（Google翻訳側のレート制限対策）
    await new Promise((resolve) => setTimeout(resolve, getDelay()));
  }

  isRunning = false;
}

const MAX_TEXT_LENGTH = 4000; // Discordの1発言の上限（Nitro）

// 送り元が、この拡張機能自身の画面（ポップアップ・詳細設定）かどうか
function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !request || typeof request !== "object") return;

  if (request.action === "translate") {
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > MAX_TEXT_LENGTH) {
      sendResponse({ success: false, error: "INVALID_TEXT" });
      return;
    }
    queue.push({ text: request.text, sendResponse });
    processQueue();
    return true;
  }
  // 接続テストとキャッシュの削除は、ポップアップと詳細設定からだけ受け付ける
  if ((request.action === "plamoTest" || request.action === "clearCache") && !isExtensionPage(sender)) {
    sendResponse({ success: false, error: "FORBIDDEN" });
    return;
  }
  if (request.action === "plamoTest") {
    // 合言葉は、詳細設定の入力欄の値（保存前）か、保存済みの値を使う。
    // 保存済みの合言葉を使うときは、送り先も保存済みのURLに限る
    chrome.storage.local
      .get({ plamoApiKey: "", plamoServerUrl: "" })
      .then(({ plamoApiKey, plamoServerUrl }) => {
        const useSaved = typeof request.apiKey !== "string";
        if (useSaved && request.serverUrl !== plamoServerUrl) throw new Error("PLAMO_BAD_URL");
        return testPlamoConnection(request.serverType, request.serverUrl, useSaved ? plamoApiKey : request.apiKey);
      })
      .then(({ model, paused }) => sendResponse({ success: true, model, paused }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "clearCache") {
    clearCache()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
