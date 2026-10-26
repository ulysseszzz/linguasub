/*
 * LinguaSub on-device inference worker.
 *
 * Pipeline (100% local after first model download):
 *   tab audio (16 kHz mono)
 *     -> Whisper (multilingual, auto language detection)   [Xenova/whisper-tiny]
 *     -> NLLB-200 distilled 600M translation               [Xenova/nllb-200-distilled-600M]
 *     -> caption lines posted back to the offscreen document
 *
 * Runs as a module Worker so model inference never blocks the UI / audio graph.
 */

import { pipeline, env } from '../../vendor/transformers.min.mjs';

// Vendored WASM (MV3 forbids loading remote scripts).
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');

// ---------------------------------------------------------------------------
// Minimal ISO 639-1 -> FLORES-200 map (mirrors src/shared/languages.js;
// duplicated because classic content-script globals can't be imported here).
// ---------------------------------------------------------------------------
const ISO_TO_FLORES = {
  en: 'eng_Latn', zh: 'zho_Hans', ja: 'jpn_Jpan', ko: 'kor_Hang',
  es: 'spa_Latn', fr: 'fra_Latn', de: 'deu_Latn', it: 'ita_Latn',
  pt: 'por_Latn', ru: 'rus_Cyrl', ar: 'arb_Arab', hi: 'hin_Deva',
  th: 'tha_Thai', vi: 'vie_Latn', id: 'ind_Latn', ms: 'zsm_Latn',
  tr: 'tur_Latn', nl: 'nld_Latn', pl: 'pol_Latn', uk: 'ukr_Cyrl',
  he: 'heb_Hebr', el: 'ell_Grek', sv: 'swe_Latn', fi: 'fin_Latn'
};

const TRADITIONAL_CHARS = '繁體國臺灣學習語言說讀寫這個們東西時麼華發開門長電車馬見觀場魚點經過業來頁風雲與書畫';
function isTraditionalChinese(text) {
  let hits = 0;
  for (const ch of String(text)) {
    if (TRADITIONAL_CHARS.includes(ch)) { hits += 1; if (hits >= 2) return true; }
  }
  return false;
}

const SCRIPT_RULES = [
  [/[ぁ-んァ-ヶ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'],
  [/[Ѐ-ӹ]/, 'ru'], [/[฀-๛]/, 'th'], [/[ऀ-ॿ]/, 'hi'],
  [/[֐-׿]/, 'he'], [/[؀-ۿ]/, 'ar'], [/[ἀ-῿]/, 'el']
];
const STOPWORDS = {
  en: ['the', 'is', 'are', 'and', 'that', 'this', 'with', 'for', 'you', 'have', 'was', 'not', 'but'],
  es: ['el', 'la', 'los', 'las', 'que', 'como', 'para', 'pero', 'una', 'con', 'porque', 'está', 'del'],
  fr: ['le', 'la', 'les', 'que', 'qui', 'dans', 'pour', 'avec', 'mais', 'une', 'des', 'est', 'sur'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'nicht', 'mit', 'sich', 'auf', 'für', 'auch'],
  it: ['il', 'la', 'lo', 'che', 'per', 'con', 'non', 'una', 'sono', 'questo', 'della', 'dei', 'come'],
  pt: ['que', 'não', 'uma', 'para', 'com', 'por', 'mais', 'como', 'mas', 'dos', 'das', 'está', 'você'],
  nl: ['het', 'een', 'die', 'dat', 'met', 'voor', 'maar', 'niet', 'zijn', 'dan', 'ook', 'op', 'er'],
  id: ['yang', 'dan', 'tidak', 'ini', 'itu', 'dengan', 'untuk', 'akan', 'ada', 'kamu', 'dari', 'kami'],
  tr: ['bir', 'bu', 'için', 'ile', 'ama', 'çok', 'gibi', 'kadar', 'var', 'olan', 'olarak'],
  vi: ['không', 'là', 'của', 'cho', 'một', 'nhưng', 'với', 'được', 'này', 'khi', 'như', 'phải']
};

function normalizeText(raw) {
  if (!raw) return '';
  return String(raw).replace(/<\|[^>]+\|>/g, '').replace(/\s+/g, ' ').trim();
}

function detectIso(text) {
  if (!text) return null;
  for (const [re, iso] of SCRIPT_RULES) {
    if (re.test(text)) return iso;
  }
  const words = String(text).toLowerCase().match(/[a-zà-ÿĀ-ž']+/g) || [];
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const iso of Object.keys(STOPWORDS)) {
    const set = STOPWORDS[iso];
    let score = 0;
    for (const w of words) if (set.includes(w)) score += 1;
    score /= Math.max(4, words.length / 6);
    if (score > bestScore) { bestScore = score; best = iso; }
  }
  return best || 'en';
}

function resolveFlores(iso, text) {
  const code = (iso || detectIso(text) || '').toLowerCase().slice(0, 2);
  if (code === 'zh') return isTraditionalChinese(text) ? 'zho_Hant' : 'zho_Hans';
  return ISO_TO_FLORES[code] || null;
}

// ---------------------------------------------------------------------------
// LRU translation cache
// ---------------------------------------------------------------------------
class LRU {
  constructor(limit = 300) { this.limit = limit; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return v;
  }
  clear() { this.map.clear(); }
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------
const SR = 16000;
const WINDOW_SECONDS = 6;          // Whisper sees the last 6 s ...
const HOP_SECONDS = 3;             // ... every 3 s
const WINDOW_SAMPLES = SR * WINDOW_SECONDS;
const HOP_SAMPLES = SR * HOP_SECONDS;
const EMPTY_CLEAR_COUNT = 2;       // consecutive empty windows -> hide caption

let transcriber = null;
let translator = null;
let targetFlores = 'zho_Hans';
let currentConfig = null;

const ring = new Float32Array(WINDOW_SAMPLES);
let ringFill = 0;
let sinceRun = 0;
let busy = false;
let runQueued = false;
let emptyStreak = 0;
let fixedIso = null;
let isoVotes = {};
let lastShown = '';
const cache = new LRU(400);

function post(msg) {
  self.postMessage(msg);
}

function postProgress(kind, p) {
  if (p && p.status === 'progress') {
    post({ kind: 'status', phase: kind, progress: Math.round(p.progress), file: p.file || '' });
  }
}

async function pickDevice(preferred) {
  if (preferred === 'webgpu') return { device: 'webgpu', dtype: 'fp16' };
  if (preferred === 'wasm') return { device: 'wasm', dtype: 'q8' };
  // auto
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: 'fp16' };
    } catch (_) { /* fall through */ }
  }
  return { device: 'wasm', dtype: 'q8' };
}

async function loadModels(config) {
  currentConfig = config;
  targetFlores = config.target || 'zho_Hans';

  const { device, dtype } = await pickDevice(config.device);
  post({ kind: 'status', phase: 'backend', message: `Using ${device.toUpperCase()} (${dtype})` });

  if (!transcriber || transcriber._lsModelId !== config.asrModel || transcriber._lsDevice !== device) {
    post({ kind: 'status', phase: 'asr-loading', progress: 0, message: config.asrModel });
    transcriber = await pipeline('automatic-speech-recognition', config.asrModel, {
      device, dtype, progress_callback: (p) => postProgress('asr-loading', p)
    });
    transcriber._lsModelId = config.asrModel;
    transcriber._lsDevice = device;
  }

  if (!translator || translator._lsModelId !== config.mtModel || translator._lsDevice !== device) {
    post({ kind: 'status', phase: 'mt-loading', progress: 0, message: config.mtModel });
    translator = await pipeline('translation', config.mtModel, {
      device, dtype, progress_callback: (p) => postProgress('mt-loading', p)
    });
    translator._lsModelId = config.mtModel;
    translator._lsDevice = device;
  }

  post({ kind: 'status', phase: 'ready' });
}

function resetStreamState() {
  ring.fill(0);
  ringFill = 0;
  sinceRun = 0;
  busy = false;
  runQueued = false;
  emptyStreak = 0;
  fixedIso = null;
  isoVotes = {};
  lastShown = '';
}

async function translate(text, srcFlores) {
  if (!srcFlores || srcFlores === targetFlores) return text;
  const key = `${srcFlores}>${targetFlores}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = await translator(text, { src_lang: srcFlores, tgt_lang: targetFlores, max_length: 512 });
  const result = (Array.isArray(out) ? out[0].translation_text : out.translation_text) || text;
  return cache.set(key, result);
}

function voteLanguage(iso) {
  if (!iso) return;
  isoVotes[iso] = (isoVotes[iso] || 0) + 1;
  if (!fixedIso && isoVotes[iso] >= 2) {
    fixedIso = iso;
    post({ kind: 'status', phase: 'language', iso, flores: resolveFlores(iso, '') });
  }
}

async function runWindow() {
  // Copy the most recent ringFill samples (or whole window once warm).
  const len = Math.min(ringFill, WINDOW_SAMPLES);
  if (len < SR * 1) return; // need at least 1 s of audio
  const audio = new Float32Array(WINDOW_SAMPLES);
  if (ringFill < WINDOW_SAMPLES) {
    audio.set(ring.slice(0, ringFill));
  } else {
    audio.set(ring);
  }

  let output;
  try {
    output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: fixedIso || null,   // null => Whisper auto-detects
      task: 'transcribe',
      condition_on_previous_text: false
    });
  } catch (err) {
    post({ kind: 'status', phase: 'error', message: `ASR failed: ${err && err.message || err}` });
    return;
  }

  const text = normalizeText(output && (output.text || ''));
  const reportedIso = output && (output.language || output.language_code) || null;

  if (!text || /^(♪|♫|\[blank audio\]|\[silence\]|\[music\])+$/i.test(text)) {
    emptyStreak += 1;
    if (emptyStreak >= EMPTY_CLEAR_COUNT && lastShown) {
      lastShown = '';
      post({ kind: 'line', clear: true });
    }
    return;
  }
  emptyStreak = 0;

  const iso = (reportedIso || detectIso(text) || fixedIso || 'en');
  voteLanguage(iso);
  const srcFlores = resolveFlores(fixedIso || iso, text);

  if (text === lastShown) return;
  lastShown = text;

  let translation = text;
  try {
    translation = await translate(text, srcFlores);
  } catch (err) {
    post({ kind: 'status', phase: 'error', message: `Translation failed: ${err && err.message || err}` });
  }

  post({
    kind: 'line',
    original: text,
    translation,
    iso: fixedIso || iso,
    flores: srcFlores
  });
}

function scheduleWindow() {
  if (busy) { runQueued = true; return; }
  busy = true;
  Promise.resolve(runWindow())
    .catch((err) => post({ kind: 'status', phase: 'error', message: String(err) }))
    .finally(() => {
      busy = false;
      if (runQueued) {
        runQueued = false;
        scheduleWindow();
      }
    });
}

function appendAudio(samples) {
  if (!samples || !samples.length) return;
  let incoming = samples;
  if (incoming.length >= WINDOW_SAMPLES) {
    ring.set(incoming.slice(incoming.length - WINDOW_SAMPLES));
    ringFill = WINDOW_SAMPLES;
  } else {
    if (ringFill + incoming.length <= WINDOW_SAMPLES) {
      ring.set(incoming, ringFill);
      ringFill += incoming.length;
    } else {
      // Shift old data left to make room.
      const keep = WINDOW_SAMPLES - incoming.length;
      ring.copyWithin(0, ringFill - keep, ringFill);
      ring.set(incoming, keep);
      ringFill = WINDOW_SAMPLES;
    }
  }
  sinceRun += incoming.length;
  if (sinceRun >= HOP_SAMPLES) {
    sinceRun = 0;
    scheduleWindow();
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.cmd === 'start') {
      resetStreamState();
      if (msg.target) targetFlores = msg.target;
      await loadModels(msg);
      post({ kind: 'status', phase: 'listening' });
    } else if (msg.cmd === 'audio') {
      if (transcriber) appendAudio(msg.samples);
    } else if (msg.cmd === 'target') {
      targetFlores = msg.target;
      cache.clear();
    } else if (msg.cmd === 'stop') {
      resetStreamState();
      post({ kind: 'line', clear: true });
      post({ kind: 'status', phase: 'stopped' });
    } else if (msg.cmd === 'ping') {
      post({ kind: 'pong' });
    }
  } catch (err) {
    post({
      kind: 'status',
      phase: 'error',
      message: `${(msg || {}).cmd || 'engine'} error: ${err && err.message || err}`
    });
  }
};

post({ kind: 'status', phase: 'worker-ready' });
