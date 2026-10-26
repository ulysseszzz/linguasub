/*
 * LinguaSub offscreen document.
 *
 * Lives only while a caption session is active and owns:
 *   - the tab audio MediaStream (chromeMediaSource: 'tab', streamId from SW)
 *   - a 16 kHz AudioContext + AudioWorklet capture graph
 *   - the module Worker that runs Whisper + NLLB locally
 *
 * The service worker cannot use getUserMedia / AudioContext, which is why this
 * document exists (MV3 offscreen API).
 */

const TARGET_SR = 16000;
const FLUSH_SAMPLES = TARGET_SR / 2; // forward 0.5 s chunks to the engine

let worker = null;
let stream = null;
let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let capture = null;
let active = false;

function send(msg) {
  // Best-effort relay to the service worker.
  chrome.runtime.sendMessage(Object.assign({ to: 'background' }, msg)).catch(() => {});
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL('src/offscreen/engine-worker.js'), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || !msg.kind) return;
    if (msg.kind === 'status' && msg.phase === 'error') {
      send({ type: 'LS_ERROR', message: msg.message });
    } else if (msg.kind === 'status') {
      send({ type: 'LS_STATUS', phase: msg.phase, progress: msg.progress, message: msg.message, iso: msg.iso, flores: msg.flores });
    } else if (msg.kind === 'line') {
      send({
        type: 'LS_LINE',
        clear: !!msg.clear,
        original: msg.original || '',
        translation: msg.translation || '',
        iso: msg.iso || '',
        flores: msg.flores || ''
      });
    }
  };
  worker.onerror = (ev) => {
    send({ type: 'LS_ERROR', message: `Engine worker error: ${ev.message || 'unknown'}` });
  };
  return worker;
}

// Linear resampling fallback (used if the AudioContext cannot run at 16 kHz).
function resampleTo16k(input, inRate) {
  if (inRate === TARGET_SR) return input;
  const ratio = TARGET_SR / inRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

async function teardownAudio() {
  active = false;
  if (capture && capture.port) {
    try { capture.port.onmessage = null; } catch (_) { /* noop */ }
  }
  if (workletNode) { try { workletNode.disconnect(); } catch (_) { /* noop */ } workletNode = null; }
  if (sourceNode) { try { sourceNode.disconnect(); } catch (_) { /* noop */ } sourceNode = null; }
  if (stream) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* noop */ } });
    stream = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch (_) { /* noop */ }
    audioCtx = null;
  }
  capture = null;
}

async function startCapture(config, streamId) {
  await teardownAudio();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioCtx = new AudioContext({ sampleRate: TARGET_SR });
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/passthrough-worklet.js'));

  sourceNode = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'ls-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1
  });
  sourceNode.connect(workletNode);
  // Intentionally not connected to destination: capture is silent for the local user,
  // while the tab itself keeps playing audio normally.

  let inBuffer = [];
  let inLength = 0;
  active = true;

  capture = workletNode;
  workletNode.port.onmessage = (ev) => {
    if (!active) return;
    const frame = ev.data; // 128 frames at context rate
    inBuffer.push(frame);
    inLength += frame.length;
    // Flush roughly every 0.5 s of 16 kHz output.
    const expectedSource = Math.ceil(FLUSH_SAMPLES * audioCtx.sampleRate / TARGET_SR);
    if (inLength >= expectedSource) {
      const merged = new Float32Array(inLength);
      let off = 0;
      for (const part of inBuffer) { merged.set(part, off); off += part.length; }
      inBuffer = [];
      inLength = 0;
      const pcm = resampleTo16k(merged, audioCtx.sampleRate);
      if (worker) worker.postMessage({ cmd: 'audio', samples: pcm }, [pcm.buffer]);
    }
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.to !== 'offscreen') return false;

  if (msg.type === 'LS_OFF_START') {
    (async () => {
      try {
        ensureWorker().postMessage({
          cmd: 'start',
          target: msg.target,
          device: msg.device,
          asrModel: msg.asrModel,
          mtModel: msg.mtModel
        });
        await startCapture({ device: msg.device }, msg.streamId);
        sendResponse({ ok: true });
      } catch (err) {
        await teardownAudio();
        const message = err && err.message ? err.message : String(err);
        send({ type: 'LS_ERROR', message: `Capture failed: ${message}` });
        sendResponse({ ok: false, error: message });
      }
    })();
    return true; // async sendResponse
  }

  if (msg.type === 'LS_OFF_TARGET') {
    if (worker) worker.postMessage({ cmd: 'target', target: msg.target });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'LS_OFF_STOP') {
    (async () => {
      if (worker) worker.postMessage({ cmd: 'stop' });
      await teardownAudio();
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
