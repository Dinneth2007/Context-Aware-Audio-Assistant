// Content script: runs in the page's world, can read the DOM.
// Listens for EXTRACT_CONTEXT requests from the sidebar and returns visible text.

function extractVisibleText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.nodeValue && node.nodeValue.trim();
      if (!text) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    parts.push(node.nodeValue.trim());
  }
  return {
    title: document.title,
    url: location.href,
    text: parts.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'EXTRACT_CONTEXT') {
    try {
      sendResponse({ ok: true, ...extractVisibleText() });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
});

console.log('[wubble content] ready on', location.href);
