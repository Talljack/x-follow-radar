import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const shared = fs.readFileSync(new URL('../shared.js', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const event = () => ({ addListener() {} });
function background() {
  const local = {}, session = {}, opened = [], removed = [];
  const area = (data) => ({
    async get(keys) { return structuredClone(Object.fromEntries((keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]))); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, onClicked: event() },
    alarms: { create() {}, async clear() {}, onAlarm: event() },
    tabs: { async create(opts) { const tab = { ...opts, id: opened.length + 1, windowId: 1 }; opened.push(tab); return tab; }, async remove(id) { removed.push(id); }, onRemoved: event() },
    runtime: { onMessage: event() }, contextMenus: { onClicked: event() },
  };
  const c = vm.createContext({ chrome, console, setTimeout, clearTimeout, URL, structuredClone });
  c.self = c;
  c.importScripts = () => vm.runInContext(shared, c);
  vm.runInContext(source.slice(0, source.lastIndexOf('(function boot()')), c);
  const run = (js) => vm.runInContext(js, c);
  const seed = async () => {
    await chrome.storage.local.set({ xfr_subs: [{ handle: 'OpenAI', addedAt: 1, primed: true }], xfr_meta: { lastCheck: 123, checking: false }, xfr_tweets: { cached: { id: 'cached', handle: 'OpenAI', state: 'read', seen: true } } });
    await run('(async()=>startCheck(await load(), {force:true}))()');
  };
  const done = (error = '', tweets = []) => { c.message = { error, tweets }; c.sender = { tab: { id: session.xfr_scan.tabId } }; return run('(async()=>onScanDone(await load(), message, sender))()'); };
  return { local, session, opened, removed, run, seed, done };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test('failed regular search retries once and recovers newer posts', async () => {
  const b = background(); await b.seed();
  await b.done('nodata');
  assert.equal(b.opened.length, 2, 'regular checks must retry transient loading failure');
  assert.equal(b.opened[1].url, b.opened[0].url);
  assert.equal(b.local.xfr_meta.lastCheck, 123);
  await b.done('', [{ id: 'latest', handle: 'OpenAI', ts: Date.now(), text: 'new post' }]);
  assert.ok(b.local.xfr_meta.lastCheck > 123);
  assert.equal(b.local.xfr_meta.lastError, '');
  assert.equal(b.local.xfr_tweets.latest.state, 'new');
  assert.equal(b.local.xfr_tweets.cached.seen, true);
});
test('repeated failures stop without advancing successful sync or deleting cache', async () => {
  const b = background(); await b.seed(); await b.done('nodata');
  if (b.session.xfr_scan) await b.done('nodata');
  assert.equal(b.opened.length, 2);
  assert.equal(b.session.xfr_scan, undefined);
  assert.equal(b.local.xfr_meta.lastCheck, 123, 'failed checks cannot advance the success watermark');
  assert.equal(b.local.xfr_meta.lastError, 'nodata');
  assert.ok(b.local.xfr_meta.lastAttempt > 123);
  assert.equal(b.local.xfr_tweets.cached.state, 'read');
});
test('watchdog retries timed-out page once', async () => {
  const b = background(); await b.seed();
  await b.run('(async()=>abandon(await load(), await getScan(), "timeout"))()');
  assert.equal(b.opened.length, 2);
  await b.run('(async()=>abandon(await load(), await getScan(), "timeout"))()');
  assert.equal(b.opened.length, 2);
  assert.equal(b.local.xfr_meta.lastCheck, 123);
});
test('valid empty timeline and login wall are not retried', async () => {
  for (const error of ['', 'login']) {
    const b = background(); await b.seed(); await b.done(error);
    assert.equal(b.opened.length, 1);
    assert.equal(b.local.xfr_meta.lastError, error);
    assert.equal(b.local.xfr_meta.checking, false);
  }
});
test('UI never describes a failed check as no new posts', () => {
  const start = content.indexOf('  function renderStatus()');
  const end = content.indexOf('\n  // Top right', start);
  const c = vm.createContext({ S: { meta: { lastCheck: 123, lastError: 'nodata' } }, checking: false, status: {}, ago: () => '昨天', ERRORS: { nodata: '加载失败' } });
  vm.runInContext(content.slice(start, end) + '\nrenderStatus()', c);
  assert.ok(!c.status.textContent.includes('没有新推文'), c.status.textContent);
  assert.ok(c.status.textContent.includes('缓存'), c.status.textContent);
});
test('an API error response is not a successful empty timeline', () => {
  const c = vm.createContext({}); vm.runInContext(shared, c);
  assert.equal(c.XFR.hasTimeline({ errors: [{ message: 'Temporary failure' }] }), false);
  assert.equal(c.XFR.hasTimeline({ data: {} }), false);
  assert.equal(c.XFR.hasTimeline({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } }), true);
});
test('each panel opening forces a fresh check, even inside the interval', () => {
  const calls = [];
  const c = vm.createContext({ gone: () => false, open: false, panel: { style: {} }, tab: '', hideToast() {}, theme() {}, place() {}, render() {}, drawn: '', body: { scrollTop: 0 }, S: { subs: [{handle:'OpenAI'}], settings: {}, tweets: {} }, send() {}, requestCheck: (...args) => calls.push(args), stopWatching() {}, flushRead() {}, kept: new Set(), Object });
  const start = content.indexOf('  function setOpen(v)');
  const end = content.indexOf('\n  // ------------------------------------------------------- read', start);
  vm.runInContext(content.slice(start, end) + '\nsetOpen(true);setOpen(true);setOpen(false);setOpen(true)', c);
  assert.equal(calls.length, 2, 'exactly one check per closed-to-open transition');
  assert.equal(calls[0][0], true, 'opening bypasses scheduled interval');
});
test('opening catches up recent unseen posts older than subscription without resurrecting seen posts', async () => {
  const b = background(); await b.seed(); await b.done();
  b.local.xfr_subs[0].addedAt = Date.now();
  b.local.xfr_tweets.unseen = { id: 'unseen', handle: 'OpenAI', state: 'read', seen: false };
  await b.run('(async()=>startCheck(await load(), {force:true, catchUp:true}))()');
  await b.done('', [{ id: 'old-new', handle: 'OpenAI', ts: Date.now()-86400000 }, { id: 'unseen', handle: 'OpenAI', ts: Date.now()-2*86400000 }, { id: 'cached', handle: 'OpenAI', ts: Date.now()-3*86400000 }]);
  assert.equal(b.local.xfr_tweets['old-new'].state, 'shown');
  assert.equal(b.local.xfr_tweets.unseen.state, 'shown');
  assert.equal(b.local.xfr_tweets.cached.state, 'read');
});
test('opening checks every author individually, including more than ten new authors', async () => {
  const b = background();
  b.local.xfr_subs = Array.from({ length: 23 }, (_, i) => ({ handle: 'author'+i, primed: i >= 12, addedAt: 1 }));
  await b.run('(async()=>startCheck(await load(), {force:true, catchUp:true}))()');
  const scan = b.session.xfr_scan;
  const jobs = [scan.cur, ...scan.queue];
  assert.equal(jobs.length, 23);
  assert.ok(jobs.every(j => j.handles.length === 1 && j.catchUp));
});
test('opening during a scheduled check upgrades the remaining work to catch-up', async () => {
  const b = background(); await b.seed();
  b.local.xfr_subs.push({ handle: 'second', primed: true, addedAt: 1 });
  await b.run('(async()=>startCheck(await load(), {force:true, catchUp:true}))()');
  assert.equal(b.session.xfr_scan.cur.catchUp, true);
  assert.deepEqual(b.session.xfr_scan.queue.map(j => j.handles[0]), ['second']);
});
test('a confirmed empty timeline finishes without waiting for nonexistent next pages', async () => {
  let clock = 1000, scrolls = 0, result;
  const c = vm.createContext({ Date: class extends Date { static now() { return clock; } }, RAW: [JSON.stringify({data:{timeline:{instructions:[]}}})],
    send: async msg => msg.type === 'scanHello' ? {scan:true, since:1, deep:true} : (result = msg),
    sleep: async ms => {clock += ms;}, loginWall: () => false, mergeItem() {}, window: {scrollTo() {scrolls++;}},
    document: {documentElement:{scrollHeight:0},querySelector(){return null},querySelectorAll(){return []}},TWEET:'article' });
  vm.runInContext(shared, c); c.X = c.XFR;
  const start = content.indexOf('  async function readTimeline()');
  const end = content.indexOf('\n  // ========================================================================\n  // Panel', start);
  await vm.runInContext(content.slice(start,end)+'\nreadTimeline()',c);
  assert.equal(scrolls, 0);
  assert.equal(result.error, '');
});
test('a subscription added during a check is queued without waiting for the next alarm', async () => {
  const b = background(); await b.seed();
  b.local.xfr_subs.push({handle:'added',primed:false,addedAt:1});
  await b.run('(async()=>startCheck(await load(), {force:true, primeOnly:true}))()');
  assert.ok(b.session.xfr_scan.queue.some(j=>j.handles[0]==='added'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, e.message); }
}
process.exitCode = failed ? 1 : 0;
