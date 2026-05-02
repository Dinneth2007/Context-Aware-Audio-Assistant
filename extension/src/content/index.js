// Content script: runs in the page world. Builds sections, runs the
// attention tracker, and broadcasts focus updates to the sidebar.

import { detectSections, watchSections, isRestrictedDocument } from './sections.js';
import {
  setSections,
  getFocus,
  subscribe,
  startAttention,
  startProactive,
  resetProactiveWindow,
  dismissProactiveSection,
} from './attention.js';

const RESTRICTED = isRestrictedDocument();
let invalidated = false;
let stopAttention = null;
let stopWatch = null;
let stopProactive = null;
let currentSections = [];

function isContextInvalidated(err) {
  return /Extension context invalidated/i.test(err?.message || '');
}

function teardown(reason) {
  if (invalidated) return;
  invalidated = true;
  console.log('[wubble content] tearing down:', reason);
  try { stopAttention && stopAttention(); } catch {}
  try { stopWatch && stopWatch(); } catch {}
  try { stopProactive && stopProactive(); } catch {}
  if (broadcastTimer) clearTimeout(broadcastTimer);
}

function restrictedFocus() {
  return {
    source: 'viewport',
    section: null,
    selectedText: null,
    hoveredElement: null,
    pageOutline: [],
    pageMeta: {
      title: document.title,
      url: location.href,
      wordCount: 0,
      restricted: true,
      restrictedReason: "Can't read this page directly — try selecting text",
    },
  };
}

let lastBroadcastKey = '';
let broadcastTimer = null;

function focusKey(f) {
  return [
    f?.source,
    f?.section?.id || '',
    f?.selectedText ? f.selectedText.slice(0, 40) : '',
    f?.hoveredElement?.type || '',
  ].join('|');
}

function safeSendMessage(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') {
      p.catch((err) => { if (isContextInvalidated(err)) teardown('sendMessage rejected'); });
    }
  } catch (err) {
    if (isContextInvalidated(err)) { teardown('sendMessage threw'); return; }
    throw err;
  }
}

function broadcast(focus) {
  if (invalidated) return;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    if (invalidated) return;
    const key = focusKey(focus);
    if (key === lastBroadcastKey) return;
    lastBroadcastKey = key;
    safeSendMessage({ type: 'FOCUS_CHANGE', focus });
    console.log('[wubble content] focus →', focus.source, focus.section?.heading || '(no section)');
  }, 500);
}

// ---------- Grounding highlight ----------
const HIGHLIGHT_STYLE_ID = 'wubble-grounded-style';
function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = HIGHLIGHT_STYLE_ID;
  s.textContent = `
.wubble-grounded {
  animation: wubble-grounded 2500ms ease-in-out forwards !important;
  border-radius: 3px !important;
  outline-offset: 2px;
}
@keyframes wubble-grounded {
  0%   { background-color: rgba(16,185,129,0);    outline: 0 solid rgba(16,185,129,0); }
  16%  { background-color: rgba(16,185,129,0.12); outline: 3px solid rgba(16,185,129,0.9); }
  84%  { background-color: rgba(16,185,129,0.12); outline: 3px solid rgba(16,185,129,0.9); }
  100% { background-color: rgba(16,185,129,0);    outline: 0 solid rgba(16,185,129,0); }
}
`;
  (document.head || document.documentElement).appendChild(s);
}

function highlightSection(sectionId) {
  if (!sectionId) {
    console.log('[wubble content] highlight: no sectionId');
    return;
  }
  const target = currentSections.find((s) => s.id === sectionId);
  if (!target?.element) {
    console.log(
      '[wubble content] highlight: no match for', sectionId,
      '— knownIds:', currentSections.map((s) => s.id).slice(0, 5)
    );
    return;
  }
  console.log('[wubble content] highlight:', target.heading, '→ scrolling into view + animating');
  ensureHighlightStyle();
  // Scroll into view if the section is offscreen, so the user actually
  // sees the animation fire.
  try {
    const rect = target.element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      target.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch {}
  target.element.classList.remove('wubble-grounded');
  void target.element.offsetWidth;
  target.element.classList.add('wubble-grounded');
  setTimeout(() => {
    try { target.element.classList.remove('wubble-grounded'); } catch {}
  }, 2600);
}

// ---------- Proactive offer ----------
function onProactiveTrigger({ sectionId, heading }) {
  safeSendMessage({ type: 'proactive-offer', sectionId, heading });
}

if (RESTRICTED) {
  console.log('[wubble content] restricted document — focus tracking disabled');
} else {
  stopWatch = watchSections((sections) => {
    console.log('[wubble content] sections detected:', sections.length);
    currentSections = sections;
    setSections(sections);
  });
  stopAttention = startAttention();
  subscribe(broadcast);
  stopProactive = startProactive(onProactiveTrigger);
  setTimeout(() => { if (!invalidated) broadcast(getFocus()); }, 600);
}

try {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
} catch (err) {
  if (isContextInvalidated(err)) teardown('addListener threw');
  else throw err;
}

function onRuntimeMessage(msg, _sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'GET_FOCUS') {
    try {
      sendResponse({ ok: true, focus: RESTRICTED ? restrictedFocus() : getFocus() });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  if (msg.type === 'EXTRACT_CONTEXT') {
    try {
      const focus = RESTRICTED ? restrictedFocus() : getFocus();
      const text = focus.section?.text || '';
      sendResponse({ ok: true, title: document.title, url: location.href, text, focus });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  if (msg.type === 'WUBBLE_HIGHLIGHT') {
    try { highlightSection(msg.sectionId); } catch {}
    return; // no response needed
  }

  if (msg.type === 'PROACTIVE_DISMISS') {
    try { dismissProactiveSection(msg.sectionId); } catch {}
    return;
  }

  if (msg.type === 'QUESTION_ASKED') {
    try { resetProactiveWindow(); } catch {}
    return;
  }
}

console.log('[wubble content] ready on', location.href, RESTRICTED ? '(restricted)' : '');
