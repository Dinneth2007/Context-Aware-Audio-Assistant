// Content script: runs in the page world. Builds sections, runs the
// attention tracker, and broadcasts focus updates to the sidebar.

import { detectSections, watchSections, isRestrictedDocument } from './sections.js';
import { setSections, getFocus, subscribe, startAttention } from './attention.js';

const RESTRICTED = isRestrictedDocument();
let invalidated = false;
let stopAttention = null;
let stopWatch = null;

function isContextInvalidated(err) {
  return /Extension context invalidated/i.test(err?.message || '');
}

function teardown(reason) {
  if (invalidated) return;
  invalidated = true;
  console.log('[wubble content] tearing down:', reason);
  try { stopAttention && stopAttention(); } catch {}
  try { stopWatch && stopWatch(); } catch {}
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

function broadcast(focus) {
  if (invalidated) return;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    if (invalidated) return;
    const key = focusKey(focus);
    if (key === lastBroadcastKey) return;
    lastBroadcastKey = key;
    try {
      const p = chrome.runtime.sendMessage({ type: 'FOCUS_CHANGE', focus });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => { if (isContextInvalidated(err)) teardown('sendMessage rejected'); });
      }
    } catch (err) {
      if (isContextInvalidated(err)) { teardown('sendMessage threw'); return; }
      throw err;
    }
    console.log('[wubble content] focus →', focus.source, focus.section?.heading || '(no section)');
  }, 500);
}

if (RESTRICTED) {
  console.log('[wubble content] restricted document — focus tracking disabled');
} else {
  stopWatch = watchSections((sections) => {
    console.log('[wubble content] sections detected:', sections.length);
    setSections(sections);
  });
  stopAttention = startAttention();
  subscribe(broadcast);
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
}

console.log('[wubble content] ready on', location.href, RESTRICTED ? '(restricted)' : '');
