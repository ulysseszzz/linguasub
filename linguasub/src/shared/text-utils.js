/*
 * LinguaSub shared text/settings utilities.
 * Classic global (globalThis.LSText) + CommonJS export for Node tests.
 */
(function (root, factory) {
  const api = factory(root.LSLang);
  root.LSText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LSLang) {
  'use strict';

  const DEFAULT_STYLE = {
    fontFamily: 'system-ui',
    fontSize: 26,          // px
    color: '#ffffff',
    bg: '#000000',
    bgEnabled: true,
    bgOpacity: 0.6,
    bold: true,
    italic: false,
    outline: true,
    shadow: true,
    position: 'bottom',    // 'bottom' | 'top'
    offset: 8,             // px from the chosen edge
    align: 'center',       // 'left' | 'center' | 'right'
    maxWidth: 72,          // % of viewport width
    lineHeight: 1.4,
    originalOpacity: 0.72,
    originalSize: 0.62     // ratio of translation font size
  };

  const DEFAULT_SETTINGS = {
    target: 'zho_Hans',
    device: 'auto',        // 'auto' | 'webgpu' | 'wasm'
    showOriginal: true,
    asrModel: 'Xenova/whisper-tiny',
    mtModel: 'Xenova/nllb-200-distilled-600M',
    style: DEFAULT_STYLE
  };

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function mergeSettings(saved) {
    const out = deepClone(DEFAULT_SETTINGS);
    if (!saved || typeof saved !== 'object') return out;
    Object.keys(saved).forEach((k) => {
      if (k === 'style' && saved.style && typeof saved.style === 'object') {
        Object.assign(out.style, saved.style);
      } else if (saved[k] !== undefined && saved[k] !== null) {
        out[k] = saved[k];
      }
    });
    return out;
  }

  // --- Text normalization -------------------------------------------------

  // Whisper emits tokens like [BLANK_AUDIO], ♪ for music, (applause), etc.
  const NOISE_PATTERNS = [
    /^\s*\[?(blank audio|silence|music|applause|laughter)\]?\s*$/i,
    /^[\s♪♫~.-]+$/
  ];

  function normalizeText(raw) {
    if (!raw) return '';
    let t = String(raw).replace(/<\|[^>]+\|>/g, ''); // whisper special tokens
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function isSilence(raw) {
    const t = normalizeText(raw);
    if (!t) return true;
    return NOISE_PATTERNS.some((re) => re.test(t));
  }

  /**
   * Decide whether a newly recognized line should replace what is shown.
   * Avoids flicker: identical / pure-extension-of-current lines are handled
   * by the caller (we still return true for extensions so growing captions update).
   */
  function shouldReplaceLine(prev, next) {
    const a = normalizeText(prev);
    const b = normalizeText(next);
    if (!b) return !!a;                 // empty clears an existing line
    if (!a) return true;
    if (a === b) return false;
    // Ignore casing / punctuation-only churn.
    const squash = (s) => s.toLowerCase().replace(/[\p{P}\s]+/gu, '');
    return squash(a) !== squash(b);
  }

  // --- Tiny language detector (fallback when ASR does not report language) -

  // Characters that only appear in traditional Chinese (not in simplified text).
  const TRADITIONAL_CHARS = '繁體國臺灣學習語言說讀寫這個們東西時麼華發開門長電車馬見觀場魚點經過業來頁風雲與書畫';
  function isTraditionalChinese(text) {
    let hits = 0;
    for (const ch of String(text)) {
      if (TRADITIONAL_CHARS.includes(ch)) hits++;
      if (hits >= 2) return true;
    }
    return false;
  }

  const SCRIPT_RULES = [
    [/[ぁ-んァ-ヶ]/, 'ja'],
    [/[가-힯]/, 'ko'],
    [/[一-鿿]/, 'zh'],
    [/[Ѐ-ӹ]/, 'ru'],
    [/[฀-๛]/, 'th'],
    [/[ऀ-ॿ]/, 'hi'],
    [/[֐-׿]/, 'he'],
    [/[؀-ۿ]/, 'ar'],
    [/[ἀ-῿]/, 'el']
  ];

  // Short stopword fingerprints for Latin-script languages (tie breaker).
  const STOPWORDS = {
    en: ['the', 'is', 'are', 'and', 'that', 'this', 'with', 'for', 'you', 'have', 'was', 'not', 'but'],
    es: ['el', 'la', 'los', 'las', 'que', 'como', 'para', 'pero', 'una', 'con', 'porque', 'está', 'del'],
    fr: ['le', 'la', 'les', 'que', 'qui', 'dans', 'pour', 'avec', 'mais', 'une', 'des', 'est', 'sur'],
    de: ['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'nicht', 'mit', 'sich', 'auf', 'für', 'auch'],
    it: ['il', 'la', 'lo', 'che', 'per', 'con', 'non', 'una', 'sono', 'questo', 'della', 'dei', 'come'],
    pt: ['que', 'não', 'uma', 'para', 'com', 'por', 'mais', 'como', 'mas', 'dos', 'das', 'está', 'você'],
    nl: ['het', 'een', 'die', 'dat', 'met', 'voor', 'maar', 'niet', 'zijn', 'dan', 'ook', 'op', 'er'],
    id: ['yang', 'dan', 'tidak', 'ini', 'itu', 'dengan', 'untuk', 'akan', 'ada', 'kamu', 'dari', 'kami'],
    tr: ['bir', 'bu', 'için', 'ile', 'ama', 'çok', 'gibi', 'kadar', 'var', 'olan', 'olarak', 'mı'],
    vi: ['không', 'là', 'của', 'cho', 'một', 'nhưng', 'với', 'được', 'này', 'khi', 'như', 'phải']
  };

  function detectLanguageIso(text) {
    if (!text) return null;
    for (const [re, iso] of SCRIPT_RULES) {
      if (re.test(text)) return iso;
    }
    if (!/[a-zA-Z]/.test(text)) return null;
    const words = String(text).toLowerCase().match(/[a-zà-ÿĀ-ž']+/g) || [];
    if (words.length === 0) return null;
    let best = null;
    let bestScore = 0;
    Object.keys(STOPWORDS).forEach((iso) => {
      const set = STOPWORDS[iso];
      let score = 0;
      for (const w of words) {
        if (set.includes(w)) score += 1;
        // Distinctive diacritics / letter patterns
        if (iso === 'es' && /[¿¡]/.test(text)) score += 2;
        if (iso === 'de' && /[äöüß]/.test(w)) score += 0.5;
      }
      score /= Math.max(4, words.length / 6); // normalize for sentence length
      if (score > bestScore) {
        bestScore = score;
        best = iso;
      }
    });
    return best || 'en';
  }

  /** Resolve a Whisper ISO code (or heuristic) to a FLORES-200 code. */
  function resolveFlores(iso, rawText) {
    const text = rawText || '';
    // Kana/hangul win over shared Han characters when source is unknown.
    if (!iso && /[ぁ-んァ-ヶー]/.test(text)) return 'jpn_Jpan';
    if (!iso && /[가-힯]/.test(text)) return 'kor_Hang';
    if (iso === 'zh' || (!iso && /[一-鿿]/.test(text))) {
      return isTraditionalChinese(text) ? 'zho_Hant' : 'zho_Hans';
    }
    const viaIso = LSLang ? LSLang.isoToFlores(iso) : null;
    if (viaIso) return viaIso;
    const guessed = detectLanguageIso(rawText);
    if (guessed) {
      return (guessed === 'zh' && isTraditionalChinese(rawText || ''))
        ? 'zho_Hant'
        : (LSLang ? LSLang.isoToFlores(guessed) : null);
    }
    return null;
  }

  // --- Small helpers -------------------------------------------------------

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
    let r = 0;
    let g = 0;
    let b = 0;
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    const a = Math.min(1, Math.max(0, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function quoteFont(family) {
    const f = String(family || 'system-ui').trim();
    if (/^(system-ui|serif|sans-serif|monospace|Georgia|Arial|Helvetica)$/.test(f)) return `'${f}'`;
    return `'${f.replace(/'/g, "\\'")}', sans-serif`;
  }

  /**
   * Build the CSS custom-property string applied to the subtitle host.
   * Kept framework-free so it is unit-testable in Node.
   */
  function buildSubtitleCSS(style) {
    const s = Object.assign({}, DEFAULT_STYLE, style || {});
    const lines = [
      `--ls-font-family:${quoteFont(s.fontFamily)}`,
      `--ls-font-size:${Number(s.fontSize) || 26}px`,
      `--ls-color:${s.color || '#fff'}`,
      `--ls-bg:${hexToRgba(s.bg, s.bgEnabled ? s.bgOpacity : 0)}`,
      `--ls-weight:${s.bold ? 700 : 400}`,
      `--ls-style:${s.italic ? 'italic' : 'normal'}`,
      `--ls-outline:${s.outline ? 1 : 0}`,
      `--ls-shadow:${s.shadow ? 1 : 0}`,
      `--ls-position:${s.position === 'top' ? 'top' : 'bottom'}`,
      `--ls-offset:${Number(s.offset) || 0}px`,
      `--ls-align:${['left', 'right'].includes(s.align) ? s.align : 'center'}`,
      `--ls-max-width:${Math.min(100, Math.max(20, Number(s.maxWidth) || 72))}%`,
      `--ls-line-height:${Number(s.lineHeight) || 1.4}`,
      `--ls-original-opacity:${s.originalOpacity}`,
      `--ls-original-size:${s.originalSize}`
    ];
    return lines.join(';') + ';';
  }

  class LRUCache {
    constructor(limit) {
      this.limit = Math.max(1, limit || 200);
      this.map = new Map();
    }

    get(key) {
      if (!this.map.has(key)) return undefined;
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }

    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.limit) {
        this.map.delete(this.map.keys().next().value);
      }
      return value;
    }

    has(key) { return this.map.has(key); }
    get size() { return this.map.size; }
    clear() { this.map.clear(); }
  }

  function debounce(fn, waitMs) {
    let timer = null;
    const wrapped = function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, waitMs);
    };
    wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
    return wrapped;
  }

  return {
    DEFAULT_STYLE,
    DEFAULT_SETTINGS,
    mergeSettings,
    normalizeText,
    isSilence,
    shouldReplaceLine,
    detectLanguageIso,
    isTraditionalChinese,
    resolveFlores,
    hexToRgba,
    quoteFont,
    buildSubtitleCSS,
    LRUCache,
    debounce
  };
});
