chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false
  sendResponse({ linkedin_url: window.location.href.split('?')[0] })
  return false
})
