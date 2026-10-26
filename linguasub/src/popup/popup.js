/*
 * LinguaSub popup controller.
 * Settings are persisted to chrome.storage.sync and applied live to every tab
 * (the content script listens for storage changes).
 */
(function () {
  'use strict';

  // Standalone shim: popup.html can then be opened as a normal file:// tab
  // (used by the UI screenshot test and as a live style preview). In the real
  // extension chrome.runtime.id exists and this branch is skipped.
  if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) {
    const memory = {};
    globalThis.chrome = {
      runtime: {
        id: undefined,
        sendMessage: async () => null,
        onMessage: { addListener() { /* standalone preview */ } }
      },
      storage: {
        sync: {
          get: async () => memory,
          set: (items, cb) => { Object.assign(memory, items); if (cb) cb(); }
        },
        onChanged: { addListener() { /* standalone preview */ } }
      }
    };
  }

  const $ = (id) => document.getElementById(id);
  const { mergeSettings, hexToRgba, debounce } = globalThis.LSText;

  let settings = mergeSettings(null);
  let running = false;
  let lastPhase = '';

  // --- Tabs ----------------------------------------------------------------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const name = tab.dataset.tab;
      $('panel-home').hidden = name !== 'home';
      $('panel-settings').hidden = name !== 'settings';
    });
  });

  // --- Language selector ----------------------------------------------------

  function fillLanguages() {
    const sel = $('target-lang');
    globalThis.LSLang.TARGET_LANGUAGES.forEach(([code, label]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      sel.appendChild(opt);
    });
    sel.value = settings.target;
    sel.addEventListener('change', () => {
      settings.target = sel.value;
      persist();
      if (running) {
        chrome.runtime.sendMessage({ type: 'LS_TARGET_CHANGED', target: settings.target }).catch(() => {});
      }
    });
  }

  // --- Settings form --------------------------------------------------------

  function syncForm() {
    const s = settings.style;
    $('s-fontFamily').value = s.fontFamily;
    $('s-position').value = s.position;
    $('s-fontSize').value = s.fontSize;
    $('o-fontSize').value = s.fontSize;
    $('s-color').value = s.color;
    $('s-bg').value = s.bg;
    $('s-bgOpacity').value = s.bgOpacity;
    $('o-bgOpacity').value = Number(s.bgOpacity).toFixed(2);
    $('s-offset').value = s.offset;
    $('o-offset').value = s.offset;
    $('s-maxWidth').value = s.maxWidth;
    $('o-maxWidth').value = s.maxWidth;
    $('s-align').value = s.align;
    $('s-device').value = settings.device;
    $('s-bold').checked = !!s.bold;
    $('s-italic').checked = !!s.italic;
    $('s-outline').checked = !!s.outline;
    $('s-shadow').checked = !!s.shadow;
    $('s-showOriginal').checked = !!settings.showOriginal;
    updatePreview();
  }

  function updatePreview() {
    const s = settings.style;
    const stage = $('preview-stage');
    const tr = $('preview-translation');
    const or = $('preview-original');
    stage.style.setProperty('--p-family', `'${String(s.fontFamily).replace(/'/g, '')}', sans-serif`);
    stage.style.setProperty('--p-color', s.color);
    stage.style.setProperty('--p-bg', hexToRgba(s.bg, s.bgEnabled === false ? 0 : s.bgOpacity));
    stage.style.setProperty('--p-weight', s.bold ? 700 : 400);
    stage.style.setProperty('--p-style', s.italic ? 'italic' : 'normal');
    tr.style.fontSize = `${Math.round(s.fontSize * 0.85)}px`;
    or.style.fontSize = `${Math.round(s.fontSize * s.originalSize * 0.85)}px`;
    stage.dataset.outline = s.outline ? '1' : '0';
    stage.dataset.shadow = s.shadow ? '1' : '0';
    or.style.display = settings.showOriginal ? '' : 'none';
  }

  function bindRange(id, outId, apply) {
    $(id).addEventListener('input', () => {
      apply(Number($(id).value));
      $(outId).textContent = id === 's-bgOpacity'
        ? Number($(id).value).toFixed(2)
        : $(id).value;
      updatePreview();
      persist();
    });
  }

  function bindSettings() {
    $('s-fontFamily').addEventListener('change', (e) => { settings.style.fontFamily = e.target.value; updatePreview(); persist(); });
    $('s-position').addEventListener('change', (e) => { settings.style.position = e.target.value; persist(); });
    $('s-align').addEventListener('change', (e) => { settings.style.align = e.target.value; persist(); });
    $('s-device').addEventListener('change', (e) => { settings.device = e.target.value; persist(); });
    $('s-color').addEventListener('input', (e) => { settings.style.color = e.target.value; updatePreview(); persist(); });
    $('s-bg').addEventListener('input', (e) => { settings.style.bg = e.target.value; updatePreview(); persist(); });

    bindRange('s-fontSize', 'o-fontSize', (v) => { settings.style.fontSize = v; });
    bindRange('s-bgOpacity', 'o-bgOpacity', (v) => { settings.style.bgOpacity = v; });
    bindRange('s-offset', 'o-offset', (v) => { settings.style.offset = v; });
    bindRange('s-maxWidth', 'o-maxWidth', (v) => { settings.style.maxWidth = v; });

    const toggles = [
      ['s-bold', (v) => { settings.style.bold = v; }],
      ['s-italic', (v) => { settings.style.italic = v; }],
      ['s-outline', (v) => { settings.style.outline = v; }],
      ['s-shadow', (v) => { settings.style.shadow = v; }],
      ['s-showOriginal', (v) => { settings.showOriginal = v; }]
    ];
    toggles.forEach(([id, fn]) => {
      $(id).addEventListener('change', (e) => { fn(e.target.checked); updatePreview(); persist(); });
    });
  }

  const persist = debounce(() => {
    chrome.storage.sync.set({ settings });
  }, 120);

  // --- Run state -------------------------------------------------------------

  const PHASE_TEXT = {
    starting: 'Starting tab capture…',
    capturing: 'Capturing tab audio…',
    backend: 'Initializing local AI backend…',
    'asr-loading': 'Downloading speech recognition model…',
    'mt-loading': 'Downloading translation model…',
    ready: 'Models ready',
    listening: 'Listening — play the video',
    stopped: 'Stopped'
  };

  function setStatus(phase, extra) {
    lastPhase = phase;
    const wrap = $('progress-wrap');
    const line = $('status-line');
    line.classList.remove('error', 'ok');

    if (phase === 'error') {
      wrap.hidden = false;
      $('progress-bar').style.width = '0%';
      line.classList.add('error');
      line.textContent = `⚠ ${extra && extra.message ? extra.message : 'Something went wrong'}`;
      return;
    }
    if (phase === 'stopped') {
      wrap.hidden = true;
      $('progress-bar').style.width = '0%';
      return;
    }

    wrap.hidden = false;
    const loading = phase === 'asr-loading' || phase === 'mt-loading';
    if (loading) {
      const p = Math.max(2, Number(extra && extra.progress) || 0);
      $('progress-bar').style.width = `${p}%`;
      line.textContent = `${PHASE_TEXT[phase]} ${p}%`;
    } else {
      $('progress-bar').style.width = phase === 'listening' || phase === 'ready' ? '100%' : '55%';
      line.classList.add(phase === 'listening' ? 'ok' : '');
      line.textContent = (extra && extra.message) || PHASE_TEXT[phase] || phase;
    }

    if (phase === 'language' && extra && extra.flores) {
      const label = globalThis.LSLang.FLORES_DISPLAY[extra.flores] || extra.iso || '';
      const chip = $('detected-lang');
      chip.textContent = label ? `detected: ${label}` : 'detected on speech';
      chip.classList.add('live');
    }
  }

  function setRunning(on) {
    running = on;
    const btn = $('start-btn');
    btn.textContent = on ? '■ Stop subtitles' : 'Start on this tab';
    btn.classList.toggle('running', on);
    btn.disabled = false;
    if (!on) {
      $('detected-lang').textContent = 'detected on speech';
      $('detected-lang').classList.remove('live');
      if (['asr-loading', 'mt-loading', 'listening', 'ready', 'capturing', 'backend', 'starting'].includes(lastPhase)) {
        setStatus('stopped');
      }
    } else {
      setStatus('starting');
    }
  }

  async function onStartClick() {
    if (running) {
      $('start-btn').disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'LS_STOP' }).catch(() => null);
      setRunning(false);
      if (res && res.ok === false) setStatus('error', { message: res.error });
      return;
    }
    $('start-btn').disabled = true;
    // Ensure latest values landed before starting the engine.
    chrome.storage.sync.set({ settings }, async () => {
      const res = await chrome.runtime.sendMessage({ type: 'LS_START', settings }).catch((e) => ({ ok: false, error: String(e) }));
      if (res && res.ok) setRunning(true);
      else { setStatus('error', { message: res && res.error }); $('start-btn').disabled = false; }
    });
  }

  // --- Init -----------------------------------------------------------------

  async function init() {
    fillLanguages();
    bindSettings();

    const stored = await chrome.storage.sync.get(null);
    if (stored && stored.settings) settings = mergeSettings(stored.settings);
    $('target-lang').value = settings.target;
    syncForm();

    $('start-btn').addEventListener('click', onStartClick);

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.to !== 'popup') return;
      if (msg.type === 'LS_STATUS') {
        if (msg.phase === 'stopped') { if (running) setRunning(false); else setStatus('stopped'); }
        else if (msg.phase === 'error') setStatus('error', { message: msg.message });
        else setStatus(msg.phase, msg);
      }
    });

    const state = await chrome.runtime.sendMessage({ type: 'LS_GET_STATE' }).catch(() => null);
    if (state && state.activeTabId != null) setRunning(true);

    // Allow deep-linking to the settings pane (?tab=settings) for previews/tests.
    if (new URLSearchParams(location.search).get('tab') === 'settings') {
      document.querySelector('.tab[data-tab="settings"]').click();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
