// Builds the JSON payload sent to the server. Keeps the focused
// section's full text (truncated to ~12000 chars) plus an outline
// of all section headings for breadth.

const MAX_FOCUS_CHARS = 12000;

function truncateMiddle(text, max) {
  if (!text || text.length <= max) return text || '';
  const half = Math.floor((max - 7) / 2);
  return text.slice(0, half) + ' [...] ' + text.slice(text.length - half);
}

export function buildContextPayload(focus) {
  if (!focus) {
    return {
      source: 'viewport',
      section: null,
      selectedText: null,
      hoveredElement: null,
      pageOutline: [],
      pageMeta: { title: '', url: '', wordCount: 0 },
    };
  }

  const section = focus.section
    ? {
        id: focus.section.id,
        heading: focus.section.heading,
        text: truncateMiddle(focus.section.text || '', MAX_FOCUS_CHARS),
      }
    : null;

  return {
    source: focus.source || 'viewport',
    section,
    selectedText: focus.selectedText || null,
    hoveredElement: focus.hoveredElement || null,
    pageOutline: Array.isArray(focus.pageOutline) ? focus.pageOutline : [],
    pageMeta: focus.pageMeta || { title: '', url: '', wordCount: 0 },
  };
}
