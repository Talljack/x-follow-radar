// Runs in the page's own world, and only in the background tab the extension
// opens to check for updates (marked with #xfr-scan). It copies the timeline
// data X itself downloads and hands it to the content script. It sends no
// requests of its own.
(() => {
  'use strict';
  if (!location.hash.includes('xfr-scan')) return;

  const TIMELINE = /\/graphql\/[^/]+\/(SearchTimeline|ListLatestTweetsTimeline|UserTweets)\b/;
  const post = (url, body) => {
    if (typeof body === 'string' && body) window.postMessage({ __xfr: 'gql', url, body }, location.origin);
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const u = String(url);
      if (TIMELINE.test(u)) {
        this.addEventListener('load', () => {
          try {
            if (this.status !== 200) return; // an error page (rate limit, say) is not an empty timeline
            const type = this.responseType;
            if (type === '' || type === 'text') post(u, this.responseText);
            else if (type === 'json') post(u, JSON.stringify(this.response));
          } catch {}
        });
      }
    } catch {}
    return open.apply(this, arguments);
  };

  const fetch_ = window.fetch;
  window.fetch = function (input) {
    const p = fetch_.apply(this, arguments);
    try {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (TIMELINE.test(u)) {
        p.then((res) => (res.ok ? res.clone().text().then((body) => post(u, body)) : null)).catch(() => {});
      }
    } catch {}
    return p;
  };
})();
