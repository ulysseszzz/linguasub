/*
 * LinguaSub Node unit tests (pure logic, no DOM).
 * Run: node test/node-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const LSLang = require(path.join(here, '..', 'src', 'shared', 'languages.js'));
const LSText = require(path.join(here, '..', 'src', 'shared', 'text-utils.js'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'equality'}: expected ${e}, got ${a}`);
}

console.log('languages.js');
test('target language list covers 20+ languages with FLORES codes', () => {
  assert(LSLang.TARGET_LANGUAGES.length >= 20, 'list too short');
  for (const [code] of LSLang.TARGET_LANGUAGES) {
    assert(/^[a-z]{3}_[A-Za-z]{4}$/.test(code), `bad FLORES code ${code}`);
  }
});
test('Chinese simplified/traditional and English map correctly', () => {
  eq(LSLang.isoToFlores('en'), 'eng_Latn');
  eq(LSLang.isoToFlores('zh'), 'zho_Hans');
  eq(LSLang.isoToFlores('JA'), 'jpn_Jpan', 'uppercase accepted');
});

console.log('\ntext-utils.js — normalization');
test('normalizeText strips whisper special tokens and collapses spaces', () => {
  eq(LSText.normalizeText('<|notimestamps|>Hello   world'), 'Hello world');
  eq(LSText.normalizeText(200), '200');
});
test('isSilence catches blank-audio / music markers', () => {
  assert(LSText.isSilence(''));
  assert(LSText.isSilence('[BLANK AUDIO]'));
  assert(LSText.isSilence('♪ ♪'));
  assert(!LSText.isSilence('Welcome back'));
});
test('shouldReplaceLine avoids duplicate flicker', () => {
  assert(LSText.shouldReplaceLine('', 'hello'));
  assert(!LSText.shouldReplaceLine('hello', 'hello'));
  assert(!LSText.shouldReplaceLine('Hello, world!', 'hello world'), 'punctuation-only churn ignored');
  assert(LSText.shouldReplaceLine('hello', 'goodbye'));
  assert(LSText.shouldReplaceLine('something', ''), 'empty clears');
});

console.log('\ntext-utils.js — language detection');
test('script-based detection (zh/ja/ko/ru/th/he/ar/hi)', () => {
  eq(LSText.detectLanguageIso('这是一个测试'), 'zh');
  eq(LSText.detectLanguageIso('これはテストです'), 'ja');
  eq(LSText.detectLanguageIso('이것은 테스트입니다'), 'ko');
  eq(LSText.detectLanguageIso('Это проверка'), 'ru');
  eq(LSText.detectLanguageIso('นี่คือการทดสอบ'), 'th');
  eq(LSText.detectLanguageIso('זאת בדיקה'), 'he');
  eq(LSText.detectLanguageIso('هذا اختبار'), 'ar');
  eq(LSText.detectLanguageIso('यह एक परीक्षा है'), 'hi');
});
test('stopword detection for Latin-script languages', () => {
  eq(LSText.detectLanguageIso("This is the test that you have been waiting for and it is great"), 'en');
  eq(LSText.detectLanguageIso("Questo è un test che non puoi perdere per favore"), 'it');
  eq(LSText.detectLanguageIso("Este es el test que has estado esperando para nosotros"), 'es');
  eq(LSText.detectLanguageIso("Ceci est un test que vous attendiez pour nous"), 'fr');
  eq(LSText.detectLanguageIso("Das ist ein Test den du nicht erwartet hast für uns"), 'de');
});
test('traditional vs simplified Chinese resolution', () => {
  eq(LSText.resolveFlores('zh', '学习语言很有趣'), 'zho_Hans');
  eq(LSText.resolveFlores('zh', '學習語言很有趣'), 'zho_Hant');
  eq(LSText.resolveFlores('en', 'hello world'), 'eng_Latn');
  eq(LSText.resolveFlores(null, 'こんにちは世界'), 'jpn_Jpan');
});

console.log('\ntext-utils.js — settings / CSS');
test('mergeSettings fills defaults and merges partial style', () => {
  const s = LSText.mergeSettings({ target: 'jpn_Jpan', style: { fontSize: 33 } });
  eq(s.target, 'jpn_Jpan');
  eq(s.style.fontSize, 33);
  eq(s.style.color, '#ffffff', 'default style preserved');
  eq(s.device, 'auto');
});
test('hexToRgba parses 6/3-digit hex and clamps alpha', () => {
  eq(LSText.hexToRgba('#ff0000', 0.5), 'rgba(255, 0, 0, 0.5)');
  eq(LSText.hexToRgba('000', 2), 'rgba(0, 0, 0, 1)');
});
test('buildSubtitleCSS emits all CSS variables with user values', () => {
  const css = LSText.buildSubtitleCSS({ fontSize: 40, color: '#112233', position: 'top', bold: false });
  assert(css.includes('--ls-font-size:40px'), css);
  assert(css.includes('--ls-color:#112233'), css);
  assert(css.includes('--ls-position:top'), css);
  assert(css.includes('--ls-weight:400'), css);
  assert(css.includes('--ls-bg:rgba(0, 0, 0, 0.6)'), css);
});

console.log('\ntext-utils.js — LRU cache');
test('LRU evicts oldest and promotes on access', () => {
  const c = new LSText.LRUCache(3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  eq(c.get('a'), 1);
  c.set('d', 4); // evicts b
  eq(c.has('b'), false);
  eq(c.get('d'), 4);
  eq(c.size, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  process.exitCode = 1;
}
