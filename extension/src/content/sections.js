// Semantic section detector. Walks the DOM in document order, partitioning
// content into sections at h1/h2/h3 boundaries. Re-runs on DOM mutation,
// debounced 500ms.

const MIN_SECTION_CHARS = 100;
const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const REJECT_SUBTREE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'FOOTER', 'ASIDE', 'SVG']);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3']);

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
      if (SKIP_TEXT_PARENTS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const t = node.nodeValue && node.nodeValue.trim();
      return t ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const parts = [];
  let n;
  while ((n = walker.nextNode())) parts.push(n.nodeValue.trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function buildFromHeadings() {
  const root = document.body;
  if (!root) return [];

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (SKIP_TEXT_PARENTS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          const t = node.nodeValue && node.nodeValue.trim();
          return t ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        const tag = node.tagName;
        if (REJECT_SUBTREE_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (HEADING_TAGS.has(tag)) {
          if (node.offsetParent === null) return NodeFilter.FILTER_SKIP;
          if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  const buckets = [];
  let current = null;
  let inHeading = null;
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const headingText = node.textContent.trim();
      current = { heading: headingText, headingEl: node, parts: [headingText] };
      buckets.push(current);
      inHeading = node;
    } else if (current) {
      if (inHeading && inHeading.contains(node)) continue;
      inHeading = null;
      current.parts.push(node.nodeValue.trim());
    }
  }

  return buckets
    .map((b) => {
      const text = b.parts.join(' ').replace(/\s+/g, ' ').trim();
      return {
        id: djb2(b.heading + '|' + text.slice(0, 50)),
        heading: b.heading,
        text,
        element: b.headingEl,
        charCount: text.length,
      };
    })
    .filter((s) => s.charCount >= MIN_SECTION_CHARS);
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
