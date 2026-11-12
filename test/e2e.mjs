// Runs the real extension against pages that imitate x.com's structure.
//   node test/e2e.mjs
// Needs Playwright with Chromium. If it is not installed here, point PW at a
// copy:  PW=/path/to/node_modules/playwright-core node test/e2e.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.PW, 'playwright', 'playwright-core'].filter(Boolean)) {
  try {
    ({ chromium } = require(name));
    break;
  } catch {}
}
if (!chromium) {
  console.error('Playwright not found. npm i -D playwright, or set PW=/path/to/playwright-core');
  process.exit(2);
}

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'xfr-profile-'));
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
const shot = (name) => path.join(EXT, 'test', 'shots', name);

// ------------------------------------------------------------ fake x.com

const world = { feed: [], home: [], domOnly: false, loggedOut: false, strictBroken: false, searches: 0, queries: [] };

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const xDate = (ts) => {
  const d = new Date(ts);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
};

const PICTURE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='400' height='300' fill='%236a8fd8'/><circle cx='200' cy='150' r='70' fill='%23f2c94c'/></svg>";

const result = (t) => ({
  __typename: 'Tweet',
  rest_id: t.id,
  core: { user_results: { result: { core: { screen_name: t.handle, name: t.name || t.handle }, avatar: { image_url: '' }, legacy: {} } } },
  legacy: {
    full_text: t.text,
    created_at: xDate(t.ts),
    conversation_id_str: t.id,
    entities: { urls: [] },
    ...(t.media ? { extended_entities: { media: t.media.map((m) => ({ media_url_https: PICTURE, type: m, url: 'https://t.co/m' })) } } : {}),
    ...(t.retweetOf ? { retweeted_status_result: { result: result(t.retweetOf) } } : {}),
  },
  ...(t.quote ? { quoted_status_result: { result: result(t.quote) } } : {}),
});
const entry = (t) => ({
  entryId: `tweet-${t.id}`,
  content: {
    itemContent: {
      itemType: 'TimelineTweet',
      tweet_results: { result: t.wrapped ? { __typename: 'TweetWithVisibilityResults', tweet: result(t) } : result(t) },
      ...(t.ad ? { promotedMetadata: { advertiser: 'x' } } : {}),
    },
  },
});

// A repost is shown as the original post with a "reposted" line above it.
const article = (t) => (t.retweetOf ? card(t.retweetOf, t.handle) : card(t));
const card = (t, reposter) => `
<article data-testid="tweet" style="padding:20px;border-bottom:1px solid #ccc;min-height:140px">
  ${reposter ? `<a href="/${reposter}"><span data-testid="socialContext">${reposter} reposted</span></a>` : ''}
  <div data-testid="Tweet-User-Avatar"><img alt="" width="40" height="40"></div>
  <div data-testid="User-Name"><div><span>${t.name || t.handle}</span></div>
    <div><a href="/${t.handle}">@${t.handle}</a> · <a href="/${t.handle}/status/${t.id}"><time datetime="${new Date(
  t.ts
).toISOString()}">now</time></a></div></div>
  <div data-testid="tweetText">${t.text}</div>
</article>`;

const shell = (inner) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>X</title></head><body style="background:#fff;margin:0">${inner}</body></html>`;

function wanted(query) {
  // An X that answers the "no reposts" condition with an empty timeline.
  if (world.strictBroken && String(query).includes('-filter:nativeretweets')) return [];
  const handles = [...String(query).matchAll(/from:(\w+)/g)].map((m) => m[1].toLowerCase());
  return world.feed.filter((t) => t.stray || t.ad || handles.includes((t.by || t.handle).toLowerCase()));
}

async function serve(route) {
  const url = new URL(route.request().url());
  const html = (body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: shell(body) });

  if (url.pathname.includes('/graphql/')) {
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    const entries = wanted(vars.rawQuery).map(entry);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } },
      }),
    });
  }
  if (url.pathname === '/search') {
    world.searches++;
    const q = url.searchParams.get('q');
    world.queries.push(q);
    if (world.loggedOut) return route.fulfill({ status: 302, headers: { location: 'https://x.com/i/flow/login' } });
    if (world.domOnly) return html(wanted(q).filter((t) => !t.ad).map(article).join(''));
    return html(`<div id="tl"></div><script>
      const x = new XMLHttpRequest();
      x.open('GET', '/i/api/graphql/abc123/SearchTimeline?variables=' + encodeURIComponent(JSON.stringify({ rawQuery: ${JSON.stringify(
        q
      )} })));
      x.send();
    </script>`);
  }
  if (url.pathname === '/home') return html(`<h1>Home</h1>${world.home.map(article).join('')}`);
  if (url.pathname === '/i/flow/login') return html('<h1>Sign in</h1>');
  if (/\/status\/\d+/.test(url.pathname)) return html('<h1>Post</h1>');
  // a profile
  const handle = url.pathname.split('/')[1];
  return html(`
    <div style="display:flex;gap:8px;padding:20px">
      <a href="/${handle}/photo"><img alt="" width="40" height="40"></a>
      <div data-testid="UserName"><span>${handle.toUpperCase()}</span><span>@${handle}</span></div>
      <div style="display:flex;margin-left:auto"><button data-testid="userActions">…</button><button>Follow</button></div>
    </div>`);
}

// ----------------------------------------------------------------- helpers

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// x.com is pointed at a local HTTPS server, so tabs the extension opens by
// itself land on the fake site too.
const CERT = fs.mkdtempSync(path.join(os.tmpdir(), 'xfr-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=x.com',
  '-keyout', path.join(CERT, 'key.pem'), '-out', path.join(CERT, 'cert.pem')], { stdio: 'ignore' });
const server = https.createServer(
  { key: fs.readFileSync(path.join(CERT, 'key.pem')), cert: fs.readFileSync(path.join(CERT, 'cert.pem')) },
  (req, res) =>
    serve({
      request: () => ({ url: () => `https://x.com${req.url}` }),
      fulfill: ({ status, contentType, headers, body }) => {
        res.writeHead(status, { ...(contentType ? { 'content-type': contentType } : {}), ...(headers || {}) });
        res.end(body || '');
      },
    }).catch(() => res.end())
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP x.com 127.0.0.1:${PORT}, MAP twitter.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server', // the machine's own proxy would bypass the mapping
  ],
});

const worker = async () => ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const store = async () => (await worker()).evaluate(() => chrome.storage.local.get(null));
const badge = async () => (await worker()).evaluate(() => chrome.action.getBadgeText({}));
const tweetsOf = async (handle) => Object.values((await store()).xfr_tweets || {}).filter((t) => t.handle === handle);
// No check in flight.
const idle = () =>
  until(async () => {
    const w = await worker();
    const scan = await w.evaluate(() => chrome.storage.session.get('xfr_scan'));
    const meta = (await store()).xfr_meta || {};
    return !scan.xfr_scan && !meta.checking;
  }, 90000);
// Every watched account has had its first look.
const settled = () =>
  until(async () => {
    const s = await store();
    return (s.xfr_subs || []).every((x) => x.primed) && (await idle());
  }, 90000);
// Make the next visit to X due for a check.
const expire = async () => {
  await sleep(3000); // a check the page, or a new subscription, is about to ask for
  await idle();
  return (await worker()).evaluate(async () => {
    const d = await chrome.storage.local.get('xfr_meta');
    const meta = Object.assign({}, d.xfr_meta, { lastCheck: 1 });
    await chrome.storage.local.set({ xfr_meta: meta });
    await chrome.alarms.clear('xfr-soon');
  });
};
const states = async () => {
  const s = await store();
  return Object.fromEntries(Object.values(s.xfr_tweets || {}).map((t) => [t.id, t.state]));
};
const finished = () =>
  until(async () => {
    const m = (await store()).xfr_meta;
    return m && m.checking === false && m.lastCheck > 1;
  }, 60000);
// Entering X: load a page and let the check it triggers run to the end.
async function enter(page, url = 'https://x.com/home') {
  const before = world.searches;
  await page.goto(url);
  const started = await until(() => world.searches > before, 12000);
  if (!started) {
    if (process.env.DEBUG) {
      const w = await worker();
      console.log('    meta', JSON.stringify((await store()).xfr_meta));
      console.log('    scan', JSON.stringify(await w.evaluate(() => chrome.storage.session.get(null))));
      console.log('    pages', ctx.pages().map((p) => p.url()));
      console.log('    alarms', JSON.stringify(await w.evaluate(() => chrome.alarms.getAll())));
    }
    return false;
  }
  await finished();
  await until(() => ctx.pages().length === 1, 10000);
  return true;
}

const toast = (page) => page.locator('#xfr-host .toast');
const toastText = async (page) => ((await toast(page).isVisible()) ? (await toast(page).innerText()).replace(/\s+/g, ' ') : '');

try {
  // Unpacked extensions only stay enabled across a reload while developer
  // mode is on, as it is in any browser the extension was loaded into by hand.
  {
    const p = await ctx.newPage();
    await p.goto('chrome://extensions/');
    await p.evaluate(() => new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, res)));
    await p.close();
  }
  const page = await ctx.newPage();
  for (const p of ctx.pages()) if (p !== page) await p.close();
  const T = Date.now();

  const panel = page.locator('#xfr-host .panel');
  const cards = page.locator('#xfr-host .panel .item');
  const tabBtn = (name) => page.locator('#xfr-host .tabs button', { hasText: name });
  const statusText = async () => (await page.locator('#xfr-host .status').innerText()).replace(/\s+/g, ' ');
  const closePanel = () => page.locator('#xfr-host .panel .head button', { hasText: '✕' }).click();

  console.log('\n1. 从博主主页快速添加');
  await page.goto('https://x.com/alice');
  const add = page.locator('button[data-xfr="btn"]');
  await add.waitFor({ timeout: 10000 });
  ok((await add.innerText()).includes('雷达'), '主页出现“＋ 雷达”按钮');
  await add.click();
  await until(async () => ((await store()).xfr_subs || []).length === 1);
  let s = await store();
  ok(s.xfr_subs?.[0]?.handle === 'alice', '点一下就加进名单', s.xfr_subs);
  ok(await until(async () => (await add.innerText()).includes('已在雷达'), 5000), '按钮变成“已在雷达”');
  ok((await toastText(page)).includes('@alice'), '有添加成功的提示');
  ok(await settled(), '几秒内自动去取这位博主最近的推文');
  ok(world.queries.includes('(from:alice) -filter:replies -filter:nativeretweets'), '新博主单独查一次', world.queries);
  await expire();

  console.log('\n2. 在面板里添加 / 无效输入');
  await page.locator('#xfr-host .fab').click();
  await tabBtn('博主').click();
  const input = page.locator('#xfr-host input[type=text]');
  await input.fill('https://x.com/home');
  await input.press('Enter');
  await sleep(600);
  ok(((await store()).xfr_subs || []).length === 1, '“/home” 不会被当成博主');
  await input.fill('@bob');
  await input.press('Enter');
  await until(async () => ((await store()).xfr_subs || []).length === 2);
  ok(await until(() => input.evaluate((el) => el.getRootNode().activeElement === el), 3000), '加完一个，输入框还在焦点上，可以接着加');
  await input.fill('https://x.com/bob/status/123');
  await input.press('Enter');
  await sleep(600);
  s = await store();
  ok(s.xfr_subs.length === 2 && s.xfr_subs.some((x) => x.handle === 'bob'), '@bob 加入，重复添加不会多一条', s.xfr_subs);
  await settled();
  await expire();

  console.log('\n3. 进入 X 时自动检查并弹窗');
  world.feed = [
    { id: '100', handle: 'alice', name: 'Alice', text: 'old post from before subscribing', ts: T - 3 * 86400000 },
    { id: '101', handle: 'alice', name: 'Alice', text: 'alice fresh &amp; new', ts: T + 60000, wrapped: true },
    { id: '201', handle: 'bob', name: 'Bob', text: 'bob fresh', ts: T + 61000 },
    { id: '900', handle: 'carol', name: 'Carol', text: 'not subscribed', ts: T + 62000, stray: true },
    { id: '901', handle: 'adco', name: 'Ad', text: 'buy now', ts: T + 63000, ad: true },
    { id: '301', handle: 'alice', by: 'alice', name: 'Alice', text: 'RT', ts: T + 64000,
      retweetOf: { id: '300', handle: 'dave', name: 'Dave', text: 'dave original', ts: T - 1000 } },
  ];
  ok(await enter(page), '打开 X 后自动开始检查');
  ok(await until(async () => (await toastText(page)).includes('2 位博主有 2 条新推文'), 8000), '弹窗：2 位博主有 2 条新推文', await toastText(page));
  await page.screenshot({ path: shot('toast.png') }).catch(() => {});
  let st = await states();
  ok(st['100'] === 'read', '已经看过首轮的博主，后来才抓到的旧推文不弹，只进历史', st);
  ok(st['101'] === 'shown' && st['201'] === 'shown', '新推文弹过后记为“已弹”', st);
  ok(!st['900'] && !st['901'], '没订阅的人和广告不收', st);
  ok(!st['300'] && !st['301'], '默认不收转推', st);
  s = await store();
  ok(s.xfr_tweets['101'].text === 'alice fresh & new', '正文解析正确', s.xfr_tweets['101'].text);
  ok(world.queries.includes('(from:alice OR from:bob) -filter:replies -filter:nativeretweets'), '搜索只要博主本人发的：排除回复和转帖', world.queries.slice(-2));
  ok(ctx.pages().length === 1, '后台标签页已自动关闭', ctx.pages().length);
  ok((await badge()) === '2', '工具栏角标显示 2', await badge());

  console.log('\n4. 不重复');
  await page.reload();
  await sleep(3500);
  ok(!(await toast(page).isVisible()), '刷新页面不会再弹一次');
  await expire();
  ok(await enter(page), '再检查一次（同样的内容）');
  await sleep(1500);
  ok(!(await toast(page).isVisible()), '同样的推文不会再弹');
  ok(Object.keys(await states()).length === 3, '记录没有重复', await states());

  world.feed.unshift({ id: '202', handle: 'bob', name: 'Bob', text: 'bob second', ts: T + 120000 });
  await expire();
  await enter(page);
  ok(await until(async () => (await toastText(page)).includes('1 位博主有 1 条新推文'), 8000), '只弹真正新的那 1 条', await toastText(page));

  console.log('\n5. 面板：直接列出未读、标记已读、点开');
  await page.locator('#xfr-host .toast button', { hasText: '查看全部' }).click();
  ok((await cards.count()) === 3, '未读里直接列出 3 条推文', await cards.count());
  await page.screenshot({ path: shot('panel.png') }).catch(() => {});
  await page.locator('#xfr-host .panel .item button[title="标记为已读"]').first().click();
  ok(await until(async () => (await cards.count()) === 2, 5000), '点 ✓ 的那条马上消失');
  const openedId = await cards.first().getAttribute('data-id');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), cards.first().click()]);
  ok(/\/status\/\d+/.test(popup.url()), '点卡片在新标签页打开推文', popup.url());
  await popup.close();
  ok(
    await until(async () => {
      const t = (await store()).xfr_tweets[openedId];
      return t.state === 'read' && t.seen === true;
    }, 5000),
    '点开过的记为看过'
  );
  await tabBtn('博主').click();
  await page.screenshot({ path: shot('subs.png') }).catch(() => {});

  console.log('\n6. 在首页已经看过的，不再提醒');
  const seenPost = { id: '103', handle: 'alice', name: 'Alice', text: 'seen on home first', ts: T + 180000 };
  world.home = [seenPost];
  await page.goto('https://x.com/home');
  ok(await until(async () => ((await (await worker()).evaluate(() => chrome.storage.local.get('xfr_ledger'))).xfr_ledger || []).includes('103'), 12000), '首页看到的推文被记下');
  world.feed.unshift(seenPost);
  await expire();
  await enter(page);
  await sleep(1500);
  st = await states();
  ok(!(await toast(page).isVisible()) && st['103'] !== 'new' && st['103'] !== 'shown', '检查到它时不再弹，也不进未读', st);
  world.home = [];

  console.log('\n7. 读不到网络数据时，改读页面卡片');
  world.domOnly = true;
  world.feed.unshift({ id: '203', handle: 'bob', name: 'Bob', text: 'from rendered card', ts: T + 240000 });
  await expire();
  await enter(page);
  ok(await until(async () => (await toastText(page)).includes('1 位博主有 1 条新推文'), 8000), '兜底方式也能发现新推文', await toastText(page));
  world.domOnly = false;

  console.log('\n8. 没登录时给出提示');
  world.loggedOut = true;
  await expire();
  await enter(page);
  s = await store();
  ok(s.xfr_meta.lastError === 'login', '记录“未登录”', s.xfr_meta);
  ok(ctx.pages().length === 1, '后台标签页已关闭');
  world.loggedOut = false;

  console.log('\n9. 移除博主');
  await page.goto('https://x.com/alice');
  await add.waitFor();
  await until(async () => (await add.innerText()).includes('已在雷达'), 5000);
  await add.click();
  ok(await until(async () => ((await store()).xfr_subs || []).length === 1, 5000), '再点一次移出名单');
  await page.screenshot({ path: shot('profile.png') }).catch(() => {});

  console.log('\n10. 刚订阅的博主：最近的推文直接进未读，不弹窗');
  world.feed = world.feed.filter((t) => t.id !== '900');
  for (let i = 1; i <= 12; i++) {
    world.feed.push({ id: String(9100 + i), handle: 'carol', name: 'Carol', text: `carol old ${i}`, ts: T - i * 3600000 });
  }
  // Posts as they really come: a long one, one with a picture and a quote, one with four attachments.
  const longText = 'dave old 1 ' + Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：这是一条很长的推文，用来检查折叠和展开。`).join('\n');
  world.feed.push(
    { id: '9201', handle: 'dave', name: 'Dave', text: longText, ts: T - 31 * 3600000 },
    { id: '9202', handle: 'dave', name: 'Dave', text: 'dave old 2 with a picture and a quote', ts: T - 32 * 3600000, media: ['photo'],
      quote: { id: '9299', handle: 'someone', name: 'Someone', text: 'the post being quoted', ts: T - 40 * 3600000 } },
    { id: '9203', handle: 'dave', name: 'Dave', text: 'dave old 3 with four attachments', ts: T - 33 * 3600000, media: ['photo', 'photo', 'video', 'photo'] }
  );
  await page.locator('#xfr-host .fab').click();
  await tabBtn('博主').click();
  await input.fill('@carol');
  await input.press('Enter');
  ok(await until(async () => (await page.locator('#xfr-host .sub', { hasText: '@carol' }).innerText()).includes('正在取回'), 4000), '名单里显示“正在取回最近的推文”');
  ok(await settled(), '首轮查看完成');
  let carol = await tweetsOf('carol');
  const shownTexts = carol.filter((t) => t.state === 'shown').map((t) => t.text);
  ok(
    carol.length === 12 && shownTexts.length === 10 && !shownTexts.includes('carol old 11') && !shownTexts.includes('carol old 12'),
    '最近 10 条进未读，更早的 2 条只进历史',
    carol.map((t) => [t.text, t.state])
  );
  ok(!carol.some((t) => t.state === 'new') && !(await toastText(page)).includes('新推文'), '订阅之前发的不当成“新推文”弹窗');
  ok(world.queries.includes('(from:carol) -filter:replies -filter:nativeretweets'), '新博主单独查一次，不会被别的博主挤掉', world.queries.slice(-3));
  ok(await until(async () => (await statusText()).includes('取回 10 条'), 5000), '状态栏说明取回了 10 条', await statusText());
  await closePanel();
  // From a profile, with the panel closed: a note says the posts have arrived.
  await page.goto('https://x.com/dave');
  await add.waitFor({ timeout: 10000 });
  await add.click();
  ok(await until(async () => (await toastText(page)).includes('正在取回'), 5000), '点“＋ 雷达”后提示正在取回', await toastText(page));
  ok(await settled(), '首轮查看完成');
  ok(await until(async () => (await toastText(page)).includes('已取回 @dave 最近的 3 条推文'), 8000), '取回后有一行提示', await toastText(page));

  console.log('\n11. 面板直接列出推文；看过的下次不再出现');
  const seenIds = async () => Object.values((await store()).xfr_tweets).filter((t) => t.state === 'read' && t.seen).map((t) => t.id);
  const seen0 = (await seenIds()).length;
  await page.locator('#xfr-host .toast button', { hasText: '查看' }).click();
  const n0 = await cards.count();
  const u0 = Object.values((await store()).xfr_tweets).filter((t) => t.state !== 'read').length;
  ok(n0 === u0 && n0 >= 13, `点“查看”打开面板，未读里直接列出 ${n0} 条推文`, { n0, u0 });
  ok(
    (await page.locator('#xfr-host .panel .item', { hasText: 'carol old' }).count()) === 10 &&
      (await page.locator('#xfr-host .panel .item', { hasText: 'dave old' }).count()) === 3,
    '两位新博主最近的推文都在'
  );
  await page.screenshot({ path: shot('feed.png') }).catch(() => {});
  await sleep(3800);
  const k = (await seenIds()).length - seen0;
  ok(k >= 2 && k < n0, `在屏幕上停留过的 ${k} 条记为看过，没滚到的不算`, { k, n0 });
  ok((await cards.count()) === n0, '看的过程中列表不跳动', await cards.count());
  ok((await page.locator('#xfr-host .panel .mark[data-kind="kept"]').count()) === k, '看过的卡片标上“已看”');
  ok((await tabBtn('未读').innerText()).trim() === `未读 ${n0 - k}`, '未读数随之减少', await tabBtn('未读').innerText());
  await page.screenshot({ path: shot('feed-seen.png') }).catch(() => {});
  await closePanel();
  await page.locator('#xfr-host .fab').click();
  ok((await cards.count()) === n0 - k, '关掉再打开：看过的不再出现', { now: await cards.count(), want: n0 - k });
  // Long text, pictures and quotes are shown in the card itself.
  await page.locator('#xfr-host .panel .body').evaluate((el) => (el.scrollTop = el.scrollHeight));
  const long = cards.filter({ hasText: 'dave old 1' });
  ok((await long.locator('.more').count()) === 1, '长推文先折叠，带“展开”');
  const h1 = await long.locator('.text').evaluate((el) => el.clientHeight);
  await long.locator('.more').click();
  const h2 = await long.locator('.text').evaluate((el) => el.clientHeight);
  ok(h2 > h1 && (await long.locator('.more').count()) === 0 && ctx.pages().length === 1, '点“展开”就在面板里看全文，不会跳走', { h1, h2 });
  const pic = cards.filter({ hasText: 'dave old 2' });
  ok((await pic.locator('.m img').count()) === 1 && (await pic.locator('.quote').innerText()).includes('the post being quoted'), '配图和引用的推文直接显示');
  const four = cards.filter({ hasText: 'dave old 3' });
  ok((await four.locator('.m img').count()) === 4 && (await four.locator('.m.video').count()) === 1, '多张图排成格子，视频有标记');
  await page.locator('#xfr-host .panel .body').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: shot('rich.png') }).catch(() => {});
  await tabBtn('全部').click();
  ok((await cards.count()) >= n0, '“全部”里历史都还在', await cards.count());

  console.log('\n12. 取消订阅再加回来：没看过的回到未读，看过的不回来');
  await tabBtn('博主').click();
  await page.locator('#xfr-host .sub', { hasText: '@carol' }).locator('button', { hasText: '移除' }).click();
  await until(async () => !((await store()).xfr_subs || []).some((x) => x.handle === 'carol'), 5000);
  await sleep(1500); // marks still on their way
  carol = await tweetsOf('carol');
  ok(carol.every((t) => t.state === 'read'), '取消订阅后，这位博主的推文不再算未读');
  const seenCarol = new Set(carol.filter((t) => t.seen).map((t) => t.id));
  await input.fill('@carol');
  await input.press('Enter');
  await until(async () => ((await store()).xfr_subs || []).some((x) => x.handle === 'carol'), 5000);
  ok(await settled(), '重新订阅后再看一次');
  const latest = (await tweetsOf('carol')).sort((a, b) => b.ts - a.ts).slice(0, 10);
  ok(
    seenCarol.size > 0 && seenCarol.size < 10 && latest.every((t) => (seenCarol.has(t.id) ? t.state === 'read' : t.state === 'shown')),
    `看过的 ${seenCarol.size} 条不回来，没看过的 ${10 - seenCarol.size} 条回到未读`,
    latest.map((t) => [t.text, t.state, !!t.seen])
  );
  await tabBtn('未读').click();
  await page.locator('#xfr-host .bar button', { hasText: '全部已读' }).click();
  ok(
    await until(async () => (await page.locator('#xfr-host .panel .empty').count()) === 1 && (await page.locator('#xfr-host .panel .empty').innerText()).includes('都看完了'), 5000),
    '点“全部已读”：未读清空'
  );
  ok(await until(async () => (await badge()) === '', 5000), '角标清零', await badge());

  console.log('\n13. 插件更新后：已打开的页面不用刷新，旧版本存下的推文回到未读');
  // What is on the page, and whether the copy from before the update put it there.
  const onPage = () =>
    page.evaluate(() => ({
      hosts: document.querySelectorAll('#xfr-host').length,
      oldHosts: document.querySelectorAll('#xfr-host[data-old]').length,
      pills: document.querySelectorAll('button[data-xfr="btn"]').length,
      oldPills: document.querySelectorAll('button[data-xfr="btn"][data-old]').length,
      v: (document.querySelector('#xfr-host') || { dataset: {} }).dataset.v || '',
    }));
  await page.goto('https://x.com/erin');
  await add.waitFor({ timeout: 10000 });
  await page.locator('#xfr-host .fab').waitFor({ timeout: 10000 });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#xfr-host, button[data-xfr="btn"]')) el.setAttribute('data-old', '1');
  });
  // Data as an earlier version left it: nothing records first looks or what was seen.
  await (await worker()).evaluate(async () => {
    const d = await chrome.storage.local.get(['xfr_subs', 'xfr_tweets']);
    for (const x of d.xfr_subs) delete x.primed;
    for (const t of Object.values(d.xfr_tweets)) {
      t.state = 'read';
      delete t.seen;
    }
    await chrome.storage.local.set(d);
  });
  const reborn = ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  await (await worker()).evaluate(() => chrome.runtime.reload()).catch(() => {});
  await reborn;
  const after = await until(async () => {
    const f = await onPage();
    return f.hosts === 1 && !f.oldHosts && f.pills === 1 && !f.oldPills ? f : null;
  }, 15000);
  ok(!!after, '旧按钮被新按钮替换，圆形按钮和“＋ 雷达”各只有一个', await onPage());
  ok(!!after && after.v === VERSION, `页面上运行的是当前版本 ${VERSION}`, after);
  ok(await settled(), '自动为已有的博主补一次查看');
  st = await states();
  ok(['201', '202', '203'].every((id) => st[id] === 'shown'), '旧版本当成历史的最近推文，回到未读', { 201: st['201'], 202: st['202'], 203: st['203'] });
  ok(await until(async () => (await toastText(page)).includes('已取回'), 8000), '页面上有一行提示', await toastText(page));
  await add.click();
  ok(await until(async () => ((await store()).xfr_subs || []).some((x) => x.handle === 'erin'), 8000), '不刷新，“＋ 雷达”照常可用');
  await page.locator('#xfr-host .fab').click();
  ok(await until(() => panel.isVisible(), 5000), '不刷新也能点开面板');
  const count13 = (await store()).xfr_subs.length;
  ok(await until(async () => ((await page.locator('#xfr-host .panel .head b').innerText()) || '').includes(`${count13} 位博主`), 5000), '面板里的名单是实时的', await page.locator('#xfr-host .panel .head b').innerText());
  await tabBtn('博主').click();
  ok((await page.locator('#xfr-host .ver').innerText()).includes(VERSION), '面板底部能看到版本号');
  await settled();
  await expire();

  console.log('\n14. 同一个页面多给一份脚本，不会出现两套按钮');
  const tabId = await (await worker()).evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);
  await (await worker()).evaluate(async (id) => {
    await inject(id);
    await inject(id);
  }, tabId);
  await sleep(1000);
  let f = await onPage();
  ok(f.hosts === 1 && f.pills === 1, '还是各一个', f);
  ok(await panel.isVisible(), '已经打开的面板没有被重置');

  console.log('\n15. 点工具栏图标、右键菜单的提示');
  const press = async (msg, retry) => (await worker()).evaluate(([id, m, r]) => deliver(id, m, r), [tabId, msg, retry]);
  ok((await press({ type: 'toggle' }, { type: 'open' })) === true && !(await panel.isVisible()), '面板开着时点图标：收起');
  ok((await press({ type: 'toggle' }, { type: 'open' })) === true && (await panel.isVisible()), '再点一次：打开（只切换一次）');
  await press({ type: 'toggle' }, { type: 'open' });
  ok(!(await panel.isVisible()), '再点一次：收起');
  // The page does not answer the first time, as when it has no page script.
  const rescued = await (await worker()).evaluate(async (id) => {
    const real = chrome.tabs.sendMessage;
    let n = 0;
    chrome.tabs.sendMessage = (...a) => (n++ ? real.apply(chrome.tabs, a) : Promise.reject(new Error('no page script')));
    try {
      return { ok: await deliver(id, { type: 'toggle' }, { type: 'open' }), calls: n };
    } finally {
      chrome.tabs.sendMessage = real;
    }
  }, tabId);
  f = await onPage();
  ok(rescued.ok === true && rescued.calls >= 2 && (await panel.isVisible()) && f.hosts === 1, '页面没回应时：补上脚本，再打开面板', { rescued, f });
  ok((await press({ type: 'toast', text: '已订阅 @zed' })) === true && (await toastText(page)).includes('@zed'), '右键添加后的提示能送到页面', await toastText(page));

  console.log('\n16. “检查”按钮和 Esc');
  let seen = world.searches;
  await page.locator('#xfr-host .panel .head button', { hasText: '检查' }).click();
  ok(await until(async () => (await statusText()).includes('正在检查'), 5000), '点“检查”后马上显示“正在检查…”', await statusText());
  await until(() => world.searches > seen, 12000);
  await finished();
  ok(await until(async () => (await statusText()).includes('没有新推文'), 6000), '没有新内容时如实说明', await statusText());
  await tabBtn('博主').click();
  await input.click();
  await page.keyboard.press('Escape');
  ok(await until(async () => !(await panel.isVisible()), 3000), '在面板里按 Esc 能关掉面板');

  console.log('\n17. X 一直开着：到点自动检查，有新推文照样弹');
  world.feed.unshift({ id: '204', handle: 'bob', name: 'Bob', text: 'bob while x stays open', ts: Date.now() + 5000 });
  await expire();
  const due = () => worker().then((w) => w.evaluate(async () => ((await chrome.alarms.get('xfr-tick')) || {}).scheduledTime));
  const due1 = await due();
  seen = world.searches;
  await (await worker()).evaluate(() => locked(() => tick()));
  ok(await until(() => world.searches > seen, 12000), '页面没刷新，定时器自己发起了检查');
  await finished();
  ok(await until(async () => (await toastText(page)).includes('1 位博主有 1 条新推文'), 8000), '弹出新推文', await toastText(page));
  await (await worker()).evaluate(() => ensureAlarms());
  ok(!!due1 && due1 === (await due()), '后台被唤醒不会让定时器重新计时', [due1, await due()]);
  await until(() => ctx.pages().length === 1, 10000);
  ok(ctx.pages().length === 1, '后台标签页已关闭', ctx.pages().length);

  console.log('\n18. 搜索语句和排队规则');
  const unit = await (await worker()).evaluate(() => {
    const q = (u) => new URL(u.replace('#xfr-scan', '')).searchParams.get('q');
    const subs = [];
    for (let i = 0; i < 12; i++) subs.push({ handle: 'n' + i, addedAt: 1, primed: false, primeFails: i === 0 ? 2 : 0 });
    for (let i = 0; i < 13; i++) subs.push({ handle: 'k' + i, addedAt: 1, primed: true });
    const state = { subs, settings: { retweets: false, listUrl: '' } };
    const full = buildQueue(state, false);
    return {
      plain: q(searchUrl(['a', 'b'], false)),
      reposts: q(searchUrl(['a'], true)),
      solos: full.filter((j) => j.prime).map((j) => j.handles[0]),
      batches: full.filter((j) => !j.prime).map((j) => j.handles.length),
      primeOnly: buildQueue(state, true).length,
    };
  });
  ok(unit.plain === '(from:a OR from:b) -filter:replies -filter:nativeretweets', '默认排除回复和转帖', unit.plain);
  ok(unit.reposts === '(from:a) -filter:replies include:nativeretweets', '打开“转推也算更新”时才包含转帖', unit.reposts);
  ok(unit.solos.length === 10 && !unit.solos.includes('n0'), '一轮最多先看 10 位新博主，失败过的排在后面', unit.solos);
  ok(JSON.stringify(unit.batches) === '[10,3]' && unit.primeOnly === 10, '其余博主每 10 位合成一次搜索', unit);

  console.log('\n19. 万一 X 不认“排除转帖”这个搜索条件');
  world.strictBroken = true;
  for (let i = 1; i <= 2; i++) {
    world.feed.push({ id: String(9300 + i), handle: 'gina', name: 'Gina', text: `gina old ${i}`, ts: T - i * 7200000 });
  }
  world.feed.push({ id: '9310', handle: 'gina', by: 'gina', name: 'Gina', text: 'RT', ts: T - 3600000,
    retweetOf: { id: '9311', handle: 'someone', name: 'Someone', text: 'reposted by gina', ts: T - 9000000 } });
  await page.locator('#xfr-host .fab').click();
  await tabBtn('博主').click();
  await input.fill('@gina');
  await input.press('Enter');
  await until(async () => ((await store()).xfr_subs || []).some((x) => x.handle === 'gina'), 5000);
  ok(await settled(), '首轮查看完成');
  const gina = await tweetsOf('gina');
  ok(gina.length === 2 && gina.every((t) => t.state === 'shown'), '带条件查不到时，自动改用不带条件的搜索再查一次', gina.map((t) => [t.text, t.state]));
  ok(world.queries.includes('(from:gina) -filter:replies -filter:nativeretweets') && world.queries.includes('(from:gina) -filter:replies'), '先带条件、后不带条件各查一次', world.queries.slice(-3));
  s = await store();
  ok(s.xfr_settings.plainQuery === true && !s.xfr_tweets['9311'], '记住这一点；转帖仍然被过滤掉', s.xfr_settings);
  world.feed.unshift({ id: '205', handle: 'bob', name: 'Bob', text: 'bob after the fallback', ts: Date.now() + 5000 });
  await closePanel();
  await expire();
  seen = world.searches;
  await (await worker()).evaluate(() => locked(() => tick()));
  await until(() => world.searches > seen, 12000);
  await finished();
  ok(await until(async () => (await toastText(page)).includes('1 位博主有 1 条新推文'), 8000), '之后的检查照常发现新推文', await toastText(page));
  ok(!world.queries.slice(-1)[0].includes('nativeretweets'), '之后的搜索不再带这个条件', world.queries.slice(-1));
  world.strictBroken = false;

  console.log('\n20. 小窗口中避让 X 悬浮按钮，面板仍完整可见');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    const dock = document.createElement('div');
    dock.dataset.testid = 'FloatingActionButtons-test';
    dock.style.cssText = 'position:fixed;right:20px;bottom:20px;width:56px;height:110px';
    document.body.append(dock);
  });
  await page.locator('#xfr-host .fab').click();
  const bounds = await page.locator('#xfr-host .panel').boundingBox();
  ok(bounds.y >= 12 && bounds.y + bounds.height <= 720,
    '避让悬浮按钮后标题、关闭按钮和面板底部都在窗口内', bounds);

  console.log('\n21. 推文作者栏快捷订阅与未读入口');
  await closePanel();
  await page.evaluate((markup) => {
    const section = document.createElement('section');
    section.id = 'inline-test';
    section.innerHTML = markup;
    section.addEventListener('click', () => { section.dataset.clicked = 'yes'; });
    document.body.prepend(section);
  }, article({ id: '9400', handle: 'helen', name: 'Helen', text: 'inline author test', ts: T }));
  const inline = page.locator('#inline-test [data-testid="User-Name"] button[data-xfr="btn"]');
  ok(await until(() => inline.count(), 3000), '推文作者栏有快捷雷达按钮');
  if (await inline.count()) {
    await inline.click();
    ok(await until(async () => ((await store()).xfr_subs || []).some((x) => x.handle === 'helen'), 5000), '点一下订阅推文作者');
    ok(await until(async () => (await inline.innerText()).includes('查看雷达'), 5000), '已订阅后变成查看雷达');
    ok(await panel.isVisible(), '快捷订阅后打开未读列表');
    ok(!(await page.locator('#inline-test').getAttribute('data-clicked')), '点击按钮不触发推文卡片导航');
    await tabBtn('全部').click();
    await closePanel();
    await inline.click();
    ok(await page.locator('#xfr-host .tabs .on').innerText().then((x) => x.startsWith('未读')), '每次进入都回到未读，不停留在历史列表');
    ok(((await store()).xfr_subs || []).some((x) => x.handle === 'helen'), '再次点击查看列表，保留订阅');
    await page.evaluate(() => {
      const row = document.querySelector('#inline-test [data-testid="User-Name"]');
      for (const a of row.querySelectorAll('a')) a.href = a.getAttribute('href').replace('helen', 'irene');
    });
    ok(await until(async () => (await inline.getAttribute('data-xfr-handle')) === 'irene', 3000), 'X 复用推文节点时按钮跟随新作者');
    ok((await inline.count()) === 1 && (await inline.innerText()).includes('＋ 雷达'), '不重复插入按钮，新作者显示未订阅');
    await page.screenshot({ path: shot('inline-entry-review.png') });
  }
  console.log('\n22. 主页雷达按钮与原生操作按钮对齐');
  await page.goto('https://x.com/alice');
  await page.locator('button[data-xfr="btn"]').waitFor();
  await page.evaluate(() => {
    const actions = document.querySelector('[data-testid="userActions"]');
    actions.parentElement.style.cssText = 'display:flex;align-items:flex-end;gap:8px';
    for (const btn of actions.parentElement.querySelectorAll('button:not([data-xfr])')) {
      btn.style.cssText = 'height:36px;margin-bottom:12px';
    }
  });
  const profileRadar = await page.locator('button[data-xfr="btn"]').boundingBox();
  const profileNative = await page.locator('[data-testid="userActions"]').boundingBox();
  ok(Math.abs(profileRadar.y - profileNative.y) <= 1 && profileRadar.height === profileNative.height,
    '主页雷达按钮与原生按钮同高且顶部对齐', { profileRadar, profileNative });
  await page.screenshot({ path: shot('profile-aligned-review.png') });

  console.log('\n23. 连续推文逐条展示，未展示的不能被误标已读');
  const fullText = Array.from({ length: 45 }, (_, i) => `完整正文第 ${i + 1} 段，需要读到文末。`).join('\n') + '\n正文结束标记';
  const fullQuote = '引用全文。'.repeat(100) + '引用结束标记';
  await (await worker()).evaluate(async ({ fullText, fullQuote }) => {
    const now = Date.now();
    const tweets = {};
    for (let i = 1; i <= 3; i++) tweets[String(9500 + i)] = {
      id: String(9500 + i), handle: 'alice', name: 'Alice', conv: '9501',
      text: i === 1 ? fullText : `连续推文第 ${i} 条`, ts: now - i * 1000,
      url: `https://x.com/alice/status/${9500 + i}`, state: 'shown', seen: false,
      media: [], via: [], quote: i === 1 ? { handle: 'bob', text: fullQuote } : null,
    };
    await chrome.storage.local.set({ xfr_subs: [{ handle: 'alice', primed: true, addedAt: now }],
      xfr_tweets: tweets, xfr_meta: { lastCheck: now, checking: false } });
  }, { fullText, fullQuote });
  await page.reload();
  await page.locator('#xfr-host .fab').click();
  ok((await cards.count()) === 3, '同一对话的 3 条推文全部可见，不藏起后续帖子');
  await page.locator('#xfr-host .item[data-id="9501"] .mark button').click();
  await sleep(1200);
  const threadStates = await states();
  ok(threadStates['9501'] === 'read' && threadStates['9502'] !== 'read' && threadStates['9503'] !== 'read',
    '读过第一条不会把尚未看到的后两条一起标为已读', threadStates);

  console.log('\n24. 历史页正文与引用全文可展开');
  await tabBtn('全部').click();
  const fullCard = page.locator('#xfr-host .item[data-id="9501"]');
  ok((await fullCard.locator(':scope > .text').innerText()) === fullText, '历史页保留完整正文，文末没有被截掉');
  ok((await fullCard.locator('.quote').innerText()).includes('引用结束标记'), '引用保留完整内容');
  ok((await fullCard.locator('.more').count()) >= 1, '历史页长文提供展开入口');
  if (await fullCard.locator('.more').count()) {
    await fullCard.locator('.more').first().click();
    ok(!(await fullCard.locator(':scope > .text').getAttribute('class')).includes('clip'), '展开后正文不再被高度裁切');
  }
  await page.screenshot({ path: shot('full-post-review.png') });

  const quoteMore = fullCard.locator('.quote .more');
  if (await quoteMore.count()) await quoteMore.click();
  ok(!(await fullCard.locator('.quote .text').getAttribute('class')).includes('clip') &&
    (await fullCard.locator('.quote .text').innerText()) === fullQuote, '引用也能展开到文末');
  await closePanel();
  await page.locator('#xfr-host .fab').click();
  ok((await page.locator('#xfr-host .item[data-id="9501"]').count()) === 0,
    '全文阅读后关掉重开，已读首条不再进入未读列表');
  await closePanel();
  await page.reload();
  await page.locator('#xfr-host .fab').click();
  ok((await page.locator('#xfr-host .item[data-id="9501"]').count()) === 0,
    '刷新页面后已读状态依然保留，不重新推送');
  await tabBtn('全部').click();
  ok((await page.locator('#xfr-host .item[data-id="9501"]').count()) === 1,
    '已读帖仍可在全部里回看且只保留一份');

  console.log('\n25. 后台标签页不能算用户看过');
  await page.locator('#xfr-host .panel .head button', { hasText: '✕' }).click();
  const hiddenPost = { id: '9600', handle: 'alice', name: 'Alice', text: '后台页面未读判定', ts: Date.now() };
  world.home = [hiddenPost];
  await (await worker()).evaluate(async (post) => {
    const d = await chrome.storage.local.get('xfr_tweets');
    d.xfr_tweets[post.id] = { ...post, conv: post.id, url: `https://x.com/alice/status/${post.id}`, state: 'shown', seen: false, media: [], via: [] };
    await chrome.storage.local.set({ xfr_tweets: d.xfr_tweets });
  }, hiddenPost);
  const hiddenPage = await ctx.newPage();
  // Headless tabs stay visible; emulate the browser signal in the extension's
  // isolated world too, where a main-world addInitScript has no effect.
  const visibilitySession = await ctx.newCDPSession(hiddenPage);
  const executionContexts = [];
  visibilitySession.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
  visibilitySession.on('Runtime.executionContextsCleared', () => { executionContexts.length = 0; });
  await visibilitySession.send('Runtime.enable');
  await page.bringToFront();
  await hiddenPage.goto('https://x.com/home');
  await hiddenPage.locator('#xfr-host .fab').waitFor();
  const visibilityContexts = executionContexts.filter((c) => c.auxData?.frameId && c.auxData.type !== 'worker');
  for (const context of visibilityContexts) {
    await visibilitySession.send('Runtime.evaluate', { contextId: context.id,
      expression: "window.testVisibility='hidden';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.testVisibility});document.dispatchEvent(new Event('visibilitychange'))" });
  }
  await sleep(4500);
  ok(await hiddenPage.evaluate(() => document.visibilityState === 'hidden'), '测试页面收到后台可见性信号');
  ok(!(await store()).xfr_tweets['9600'].seen, '后台加载时间线不会误标为用户看过');
  await hiddenPage.bringToFront();
  for (const context of visibilityContexts) {
    await visibilitySession.send('Runtime.evaluate', { contextId: context.id,
      expression: "window.testVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))" });
  }
  ok(await until(async () => (await store()).xfr_tweets['9600'].seen, 7000), '切到前台实际看到后才标为已读');
  await hiddenPage.close();

  console.log('\n26. 时间线快速划过不能累计成已读');
  world.home = [{ ...hiddenPost, id: '9601', text: '短暂划过仍然未读' }];
  await page.goto('https://x.com/home');
  await page.locator('#xfr-host .fab').waitFor();
  await sleep(400);
  await page.locator('article').evaluate((el) => { el.style.marginTop = '2000px'; });
  await sleep(150);
  await page.locator('article').evaluate((el) => { el.style.marginTop = '0'; });
  await sleep(550);
  await page.locator('article').evaluate((el) => { el.style.marginTop = '2000px'; });
  await sleep(3500);
  ok(!((await store()).xfr_ledger || []).includes('9601'), '两次不足 900ms 的露出不会累计为已读');
  console.log('\n27. 详情页按钮与作者名称同行，窄屏不增加作者区高度');
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="max-width:600px;background:#000;color:#e7e9ea;font:15px system-ui;padding:16px;margin:auto">
      <h2>帖子</h2><article data-testid="tweet"><header style="display:flex;gap:12px;align-items:flex-start">
      <div style="height:40px;width:40px;border-radius:50%;background:#536471;flex-shrink:0"></div>
      <div data-testid="User-Name" style="display:flex;flex-direction:column;flex:1;min-width:0">
        <div style="display:flex;flex-direction:column"><a href="/detailauthor" style="color:inherit;text-decoration:none;font-weight:700">小蕾姆 ✓</a></div>
        <div><a href="/detailauthor" style="color:#71767b;text-decoration:none">@detailauthor</a></div>
      </div><button style="background:none;border:0;color:#71767b">•••</button></header>
      <div data-testid="tweetText" style="padding:20px 0">来啦来啦别急</div>
      <div style="color:#71767b;border-bottom:1px solid #2f3336;padding-bottom:16px">下午8:56 · 2026年11月12日 · 6 查看</div>
      </article></main>`;
    document.body.style.cssText = 'background:#000;margin:0';
  });
  const detailButton = page.locator('[data-testid="User-Name"] button[data-xfr]');
  await detailButton.waitFor();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 760 });
    const nameBox = await page.locator('[data-testid="User-Name"] a').first().boundingBox();
    const buttonBox = await detailButton.boundingBox();
    const rowBox = await page.locator('[data-testid="User-Name"]').boundingBox();
    ok(Math.abs(nameBox.y + nameBox.height / 2 - buttonBox.y - buttonBox.height / 2) <= 2 && rowBox.height < 50,
      `${width}px 详情页雷达按钮贴合作者名，不落到账号下方`, { nameBox, buttonBox, rowBox });
    ok(buttonBox.x + buttonBox.width <= width - 16, `${width}px 按钮不溢出屏幕`);
    await page.screenshot({ path: shot(`detail-entry-${width}.png`) });
  }
} catch (e) {
  failed++;
  console.log('  FAIL  ' + (e && e.stack ? e.stack : e));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(CERT, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
