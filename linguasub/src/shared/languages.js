/*
 * LinguaSub shared language tables.
 * Works as a classic content-script global (globalThis.LSLang) and as a CommonJS module for Node tests.
 *
 * Translation model: NLLB-200 distilled (FLORES-200 codes).
 * Speech model: Whisper (ISO 639-1 codes), mapped to FLORES below.
 */
(function (root, factory) {
  const api = factory();
  root.LSLang = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // [FLORES-200 code, display name] — shown in the popup target-language selector.
  const TARGET_LANGUAGES = [
    ['zho_Hans', '中文（简体）'],
    ['zho_Hant', '中文（繁體）'],
    ['eng_Latn', 'English'],
    ['jpn_Jpan', '日本語'],
    ['kor_Hang', '한국어'],
    ['spa_Latn', 'Español'],
    ['fra_Latn', 'Français'],
    ['deu_Latn', 'Deutsch'],
    ['ita_Latn', 'Italiano'],
    ['por_Latn', 'Português'],
    ['rus_Cyrl', 'Русский'],
    ['arb_Arab', 'العربية'],
    ['hin_Deva', 'हिन्दी'],
    ['tha_Thai', 'ไทย'],
    ['vie_Latn', 'Tiếng Việt'],
    ['ind_Latn', 'Bahasa Indonesia'],
    ['zsm_Latn', 'Bahasa Melayu'],
    ['tur_Latn', 'Türkçe'],
    ['nld_Latn', 'Nederlands'],
    ['pol_Latn', 'Polski'],
    ['ukr_Cyrl', 'Українська'],
    ['heb_Hebr', 'עברית']
  ];

  // Whisper / heuristic ISO 639-1 -> FLORES-200.
  const ISO_TO_FLORES = {
    en: 'eng_Latn',
    zh: 'zho_Hans',
    ja: 'jpn_Jpan',
    ko: 'kor_Hang',
    es: 'spa_Latn',
    fr: 'fra_Latn',
    de: 'deu_Latn',
    it: 'ita_Latn',
    pt: 'por_Latn',
    ru: 'rus_Cyrl',
    ar: 'arb_Arab',
    hi: 'hin_Deva',
    th: 'tha_Thai',
    vi: 'vie_Latn',
    id: 'ind_Latn',
    ms: 'zsm_Latn',
    tr: 'tur_Latn',
    nl: 'nld_Latn',
    pl: 'pol_Latn',
    uk: 'ukr_Cyrl',
    he: 'heb_Hebr',
    el: 'ell_Grek',
    sv: 'swe_Latn',
    fi: 'fin_Latn',
    da: 'dan_Latn',
    no: 'nob_Latn',
    cs: 'ces_Latn',
    ro: 'ron_Latn',
    hu: 'hun_Latn',
    bg: 'bul_Cyrl'
  };

  const FLORES_DISPLAY = {};
  TARGET_LANGUAGES.forEach(([code, label]) => { FLORES_DISPLAY[code] = label; });

  function isoToFlores(iso) {
    if (!iso) return null;
    return ISO_TO_FLORES[String(iso).toLowerCase().slice(0, 2)] || null;
  }

  return { TARGET_LANGUAGES, ISO_TO_FLORES, FLORES_DISPLAY, isoToFlores };
});
