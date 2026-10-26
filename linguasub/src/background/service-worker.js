/*
 * LinguaSub MV3 service worker.
 *
 * Coordinates the three worlds:
 *   popup  --(LS_START/STOP)-->  service worker
 *                                 | tabCapture.getMediaStreamId
 *                                 v
 *                             offscreen document (audio + local models)
 *                                 | LS_LINE / LS_STATUS
 *                                 v
 *                             content script subtitle overlay
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

const state = {
  activeTabId: null,
  settings: null,
  lastStatus: null
};

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Captures the current tab audio stream to run on-device speech recognition and translation for live subtitles.'
  });
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function broadcastToExtension(message) {
  // Delivered to the popup/offscreen (not to content scripts).
  chrome.runtime.sendMessage(message).catch(() => {
    // "No receiving end" (popup closed) is expected; ignore.
  });
}

async function relayToTab(message) {
  if (state.activeTabId == null) return;
  try {
    await chrome.tabs.sendMessage(state.activeTabId, message);
  } catch (_) {
    // Content script may not be injected yet (e.g. chrome:// pages); ignore.
  }
}

async function startSession(settings) {
  const tabId = await getActiveTabId();
  if (tabId == null) throw new Error('No active tab found.');

  state.activeTabId = tabId;
  state.settings = settings;
  state.lastStatus = { phase: 'starting' };

  await ensureOffscreen();

  // The consumer (offscreen document, same extension) must use this id quickly.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const reply = await chrome.runtime.sendMessage({
    to: 'offscreen',
    type: 'LS_OFF_START',
    streamId,
    target: settings.target,
    device: settings.device,
    asrModel: settings.asrModel,
    mtModel: settings.mtModel
  });

  if (!reply || !reply.ok) {
    throw new Error((reply && reply.error) || 'Offscreen start failed');
  }

  broadcastToExtension({ to: 'popup', type: 'LS_STATUS', phase: 'capturing' });
  return { ok: true, tabId };
}

async function stopSession(reason) {
  if (state.activeTabId == null) return { ok: true };
  try {
    await chrome.runtime.sendMessage({ to: 'offscreen', type: 'LS_OFF_STOP' });
  } catch (_) { /* offscreen may be gone */ }
  await relayToTab({ type: 'LS_STOPPED' });
  broadcastToExtension({ to: 'popup', type: 'LS_STATUS', phase: 'stopped', message: reason || '' });
  state.activeTabId = null;
  state.settings = null;
  state.lastStatus = null;
  return { ok: true };
}

// ---- Messages from popup / offscreen --------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LS_START') {
    startSession(msg.settings)
      .then((r) => sendResponse(r))
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        broadcastToExtension({ to: 'popup', type: 'LS_STATUS', phase: 'error', message });
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  if (msg.type === 'LS_STOP') {
    stopSession('user')
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'LS_GET_STATE') {
    sendResponse({
      activeTabId: state.activeTabId,
      settings: state.settings,
      lastStatus: state.lastStatus
    });
    return false;
  }

  if (msg.type === 'LS_TARGET_CHANGED') {
    // Popup can retarget language without restarting audio/models.
    if (state.activeTabId != null) {
      chrome.runtime.sendMessage({ to: 'offscreen', type: 'LS_OFF_TARGET', target: msg.target }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  // Events coming from the offscreen document.
  if (msg.to === 'background') {
    if (msg.type === 'LS_LINE') {
      relayToTab(msg);
      return false;
    }
    if (msg.type === 'LS_STATUS') {
      state.lastStatus = { phase: msg.phase, progress: msg.progress, message: msg.message };
      broadcastToExtension({
        to: 'popup',
        type: 'LS_STATUS',
        phase: msg.phase,
        progress: msg.progress,
        message: msg.message,
        iso: msg.iso,
        flores: msg.flores
      });
      return false;
    }
    if (msg.type === 'LS_ERROR') {
      broadcastToExtension({ to: 'popup', type: 'LS_STATUS', phase: 'error', message: msg.message });
      relayToTab({ type: 'LS_ERROR', message: msg.message });
      return false;
    }
  }

  return false;
});

// Release the tab capture if its tab disappears.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.activeTabId) {
    stopSession('tab-closed').catch(() => {});
  }
});
