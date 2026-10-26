# LinguaSub — Real-time Translated Subtitles

A Chrome extension that adds **real-time, on-device translated subtitles** to any video on the web. Powered by local AI models (Whisper for speech recognition + NLLB for translation), all processing happens in your browser — no audio ever leaves your device.

## ✨ Features

- **Auto language detection** — just pick the language you want to read
- **100% on-device AI** — Whisper-tiny (ASR) + NLLB-200-600M (MT) via WebGPU/WASM
- **Fullscreen support** — subtitles stay visible even in fullscreen (native VTTCue fallback for raw `<video>`)
- **Customizable styles** — font, size, color, background, position, opacity, outline, shadow, bilingual toggle
- **Privacy first** — no audio, captions, or personal data is ever uploaded

## 📦 Installation

### From Chrome Web Store
_(pending review)_

### Load unpacked (development)
1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `linguasub/` directory

> Note: enterprise-managed Chrome with `ExtensionInstallBlocklist: "*"` will silently refuse unpacked extensions. Use Chrome for Testing or Chromium instead.

## 🚀 Usage

1. Open any video page (YouTube, Netflix, Bilibili, online courses, video calls…)
2. Click the LinguaSub toolbar icon
3. Choose your target language
4. Click **Start on this tab**

First run downloads AI models (~600 MB) from Hugging Face; they are cached afterward.

## 🏗️ Architecture

```
popup ──(LS_START)──▶ service worker ──(tabCapture)──▶ offscreen document
                                                              │
                                              getUserMedia(tab audio)
                                                              │
                                              AudioContext → AudioWorklet
                                                              │
                                              engine-worker (module Worker)
                                              ├─ Whisper  (ASR, auto lang detect)
                                              └─ NLLB     (translation)
                                                              │
                                              LS_LINE ──▶ content script overlay
                                                              │
                                              Shadow DOM subtitles (fullscreen-aware)
```

| Component | Path | Role |
|---|---|---|
| Manifest | `linguasub/manifest.json` | MV3 permissions & entry points |
| Service worker | `linguasub/src/background/service-worker.js` | session orchestration, tabCapture, message relay |
| Offscreen | `linguasub/src/offscreen/offscreen.js` | audio capture graph, worker lifecycle |
| Engine worker | `linguasub/src/offscreen/engine-worker.js` | Whisper + NLLB inference, streaming windows |
| Content script | `linguasub/src/content/content.js` | Shadow DOM overlay, fullscreen reparent, VTTCue fallback |
| Popup | `linguasub/src/popup/` | UI: language picker, start button, style settings |
| Shared | `linguasub/src/shared/` | languages table, text utils, CSS builder |

## 🛠️ Build & Test

```bash
# Package a publishable ZIP (output: release/linguasub-<version>.zip)
./build-release.sh

# Run unit tests
node linguasub/test/node-test.mjs

# Run overlay DOM harness (headless Chrome)
node --experimental-websocket /tmp/ls-harness-run.mjs "$(pwd)/linguasub"

# Run CDP end-to-end smoke test
node --experimental-websocket linguasub/test/cdp-smoke.mjs
```

## 📁 Project Layout

```
.
├── linguasub/              # Extension source (load this dir unpacked)
│   ├── manifest.json
│   ├── assets/icons/       # 16/32/48/128 px icons
│   ├── vendor/             # Transformers.js + ONNX Runtime WASM (vendored)
│   ├── src/
│   │   ├── background/
│   │   ├── content/
│   │   ├── offscreen/
│   │   ├── popup/
│   │   └── shared/
│   └── test/               # node-test, harness, cdp-smoke
├── store-assets/           # Screenshots, privacy policy, store listing copy
├── build-release.sh        # Chrome Web Store packaging script
└── start-linguasub.sh      # Launch Chrome for Testing with the extension
```

## 🔒 Privacy

All audio is processed locally in the browser. No data is collected, stored, or transmitted. See [store-assets/privacy-policy.html](store-assets/privacy-policy.html).

## 📄 License

MIT
