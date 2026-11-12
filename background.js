// Background worker: owns the watch list, the ledger, and the check schedule.
//
// A check opens one hidden tab per search. Each tab loads a "Latest" search
// for some watched accounts; the page script reads the timeline data and
// reports back. Results are stored here. Every post is announced at most once,
// and stays in "unread" only until the user has seen it.
//
// A stored post carries, on top of what shared.js describes:
//   state  'new'    found after its account was added, not announced yet
//          'shown'  unread, with no (further) announcement due
//          'read'   out of the unread list
//   seen   true once the user actually saw it: in the panel, on a timeline,
//          or by marking it. A post that is `read` but not `seen` may come
//          back into "unread" when its account gets a first look again.
'use strict';

importScripts('shared.js');

const X = self.XFR;

const K = {
  SUBS: 'xfr_subs',
  SETTINGS: 'xfr_settings',
  TWEETS: 'xfr_tweets',
  LEDGER: 'xfr_ledger',
  META: 'xfr_meta',
  SCAN: 'xfr_scan',
  BOOT: 'xfr_boot',
};
const DEFAULTS = {
  intervalMin: 30,
  popup: true,
  retweets: false,
  listUrl: '',
  listSince: 0,
  listPrimed: false,
  plainQuery: false, // X did not take the "no reposts" search condition; search without it
};

const MAX_TWEETS = 600;      // history kept
const MAX_LEDGER = 20000;    // ids that must never be announced again
const BATCH = 10;            // accounts per search
const SOLO = 10;             // first looks at newly added accounts, per round
const FIRST_LOOK = 10;       // posts from before an account was added that go to "unread"
const STEP_LIMIT = 40000;    // a single page has this long
const X_URLS = ['https://x.com/*', 'https://twitter.com/*'];

// Every storage mutation goes through one queue so two calls can't clobber
// each other.
let chain = Promise.resolve();
const locked = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

async function load() {
  const d = await chrome.storage.local.get([K.SUBS, K.SETTINGS, K.TWEETS, K.LEDGER, K.META]);
  return {
    subs: d[K.SUBS] || [],
    settings: Object.assign({}, DEFAULTS, d[K.SETTINGS] || {}),
    tweets: d[K.TWEETS] || {},
    ledger: d[K.LEDGER] || [],
    meta: Object.assign({ lastCheck: 0, lastError: '', lastAdded: 0, checking: false, checkingAt: 0 }, d[K.META] || {}),
  };
}

async function save(st, keys) {
  const out = {};
  for (const k of keys) out[K[k.toUpperCase()]] = st[k];
  await chrome.storage.local.set(out);
}

async function refreshBadge(st) {
  const n = Object.values(st.tweets).filter((t) => t.state !== 'read').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  await chrome.action.setBadgeText({ text: n ? (n > 99 ? '99+' : String(n)) : '' });
}

// ----------------------------------------------------------------- ingestion

const newestFirst = (a, b) => (b.ts || 0) - (a.ts || 0);

// Unread posts are kept ahead of history when space runs out.
function prune(st) {
  const all = Object.values(st.tweets);
  if (all.length > MAX_TWEETS) {
    const unread = all.filter((t) => t.state !== 'read').sort(newestFirst);
    const read = all.filter((t) => t.state === 'read').sort(newestFirst);
    st.tweets = Object.fromEntries(unread.concat(read).slice(0, MAX_TWEETS).map((t) => [t.id, t]));
  }
  if (st.ledger.length > MAX_LEDGER) st.ledger = st.ledger.slice(-MAX_LEDGER);
}

// Adds what came back from one page. `job.kind` is 'search' (only watched
// accounts count) or 'list' (everything on the list counts). `job.prime`
// marks the first look at an account or list.
function ingest(st, items, job) {
  const byHandle = new Map(st.subs.map((s) => [s.handle.toLowerCase(), s]));
  const ledger = new Set(st.ledger);
  const list = job.kind === 'list';
  let added = 0;
  let fresh = 0;
  let unread = 0;

  // On a first look, the newest few posts go to "unread" although they were
  // posted before the account was added. That is what the user added it for.
  const recent = new Set();
  if (job.prime) {
    const owner = list ? '' : String((job.handles || [])[0] || '').toLowerCase();
    items
      .filter((it) => it && it.id && it.handle && !(it.via || []).length && (list || it.handle.toLowerCase() === owner))
      .sort(newestFirst)
      .slice(0, FIRST_LOOK)
      .forEach((it) => recent.add(it.id));
  }

  for (const it of items) {
    if (!it || !it.id || !it.handle) continue;
    if (it.via && it.via.length && !st.settings.retweets) continue;

    let base = 0;
    if (list) {
      base = st.settings.listSince || 0;
    } else {
      const who = [it.handle, ...(it.via || [])].map((h) => String(h).toLowerCase());
      const matched = who.map((h) => byHandle.get(h)).filter(Boolean);
      if (!matched.length) continue;
      // The post is new unless it predates every account involved.
      base = Math.min(...matched.map((s) => s.addedAt || 0));
    }

    const prev = st.tweets[it.id];
    if (prev) {
      const via = [...new Set([...(prev.via || []), ...(it.via || [])])];
      if (via.length !== (prev.via || []).length) prev.via = via;
      for (const f of ['avatar', 'name', 'text']) if (!prev[f] && it[f]) prev[f] = it[f];
      // Filed away without the user ever seeing it (the account was removed
      // and added again, say): it is still news to them.
      if (recent.has(it.id) && prev.state === 'read' && !prev.seen) {
        prev.state = 'shown';
        unread++;
      }
      continue;
    }
    // Seen on a timeline before it was ever fetched: never surface it.
    if (ledger.has(it.id)) continue;

    const old = !!it.ts && it.ts < base;
    const state = !old ? 'new' : recent.has(it.id) ? 'shown' : 'read';
    st.tweets[it.id] = Object.assign({}, it, { state, src: job.kind, gotAt: Date.now() });
    ledger.add(it.id);
    added++;
    if (state === 'new') fresh++;
    if (state !== 'read') unread++;

    const owner = byHandle.get(it.handle.toLowerCase());
    if (owner && (it.name || it.avatar)) {
      if (it.name && owner.name !== it.name) owner.name = it.name;
      if (it.avatar && !owner.avatar) owner.avatar = it.avatar;
    }
  }

  st.ledger = [...ledger];
  prune(st);
  return { added, fresh, unread };
}

// -------------------------------------------------------------------- checks

const getScan = async () => (await chrome.storage.session.get(K.SCAN))[K.SCAN] || null;
const setScan = async (s) => (s ? chrome.storage.session.set({ [K.SCAN]: s }) : chrome.storage.session.remove(K.SCAN));

// Posts by these accounts only: no replies, and no reposts of other people's
// posts unless the user asked for those. `plain` leaves the repost condition
// out; reposts that come back are dropped when the results are stored.
function searchUrl(handles, retweets, plain) {
  const from = handles.map((h) => 'from:' + h).join(' OR ');
  const reposts = retweets ? ' include:nativeretweets' : plain ? '' : ' -filter:nativeretweets';
  const q = `(${from}) -filter:replies${reposts}`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live#xfr-scan`;
}

const scanUrl = (url) => String(url).replace(/#.*$/, '') + '#xfr-scan';

const waitingList = (st) => !!st.settings.listUrl && !st.settings.listPrimed;
const hasWaiting = (st) => st.subs.some((s) => !s.primed) || waitingList(st);

// An account that has not had its first look gets a search of its own, so its
// latest posts are not crowded out by busier accounts. The rest are searched
// together, BATCH at a time. `primeOnly` leaves those out.
function buildQueue(st, primeOnly) {
  const jobs = [];
  const url = (handles) => searchUrl(handles, st.settings.retweets, st.settings.plainQuery);
  const waiting = st.subs.filter((s) => !s.primed).sort((a, b) => (a.primeFails || 0) - (b.primeFails || 0));
  for (const s of waiting.slice(0, SOLO)) {
    jobs.push({ kind: 'search', prime: true, handles: [s.handle], url: url([s.handle]) });
  }
  if (!primeOnly) {
    const known = st.subs.filter((s) => s.primed).map((s) => s.handle);
    for (let i = 0; i < known.length; i += BATCH) {
      const slice = known.slice(i, i + BATCH);
      jobs.push({ kind: 'search', handles: slice, url: url(slice) });
    }
  }
  if (st.settings.listUrl && (!primeOnly || waitingList(st))) {
    jobs.push({ kind: 'list', prime: waitingList(st), handles: [], url: scanUrl(st.settings.listUrl) });
  }
  return jobs;
}

async function startCheck(st, opts) {
  const o = opts || {};
  const queue = buildQueue(st, !!o.primeOnly);
  if (!queue.length) return { started: false, reason: 'empty' };

  const running = await getScan();
  if (running && Date.now() - running.stepAt < STEP_LIMIT + 35000) return { started: false, reason: 'busy' };
  if (!o.force && Date.now() - (st.meta.lastCheck || 0) < st.settings.intervalMin * 60000 - 5000) {
    return { started: false, reason: 'fresh' };
  }

  const scan = {
    queue,
    primeOnly: !!o.primeOnly,
    // A round of first looks that happens to cover the whole list is a check.
    full: !o.primeOnly || queue.length === buildQueue(st, false).length,
    tabId: null,
    windowId: o.windowId || null,
    cur: null,
    stepAt: Date.now(),
    startedAt: Date.now(),
    errors: [],
    added: 0,
    fresh: 0,
    unread: 0,
    pages: 0,
    primed: [],        // accounts that got their first look this round
    primedUnread: 0,   // posts those first looks put into "unread"
    primeFailed: false,
  };
  const pages = queue.length;
  st.meta.checking = true;
  st.meta.checkingAt = Date.now();
  await save(st, ['meta']);
  await setScan(scan);
  chrome.alarms.create('xfr-watchdog', { periodInMinutes: 0.5 });
  await nextStep(st, scan);
  return { started: true, pages };
}

async function nextStep(st, scan) {
  const job = scan.queue.shift();
  if (!job) return finish(st, scan);
  scan.cur = { kind: job.kind, handles: job.handles, prime: !!job.prime, plain: !!job.plain };
  scan.stepAt = Date.now();
  await setScan(scan);

  let tab;
  try {
    tab = await chrome.tabs.create({ url: job.url, active: false, windowId: scan.windowId || undefined });
  } catch {
    // that window is gone; any window will do
    tab = await chrome.tabs.create({ url: job.url, active: false });
  }
  scan.tabId = tab.id;
  scan.windowId = tab.windowId;
  await setScan(scan);
}

// Bookkeeping for a first look, once its page has been read or given up on.
function settleJob(st, scan, job, error) {
  if (!job || !job.prime) return;
  if (job.kind === 'list') {
    if (!error) st.settings.listPrimed = true;
    return;
  }
  const handle = String((job.handles || [])[0] || '').toLowerCase();
  const sub = st.subs.find((s) => s.handle.toLowerCase() === handle);
  if (!sub) return;
  if (!error) {
    sub.primed = true;
    delete sub.primeFails;
    scan.primed.push(sub.handle);
    return;
  }
  if (error === 'login') return;
  // Next time, accounts that have not failed go first. After three tries the
  // account joins the regular searches without a first look.
  sub.primeFails = (sub.primeFails || 0) + 1;
  if (sub.primeFails >= 3) sub.primed = true;
  // Whatever went wrong is likely to go wrong for the next account as well.
  scan.queue = scan.queue.filter((j) => !(j.prime && j.kind === 'search'));
  scan.primeFailed = true;
}

async function finish(st, scan) {
  st.meta.checking = false;
  if (scan.full) st.meta.lastCheck = Date.now();
  st.meta.lastError = scan.errors[0] || '';
  st.meta.lastAdded = scan.added || 0;
  st.meta.lastFresh = scan.fresh || 0;
  st.meta.lastUnread = scan.unread || 0;
  st.meta.lastScanned = scan.pages || 0;
  if (scan.primed && scan.primed.length) {
    st.meta.primed = { at: Date.now(), handles: scan.primed, count: scan.primedUnread || 0 };
  }
  await save(st, ['meta', 'tweets', 'ledger', 'subs', 'settings']);
  await setScan(null);
  chrome.alarms.clear('xfr-watchdog');
  await refreshBadge(st);
  // More accounts were waiting than one round takes: carry on shortly.
  if (scan.primed && scan.primed.length && !scan.primeFailed && hasWaiting(st)) {
    chrome.alarms.create('xfr-soon', { delayInMinutes: 0.5 });
  }
}

async function onScanDone(st, msg, sender) {
  const scan = await getScan();
  const tabId = sender.tab && sender.tab.id;
  if (!scan || !tabId || scan.tabId !== tabId) return { ok: false };

  scan.tabId = null;
  const job = scan.cur || { kind: 'search', handles: [] };
  const items = Array.isArray(msg.tweets) ? msg.tweets : [];

  // An account's first look came back with nothing at all. X may not take the
  // "no reposts" condition (any more), so look once more without it before
  // concluding that the account has no posts.
  const strict = job.prime && job.kind === 'search' && !job.plain && !st.settings.retweets && !st.settings.plainQuery;
  if (strict && (msg.error === 'nodata' || (!msg.error && !items.length))) {
    scan.queue.unshift({ kind: 'search', prime: true, plain: true, handles: job.handles, url: searchUrl(job.handles, false, true) });
    scan.pages++;
    await chrome.tabs.remove(tabId).catch(() => {});
    await nextStep(st, scan);
    return { ok: true };
  }
  if (job.plain) {
    // It was the condition: the same account has posts without it.
    const owner = String((job.handles || [])[0] || '').toLowerCase();
    const own = (it) => it && it.handle && it.handle.toLowerCase() === owner && !(it.via || []).length;
    if (items.some(own)) st.settings.plainQuery = true;
  }

  const res = ingest(st, items, job);
  scan.added += res.added;
  scan.fresh += res.fresh;
  scan.unread += res.unread;
  scan.pages++;
  if (job.prime && job.kind === 'search') scan.primedUnread += res.unread;
  if (msg.error) scan.errors.push(msg.error);
  settleJob(st, scan, job, msg.error || '');

  await save(st, ['tweets', 'ledger', 'subs', 'settings']);
  await refreshBadge(st);
  await chrome.tabs.remove(tabId).catch(() => {});

  // Not signed in: the rest of the pages would fail the same way.
  if (msg.error === 'login') {
    scan.errors = ['login'];
    return finish(st, scan);
  }
  await nextStep(st, scan);
  return { ok: true };
}

// The page for the current step is stuck or gone: note it and move on.
async function abandon(st, scan, error) {
  const tabId = scan.tabId;
  scan.tabId = null;
  scan.errors.push(error);
  settleJob(st, scan, scan.cur, error);
  await save(st, ['subs', 'settings']);
  if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  await nextStep(st, scan);
}

async function watchdog() {
  const scan = await getScan();
  if (!scan) {
    chrome.alarms.clear('xfr-watchdog');
    return;
  }
  if (Date.now() - scan.stepAt < STEP_LIMIT) return;
  await abandon(await load(), scan, 'timeout');
}

// ---------------------------------------------------------------- schedule

async function ensureAlarms(st) {
  const s = st || (await load());
  const period = Math.max(1, Number(s.settings.intervalMin) || 30);
  // Leave a running timer alone. This runs every time the worker wakes up, and
  // recreating the timer would start the wait over each time.
  const cur = await chrome.alarms.get('xfr-tick');
  if (cur && cur.periodInMinutes === period) return;
  await chrome.alarms.create('xfr-tick', { periodInMinutes: period });
}

// Only worth checking while the user actually has X open.
async function tick() {
  const st = await load();
  const scan = await getScan();
  const tabs = (await chrome.tabs.query({ url: X_URLS })).filter((t) => t.id !== (scan && scan.tabId));
  if (!tabs.length) return;
  await startCheck(st, { force: false, windowId: tabs[0].windowId });
}

// First looks for whatever is waiting, without checking the whole list.
async function primeNow(windowId) {
  const st = await load();
  if (!hasWaiting(st)) return;
  const r = await startCheck(st, { force: true, primeOnly: true, windowId });
  if (!r.started && r.reason === 'busy') chrome.alarms.create('xfr-soon', { delayInMinutes: 0.5 });
}

// A moment after an account is added, so that several added in a row are
// handled together. The alarm covers the case of the worker being stopped
// before the timer fires.
let soonTimer = 0;
function primeSoon(windowId) {
  chrome.alarms.create('xfr-soon', { delayInMinutes: 0.5 });
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    chrome.alarms.clear('xfr-soon');
    locked(() => primeNow(windowId));
  }, 2500);
}

// ------------------------------------------------------------------ actions

async function addSub(st, handle, extra, windowId) {
  const h = X.validHandle(handle);
  if (!h) return { ok: false, reason: 'handle' };
  const found = st.subs.find((s) => s.handle.toLowerCase() === h.toLowerCase());
  if (found) {
    if (extra && extra.name && !found.name) found.name = extra.name;
    if (extra && extra.avatar && !found.avatar) found.avatar = extra.avatar;
    await save(st, ['subs']);
    return { ok: true, added: false, count: st.subs.length };
  }
  st.subs.push({
    handle: h,
    name: (extra && extra.name) || h,
    avatar: (extra && extra.avatar) || '',
    addedAt: Date.now(),
    primed: false, // its latest posts have not been fetched yet
  });
  await save(st, ['subs']);
  primeSoon(windowId);
  return { ok: true, added: true, count: st.subs.length };
}

// Its unread posts are filed away, but not as "seen": if the account is added
// again, the latest ones come back.
async function removeSub(st, handle) {
  const h = X.validHandle(handle).toLowerCase();
  st.subs = st.subs.filter((s) => s.handle.toLowerCase() !== h);
  for (const t of Object.values(st.tweets)) {
    if (t.state !== 'read' && (t.handle.toLowerCase() === h || (t.via || []).some((v) => v.toLowerCase() === h))) {
      t.state = 'read';
    }
  }
  await save(st, ['subs', 'tweets']);
  await refreshBadge(st);
  return { ok: true, count: st.subs.length };
}

async function applySettings(st, patch) {
  const next = Object.assign({}, st.settings, patch || {});
  let newList = false;
  if (patch && typeof patch.listUrl === 'string') {
    const url = patch.listUrl.trim();
    next.listUrl = url;
    if (url !== (st.settings.listUrl || '')) {
      next.listSince = url ? Date.now() : 0;
      next.listPrimed = false;
      newList = !!url;
    }
  }
  next.intervalMin = Math.min(720, Math.max(5, Number(next.intervalMin) || 30));
  st.settings = next;
  await save(st, ['settings']);
  await ensureAlarms(st);
  if (newList) primeSoon();
  return { ok: true, settings: next };
}

// 'shown': announced. 'read': the user saw it or dismissed it.
function setState(st, ids, state) {
  let n = 0;
  for (const id of ids || []) {
    const t = st.tweets[id];
    if (!t) continue;
    if (state === 'read') {
      if (t.state !== 'read') n++;
      t.state = 'read';
      t.seen = true;
    } else if (t.state === 'new') {
      t.state = state;
      n++;
    }
  }
  return n;
}

// Posts the user scrolled past on a timeline. Ids that are not stored are
// remembered too, so they are skipped when a check finds them later.
function markSeen(st, ids) {
  const ledger = new Set(st.ledger);
  let n = 0;
  for (const id of ids || []) {
    const t = st.tweets[id];
    if (t) {
      if (t.state !== 'read') n++;
      t.state = 'read';
      t.seen = true;
    }
    ledger.add(id);
  }
  st.ledger = [...ledger];
  prune(st);
  return n;
}

// ------------------------------------------------------------------- wiring

const handlers = {
  async addSub(msg, sender) {
    return locked(async () => addSub(await load(), msg.handle, msg, (sender.tab && sender.tab.windowId) || null));
  },
  async removeSub(msg) {
    return locked(async () => removeSub(await load(), msg.handle));
  },
  async setSettings(msg) {
    return locked(async () => applySettings(await load(), msg.patch));
  },
  async check(msg, sender) {
    return locked(async () => {
      const st = await load();
      const windowId = (sender.tab && sender.tab.windowId) || null;
      return startCheck(st, { force: !!msg.force, windowId });
    });
  },
  async markShown(msg) {
    return locked(async () => {
      const st = await load();
      const n = setState(st, msg.ids, 'shown');
      await save(st, ['tweets']);
      return { ok: true, n };
    });
  },
  async markRead(msg) {
    return locked(async () => {
      const st = await load();
      const n = setState(st, msg.ids, 'read');
      await save(st, ['tweets']);
      await refreshBadge(st);
      return { ok: true, n };
    });
  },
  async markAllRead() {
    return locked(async () => {
      const st = await load();
      const n = setState(st, Object.keys(st.tweets), 'read');
      await save(st, ['tweets']);
      await refreshBadge(st);
      return { ok: true, n };
    });
  },
  async seen(msg) {
    return locked(async () => {
      const st = await load();
      const n = markSeen(st, msg.ids);
      await save(st, ['tweets', 'ledger']);
      if (n) await refreshBadge(st);
      return { ok: true, n };
    });
  },
  async clearHistory() {
    return locked(async () => {
      const st = await load();
      st.tweets = {};
      await save(st, ['tweets']);
      await refreshBadge(st);
      return { ok: true };
    });
  },
  async scanHello(msg, sender) {
    // Queued behind the step that opened the tab, so its id is on record.
    return locked(async () => {
      const scan = await getScan();
      const id = sender.tab && sender.tab.id;
      if (!scan || !id || scan.tabId !== id) return { scan: false };
      const st = await load();
      // A first look takes the first page as it is; a regular check reads on
      // until it reaches posts from before the last check.
      return { scan: true, since: st.meta.lastCheck || Date.now(), deep: !(scan.cur && scan.cur.prime) };
    });
  },
  async scanDone(msg, sender) {
    return locked(async () => onScanDone(await load(), msg, sender));
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return;
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then((r) => reply(r || { ok: true }))
    .catch((e) => reply({ ok: false, error: String(e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xfr-watchdog') return locked(() => watchdog());
  if (a.name === 'xfr-tick') return locked(() => tick());
  if (a.name === 'xfr-soon') {
    chrome.alarms.clear('xfr-soon');
    return locked(() => primeNow());
  }
});

chrome.tabs.onRemoved.addListener((tabId) =>
  locked(async () => {
    const scan = await getScan();
    if (!scan || scan.tabId !== tabId) return;
    scan.tabId = null;
    await abandon(await load(), scan, 'closed');
  })
);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'xfr-add') return;
  const handle = X.handleFrom(info.linkUrl || info.pageUrl || '');
  const say = (text) => tab && tab.id && deliver(tab.id, { type: 'toast', text });
  if (!handle) {
    say('这里认不出博主。请在博主的名字、头像或主页上点右键');
    return;
  }
  locked(async () => {
    const st = await load();
    const res = await addSub(st, handle, {}, (tab && tab.windowId) || null);
    say(res.added ? `已订阅 @${handle}，正在取回最近的推文…` : `@${handle} 已在名单里`);
  });
});

// ------------------------------------------------------- pages already open
// A page that was open before the extension was installed, updated, reloaded
// or switched back on has no working page script: either none at all, or one
// that is cut off from the extension. The page script is written so that a
// second copy in the same page does nothing, which makes it safe to hand one
// to any page at any time.

const isScanTab = (t) => (t.url || '').includes('#xfr-scan');

const inject = (tabId) =>
  chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] }).catch(() => {});

// True when the page script took the message.
const tell = (tabId, msg) =>
  chrome.tabs.sendMessage(tabId, msg).then(
    (r) => !!(r && r.ok),
    () => false
  );

// Hands a message to the page script in a tab, giving the page a script first
// if it has none. `retry` is what to send once that script is up.
async function deliver(tabId, msg, retry) {
  if (await tell(tabId, msg)) return true;
  await inject(tabId);
  for (let i = 0; i < 8; i++) {
    if (await tell(tabId, retry || msg)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Runs once each time the extension starts afresh. Session storage is emptied
// on exactly those occasions, so a missing mark means "first run".
async function freshStart(st) {
  const mark = await chrome.storage.session.get(K.BOOT);
  if (mark[K.BOOT]) return;
  await chrome.storage.session.set({ [K.BOOT]: Date.now() });

  // A check that was cut short leaves its flag and its tab behind.
  if (st.meta.checking) {
    st.meta.checking = false;
    await save(st, ['meta']);
  }
  const tabs = await chrome.tabs.query({ url: X_URLS });
  let open = null;
  for (const t of tabs) {
    if (!t.id) continue;
    if (isScanTab(t)) {
      chrome.tabs.remove(t.id).catch(() => {});
    } else if (!t.discarded) {
      inject(t.id);
      open = open || t;
    }
  }
  // Accounts from before first looks existed, or ones that never got theirs.
  if (open && hasWaiting(st)) primeSoon(open.windowId);
}

chrome.action.onClicked.addListener(async (tab) => {
  const isX = tab && tab.id && tab.url && /^https:\/\/(x|twitter)\.com\//.test(tab.url);
  if (isX) {
    deliver(tab.id, { type: 'toggle' }, { type: 'open' });
    return;
  }
  const existing = (await chrome.tabs.query({ url: X_URLS })).find((t) => t.id && !isScanTab(t));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    deliver(existing.id, { type: 'open' });
  } else {
    await chrome.tabs.create({ url: 'https://x.com/home' });
  }
});

(function boot() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'xfr-add',
      title: '添加到 X 关注雷达',
      contexts: ['link', 'page'],
      documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    });
  });
  locked(async () => {
    const st = await load();
    await ensureAlarms(st);
    await refreshBadge(st);
    await freshStart(st);
  });
})();
