# Wubble Hackathon: Context-Aware Audio Assistant

## What we're building
A Chrome extension (Manifest V3) that helps users understand web content
(papers, blogs, docs, PDFs) through a sidebar UI with audio interaction.
The extension tracks what the user is focused on (viewport, selection,
dwell time) and lets them ask voice or text questions about it.

## Architecture
- `extension/` — Vite + React + @crxjs/vite-plugin Chrome extension
  - `src/content/` — content scripts injected into web pages
  - `src/sidebar/` — React sidebar UI (side panel API)
  - `src/background/` — MV3 service worker
  - `src/lib/` — shared utilities (context extraction, audio, api client)
- `server/` — Express backend that proxies LLM and TTS calls
  - Never expose API keys in the extension; everything goes through here

## Stack
- Frontend: React 18, Vite, TailwindCSS, plain JS (no TypeScript)
- Backend: Node 20+, Express, OpenAI SDK
- Audio: Web Speech API (STT), starts with speechSynthesis, swaps to
  OpenAI TTS later
- LLM: OpenAI gpt-4o-mini and gpt-4o

## Constraints I'm working under
- 2-day hackathon, solo developer
- I have backend (Java, Node/Express) and React experience but have never
  shipped a Chrome extension before — explain extension-specific concepts
  when they come up
- Prioritize a working end-to-end flow over feature breadth
- Commit at the end of every phase

## Judging criteria (optimize for these)
1. Context extraction quality — 25%
2. Usefulness of assistance — 30%
3. Audio quality and relevance — 25%
4. UX, creativity, technical execution — 20%
