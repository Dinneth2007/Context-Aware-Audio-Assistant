# Wubble

Context Aware Reading-Audio Assistant

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

▸ [Watch the 90-second demo](VIDEO_URL_PLACEHOLDER)

Wubble is a Chrome extension that helps you understand what you're reading. It answers about the specific section you're focused on — by selection, hover, or viewport dwell — and briefly highlights that section so you can verify the grounding.

## What makes it different

- **Context-aware grounding.** Answers come from the section you're focused on, not a flat dump of the page text.
- **Visible attention.** When the model answers, the section it grounded in briefly outlines on the page — no black box.
- **Proactive engagement.** After 8 seconds of continuous dwell on a section without activity, Wubble offers to explain it.

## How it understands user context

Three signals feed the focus payload: text selection, recent hover on figures and code, and viewport dwell. Selection wins as the most explicit intent; hover within three seconds is next; dwell is the default.

A document-order DOM walker partitions the page at h1/h2/h3 boundaries, skipping nav, aside, and footer subtrees. Dwell uses IntersectionObserver with thresholds at 0, 0.25, 0.5, 0.75, 1, and counters that decay 5% every five seconds. Selection uses the Selection API. The payload carries the focused section, an outline of every heading, and page metadata.

## Where audio fits

Speech-to-text uses the Web Speech API (webkitSpeechRecognition) with a 1.5-second silence timer and a fallback that promotes the trailing interim transcript to final if the recognizer ends without one. Speech-out uses chrome.tts; side panels restrict speechSynthesis.

The audio loop is an explicit four-state machine: idle, listening, thinking, speaking. The proactive dwell offer is audio-first, announced by an optional 660Hz tone. /api/chat returns the answer in one SSE chunk — live token streaming is disabled because of provider reliability issues.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S CHROME BROWSER                    │
│                                                             │
│   ┌──────────────┐         ┌──────────────────────────┐     │
│   │  Web page    │         │     Sidebar (React)      │     │
│   │              │◀────────│                          │     │
│   │  Content     │  high-  │  - Focus pill            │     │
│   │  script      │  light  │  - Mic + text box        │     │
│   │              │  + ask  │  - Answer card           │     │
│   │  - Reads DOM │────────▶│  - Proactive offer card  │     │
│   │  - Tracks    │ focus   │  - State indicator       │     │
│   │    attention │ updates │                          │     │
│   │  - Section   │         └────────────┬─────────────┘     │
│   │    detection │                      │                   │
│   └──────────────┘                      │                   │
│                                         │ HTTPS             │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  Backend server      │
                              │  (Node + Express)    │
                              │  - /api/chat         │
                              │  - Provider adapter  │
                              │    (Groq / Gemini)   │
                              │  - Holds API key     │
                              └──────────┬───────────┘
                                         │
                                         ▼
                                ┌─────────────────┐
                                │  LLM provider   │
                                │  (Groq Llama)   │
                                └─────────────────┘
```

API keys never reach the extension bundle. The backend forwards to either Groq (default) or Gemini, switchable by one env-var.

## Running it locally

1. Node 20+, Chrome, and a Groq API key (or Gemini).

2. Set up the server:
   ```bash
   cd server
   npm install
   cp .env.example .env   # then add your key
   npm run dev
   ```

3. Build the extension:
   ```bash
   cd extension
   npm install
   npm run build
   ```

4. Load the extension: open `chrome://extensions`, enable Developer Mode, click Load unpacked, and select `extension/dist`.

5. Click the Wubble toolbar icon to open the side panel.

## Tech stack

Chrome Manifest V3 extension with a content script, service-worker background, and side panel UI in React 18 with Vite and Tailwind, bundled by @crxjs/vite-plugin. Backend is Node 20 + Express, picking between @google/genai and the OpenAI SDK pointed at Groq by env var. Audio is browser-native.

## Known limitations

- Auto-speak after a mic question doesn't fire reliably; one Replay click plays the answer. Fix path: a server-side TTS endpoint feeding an `<audio>` element.
- /api/chat returns the answer in a single SSE chunk; live token streaming is disabled.
- Free-tier provider quotas can hit during heavy testing.
- Cross-origin iframes are unreachable per browser security; selection inside an iframe still propagates.

## What's next

- Server-side TTS to fix auto-speak.
- PDF support via PDF.js text extraction.
- Conversation memory across questions on a page.
- Evaluation harness with LLM-judged answer quality.
