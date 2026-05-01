// Semantic section detector. Walks the DOM to produce a list of
// { id, heading, text, element, charCount } entries. Re-runs on DOM
// mutation, debounced 500ms.

const MIN_SECTION_CHARS = 100;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'NAV', 'FOOTER', 'HEADER', 'ASIDE']);

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function visibleText(el) {
  if (!el) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const t = node.nodeValue && node.nodeValue.trim();
      if (!t) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  let n;
  while ((n = walker.nextNode())) parts.push(n.nodeValue.trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function headingsBetween(start, end) {
  const out = [];
  let node = start.nextElementSibling;
  while (node && node !== end) {
    if (node.contains(end)) break;
    out.push(node);
    node = node.nextElementSibling;
  }
  return out;
}

function buildFromHeadings() {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter((h) => h.offsetParent !== null && h.textContent.trim().length > 0);
  if (headings.length === 0) return [];

  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const siblings = next ? headingsBetween(h, next) : [];
    let bodyText = '';
    for (const s of siblings) bodyText += ' ' + visibleText(s);
    const headingText = h.textContent.trim();
    const text = (headingText + ' ' + bodyText).replace(/\s+/g, ' ').trim();
    sections.push({
      id: djb2(headingText + '|' + text.slice(0, 50)),
      heading: headingText,
      text,
      element: h,
      charCount: text.length,
    });
  }
  return sections.filter((s) => s.charCount >= MIN_SECTION_CHARS);
}

function buildFromContainers() {
  const containers = Array.from(document.querySelectorAll('article, section, main'))
    .filter((el) => el.offsetParent !== null);
  const sections = [];
  for (const el of containers) {
    const h = el.querySelector('h1, h2, h3');
    const headingText = (h?.textContent || '').trim() || '(unnamed section)';
    const text = visibleText(el);
    if (text.length < MIN_SECTION_CHARS) continue;
    sections.push({
      id: djb2(headingText + '|' + text.slice(0, 50)),
      heading: headingText,
      text,
      element: el,
      charCount: text.length,
    });
  }
  return sections;
}

function buildFallback() {
  const text = visibleText(document.body).slice(0, 50000);
  if (text.length < MIN_SECTION_CHARS) return [];
  const heading = (document.title || 'This page').trim();
  return [{
    id: djb2(heading + '|fallback'),
    heading,
    text,
    element: document.body,
    charCount: text.length,
  }];
}

export function detectSections() {
  let sections = buildFromHeadings();
  if (sections.length === 0) sections = buildFromContainers();
  if (sections.length === 0) sections = buildFallback();

  const seen = new Set();
  return sections.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export function watchSections(onChange) {
  let timer = null;
  let last = detectSections();
  onChange(last);

  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const next = detectSections();
      if (next.length === last.length && next.every((s, i) => s.id === last[i].id)) return;
      last = next;
      onChange(next);
    }, 500);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}

export function isRestrictedDocument() {
  if (document.contentType === 'application/pdf') return true;
  if (document.querySelector('embed[type="application/pdf"]')) return true;
  if (!document.body || document.body.children.length === 0) return true;
  return false;
}
