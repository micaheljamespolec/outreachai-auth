// ─── background.js ────────────────────────────────────────────────────────────
// The auth callback is now handled entirely by auth-callback.js (loaded inside
// auth.html). That script parses the token, saves the session, and closes the
// tab itself — no executeScript needed here.
//
// This listener is kept as a safety net: if auth-callback.js somehow fails to
// close the tab, we close it after 5 seconds.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_URL') {
    fetch(msg.url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000)
    })
      .then(r => r.text())
      .then(html => sendResponse({ ok: true, html }))
      .catch(err => sendResponse({ ok: false, error: err.message }))
    return true
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url        = tab.url ?? ''
  const authPageUrl = chrome.runtime.getURL('auth.html')

  if (!url.startsWith(authPageUrl)) return
  if (changeInfo.status !== 'complete') return

  console.log('[SourcedOut] Auth tab detected — auth-callback.js will handle token.')

  // Fallback close in case auth-callback.js doesn't finish (e.g. fetch timeout)
  setTimeout(() => {
    chrome.tabs.get(tabId, t => {
      if (chrome.runtime.lastError) return   // tab already closed — good
      if (t && t.url?.startsWith(authPageUrl)) {
        chrome.tabs.remove(tabId).catch(() => {})
      }
    })
  }, 5000)
})
