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
    alarms: { async get() {return null;}, create() {}, async clear() {}, onAlarm: event() },
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
  assert.equal(new Set(jobs.map(j=>j.handles[0])).size,23);
  assert.ok(jobs.every(j=>j.range && j.url.includes("since%3A")));
  assert.ok(jobs.every(j => j.handles.length === 1 && j.catchUp));
});
test('opening during a scheduled check upgrades the remaining work to catch-up', async () => {
  const b = background(); await b.seed();
  b.local.xfr_subs.push({ handle: 'second', primed: true, addedAt: 1 });
  await b.run('(async()=>startCheck(await load(), {force:true, catchUp:true}))()');
  assert.equal(b.session.xfr_scan.cur.catchUp, true);
  assert.ok(b.session.xfr_scan.queue.some(j=>j.handles[0]==='second'));
  assert.ok(b.session.xfr_scan.queue.every(j=>j.range));
});
test('a confirmed empty timeline finishes without waiting for nonexistent next pages', async () => {
  let clock = 1000, scrolls = 0, result;
  const c = vm.createContext({ Date: class extends Date { static now() { return clock; } }, RAW: [JSON.stringify({data:{timeline:{instructions:[]}}})], HTTP_ERROR:null,
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

test('partial pagination keeps posts without moving the previous successful boundary', async () => {
  const b = background(); await b.seed();
  await b.done('incomplete', [{id:'partial',handle:'OpenAI',ts:Date.now(),text:'partial post'}]);
  assert.equal(b.local.xfr_meta.lastCheck,123);
  assert.equal(b.local.xfr_meta.lastError,'incomplete');
  assert.ok(b.local.xfr_tweets.partial);
  assert.equal(b.local.xfr_tweets.cached.seen,true);
});
test('unread backlog is not silently discarded at the 600-post history limit', async () => {
  const b = background(); await b.seed();
  await b.done('',Array.from({length:650},(_,i)=>({id:'backlog'+i,handle:'OpenAI',ts:Date.now()+i})));
  assert.equal(Object.values(b.local.xfr_tweets).filter(t=>t.state!=='read').length,650);
});

test('three-day window excludes older posts and recovers more than ten recent posts', async () => {
 const b=background(); await b.seed();
 await b.run("(async()=>{const s=await load();s.subs[0].addedAt=Date.now();await save(s,['subs']);const scan=await getScan();scan.cur.catchUp=true;await setScan(scan)})()");
 await b.done('',Array.from({length:16},(_,i)=>({id:'window'+i,handle:'OpenAI',ts:Date.now()-(i===15?4*86400000:i*3600000)})));
 assert.equal(Object.values(b.local.xfr_tweets).filter(t=>t.id.startsWith('window')&&t.state!=='read').length,15);
 assert.equal(b.local.xfr_tweets.window15,undefined);
});

test('changing the time window is validated, saved and widens the catch-up boundary', async()=>{
 const b=background();await b.seed();
 await b.run('(async()=>applySettings(await load(),{windowHours:24}))()');
 assert.equal(b.local.xfr_settings.windowHours,24);
 await b.run('(async()=>applySettings(await load(),{windowHours:72}))()');
 assert.equal(b.local.xfr_meta.lastCheck,0);
 await b.run('(async()=>applySettings(await load(),{windowHours:999}))()');
 assert.equal(b.local.xfr_settings.windowHours,72);
});

test('long catch-up refreshes the UI heartbeat at each page without advancing success',async()=>{
 const b=background();await b.seed();
 b.local.xfr_meta.checkingAt=Date.now()-5*60000;
 await b.run('(async()=>{const st=await load(),scan=await getScan();scan.queue.push({...scan.cur});await nextStep(st,scan)})()');
 assert.ok(Date.now()-b.local.xfr_meta.checkingAt<1000,'active page must refresh checkingAt');
 assert.equal(b.local.xfr_meta.checking,true);
 assert.equal(b.local.xfr_meta.lastCheck,123);
});

test('mark all read preserves hidden older posts and concurrently arriving posts', async () => {
 const b=background(), now=Date.now();
 b.local.xfr_settings={windowHours:24};
 b.local.xfr_tweets={visible:{id:'visible',ts:now-1000,state:'shown'},older:{id:'older',ts:now-36*3600000,state:'shown'},arrived:{id:'arrived',ts:now,state:'new'}};
 await b.run("handlers.markAllRead({ids:['visible']})");
 assert.equal(b.local.xfr_tweets.visible.state,'read');
 assert.equal(b.local.xfr_tweets.older.state,'shown','hidden outside selected window must remain unread');
 assert.equal(b.local.xfr_tweets.arrived.state,'new','posts absent from the clicked snapshot must remain unread');
 await b.run('handlers.markAllRead()');
 assert.equal(b.local.xfr_tweets.older.state,'shown','legacy caller must also respect selected window');
});

test('failed first checks never promote an author into the global successful watermark', async () => {
 const b=background();await b.seed();b.local.xfr_meta.lastCheck=Date.now()-3600000;
 b.local.xfr_subs.push({handle:'newAuthor',primed:false,addedAt:Date.now()});
 await b.run("(async()=>{const st=await load();for(let i=0;i<3;i++)settleJob(st,{queue:[],primed:[]},{kind:'search',prime:true,handles:['newAuthor']},'closed');await save(st,['subs']);})()");
 assert.equal(b.local.xfr_subs[1].primed,false);
 const jobs=await b.run('(async()=>buildQueue(await load(),false,true))()');
 assert.ok(jobs.filter(j=>j.handles[0]==='newAuthor').some(j=>j.since<Date.now()-70*3600000));
});
test('read decisions are dispatched immediately before navigation can discard timers', () => {
 const sent=[]; const c=vm.createContext({seenQueue:new Set(),clearTimeout(){},setTimeout(){return 1},seenTimer:0,send:msg=>{sent.push(msg);return Promise.resolve({ok:true})}});
 const a=content.indexOf('  function queueSeen('),z=content.indexOf('  let scanQueued',a);
 vm.runInContext(content.slice(a,z)+";queueSeen('read-on-timeline')",c);
 assert.equal(sent[0]?.type,'seen','must send without waiting three seconds');
 const m=content.slice(content.indexOf('  function markReadHere'),content.indexOf('  const cardWatch'));
 assert.ok(!m.includes('setTimeout(flushRead'),'manual/panel read must flush immediately');
});

test('widening a running scan requeues the same day when its required boundary moves earlier', async()=>{
 const b=background();await b.seed();
 await b.run("(async()=>{const st=await load();st.settings.windowHours=24;st.meta.lastCheck=0;const jobs=buildQueue(st,false,true);const scan=await getScan();scan.cur=jobs.find(j=>j.since===Math.min(...jobs.map(x=>x.since)));scan.queue=[];await save(st,['settings','meta']);await setScan(scan);})()");
 const url=b.session.xfr_scan.cur.url, since=b.session.xfr_scan.cur.since;
 await b.run("(async()=>{const st=await load();await applySettings(st,{windowHours:72});await startCheck(await load(),{force:true,catchUp:true})})()");
 assert.ok(b.session.xfr_scan.queue.some(j=>j.url===url&&j.since<since),'same URL must not discard newly requested older coverage');
});
test('unseen archived posts survive history pruning and shared-source unsubscribe',async()=>{
 const b=background();await b.seed();
 await b.run("(async()=>{const st=await load();st.tweets=Object.fromEntries(Array.from({length:650},(_,i)=>[String(i),{id:String(i),ts:Date.now()-i,state:'read',seen:false}]));prune(st);await save(st,['tweets']);})()");
 assert.equal(Object.keys(b.local.xfr_tweets).length,650);
 b.local.xfr_subs=[{handle:'author'},{handle:'reposter'}];b.local.xfr_settings={retweets:true};
 b.local.xfr_tweets={shared:{id:'shared',handle:'author',via:['reposter'],state:'shown',ts:Date.now()}};
 await b.run("(async()=>removeSub(await load(),'reposter'))()");
 assert.equal(b.local.xfr_tweets.shared.state,'shown','still covered by subscribed author');
});

test('scope change queues full coverage atomically before the current job can finish',async()=>{
 const b=background();await b.seed();
 b.local.xfr_settings={windowHours:24};b.local.xfr_meta.lastCheck=Date.now()-1000;
 await b.run("handlers.setSettings({patch:{windowHours:72}},{tab:{windowId:1}})");
 assert.ok(b.session.xfr_scan.queue.some(j=>j.since<Date.now()-70*3600000),'settings message itself must queue the expanded range');
 await b.done();
 assert.ok(b.session.xfr_scan,'old page completion must continue widened work, not finish');
 assert.equal(b.local.xfr_meta.lastCheck,0);
});
test('readding a reposter recovers unseen archived reposts but keeps seen ones hidden',async()=>{
 const b=background();await b.seed();
 b.local.xfr_subs=[{handle:'reposter',addedAt:Date.now()}];b.local.xfr_settings={retweets:true};
 b.local.xfr_tweets=Object.fromEntries(Array.from({length:650},(_,i)=>[String(i),{id:String(i),handle:'original',via:['reposter'],ts:Date.now()-i,state:'shown',seen:i===0}]));
 await b.run("(async()=>removeSub(await load(),'reposter'))()");
 b.local.xfr_subs=[{handle:'reposter',addedAt:Date.now()}];
 b.local.xfr_ledger=Object.keys(b.local.xfr_tweets);
 await b.run("(async()=>{const st=await load(),items=Object.values(st.tweets);prune(st);ingest(st,items,{kind:'search',prime:true,handles:['reposter']});await save(st,['tweets'])})()");
 assert.ok(!b.local.xfr_tweets['0'] || b.local.xfr_tweets['0'].state==='read');
 assert.equal(Object.values(b.local.xfr_tweets).filter(t=>t.state==='shown').length,649);
});

test('stalled native cursor continues below the oldest post ID before declaring success',async()=>{
 const b=background();await b.seed();
 await b.done('incomplete',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 assert.ok(b.session.xfr_scan,'partial page must keep the round active');
 assert.equal(b.session.xfr_scan.cur.maxId,'199');
 assert.match(new URL(b.opened.at(-1).url).searchParams.get('q'),/max_id:199/);
 assert.equal(b.local.xfr_meta.lastCheck,123);
 await b.done('incomplete',[{id:'150',handle:'OpenAI',ts:Date.now()-1000}]);
 assert.equal(b.session.xfr_scan.cur.maxId,'149');
 await b.done('',[]);
 assert.equal(b.session.xfr_scan,undefined);
 assert.equal(b.local.xfr_meta.lastError,'');
 assert.ok(b.local.xfr_meta.lastCheck>123);
 assert.ok(b.local.xfr_tweets['150']&&b.local.xfr_tweets['200']);
});
test('non-progressing ID continuation is a failure, not a completed range',async()=>{
 const b=background();await b.seed();await b.done('incomplete',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 await b.done('incomplete',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 assert.equal(b.session.xfr_scan,undefined);assert.equal(b.local.xfr_meta.lastError,'incomplete');assert.equal(b.local.xfr_meta.lastCheck,123);
});
test('repost continuation uses the repost ID and refuses an unknown repost cursor',async()=>{
 const b=background();await b.seed();b.local.xfr_settings={retweets:true};
 await b.done('incomplete',[{id:'10',scanId:'200',handle:'original',via:['OpenAI'],ts:Date.now()}]);
 assert.equal(b.session.xfr_scan.cur.maxId,'199','original ID must not skip the middle of the repost timeline');
 await b.done('incomplete',[{id:'9',handle:'original',via:['OpenAI'],ts:Date.now()}]);
 assert.equal(b.local.xfr_meta.lastError,'incomplete');
});
test('empty first-look continuation completes without dropping its max_id bound',async()=>{
 const b=background();await b.seed();
 await b.run('(async()=>{const s=await getScan();s.cur.prime=true;await setScan(s)})()');
 await b.done('incomplete',[{id:'200',handle:'OpenAI',ts:Date.now()}]);await b.done('',[]);
 assert.equal(b.opened.length,2,'empty bounded continuation must not restart an unbounded plain query');
 assert.equal(b.session.xfr_scan,undefined);
});

test('a successful-looking response that ignores max_id cannot advance the watermark',async()=>{
 const b=background();await b.seed();await b.done('incomplete',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 await b.done('',[{id:'201',handle:'OpenAI',ts:Date.now()}]);
 assert.equal(b.local.xfr_meta.lastCheck,123);assert.equal(b.local.xfr_meta.lastError,'incomplete');
});
test('GraphQL keeps original dedup ID separate from repost pagination ID',()=>{
 const c=vm.createContext({});vm.runInContext(shared,c);
 const t=(id,handle)=>({rest_id:id,core:{user_results:{result:{legacy:{screen_name:handle}}}},legacy:{full_text:'post',created_at:new Date().toUTCString()}});
 const original=t('10','original'),repost=t('200','reposter');repost.legacy.retweeted_status_result={result:original};
 const got=c.XFR.fromGraphQL({tweet_results:{result:repost}})[0];assert.equal(got.id,'10');assert.equal(got.scanId,'200');assert.equal(got.via[0],'reposter');
});

test('HTTP 429 pauses remaining work and forced openings cannot bypass cooldown',async()=>{
 const b=background();await b.seed();
 await b.run('(async()=>{const s=await getScan();s.queue.push({...s.cur,handles:["nextAuthor"]});await setScan(s)})()');
 await b.done('rateLimit',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 assert.equal(b.opened.length,1,'must not immediately issue the next request');
 assert.ok(b.session.xfr_scan.pausedUntil>Date.now());
 assert.equal(b.session.xfr_scan.queue.length,2);assert.equal(b.session.xfr_scan.cur,null);
 assert.equal(b.local.xfr_meta.lastError,'rateLimit');assert.equal(b.local.xfr_meta.checking,false);assert.equal(b.local.xfr_meta.lastCheck,123);
 const result=await b.run('(async()=>startCheck(await load(),{force:true,catchUp:true}))()');
 assert.equal(result.reason,'rateLimit');assert.equal(b.opened.length,1);
 await b.run('watchdog()');assert.equal(b.opened.length,1);
});
test('cooldown expiry resumes the remaining queue, not already-completed authors',async()=>{
 const b=background();await b.seed();await b.done('rateLimit');
 b.session.xfr_scan.pausedUntil=1;b.local.xfr_meta.retryAt=1;
 await b.run('watchdog()');
 assert.equal(b.opened.length,2);assert.equal(b.session.xfr_scan.cur.handles[0],'OpenAI');
 await b.done();assert.ok(b.local.xfr_meta.lastCheck>123);assert.equal(b.local.xfr_meta.lastError,'');
});
test('cooldown survives a worker/browser restart even when its session queue is lost',async()=>{
 const b=background();await b.seed();await b.done('rateLimit');delete b.session.xfr_scan;
 const r=await b.run('(async()=>startCheck(await load(),{force:true,catchUp:true}))()');
 assert.equal(r.reason,'rateLimit');assert.equal(b.opened.length,1);assert.equal(b.local.xfr_meta.lastCheck,123);
});
test('X rate-limit headers determine a safe retry time without making more requests',()=>{
 const c=vm.createContext({});vm.runInContext(shared,c);const now=1800000000000;
 assert.equal(c.XFR.retryAt('120',null,now),now+120000);
 assert.equal(c.XFR.retryAt(null,String(now/1000+900),now),now+900000);
 assert.equal(c.XFR.retryAt(null,null,now),now+300000);
});

test('widening the window during cooldown rebuilds coverage only when requests may resume',async()=>{
 const b=background();await b.seed();b.local.xfr_settings={windowHours:24};
 await b.done('rateLimit');await b.run('handlers.setSettings({patch:{windowHours:72}})');
 assert.equal(b.opened.length,1,'scope change must still honor X cooldown');
 b.local.xfr_meta.retryAt=1;b.session.xfr_scan.pausedUntil=1;
 await b.run('watchdog()');
 const jobs=[b.session.xfr_scan.cur,...b.session.xfr_scan.queue];
 assert.ok(jobs.some(j=>j.since<Date.now()-70*3600000),'widened resume must cover the earlier boundary');
});
test('a partially fetched page resumes after its oldest ID without losing fetched posts',async()=>{
 const b=background();await b.seed();await b.done('rateLimit',[{id:'200',handle:'OpenAI',ts:Date.now()}]);
 assert.ok(b.local.xfr_tweets['200']);assert.equal(b.session.xfr_scan.queue[0].maxId,'199');
 b.local.xfr_meta.retryAt=1;b.session.xfr_scan.pausedUntil=1;await b.run('watchdog()');
 assert.equal(b.session.xfr_scan.cur.maxId,'199');await b.done('',[{id:'150',handle:'OpenAI',ts:Date.now()-1000}]);
 assert.ok(b.local.xfr_tweets['200']&&b.local.xfr_tweets['150']);assert.equal(b.local.xfr_meta.lastError,'');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, e.message); }
}
process.exitCode = failed ? 1 : 0;
