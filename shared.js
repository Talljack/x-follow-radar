// Shared by the background worker and the content script: handle parsing and
// turning X's timeline data (or a rendered post) into one plain item shape:
//   { id, url, handle, name, avatar, text, ts, media[{type,url}], quote, conv, via[] }
// For a repost, the item is the original post, `via` lists who reposted it and
// `ts` is when it was reposted.
(() => {
  'use strict';

  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose',
    'hashtag', 'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'jobs', 'intent',
    'share', 'account', 'download', 'help', 'communities', 'premium', 'grok', 'lists',
    'bookmarks', 'topics', 'verified', 'who_to_follow',
  ]);

  function validHandle(h) {
    h = String(h || '').trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(h) && !RESERVED.has(h.toLowerCase()) ? h : '';
  }

  // "@name", "name", or any x.com link that starts with the account's handle.
  function handleFrom(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s) || /^(www\.|mobile\.)?(x|twitter)\.com\//i.test(s)) {
      try {
        const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
        if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return '';
        return validHandle(u.pathname.split('/')[1]);
      } catch {
        return '';
      }
    }
    if (s.startsWith('/')) return validHandle(s.split('/')[1]);
    return validHandle(s);
  }

  // ------------------------------------------------------- X timeline data

  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function unwrap(r) {
    if (!r || typeof r !== 'object') return null;
    if (!r.legacy && r.tweet) r = r.tweet;
    return r.legacy && r.rest_id ? r : null;
  }

  function userOf(r) {
    const u = (r.core && r.core.user_results && r.core.user_results.result) || {};
    const l = u.legacy || {};
    const c = u.core || {};
    return {
      handle: c.screen_name || l.screen_name || '',
      name: c.name || l.name || '',
      avatar: (u.avatar && u.avatar.image_url) || l.profile_image_url_https || '',
    };
  }

  function textOfTweet(r) {
    const l = r.legacy;
    const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
    let text = (note && note.text) || l.full_text || '';
    const urls = (note && note.entity_set && note.entity_set.urls) || (l.entities && l.entities.urls) || [];
    for (const u of urls) if (u.url) text = text.split(u.url).join(u.expanded_url || u.display_url || u.url);
    const media = (l.extended_entities && l.extended_entities.media) || (l.entities && l.entities.media) || [];
    for (const m of media) if (m.url) text = text.split(m.url).join('');
    return decode(text).trim();
  }

  function plain(r) {
    const l = r.legacy;
    const user = userOf(r);
    const media = [];
    for (const m of (l.extended_entities && l.extended_entities.media) || []) {
      if (m.media_url_https && media.length < 4) media.push({ type: m.type || 'photo', url: m.media_url_https });
    }
    const q = unwrap(r.quoted_status_result && r.quoted_status_result.result);
    const qu = q ? userOf(q) : null;
    return {
      id: r.rest_id,
      url: `https://x.com/${user.handle}/status/${r.rest_id}`,
      handle: user.handle,
      name: user.name || user.handle,
      avatar: user.avatar,
      text: textOfTweet(r),
      ts: Date.parse(l.created_at) || 0,
      media,
      quote: q ? { handle: qu.handle, name: qu.name || qu.handle, text: textOfTweet(q) } : null,
      conv: l.conversation_id_str || r.rest_id,
      via: [],
    };
  }

  function toItem(r) {
    const original = unwrap(r.legacy.retweeted_status_result && r.legacy.retweeted_status_result.result);
    if (!original) return plain(r);
    const item = plain(original);
    const reposter = userOf(r).handle;
    if (reposter) item.via = [reposter];
    item.ts = Date.parse(r.legacy.created_at) || item.ts;
    return item;
  }

  // Posts sit under a `tweet_results` key wherever they are in the response;
  // ads carry `promotedMetadata` next to it.
  function fromGraphQL(json) {
    const out = [];
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      if (node.tweet_results && typeof node.tweet_results === 'object') {
        if (node.promotedMetadata) return;
        const r = unwrap(node.tweet_results.result);
        if (r) {
          try {
            const item = toItem(r);
            if (item.id && item.handle) out.push(item);
          } catch {}
        }
        return;
      }
      for (const k in node) walk(node[k], depth + 1);
    })(json, 0);
    return out;
  }

  // Empty results are success only when X actually returned a timeline.
  // HTTP 200 can also carry API errors or an unfamiliar response shape.
  function hasTimeline(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return false;
    if (Array.isArray(node.instructions)) return true;
    return Object.values(node).some((value) => hasTimeline(value, depth + 1));
  }

  // ------------------------------------------------------- a rendered post
  // Selectors follow yetone/rewind-for-x (MIT).

  const TWEET = 'article[data-testid="tweet"]';

  function textOfEl(el) {
    let out = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.tagName === 'IMG') out += c.getAttribute('alt') || '';
          else if (c.tagName === 'BR') out += '\n';
          else walk(c);
        }
      }
    })(el);
    return out.trim();
  }

  function inQuote(el, article) {
    const q = el.closest('div[role="link"]');
    return !!q && article.contains(q);
  }

  // The post's own id and author, or null for ads (they have no time link).
  function idOfArticle(article) {
    const time = [...article.querySelectorAll('a[href*="/status/"] time')].find((e) => !inQuote(e, article));
    if (!time) return null;
    const m = time.closest('a').getAttribute('href').match(/^\/([^/?#]+)\/status\/(\d+)/);
    return m ? { handle: m[1], id: m[2], time } : null;
  }

  function fromArticle(article) {
    const head = idOfArticle(article);
    if (!head) return null;
    const own = (sel) => [...article.querySelectorAll(sel)].find((e) => !inQuote(e, article));
    const quoted = (sel) => [...article.querySelectorAll(sel)].find((e) => inQuote(e, article));
    const nameOf = (block) => textOfEl(block.firstElementChild || block).split('\n')[0].trim();

    const nameBlock = own('[data-testid="User-Name"]');
    const text = own('[data-testid="tweetText"]');
    const quoteText = quoted('[data-testid="tweetText"]');
    const quoteName = quoted('[data-testid="User-Name"]');
    const avatar = own('[data-testid="Tweet-User-Avatar"] img');
    const context = article.querySelector('[data-testid="socialContext"]');
    const reposter = context && context.closest('a[href^="/"]');

    const media = [];
    for (const el of article.querySelectorAll('[data-testid="tweetPhoto"] img, [data-testid="videoPlayer"] video[poster]')) {
      if (inQuote(el, article)) continue;
      const video = el.tagName === 'VIDEO';
      const url = video ? el.getAttribute('poster') : el.currentSrc || el.src;
      if (url && !url.startsWith('blob:') && media.length < 4) media.push({ type: video ? 'video' : 'photo', url });
    }

    return {
      id: head.id,
      url: `https://x.com/${head.handle}/status/${head.id}`,
      handle: head.handle,
      name: (nameBlock && nameOf(nameBlock)) || head.handle,
      avatar: (avatar && avatar.src) || '',
      text: text ? textOfEl(text) : '',
      ts: Date.parse(head.time.getAttribute('datetime') || '') || 0,
      media,
      quote: quoteText ? { handle: '', name: quoteName ? nameOf(quoteName) : '', text: textOfEl(quoteText) } : null,
      conv: head.id,
      via: reposter ? [validHandle((reposter.getAttribute('href') || '').split('/')[1])].filter(Boolean) : [],
    };
  }

  globalThis.XFR = { TWEET, validHandle, handleFrom, fromGraphQL, hasTimeline, fromArticle, idOfArticle };
})();
