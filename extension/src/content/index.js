// Content script: runs in the page world. Builds sections, runs the
// attention tracker, and broadcasts focus updates to the sidebar.

import { detectSections, watchSections, isRestrictedDocument } from './sections.js';
import { setSections, getFocus, subscribe, startAttention } from './attention.js';

const RESTRICTED = isRestrictedDocument();

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
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const key = focusKey(focus);
    if (key === lastBroadcastKey) return;
    lastBroadcastKey = key;
    chrome.runtime
      .sendMessage({ type: 'FOCUS_CHANGE', focus })
      .catch(() => {}); // no listener (sidebar closed) is fine
    console.log('[wubble content] focus →', focus.source, focus.section?.heading || '(no section)');
  }, 500);
}

if (RESTRICTED) {
  console.log('[wubble content] restricted document — focus tracking disabled');
} else {
  watchSections((sections) => {
    console.log('[wubble content] sections detected:', sections.length);
    setSections(sections);
  });
  startAttention();
  subscribe(broadcast);
  // Prime an initial broadcast once layout settles.
  setTimeout(() => broadcast(getFocus()), 600);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
});

console.log('[wubble content] ready on', location.href, RESTRICTED ? '(restricted)' : '');
