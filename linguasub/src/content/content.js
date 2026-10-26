/*
 * LinguaSub content script: renders the live translated-subtitle overlay.
 *
 * - Shadow DOM so page CSS can never corrupt the captions.
 * - Reparents itself inside the fullscreen element so subtitles stay visible
 *   when a video player enters fullscreen (YouTube/Netflix-style containers).
 * - All visuals are CSS custom properties produced by buildSubtitleCSS(),
 *   i.e. fully user-editable and updated live from the popup.
 *
 * The same file exposes globalThis.LSContent for the headless test harness.
 */
(function () {
  'use strict';

  const HOST_ID = 'linguasub-host';
  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  let host = null;
  let stageEl = null;
  let boxEl = null;
  let originalEl = null;
  let translationEl = null;
  let badgeEl = null;
  let handleEl = null;
  let mounted = false;
  let visible = false;
  let settings = null;
  let hideTimer = null;
  let isFullscreen = false;
  let dragging = false;
  let cueVideo = null;
  let cueTrack = null;
  let cueStyleEl = null;

  const LIGHT_NOISE = /^\s*(♪|♫|\[blank audio\]|\[silence\]|\[music\])+\s*$/i;

  const SHADOW_CSS = `
:host {
  all: initial;
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  pointer-events: none;
  z-index: 2147483647 !important;
  --ls-scale: clamp(1, 100vw / 1280px, 1.7);
}
.ls-stage {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: var(--ls-justify, flex-end);
  padding: 0 calc(12px * var(--ls-scale)) calc(var(--ls-offset) * var(--ls-scale));
  opacity: 0;
  transition: opacity .18s ease;
  box-sizing: border-box;
  font-family: var(--ls-font-family);
}
.ls-stage.top {
  justify-content: flex-start;
  padding: calc(var(--ls-offset) * var(--ls-scale)) 12px 0;
}
.ls-stage.show { opacity: 1; }
.ls-box {
  pointer-events: none;
  max-width: var(--ls-max-width);
  display: flex;
  flex-direction: column;
  align-items: var(--ls-align-items, center);
  gap: calc(3px * var(--ls-scale));
  font-family: var(--ls-font-family);
  text-align: var(--ls-align);
}
.ls-original {
  font-size: calc(var(--ls-font-size) * var(--ls-original-size) * var(--ls-scale));
  line-height: var(--ls-line-height);
  color: var(--ls-color);
  opacity: var(--ls-original-opacity);
  font-weight: var(--ls-weight);
  font-style: var(--ls-style);
  background: var(--ls-bg);
  padding: calc(2px * var(--ls-scale)) calc(10px * var(--ls-scale));
  border-radius: calc(8px * var(--ls-scale));
  -webkit-text-decoration: none;
  text-decoration: none;
  white-space: pre-wrap;
}
.ls-translation {
  font-size: calc(var(--ls-font-size) * var(--ls-scale));
  line-height: var(--ls-line-height);
  color: var(--ls-color);
  font-weight: var(--ls-weight);
  font-style: var(--ls-style);
  background: var(--ls-bg);
  padding: calc(4px * var(--ls-scale)) calc(14px * var(--ls-scale));
  border-radius: calc(10px * var(--ls-scale));
  white-space: pre-wrap;
  -webkit-text-decoration: none;
  text-decoration: none;
}
.ls-stage[data-outline="1"] .ls-translation,
.ls-stage[data-outline="1"] .ls-original {
  -webkit-text-stroke: calc(0.6px * var(--ls-scale)) rgba(0,0,0,.85);
  paint-order: stroke fill;
}
.ls-stage[data-shadow="1"] .ls-translation,
.ls-stage[data-shadow="1"] .ls-original {
  text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 calc(6px * var(--ls-scale)) rgba(0,0,0,.55);
}
.ls-badge {
  font-size: calc(10px * var(--ls-scale));
  font-weight: 600;
  letter-spacing: .04em;
  color: #cfe0ff;
  background: rgba(20,40,90,.55);
  border-radius: calc(6px * var(--ls-scale));
  padding: calc(1px * var(--ls-scale)) calc(6px * var(--ls-scale));
  text-transform: uppercase;
  opacity: .85;
}
.ls-row {
  display: flex;
  align-items: center;
  gap: calc(6px * var(--ls-scale));
  justify-content: var(--ls-align);
  max-width: 100%;
}
.ls-handle {
  pointer-events: auto;
  cursor: ns-resize;
  color: rgba(255,255,255,.75);
  background: rgba(0,0,0,.45);
  border-radius: calc(6px * var(--ls-scale));
  width: calc(34px * var(--ls-scale));
  height: calc(14px * var(--ls-scale));
  display: none;
  align-items: center;
  justify-content: center;
  font-size: calc(11px * var(--ls-scale));
  user-select: none;
  margin-top: calc(4px * var(--ls-scale));
}
.ls-stage:hover .ls-handle { display: flex; }
`;

  function defaultSettings() {
    return (globalThis.LSText && globalThis.LSText.mergeSettings)
      ? globalThis.LSText.mergeSettings(null)
      : { showOriginal: true, style: {} };
  }

  function mount(initialSettings) {
    if (mounted) return host;
    settings = initialSettings || settings || defaultSettings();

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-ls', 'overlay');

    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    shadow.innerHTML = '';
    const styleEl = document.createElement('style');
    styleEl.textContent = SHADOW_CSS;
    shadow.appendChild(styleEl);

    stageEl = document.createElement('div');
    stageEl.className = 'ls-stage';
    stageEl.innerHTML = `
      <div class="ls-box">
        <div class="ls-row" data-role="original-row">
          <span class="ls-badge" data-role="badge"></span>
          <span class="ls-original" data-role="original"></span>
        </div>
        <div class="ls-translation" data-role="translation"></div>
        <div class="ls-handle" data-role="handle" title="Drag to move subtitles">⠿</div>
      </div>`;
    shadow.appendChild(stageEl);

    boxEl = stageEl.querySelector('[data-role="box"]') || stageEl.querySelector('.ls-box');
    originalEl = stageEl.querySelector('[data-role="original"]');
    translationEl = stageEl.querySelector('[data-role="translation"]');
    badgeEl = stageEl.querySelector('[data-role="badge"]');
    handleEl = stageEl.querySelector('[data-role="handle"]');
    attachDrag(handleEl);

    mounted = true; // before reparentForFullscreen(), which early-returns when unmounted
    reparentForFullscreen();
    // Registered once (mount() is a no-op after the first mount).
    document.addEventListener('fullscreenchange', reparentForFullscreen, true);
    document.addEventListener('webkitfullscreenchange', reparentForFullscreen, true);
    applyStyle();
    return host;
  }

  function unmount() {
    teardownCues();
    if (cueStyleEl && cueStyleEl.parentNode) cueStyleEl.parentNode.removeChild(cueStyleEl);
    cueStyleEl = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    mounted = false;
    visible = false;
  }

  function applyStyle() {
    if (!mounted) return;
    const s = (settings && settings.style) || {};
    stageEl.style.cssText = (globalThis.LSText ? globalThis.LSText.buildSubtitleCSS(s) : '');
    const isTop = s.position === 'top';
    stageEl.classList.toggle('top', isTop);
    stageEl.setAttribute('data-outline', s.outline === false ? '0' : '1');
    stageEl.setAttribute('data-shadow', s.shadow === false ? '0' : '1');
    const align = s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center';
    stageEl.style.setProperty('--ls-align-items', align);
    applyCueStyle();
  }

  function setSettings(next) {
    settings = globalThis.LSText.mergeSettings(next);
    applyStyle();
    // Re-render to honor showOriginal changes immediately.
    const prevOriginal = originalEl ? originalEl.textContent : '';
    const prevTranslation = translationEl ? translationEl.textContent : '';
    if (prevTranslation) renderLine({ original: prevOriginal, translation: prevTranslation, iso: badgeEl.textContent });
  }

  function show() {
    if (!mounted) mount();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!visible) { stageEl.classList.add('show'); visible = true; }
  }

  function hideSoon(delayMs) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (stageEl) stageEl.classList.remove('show');
      visible = false;
    }, delayMs || 2000);
  }

  function hideNow() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (stageEl) stageEl.classList.remove('show');
    visible = false;
    clearCues();
  }

  function renderLine(line) {
    if (!mounted) mount();
    if (!line || line.clear) { hideNow(); return; }
    const original = globalThis.LSText.normalizeText(line.original || '');
    const translation = globalThis.LSText.normalizeText(line.translation || '');
    if (!translation || LIGHT_NOISE.test(translation)) return;

    if (settings && settings.showOriginal && original && original !== translation) {
      originalEl.textContent = original;
      originalEl.parentNode.style.display = '';
    } else {
      originalEl.textContent = '';
      originalEl.parentNode.style.display = 'none';
    }
    badgeEl.textContent = line.iso || '';
    badgeEl.style.display = line.iso ? '' : 'none';
    translationEl.textContent = translation;
    show();
    // Raw-<video> fullscreen: paint the same line through native cues.
    if (cueVideo && cueTrack) showCue(original, translation);
  }

  function setStatus(status) {
    if (!status) return;
    if (status.phase === 'stopped') hideSoon(1200);
  }

  // --- Fullscreen: keep captions inside the fullscreen element --------------

  function getFullscreenElement() {
    return document.fullscreenElement
      || document.webkitFullscreenElement
      || document.webkitCurrentFullScreenElement
      || null;
  }

  // Raw <video> fullscreen paints ONLY the video element (a replaced element:
  // neither children nor sibling DOM are rendered). The only way to paint
  // text over native video fullscreen is a TextTrack cue, which the browser
  // composites on the top fullscreen layer itself.
  function ensureCueTrack(video) {
    if (cueVideo === video && cueTrack) return cueTrack;
    cueVideo = video;
    cueTrack = null;
    if (!video || typeof video.addTextTrack !== 'function' || typeof globalThis.VTTCue !== 'function') {
      return null;
    }
    // Reuse our track when the same video re-enters fullscreen.
    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i += 1) {
        if (video.textTracks[i].label === 'LinguaSub') {
          cueTrack = video.textTracks[i];
          return cueTrack;
        }
      }
    }
    const track = video.addTextTrack('subtitles', 'LinguaSub', 'en');
    track.mode = 'showing';
    cueTrack = track;
    return track;
  }

  function buildCueCSS() {
    const s = (settings && settings.style) || {};
    const bg = globalThis.LSText && globalThis.LSText.hexToRgba
      ? globalThis.LSText.hexToRgba(s.bg || '#000000', s.bgOpacity == null ? 0.6 : s.bgOpacity)
      : 'rgba(0,0,0,.6)';
    // ::cue accepts a restricted property set; map the editable style onto it.
    return `video::cue {
      color: ${s.color || '#ffffff'};
      background: ${bg};
      font-family: ${s.fontFamily || 'sans-serif'};
      font-size: ${s.fontSize || 26}px;
      font-weight: ${s.bold === false ? '400' : '700'};
      font-style: ${s.italic ? 'italic' : 'normal'};
      line: 92%;
    }`;
  }

  function applyCueStyle() {
    if (!cueStyleEl) return;
    cueStyleEl.textContent = buildCueCSS();
  }

  function ensureCueStyle() {
    if (cueStyleEl && cueStyleEl.parentNode) return;
    cueStyleEl = document.createElement('style');
    cueStyleEl.dataset.ls = 'cue-style';
    cueStyleEl.textContent = buildCueCSS();
    (document.head || document.documentElement).appendChild(cueStyleEl);
  }

  function clearCues() {
    if (!cueTrack) return;
    // `cues` is the full list; `activeCues` may be empty/Null while cues linger.
    const list = (cueTrack.cues && cueTrack.cues.length) ? cueTrack.cues : cueTrack.activeCues;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      try { cueTrack.removeCue(list[i]); } catch (_) { /* noop */ }
    }
  }

  function showCue(original, translation) {
    if (!cueVideo || !cueTrack) return;
    const showOriginal = settings && settings.showOriginal && original && original !== translation;
    const text = showOriginal ? `${original}\n${translation}` : translation;
    clearCues();
    const now = cueVideo.currentTime || 0;
    let cue;
    try {
      cue = new VTTCue(now, now + 4, text); //eslint-disable-line no-undef
    } catch (_) {
      return;
    }
    cue.line = 92;
    cue.snapToLines = false;
    try { cueTrack.addCue(cue); } catch (_) { /* noop */ }
  }

  function teardownCues() {
    clearCues();
    if (cueTrack) { try { cueTrack.mode = 'hidden'; } catch (_) { /* noop */ } }
    cueTrack = null;
    cueVideo = null;
  }

  function reparentForFullscreen() {
    if (!mounted) return;
    const fs = getFullscreenElement();
    isFullscreen = !!fs;
    let target = document.body || document.documentElement;
    if (fs) {
      if (fs.tagName === 'VIDEO') {
        // Replaced element: overlay DOM cannot paint over it. Native VTTCues
        // are composited by the browser itself and survive raw-video
        // fullscreen; the host is parked on the parent meanwhile.
        ensureCueStyle();
        const track = ensureCueTrack(fs);
        if (track) {
          try { track.mode = 'showing'; } catch (_) { /* noop */ }
        }
        target = fs.parentElement || target;
      } else {
        // Player wrapper fullscreen (YouTube/Netflix style): move the host
        // inside the fullscreen subtree, which is what actually gets painted.
        teardownCues();
        target = fs;
      }
    } else {
      teardownCues();
    }
    if (host.parentNode !== target) target.appendChild(host);
  }

  // --- Drag to reposition ---------------------------------------------------

  function persistOffset(offset) {
    if (!settings) return;
    settings.style.offset = Math.max(0, Math.min(70, offset));
    applyStyle();
    if (hasChrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(null, (all) => {
        const saved = (all && all.settings) || {};
        const style = Object.assign({}, saved.style || {}, { offset: settings.style.offset });
        chrome.storage.sync.set({ settings: Object.assign({}, saved, { style }) });
      });
    }
  }

  function attachDrag(handle) {
    if (!handle) return;
    let startY = 0;
    let startOffset = 0;

    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dragging = true;
      startY = ev.clientY;
      startOffset = ((settings && settings.style) || {}).offset || 0;
      handle.setPointerCapture && handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const isTop = settings.style.position === 'top';
      const delta = isTop ? (ev.clientY - startY) : (startY - ev.clientY);
      persistOffset(startOffset + Math.round(delta / 2));
    });
    const endDrag = () => { dragging = false; };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  // --- Extension wiring ------------------------------------------------------

  function boot() {
    document.documentElement.dataset.lsBoot = '1';
    mount();
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(null, (all) => {
        const saved = all && all.settings;
        settings = globalThis.LSText.mergeSettings(saved);
        applyStyle();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.settings) {
          setSettings(changes.settings.newValue);
        }
      });
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'LS_LINE') renderLine(msg);
      else if (msg.type === 'LS_STOPPED') hideSoon(1200);
      else if (msg.type === 'LS_STATUS') setStatus(msg);
      else if (msg.type === 'LS_ERROR' && mounted) {
        translationEl.textContent = `[LinguaSub] ${msg.message || 'error'}`;
        originalEl.textContent = '';
        badgeEl.textContent = 'err';
        badgeEl.style.display = '';
        show();
        hideSoon(4000);
      }
      return false;
    });
  }

  const api = {
    mount,
    unmount,
    applyStyle,
    setSettings,
    renderLine,
    setStatus,
    hideNow,
    reparentForFullscreen,
    getFullscreenElement,
    get host() { return host; },
    get mounted() { return mounted; },
    get els() { return { stageEl, originalEl, translationEl, badgeEl, handleEl, boxEl }; },
    get isFullscreen() { return isFullscreen; },
    get cueTrack() { return cueTrack; },
    get cueVideo() { return cueVideo; }
  };
  globalThis.LSContent = api;

  if (hasChrome) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
