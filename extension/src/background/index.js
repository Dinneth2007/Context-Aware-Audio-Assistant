// MV3 service worker. Wakes up on events, then idles back to sleep.
// Job here: tell Chrome that clicking the toolbar icon opens the side panel.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[wubble bg] setPanelBehavior failed:', err));
});
