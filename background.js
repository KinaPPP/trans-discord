const cache = new Map();
const queue = [];
let isRunning = false;
let consecutiveFailures = 0;

const SETTINGS_DEFAULTS = {
  translationProvider: "google", // "google" | "deepl" | "gemini"
  deeplApiKey: "",
  geminiApiKey: "",
  geminiTone: "auto", // "auto" | "frank" | "polite" | "cat" | "ojousama" | "kansai" | "custom"
  geminiCustomPrompt: "",
  sourceLang: "auto", // "auto" または言語コード（例: "en"）
  targetLang: "ja", // "browser"（ブラウザの言語設定）または言語コード
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

  // 口調指示はプロンプトの一番最後（AIが最も強く意識する位置）に置く。
  // 「正確な翻訳者として振る舞え」という指示と混ぜると、AIが
  // 標準的で無難な口調に補正してしまい、口調指示が無視されやすくなるため。
  return (
    `あなたはゲームコミュニティ専門の優秀な翻訳者です。${sourceInstruction}` +
    `自然な【${targetName}】に翻訳してください。ゲーム用語、スラング、ネットミームの文脈を正しく汲み取ってください。` +
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

async function translateWithGemini(text, settings) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${settings.geminiApiKey}`;
  const systemPrompt = buildGeminiSystemPrompt(settings);

  console.log(
    "[トランス☆ディスコ] Geminiへ送信します。口調設定:",
    settings.geminiTone,
    "/ 実際のシステムプロンプト:",
    systemPrompt
  );

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function translateText(text, settings) {
  console.log("[トランス☆ディスコ] 使用する翻訳エンジン:", settings.translationProvider);

  // 選択中のエンジンを最優先に、キーが設定されている他の有料エンジンを予備として並べ、
  // 最後にキー不要のGoogle翻訳を保険として置く連鎖を組み立てる
  const chain = [];

  if (settings.translationProvider === "deepl" && settings.deeplApiKey) {
    chain.push({ name: "DeepL", fn: () => translateWithDeepL(text, settings) });
  } else if (settings.translationProvider === "gemini" && settings.geminiApiKey) {
    chain.push({ name: "Gemini", fn: () => translateWithGemini(text, settings) });
  }

  if (settings.translationProvider !== "deepl" && settings.deeplApiKey) {
    chain.push({ name: "DeepL", fn: () => translateWithDeepL(text, settings) });
  }
  if (settings.translationProvider !== "gemini" && settings.geminiApiKey) {
    chain.push({ name: "Gemini", fn: () => translateWithGemini(text, settings) });
  }

  chain.push({ name: "Google翻訳", fn: () => translateWithGoogle(text, settings) });

  let lastError;
  for (const { name, fn } of chain) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.log(`[トランス☆ディスコ] ${name}失敗、次のエンジンを試します:`, err.message);
    }
  }
  throw lastError;
}

async function processQueue() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;

  while (queue.length > 0) {
    const { text, sendResponse } = queue.shift();
    // リクエストのたびに最新の設定を読み直す（Service Worker再起動直後のレース対策）
    const settings = await getSettings();
    const cacheKey = `${settings.translationProvider}:${settings.sourceLang}:${settings.targetLang}:${settings.geminiTone}:${settings.geminiCustomPrompt}:${text}`;

    console.log(
      "[トランス☆ディスコ] キュー処理開始 / エンジン:",
      settings.translationProvider,
      "/ 口調:",
      settings.geminiTone
    );

    if (cache.has(cacheKey)) {
      console.log("[トランス☆ディスコ] キャッシュから返答（新規リクエストは送っていません）");
      sendResponse({ success: true, text: cache.get(cacheKey) });
      continue;
    }

    try {
      const translatedText = await translateText(text, settings);
      cache.set(cacheKey, translatedText);
      sendResponse({ success: true, text: translatedText });
      consecutiveFailures = 0; // 成功したらリセット
    } catch (err) {
      consecutiveFailures++;
      sendResponse({ success: false, error: err.message });
    }

    // 失敗が続くほど待機時間を指数的に延ばす（Google翻訳側のレート制限対策）
    await new Promise((resolve) => setTimeout(resolve, getDelay()));
  }

  isRunning = false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    queue.push({ text: request.text, sendResponse });
    processQueue();
    return true;
  }
});
