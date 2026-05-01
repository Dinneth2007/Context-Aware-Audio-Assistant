// Attention tracker. Watches selection, viewport dwell, and hover, and
// exposes getFocus() returning the structured focus object the LLM uses.

const HOVER_TAGS = new Set(['FIGURE', 'TABLE', 'IMG', 'CODE', 'BLOCKQUOTE', 'PRE']);
const HOVER_RECENT_MS = 3000;
const TICK_MS = 1000;
const DECAY_INTERVAL_MS = 5000;
const DECAY_FACTOR = 0.95;
const MIN_DWELL_RATIO = 0.5;

let sections = [];
let sectionById = new Map();
let observer = null;
let visibilityRatios = new Map();
let dwellMs = new Map();
let tickHandle = null;
let decayHandle = null;

let selectionState = null;
let hoverState = null;
let listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(getFocus()); } catch (e) { console.error('[wubble attention] listener error:', e); }
  }
}

function findSectionForNode(node) {
  if (!node) return null;
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== document.body) {
    for (const s of sections) {
      if (s.element === el || s.element?.contains(el)) return s;
    }
    el = el.parentElement;
  }
  return null;
}

function onSelectionChange() {
  const sel = document.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text) {
    if (selectionState) {
      selectionState = null;
      notify();
    }
    return;
  }
  const anchorNode = sel.anchorNode;
  const section = findSectionForNode(anchorNode);
  selectionState = { text, sectionId: section?.id || null, ts: Date.now() };
  notify();
}

function onMouseOver(e) {
  let el = e.target;
  while (el && el !== document.body) {
    if (HOVER_TAGS.has(el.tagName)) {
      const text = (el.textContent || el.alt || '').trim().slice(0, 300);
      hoverState = {
        type: el.tagName.toLowerCase(),
        text,
        ts: Date.now(),
        sectionId: findSectionForNode(el)?.id || null,
      };
      notify();
      return;
    }
    el = el.parentElement;
  }
}

function tick() {
  let bestId = null;
  let bestRatio = 0;
  for (const [id, ratio] of visibilityRatios) {
    if (ratio >= MIN_DWELL_RATIO && ratio > bestRatio) {
      bestRatio = ratio;
      bestId = id;
    }
  }
  if (!bestId) {
    const center = window.innerHeight / 2;
    let lastAbove = null;
    let lastAboveTop = -Infinity;
    for (const s of sections) {
      const rect = s.element?.getBoundingClientRect?.();
      if (!rect) continue;
      if (rect.top <= center && rect.top > lastAboveTop) {
        lastAboveTop = rect.top;
        lastAbove = s.id;
      }
    }
    bestId = lastAbove;
  }
  if (bestId) {
    dwellMs.set(bestId, (dwellMs.get(bestId) || 0) + TICK_MS);
    notify();
  }
}

function decay() {
  for (const [id, ms] of dwellMs) dwellMs.set(id, ms * DECAY_FACTOR);
}

export function setSections(next) {
  sections = next || [];
  sectionById = new Map(sections.map((s) => [s.id, s]));
  if (observer) observer.disconnect();
  visibilityRatios = new Map();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.__wubbleSectionId;
        if (!id) continue;
        visibilityRatios.set(id, entry.intersectionRatio);
      }
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] }
  );
  for (const s of sections) {
    if (!s.element) continue;
    s.element.__wubbleSectionId = s.id;
    observer.observe(s.element);
  }
  for (const id of Array.from(dwellMs.keys())) {
    if (!sectionById.has(id)) dwellMs.delete(id);
  }
  notify();
}

export function getFocus() {
  const now = Date.now();
  const pageOutline = sections.map((s) => ({ id: s.id, heading: s.heading }));
  const wordCount = sections.reduce((n, s) => n + (s.text?.split(/\s+/).length || 0), 0);
  const pageMeta = { title: document.title, url: location.href, wordCount };

  if (selectionState && selectionState.text) {
    const section = sectionById.get(selectionState.sectionId) || sections[0] || null;
    return {
      source: 'selection',
      section: section ? { id: section.id, heading: section.heading, text: section.text } : null,
      selectedText: selectionState.text,
      hoveredElement: null,
      pageOutline,
      pageMeta,
    };
  }

  if (hoverState && now - hoverState.ts < HOVER_RECENT_MS &&
      ['figure', 'table', 'img'].includes(hoverState.type)) {
    const section = sectionById.get(hoverState.sectionId) || sections[0] || null;
    return {
      source: 'hover',
      section: section ? { id: section.id, heading: section.heading, text: section.text } : null,
      selectedText: null,
      hoveredElement: { type: hoverState.type, text: hoverState.text },
      pageOutline,
      pageMeta,
    };
  }

  let bestId = null;
  let bestMs = 0;
  for (const [id, ms] of dwellMs) {
    if (ms > bestMs) { bestMs = ms; bestId = id; }
  }
  const section = (bestId && sectionById.get(bestId)) || sections[0] || null;
  const recentHover = hoverState && now - hoverState.ts < HOVER_RECENT_MS
    ? { type: hoverState.type, text: hoverState.text }
    : null;
  return {
    source: 'viewport',
    section: section ? { id: section.id, heading: section.heading, text: section.text } : null,
    selectedText: null,
    hoveredElement: recentHover,
    pageOutline,
    pageMeta,
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startAttention() {
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mouseover', onMouseOver, { passive: true });
  tickHandle = setInterval(tick, TICK_MS);
  decayHandle = setInterval(decay, DECAY_INTERVAL_MS);
  return () => {
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('mouseover', onMouseOver);
    if (tickHandle) clearInterval(tickHandle);
    if (decayHandle) clearInterval(decayHandle);
    if (observer) observer.disconnect();
    listeners.clear();
  };
}
