# LinguaSub — Chrome Web Store 上架材料

## 一、扩展基本信息

| 字段 | 内容 |
|---|---|
| 扩展名称 | LinguaSub — Real-time Translated Subtitles |
| 版本 | 0.1.0 |
| 分类 | Productivity |
| 主语言 | English |
| 可见性 | Public（公开） |

## 二、详细描述（英文 — 主语言）

```
LinguaSub brings real-time, on-device translated subtitles to ANY video on the web.

★ HOW IT WORKS
1. Open any video (YouTube, Netflix, Bilibili, online courses, video calls…)
2. Click the LinguaSub icon and pick your target language
3. Press "Start on this tab" — captions appear instantly over the video

★ KEY FEATURES
• Auto language detection — just choose the language you want to read
• 100% on-device AI — Whisper for speech recognition + NLLB for translation
• No audio leaves your browser. Your data stays private.
• Works in fullscreen — subtitles follow the video even in fullscreen mode
• Fully customizable styles — font, size, color, background, position, opacity, outline, shadow
• Bilingual display — original text and translation shown together

★ PRIVACY FIRST
All processing happens locally in your browser using WebGPU/WASM-accelerated AI models. We never upload, store, or transmit your audio or captions to any server.

Note: First run downloads AI models (~600MB) from Hugging Face; they are cached afterward.
```

## 三、详细描述（中文 — 可选第二语言）

```
LinguaSub 为网络上的任意视频提供实时、本地运行的翻译字幕。

★ 使用方式
1. 打开任意视频（YouTube、Netflix、B站、在线课程、视频会议…）
2. 点击 LinguaSub 图标，选择目标语言
3. 点击「Start on this tab」——字幕即刻浮现在视频上方

★ 核心功能
• 自动识别源语言——只需选择你想看的目标语言
• 100% 本地 AI——Whisper 语音识别 + NLLB 机器翻译
• 音频不出浏览器，数据完全私密
• 支持全屏——视频全屏时字幕依然显示
• 样式自由定制——字体、字号、颜色、背景、位置、透明度、描边、阴影
• 双语显示——原文与译文同时呈现

★ 隐私优先
所有处理均在浏览器本地完成，使用 WebGPU/WASM 加速的 AI 模型。我们绝不会上传、存储或传输你的音频或字幕到任何服务器。

注：首次使用会从 HuggingFace 下载 AI 模型（约 600MB），之后会缓存。
```

## 四、截图（4 张，1280×800）

文件位于 `store-assets/` 目录：

| 文件 | 内容 |
|---|---|
| `01-popup.png` | 主面板（语言选择 + Start 按钮） |
| `02-subtitles.png` | 视频上的双语字幕效果 |
| `03-settings.png` | 样式设置页 |
| `04-fullscreen.png` | 全屏字幕效果 |

## 五、隐私政策

文件：`store-assets/privacy-policy.html`

需托管到公开可访问的 URL（GitHub Pages / 个人网站 / Google Sites），然后将 URL 填入后台「Privacy policy」字段。

核心声明：
- 音频仅在本地处理，不上传任何服务器
- 语音识别和翻译全部在浏览器内通过本地 AI 模型完成
- 不收集、不存储、不传输用户的任何音频或翻译文本
- 样式偏好通过 chrome.storage 本地保存

## 六、权限说明（Privacy practices 页）

| 权限 | 用途 |
|---|---|
| `tabCapture` | 捕获当前标签页音频，送入本地 Whisper 做语音识别 |
| `offscreen` | 创建离屏文档运行 AudioContext + 模型 Worker |
| `storage` | 本地保存字幕样式和目标语言偏好 |
| `activeTab` | 获取活动标签页 ID 以定向发送字幕 |
| `<all_urls>` | 在任意视频页面注入字幕覆盖层 |

隐私实践填写：
- 「你是否会收集或传输用户数据？」→ **否**
- 「你是否会出售用户数据？」→ **否**
- 「使用方式」→ 音频仅用于本地语音识别，不存储不传输

## 七、上架步骤

1. 访问 https://chrome.google.com/webstore/devconsole
2. 注册开发者账号（$5 一次性费用）
3. Add new item → 上传 `release/linguasub-0.1.0.zip`
4. 填写 Store listing（名称、描述、分类、截图）
5. 填写 Privacy practices（权限说明 + 隐私政策 URL）
6. Submit for review（1–3 个工作日）
