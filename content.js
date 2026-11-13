// Page script for x.com. Two jobs:
//
//  * in the hidden tab the extension opens (url carries #xfr-scan): read the
//    timeline and report it, then the tab is closed by the worker;
//  * everywhere else: show the panel with the unread posts of the watched
//    accounts, pop up what is new, offer "add to radar" buttons, and notice
//    which posts the user has seen, in the panel or on a timeline, so they
//    are not shown again.
(() => {
  'use strict';

  // One copy per page. The extension also hands this file to pages that were
  // open before it was installed or updated, and a page may already have it.
  if (globalThis.__xfrLoaded) return;
  globalThis.__xfrLoaded = true;

  const X = globalThis.XFR;
  const SCAN_MARK = 'xfr-scan';
  const TWEET = X.TWEET;

  const alive = () => {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '';
    }
  })();
  const send = (msg) => {
    if (!alive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ========================================================================
  // Reading a timeline (background tab)
  // ========================================================================

  const RAW = [];
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source === window && d && d.__xfr === 'gql' && typeof d.body === 'string') RAW.push(d.body);
  });

  function mergeItem(map, it) {
    if (!it || !it.id) return;
    const prev = map.get(it.id);
    if (!prev) {
      map.set(it.id, it);
      return;
    }
    prev.via = [...new Set([...(prev.via || []), ...(it.via || [])])];
    for (const f of ['avatar', 'name', 'text', 'quote']) if (!prev[f] && it[f]) prev[f] = it[f];
  }

  const loginWall = () => /^\/(login|i\/flow\/login)/.test(location.pathname);

  async function readTimeline() {
    const hello = await send({ type: 'scanHello' });
    if (!hello || !hello.scan) return false;

    const since = Math.max(hello.since || Date.now(), Date.now() - 48 * 3600 * 1000);
    const items = new Map();
    let responses = 0;

    const absorb = () => {
      while (RAW.length) {
        const raw = RAW.shift();
        try {
          const json = JSON.parse(raw);
          const parsed = X.fromGraphQL(json);
          if (!parsed.length && !X.hasTimeline(json)) continue;
          responses++;
          for (const it of parsed) mergeItem(items, it);
        } catch {}
      }
    };
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        absorb();
        if (fn()) return true;
        await sleep(250);
      }
      absorb();
      return fn();
    };

    const deadline = Date.now() + 22000;
    await waitFor(() => responses > 0 || loginWall(), 15000);

    if (loginWall()) {
      send({ type: 'scanDone', tweets: [], error: 'login' });
      return true;
    }

    // Older posts only if the first page did not reach back far enough. A
    // first look at an account takes the first page as it is.
    for (let i = 0; hello.deep !== false && i < 3 && Date.now() < deadline; i++) {
      const times = [...items.values()].map((t) => t.ts || 0).filter(Boolean);
      if (!times.length || Math.min(...times) < since) break;
      const seen = responses;
      window.scrollTo(0, document.documentElement.scrollHeight);
      if (!(await waitFor(() => responses > seen, 4000))) break;
    }

    // Nothing came through the network: read the rendered cards instead.
    if (!items.size && !responses) {
      await waitFor(() => document.querySelector(TWEET), 4000);
      for (const article of document.querySelectorAll(TWEET)) mergeItem(items, X.fromArticle(article));
    }

    const tweets = [...items.values()];
    send({ type: 'scanDone', tweets, error: tweets.length || responses ? '' : 'nodata' });
    return true;
  }

  // ========================================================================
  // Panel
  // ========================================================================

  const CSS = `
  :host { all: initial; }
  :host([data-theme="light"]) { --bg:#fff; --fg:#0f1419; --mut:#536471; --line:#e3e8ea; --hover:#f7f9f9; --chip:#eff3f4; }
  :host([data-theme="dim"])   { --bg:#15202b; --fg:#f7f9f9; --mut:#8b98a5; --line:#2c3d4d; --hover:#1e2732; --chip:#22303c; }
  :host([data-theme="dark"])  { --bg:#000; --fg:#e7e9ea; --mut:#71767b; --line:#2f3336; --hover:#16181c; --chip:#16181c; }
  * { box-sizing: border-box; }
  .fab { position:fixed; right:20px; bottom:88px; width:48px; height:48px; border:0; border-radius:50%;
         background:#1d9bf0; color:#fff; display:flex; align-items:center; justify-content:center;
         box-shadow:0 2px 12px rgba(0,0,0,.28); cursor:pointer; z-index:2; }
  .fab:hover { background:#1a8cd8; }
  .fab.scan { animation:pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.5 } }
  .badge { position:absolute; top:-3px; right:-3px; min-width:18px; height:18px; padding:0 5px; border-radius:9px;
           background:#f4212e; color:#fff; font:700 11px/18px system-ui,-apple-system,"PingFang SC",sans-serif; text-align:center; }
  .panel, .toast { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:16px;
                   box-shadow:0 8px 30px rgba(0,0,0,.32);
                   font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .panel { position:fixed; right:20px; bottom:148px; width:420px; max-width:calc(100vw - 28px); height:min(78vh,760px);
           display:flex; flex-direction:column; overflow:hidden; z-index:3; }
  .toast { position:fixed; right:20px; bottom:148px; width:360px; max-width:calc(100vw - 28px); padding:12px;
           max-height:calc(100vh - 180px); overflow:auto; z-index:4; animation:rise .18s ease-out; }
  @keyframes rise { from { transform:translateY(8px); opacity:0 } to { transform:none; opacity:1 } }
  .head { display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--line); }
  .head b { font-size:15px; }
  .grow { flex:1; }
  .btn { border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:999px;
         padding:5px 12px; font:600 13px/1.2 inherit; cursor:pointer; white-space:nowrap; }
  .btn:hover { background:var(--hover); }
  .btn.primary { background:#1d9bf0; border-color:#1d9bf0; color:#fff; }
  .btn.primary:hover { background:#1a8cd8; }
  .btn.icon { border:0; padding:4px 8px; font-size:16px; }
  .status { padding:8px 14px; color:var(--mut); font-size:12px; border-bottom:1px solid var(--line); }
  .status.err { color:#f4212e; }
  .tabs { display:flex; gap:6px; padding:10px 14px 0; }
  .tabs .btn.on { background:var(--chip); border-color:transparent; }
  .body { flex:1; overflow:auto; padding:10px 12px 16px; }
  .bar { display:flex; align-items:center; gap:8px; margin:0 2px 10px; }
  .item { border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:8px; cursor:pointer; }
  .item:hover { background:var(--hover); }
  .row { display:flex; align-items:center; gap:8px; }
  .av { width:26px; height:26px; border-radius:50%; background:var(--chip); flex:none; object-fit:cover; }
  .who { font-weight:700; }
  .who, .at { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .at { flex-shrink:4; }
  .time { flex:none; }
  .mut { color:var(--mut); font-size:12px; }
  .text { white-space:pre-wrap; word-break:break-word; margin:6px 0 0; }
  .text.clip { max-height:15em; overflow:hidden; }
  .toast .text { max-height:4.5em; overflow:hidden; }
  .more { display:block; border:0; background:transparent; color:#1d9bf0; padding:2px 0 0; font:13px inherit; cursor:pointer; }
  .media { display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-top:8px; }
  .media.one { grid-template-columns:1fr; }
  .media.small { display:flex; }
  .m { position:relative; display:block; min-width:0; }
  .m img { display:block; width:100%; height:128px; border-radius:10px; object-fit:cover; background:var(--chip); }
  .media.one .m img { height:200px; }
  .media.small .m img { width:72px; height:72px; border-radius:8px; }
  .m.video::after { content:'▶'; position:absolute; left:8px; bottom:8px; padding:1px 8px; border-radius:999px;
                    background:rgba(0,0,0,.65); color:#fff; font-size:11px; }
  .quote { border:1px solid var(--line); border-radius:10px; padding:6px 8px; margin-top:8px; font-size:12.5px; color:var(--mut); }
  .quote .qname { color:var(--fg); font-weight:600; }
  .meta { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:var(--mut); }
  .mark { display:inline-flex; align-items:center; flex:none; color:var(--mut); font-size:12px; }
  .mark .btn { margin:-4px -6px -4px 0; }
  .via { background:var(--chip); border-radius:999px; padding:1px 8px; }
  .sub { display:flex; align-items:center; gap:8px; padding:8px 6px; border-bottom:1px solid var(--line); }
  .field { display:flex; gap:8px; margin:10px 0 14px; }
  input[type=text], input[type=url], select { flex:1; min-width:0; background:transparent; color:var(--fg);
      border:1px solid var(--line); border-radius:10px; padding:8px 10px; font:13px inherit; }
  .opt { display:flex; align-items:center; gap:8px; margin:8px 0; font-size:13px; }
  .hint { color:var(--mut); font-size:12px; margin:10px 2px 4px; }
  .empty { color:var(--mut); text-align:center; padding:28px 10px; font-size:13px; }
  .trow { display:flex; align-items:center; gap:8px; }
  @media (max-width:640px) {
    .panel, .toast { right:8px; left:8px; width:auto; bottom:96px; height:auto; max-height:70vh; }
  }`;

  const SVG_TAGS = new Set(['svg', 'circle', 'path']);
  const h = (tag, props, ...kids) => {
    const el = SVG_TAGS.has(tag)
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  };

  const host = document.createElement('div');
  host.id = 'xfr-host';
  host.dataset.v = VERSION;
  const root = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.append(h('style', { text: CSS }));
  }

  // ------------------------------------------------------------------ state

  const KEY = { SUBS: 'xfr_subs', SET: 'xfr_settings', TWEETS: 'xfr_tweets', META: 'xfr_meta' };
  let S = { subs: [], settings: {}, tweets: {}, meta: {} };
  let tab = 'unread';
  let open = false;
  let checking = false;
  const popped = new Set();
  // Read while the panel was open: it keeps its place until the panel is
  // closed, so the list does not jump under the reader.
  const kept = new Set();
  // Marked read on this page, not yet confirmed by storage.
  const pending = new Set();
  const subsSet = () => new Set(S.subs.map((s) => s.handle.toLowerCase()));

  const ago = (ts) => {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    if (d < 7 * 86400000) return `${Math.floor(d / 86400000)} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  };
  const ERRORS = {
    login: '你没有登录 X，请先登录再检查',
    timeout: '后台页面加载超时',
    closed: '后台页面被关闭',
    nodata: '暂时未能读取 X 数据，请重试',
  };

  const byTsDesc = (a, b) => (b.ts || 0) - (a.ts || 0);
  const allTweets = () => Object.values(S.tweets).sort(byTsDesc);
  const isRead = (t) => t.state === 'read' || pending.has(t.id);
  const unread = () => allTweets().filter((t) => !isRead(t));

  // -------------------------------------------------------------- rendering

  const body = h('div', { class: 'body' });
  const tabs = h('div', { class: 'tabs' });
  const status = h('div', { class: 'status' });
  const title = h('b', { text: '关注雷达' });
  const fab = h(
    'button',
    { class: 'fab', title: '关注雷达', onclick: () => setOpen(!open) },
    h(
      'svg',
      { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
      h('circle', { cx: '12', cy: '12', r: '3', fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: '12', cy: '12', r: '7', 'stroke-opacity': '.75' }),
      h('circle', { cx: '12', cy: '12', r: '10.5', 'stroke-opacity': '.45' })
    ),
    h('span', { class: 'badge', style: 'display:none' })
  );
  const panel = h(
    'div',
    { class: 'panel', style: 'display:none' },
    h(
      'div',
      { class: 'head' },
      title,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', text: '检查', onclick: () => forceCheck() }),
      h('button', { class: 'btn icon', text: '✕', onclick: () => setOpen(false) })
    ),
    status,
    tabs,
    body
  );
  const toastBox = h('div', { class: 'toast', style: 'display:none' });
  root.append(fab, panel, toastBox);

  function updateFab() {
    const n = unread().length;
    const b = fab.querySelector('.badge');
    b.textContent = n > 99 ? '99+' : String(n);
    b.style.display = n ? '' : 'none';
    fab.classList.toggle('scan', checking);
  }

  function renderTabs() {
    const n = unread().length;
    const items = [
      ['unread', `未读 ${n ? n : ''}`.trim()],
      ['all', '全部'],
      ['subs', `博主 ${S.subs.length}`],
    ];
    tabs.replaceChildren(
      ...items.map(([k, label]) =>
        h('button', {
          class: `btn ${tab === k ? 'on' : ''}`,
          text: label,
          onclick: () => {
            tab = k;
            render();
            body.scrollTop = 0;
          },
        })
      )
    );
  }

  function renderStatus() {
    const m = S.meta || {};
    const parts = [m.lastCheck ? `上次成功更新 ${ago(m.lastCheck)}` : '尚未成功更新'];
    const backlog = (m.lastUnread || 0) - (m.lastFresh || 0);
    const err = !checking && m.lastError;
    if (checking) parts.push('正在检查…');
    else if (err) parts.push('更新失败，当前为缓存');
    else if (m.lastFresh) parts.push(`发现 ${m.lastFresh} 条新推文`);
    else if (backlog > 0) parts.push(`取回 ${backlog} 条最近的推文`);
    else if (m.lastCheck) parts.push('没有新推文');
    status.className = err ? 'status err' : 'status';
    status.textContent = err ? `${parts.join(' · ')} · ${ERRORS[err] || err}` : parts.join(' · ');
  }

  // Top right of a card: a "mark as read" button while the post is unread,
  // a note once it has been read during this visit to the panel.
  const markKind = (t) => (kept.has(t.id) ? 'kept' : isRead(t) ? 'read' : 'unread');
  function markEl(t) {
    const kind = markKind(t);
    const el = h('span', { class: 'mark', 'data-kind': kind });
    if (kind === 'kept') el.textContent = '已看';
    if (kind === 'unread') {
      el.append(
        h('button', {
          class: 'btn icon',
          text: '✓',
          title: '标记为已读',
          onclick: (e) => {
            e.stopPropagation();
            markReadHere([t.id], false);
          },
        })
      );
    }
    return el;
  }

  function itemEl(t, opts) {
    const compact = !!(opts && opts.compact);
    const more = (opts && opts.more) || 0;
    const via = (t.via || []).filter(Boolean);
    const media = (t.media || []).slice(0, compact ? 2 : 4);
    return h(
      'div',
      { class: 'item', 'data-id': t.id, onclick: () => openItem(t) },
      h(
        'div',
        { class: 'row' },
        t.avatar ? h('img', { class: 'av', src: t.avatar, loading: 'lazy' }) : h('span', { class: 'av' }),
        h('span', { class: 'who', text: t.name || t.handle }),
        h('span', { class: 'mut at', text: `@${t.handle}` }),
        h('span', { class: 'grow' }),
        h('span', { class: 'mut time', text: ago(t.ts) }),
        markEl(t)
      ),
      t.text ? h('div', { class: compact ? 'text' : 'text clip', text: compact ? t.text.slice(0, 180) : t.text }) : null,
      media.length
        ? h(
            'div',
            { class: `media ${compact ? 'small' : media.length === 1 ? 'one' : ''}`.trim() },
            media.map((m) =>
              h('span', { class: m.type && m.type !== 'photo' ? 'm video' : 'm' }, h('img', { src: m.url, loading: 'lazy', alt: '' }))
            )
          )
        : null,
      t.quote && t.quote.text
        ? h(
            'div',
            { class: 'quote' },
            h('div', { class: 'qname', text: `引用 @${t.quote.handle || t.quote.name || ''}` }),
            h('div', { class: 'text clip', text: t.quote.text })
          )
        : null,
      via.length || more
        ? h(
            'div',
            { class: 'meta' },
            via.length ? h('span', { class: 'via', text: `${via.map((v) => '@' + v).join('、')} 转推` }) : null,
            more ? h('span', { text: `+${more} 条连续推文` }) : null
          )
        : null
    );
  }

  // Each view says what it would draw (`sig`) and how. The body is only
  // rebuilt when that changes, so a card being read or a check finishing does
  // not move the list or wipe what is being typed.

  function unreadView() {
    const heads = allTweets().filter((t) => !isRead(t) || kept.has(t.id));
    const waiting = S.subs.some((s) => !s.primed);
    const empty = S.subs.length || S.settings.listUrl ? (waiting ? 'wait' : 'done') : 'none';
    return {
      sig: `unread|${heads.map((t) => t.id).join(',')}|${empty}`,
      build() {
        if (!heads.length) return [emptyUnread(empty)];
        // Newest first, whoever posted it.
        return [
          h(
            'div',
            { class: 'bar' },
            h('span', { class: 'mut', text: '看过的推文，下次不再显示' }),
            h('span', { class: 'grow' }),
            h('button', {
              class: 'btn',
              text: '全部已读',
              onclick: () => {
                kept.clear();
                for (const t of unread()) pending.add(t.id);
                send({ type: 'markAllRead' });
                updateFab();
                render();
              },
            })
          ),
          ...heads.map((t) => itemEl(t)),
        ];
      },
    };
  }

  function emptyUnread(kind) {
    if (kind === 'none') {
      return h(
        'div',
        { class: 'empty' },
        h('div', { text: '还没有订阅博主。' }),
        h('button', {
          class: 'btn primary',
          style: 'margin-top:12px',
          text: '添加博主',
          onclick: () => {
            tab = 'subs';
            render();
          },
        })
      );
    }
    if (kind === 'wait') return h('div', { class: 'empty', text: '正在取回刚订阅博主最近的推文，稍等几秒…' });
    return h('div', { class: 'empty', text: '都看完了。博主发新推文时会出现在这里，并弹窗提醒。' });
  }

  function allView() {
    const list = allTweets().slice(0, 300);
    return {
      sig: `all|${list.map((t) => t.id).join(',')}`,
      build() {
        if (!list.length) return [h('div', { class: 'empty', text: '还没有记录。' })];
        return list.map((t) => itemEl(t));
      },
    };
  }

  function settingsBlock() {
    const s = S.settings || {};
    const interval = h(
      'select',
      {
        onchange: (e) => send({ type: 'setSettings', patch: { intervalMin: Number(e.target.value) } }),
      },
      ...[15, 30, 60, 120, 240].map((v) =>
        h('option', { value: v, selected: Number(s.intervalMin || 30) === v, text: `${v} 分钟` })
      )
    );
    const checkbox = (label, key, value) =>
      h(
        'label',
        { class: 'opt' },
        h('input', {
          type: 'checkbox',
          checked: value,
          onchange: (e) => send({ type: 'setSettings', patch: { [key]: e.target.checked } }),
        }),
        h('span', { text: label })
      );
    const listInput = h('input', { type: 'url', value: s.listUrl || '', placeholder: '可选：https://x.com/i/lists/…' });
    const commit = () => send({ type: 'setSettings', patch: { listUrl: listInput.value.trim() } });
    listInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
    });
    return [
      h('div', { class: 'hint', text: '检查间隔' }),
      h('div', { class: 'opt' }, interval, h('span', { class: 'mut', text: '打开 X 时按此间隔检查' })),
      checkbox('发现新推文时弹窗提醒', 'popup', s.popup !== false),
      checkbox('把博主的转推也算成更新', 'retweets', !!s.retweets),
      h('div', { class: 'hint', text: '名单链接（可选，把你已有的 X 列表也一起检查）' }),
      h('div', { class: 'field' }, listInput, h('button', { class: 'btn', text: '保存', onclick: commit })),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'btn',
          text: '清空历史',
          onclick: () => {
            if (confirm('清空已抓到的推文记录？订阅名单会保留。')) send({ type: 'clearHistory' });
          },
        })
      ),
    ];
  }

  function subsView() {
    const s = S.settings || {};
    const subs = S.subs.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return {
      sig: 'subs|' + JSON.stringify([subs.map((x) => [x.handle, x.name, x.avatar, !!x.primed]), s.intervalMin, s.popup, s.retweets, s.listUrl]),
      build() {
        const input = h('input', { type: 'text', placeholder: '@博主或主页链接', value: '' });
        const add = () => {
          const handle = X.handleFrom(input.value);
          input.value = '';
          if (!handle) {
            input.placeholder = '看不清这个账号名，试试 @名字 或主页链接';
            return;
          }
          send({ type: 'addSub', handle });
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') add();
        });
        return [
          h('div', { class: 'field' }, input, h('button', { class: 'btn primary', text: '添加', onclick: add })),
          h('div', { class: 'hint', text: '在 X 上也可以：博主主页点“＋ 雷达”、鼠标悬停账号卡片、或右键任意链接。' }),
          ...subs.map((x) =>
            h(
              'div',
              { class: 'sub' },
              x.avatar ? h('img', { class: 'av', src: x.avatar }) : h('span', { class: 'av' }),
              h(
                'div',
                { class: 'grow' },
                h('div', { text: x.name || x.handle }),
                h('div', {
                  class: 'mut',
                  text: `@${x.handle} · ${ago(x.addedAt)}加入${x.primed ? '' : ' · 正在取回最近的推文'}`,
                })
              ),
              h('button', { class: 'btn', text: '移除', onclick: () => send({ type: 'removeSub', handle: x.handle }) })
            )
          ),
          h('div', { class: 'hint', text: '设置' }),
          ...settingsBlock(),
          h('div', { class: 'hint ver', text: `X 关注雷达 ${VERSION}` }),
        ];
      },
    };
  }

  let drawn = '';
  function render() {
    if (!open) return;
    renderTabs();
    renderStatus();
    title.textContent = `关注雷达 · ${S.subs.length} 位博主`;
    const view = tab === 'unread' ? unreadView() : tab === 'all' ? allView() : subsView();
    if (view.sig === drawn) {
      refreshMarks();
      return;
    }
    drawn = view.sig;
    const typing = !!root.activeElement && root.activeElement.matches('input[type=text]');
    body.replaceChildren(...view.build());
    afterDraw();
    if (typing) {
      const input = body.querySelector('input[type=text]');
      if (input) input.focus(); // adding several accounts in a row
    }
  }

  // The cards are in place: watch them, and offer "expand" on long text.
  function afterDraw() {
    stopWatching();
    for (const el of body.querySelectorAll('.item[data-id]')) cardWatch.observe(el);
    for (const el of body.querySelectorAll('.text.clip')) {
      if (el.scrollHeight <= el.clientHeight + 4) continue;
      el.after(
        h('button', {
          class: 'more',
          text: '展开',
          onclick: (e) => {
            e.stopPropagation();
            el.classList.remove('clip');
            e.target.remove();
          },
        })
      );
    }
  }

  // Bring the marks on the cards in step with what is known now.
  function refreshMarks() {
    for (const el of body.querySelectorAll('.item[data-id]')) {
      const t = S.tweets[el.dataset.id];
      const slot = el.querySelector('.mark');
      if (t && slot && slot.dataset.kind !== markKind(t)) slot.replaceWith(markEl(t));
    }
  }

  function setOpen(v) {
    if (gone()) return;
    const opening = v && !open;
    open = v;
    panel.style.display = v ? 'flex' : 'none';
    if (v) {
      tab = 'unread';
      hideToast();
      theme();
      place();
      drawn = '';
      render();
      body.scrollTop = 0;
      const fresh = Object.values(S.tweets).filter((t) => t.state === 'new');
      if (fresh.length) send({ type: 'markShown', ids: fresh.map((t) => t.id) });
      if (opening && (S.subs.length || S.settings.listUrl)) requestCheck(true, true);
    } else {
      stopWatching();
      flushRead();
      kept.clear();
    }
  }

  // ------------------------------------------------------- read in the panel
  // A card that stayed in view for a moment counts as read. It keeps its place
  // until the panel is closed, and is left out of "unread" from then on.

  const DWELL = 1500;
  const dwell = new Map(); // post id -> timer
  const readQueue = new Set();
  let readTimer = 0;

  function flushRead() {
    clearTimeout(readTimer);
    readTimer = 0;
    if (!readQueue.size) return;
    const ids = [...readQueue];
    readQueue.clear();
    send({ type: 'markRead', ids });
  }

  // `keep`: leave the cards where they are for now (the user is reading).
  function markReadHere(ids, keep) {
    for (const id of ids) {
      pending.add(id);
      readQueue.add(id);
      if (keep && open) kept.add(id);
    }
    clearTimeout(readTimer);
    readTimer = setTimeout(flushRead, 800);
    updateFab();
    render();
  }

  const cardWatch = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = e.target.dataset.id;
        const inView =
          e.isIntersecting &&
          e.intersectionRect.height >= Math.min(e.boundingClientRect.height * 0.6, body.clientHeight * 0.5);
        if (!inView) {
          clearTimeout(dwell.get(id));
          dwell.delete(id);
          continue;
        }
        if (dwell.has(id)) continue;
        dwell.set(
          id,
          setTimeout(() => {
            dwell.delete(id);
            const t = S.tweets[id];
            if (!open || !t || isRead(t) || document.visibilityState !== 'visible') return;
            markReadHere([id], true);
          }, DWELL)
        );
      }
    },
    { root: body, threshold: [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1] }
  );

  function stopWatching() {
    cardWatch.disconnect();
    for (const timer of dwell.values()) clearTimeout(timer);
    dwell.clear();
  }

  // ------------------------------------------------------------------ toast

  let toastTimer = 0;
  // Either a line of text (with an optional button), or a list of new posts.
  function showToast(text, list, action) {
    const hide = () => h('button', { class: 'btn icon', text: '✕', onclick: () => hideToast() });
    toastBox.replaceChildren();
    if (text) {
      toastBox.append(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'grow', text }),
          action
            ? h('button', {
                class: 'btn primary',
                text: action.label,
                onclick: () => {
                  hideToast();
                  action.run();
                },
              })
            : null,
          hide()
        )
      );
    } else {
      const authors = new Set(list.map((t) => t.handle.toLowerCase()));
      toastBox.append(
        h(
          'div',
          { class: 'head', style: 'padding:0 0 8px;border:0' },
          h('b', { text: `${authors.size} 位博主有 ${list.length} 条新推文` }),
          h('span', { class: 'grow' }),
          hide()
        )
      );
      for (const t of list.slice(0, 3)) toastBox.append(itemEl(t, { compact: true }));
      toastBox.append(
        h(
          'div',
          { class: 'row', style: 'margin-top:6px' },
          h('span', { class: 'grow' }),
          h('button', {
            class: 'btn primary',
            text: '查看全部',
            onclick: () => {
              tab = 'unread';
              setOpen(true);
            },
          })
        )
      );
    }
    toastBox.style.display = 'block';
    theme();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 20000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    toastBox.style.display = 'none';
  }

  function maybePopup() {
    const fresh = Object.values(S.tweets).filter((t) => t.state === 'new' && !popped.has(t.id)).sort(byTsDesc);
    if (!fresh.length || checking) return;
    if (open) {
      fresh.forEach((t) => popped.add(t.id));
      send({ type: 'markShown', ids: fresh.map((t) => t.id) });
      return;
    }
    if (S.settings.popup === false) return;
    if (document.visibilityState !== 'visible') return;
    fresh.forEach((t) => popped.add(t.id));
    showToast(null, fresh);
    send({ type: 'markShown', ids: fresh.map((t) => t.id) });
  }

  // The latest posts of a newly added account have arrived. They are not
  // "new posts", so this is a one-line note rather than the popup.
  let noted = Date.now();
  function firstLookNote() {
    const p = S.meta.primed;
    if (!p || !(p.at > noted)) return;
    noted = p.at;
    if (open || Date.now() - p.at > 20000 || document.visibilityState !== 'visible') return;
    const who = p.handles.length === 1 ? `@${p.handles[0]}` : `${p.handles.length} 位博主`;
    if (p.count) {
      showToast(`已取回 ${who} 最近的 ${p.count} 条推文`, null, {
        label: '查看',
        run: () => {
          tab = 'unread';
          setOpen(true);
        },
      });
    } else {
      showToast(`${who} 最近没有可显示的推文，发新推文时会提醒你`, null);
    }
  }

  function openItem(t) {
    window.open(t.url, '_blank', 'noopener');
    markReadHere([t.id], true);
  }

  // ------------------------------------------------------------------ theme

  function theme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    const [r, g, b] = (m || [255, 255, 255]).map(Number);
    const sum = r + g + b;
    host.dataset.theme = sum > 600 ? 'light' : sum < 10 ? 'dark' : 'dim';
  }

  // -------------------------------------------------------- button position
  // Sit above X's own floating buttons, and step up if another extension's
  // button is already there (Rewind for X, for instance).

  const DOCK = '[data-testid="GrokDrawerHeader"], [data-testid="chat-drawer-main"], [data-testid^="FloatingActionButtons"]';
  const TAB_BAR = '[data-testid="BottomBar"]';

  function taken(right, bottom) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const x = vw - right - 24;
    const y = vh - bottom - 24;
    for (let el of document.elementsFromPoint(x, y)) {
      if (el === host) continue;
      if (el.shadowRoot) el = el.shadowRoot.elementsFromPoint(x, y)[0] || el;
      else if (getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width <= 90 && r.height > 20) return true;
    }
    return false;
  }

  function place() {
    let top = Infinity;
    let right = 0;
    for (const el of document.querySelectorAll(DOCK)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top < 80) continue;
      if (r.top < top) {
        top = r.top;
        right = r.right;
      }
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let bottom = 88;
    let rt = 20;
    if (top !== Infinity) {
      bottom = Math.round(vh - top + 12);
      rt = Math.round(vw - right);
    } else {
      const bar = document.querySelector(TAB_BAR);
      const r = bar && bar.getBoundingClientRect();
      if (r && r.height && r.top > vh / 2) bottom = Math.round(vh - r.top + 16);
    }
    for (let i = 0; i < 3 && taken(rt, bottom); i++) bottom += 56;
    fab.style.right = `${rt}px`;
    fab.style.bottom = `${bottom}px`;
    if (open) {
      panel.style.right = `${Math.min(rt, 20)}px`;
      panel.style.bottom = `${bottom + 60}px`;
      // Moving above X's dock also reduces the available vertical space.
      panel.style.maxHeight = `${Math.max(0, vh - bottom - 60 - 12)}px`;
    }
    toastBox.style.right = `${Math.min(rt, 20)}px`;
    toastBox.style.bottom = `${bottom + 60}px`;
    toastBox.style.maxHeight = `${Math.max(0, vh - bottom - 60 - 12)}px`;
  }

  // ------------------------------------------------------- "add" affordances

  function btnLabel(btn, handle) {
    const on = subsSet().has(handle.toLowerCase());
    const inline = btn.dataset.xfrPlacement === 'tweet';
    const label = on ? (inline ? '查看雷达' : '✓ 已在雷达') : '＋ 雷达';
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.dataset.xfrHandle !== handle) btn.dataset.xfrHandle = handle;
    const title = on && inline ? '打开未读列表' : `${on ? '取消订阅' : '订阅'} @${handle}`;
    if (btn.title !== title) btn.title = title;
  }

  function makeBtn(handle, extra) {
    const btn = h('button', {
      type: 'button',
      style:
        'height:34px;padding:0 14px;margin-right:8px;border-radius:999px;border:1px solid currentColor;' +
        'background:transparent;color:inherit;font:700 13px/1 system-ui,-apple-system,"PingFang SC",sans-serif;cursor:pointer;white-space:nowrap;',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (gone()) return;
        const h2 = btn.dataset.xfrHandle || handle;
        if (subsSet().has(h2.toLowerCase())) {
          if (extra && extra.inline) {
            setOpen(true);
            return;
          }
          await send({ type: 'removeSub', handle: h2 });
          showToast(`已把 @${h2} 移出名单`, null);
        } else {
          await send({ type: 'addSub', handle: h2, name: extra && extra.name, avatar: extra && extra.avatar });
          showToast(`已订阅 @${h2}，正在取回最近的推文…`, null);
          if (extra && extra.inline) {
            await sync();
            setOpen(true);
          }
        }
      },
    });
    btn.dataset.xfr = 'btn';
    if (extra && extra.inline) {
      btn.dataset.xfrPlacement = 'tweet';
      btn.style.cssText += 'display:inline-flex;align-items:center;justify-content:center;align-self:center;height:24px;padding:0 8px;margin:0 0 0 8px;border:0;background:rgba(29,155,240,.1);font-size:12px;font-weight:600;flex:0 0 auto;vertical-align:middle;color:rgb(29,155,240);';
    }
    mine.add(btn);
    if (handle) btnLabel(btn, handle);
    return btn;
  }

  const authorLines = new Set();
  const entryStyle = h('style', { text: `
    [data-xfr-author-line] {display:flex!important;flex-direction:row!important;align-items:center!important;min-width:0}
    button[data-xfr-placement="tweet"]:hover {background:rgba(29,155,240,.2)!important}
    button[data-xfr-placement="tweet"]:focus-visible {outline:2px solid rgb(29,155,240);outline-offset:2px}
  ` });

  function scanPage() {
    if (!entryStyle.isConnected) document.documentElement.append(entryStyle);
    // Inline entry beside the timestamp of the outer post, never a quote's author.
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const row = article.querySelector('[data-testid="User-Name"]');
      if (!row) continue;
      const link = [...row.querySelectorAll('a[href]')].find((a) => X.handleFrom(a.getAttribute('href')));
      const handle = link && X.handleFrom(link.getAttribute('href'));
      if (!handle) continue;
      let btn = row.querySelector('button[data-xfr-placement="tweet"]');
      if (!btn) {
        btn = makeBtn(handle, { inline: true });
        const time = row.querySelector('time');
        const timestamp = time && time.closest('a');
        if (timestamp) {
          (timestamp.parentElement !== row && !timestamp.parentElement.closest('a')
            ? timestamp.parentElement : row).append(btn);
        } else {
          // Detail posts stack name and handle vertically. Use the name's own
          // line rather than append a third line below the handle.
          const nameLine = link.parentElement;
          nameLine.setAttribute('data-xfr-author-line', '');
          authorLines.add(nameLine);
          nameLine.append(btn);
        }
      } else {
        btnLabel(btn, handle);
      }
    }
    // Profile header
    const actions = document.querySelector('[data-testid="userActions"]');
    if (actions && actions.parentElement) {
      const handle = X.handleFrom(location.pathname);
      if (handle) {
        let btn = actions.parentElement.querySelector('button[data-xfr="btn"]');
        if (!btn) {
          const nameEl = document.querySelector('[data-testid="UserName"]');
          const avatarEl = document.querySelector('a[href$="/photo"] img');
          btn = makeBtn(handle, {
            name: ((nameEl && nameEl.querySelector('span')) || { textContent: '' }).textContent.trim(),
            avatar: (avatarEl && avatarEl.src) || '',
          });
          // X's own controls reserve space below; align to their top edge.
          btn.style.cssText += 'align-self:flex-start;height:36px;margin-bottom:12px;';
          actions.parentElement.insertBefore(btn, actions);
        } else if (btn.dataset.xfrHandle !== handle) {
          btnLabel(btn, handle);
        }
      }
    }
    // Account hover cards
    for (const card of document.querySelectorAll('[data-testid="HoverCard"]')) {
      if (card.querySelector('button[data-xfr="btn"]')) continue;
      const link = card.querySelector('a[href^="/"][role="link"]');
      const handle = link && X.handleFrom(link.getAttribute('href'));
      if (!handle) continue;
      const follow = card.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]');
      const btn = makeBtn(handle);
      if (follow) {
        const wrap = follow.closest('div') || follow;
        (wrap.parentElement || card).insertBefore(btn, wrap);
      } else {
        (card.firstElementChild || card).append(btn);
      }
    }
    // Keep labels in step with the watch list
    for (const btn of document.querySelectorAll('button[data-xfr="btn"]')) {
      if (btn.dataset.xfrHandle) btnLabel(btn, btn.dataset.xfrHandle);
    }
  }

  // ------------------------------------------------------------- read guard
  // A post the user actually looked at on any timeline is treated as read, so
  // it is never announced or listed afterwards.

  const timelineDwell = new Map();
  function stopTimelineWatching() {
    io.disconnect();
    for (const timer of timelineDwell.values()) clearTimeout(timer);
    timelineDwell.clear();
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        clearTimeout(timelineDwell.get(e.target));
        timelineDwell.delete(e.target);
        const shown = e.intersectionRect.height;
        const enough = e.isIntersecting && shown >= Math.min(e.boundingClientRect.height * 0.5, innerHeight * 0.4);
        const head = enough && X.idOfArticle(e.target);
        if (!head || document.visibilityState !== 'visible') continue;
        timelineDwell.set(e.target, setTimeout(() => {
          timelineDwell.delete(e.target);
          if (!alive() || document.visibilityState !== 'visible' || !e.target.isConnected) return;
          const current = X.idOfArticle(e.target);
          if (!current || current.id !== head.id) return;
          if (subsSet().has(head.handle.toLowerCase()) || S.tweets[head.id]) queueSeen(head.id);
        }, 900));
      }
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] }
  );
  const watch = new Set();
  const seenQueue = new Set();
  let seenTimer = 0;
  function queueSeen(id) {
    seenQueue.add(id);
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      const ids = [...seenQueue];
      seenQueue.clear();
      if (ids.length) send({ type: 'seen', ids });
    }, 3000);
  }
  let scanQueued = false;
  function scanArticles() {
    scanQueued = false;
    for (const el of watch) {
      if (!el.isConnected) {
        io.unobserve(el);
        watch.delete(el);
      }
    }
    for (const el of document.querySelectorAll(TWEET)) {
      if (!watch.has(el)) {
        watch.add(el);
        io.observe(el);
      }
    }
  }

  // ------------------------------------------------------------------- sync

  let syncTimer = 0;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 250);
  }

  async function sync() {
    if (gone()) return;
    const d = await chrome.storage.local.get([KEY.SUBS, KEY.SET, KEY.TWEETS, KEY.META]);
    S = {
      subs: d[KEY.SUBS] || [],
      settings: d[KEY.SET] || {},
      tweets: d[KEY.TWEETS] || {},
      meta: d[KEY.META] || {},
    };
    for (const id of pending) {
      const t = S.tweets[id];
      if (!t || t.state === 'read') pending.delete(id); // storage has caught up
    }
    checking = !!S.meta.checking && Date.now() - (S.meta.checkingAt || 0) < 3 * 60000;
    updateFab();
    render();
    scanPage();
    firstLookNote();
    maybePopup();
  }

  async function requestCheck(force, opening = false) {
    const r = await send({ type: 'check', force, catchUp: opening });
    if (r && r.started) {
      checking = true;
      updateFab();
      render();
    } else if (!opening && force && r && r.reason === 'empty') {
      showToast('名单还是空的，先添加一位博主', null);
    } else if (!opening && force && r && r.reason === 'busy') {
      showToast('正在检查中，稍等几秒', null);
    }
  }
  const forceCheck = () => requestCheck(true);

  function maybeCheck() {
    if (document.visibilityState !== 'visible' || checking) return;
    if (!S.subs.length && !S.settings.listUrl) return;
    const interval = (S.settings.intervalMin || 30) * 60000;
    const m = S.meta || {};
    if (Date.now() - Math.max(m.lastAttempt || 0, m.lastCheck || 0) < interval - 5000) return;
    requestCheck(false);
  }

  // ----------------------------------------------------------------- retire
  // After an update, a reload, or being switched off, this copy can no longer
  // reach the extension. Take its controls off the page rather than leave
  // buttons that do nothing; the new copy brings its own.

  const life = new AbortController();
  const mine = new WeakSet(); // "add to radar" buttons this copy put on the page
  let mo = null;

  function retire() {
    if (life.signal.aborted) return;
    life.abort();
    if (mo) mo.disconnect();
    stopTimelineWatching();
    stopWatching();
    clearTimeout(toastTimer);
    clearTimeout(seenTimer);
    clearTimeout(syncTimer);
    clearTimeout(readTimer);
    host.remove();
    entryStyle.remove();
    for (const line of authorLines) line.removeAttribute('data-xfr-author-line');
    authorLines.clear();
    for (const btn of document.querySelectorAll('button[data-xfr="btn"]')) if (mine.has(btn)) btn.remove();
  }
  const gone = () => {
    if (alive()) return false;
    retire();
    return true;
  };

  // ------------------------------------------------------------------- boot

  function bootNormal() {
    // Left over from a copy of this script that ran before an update.
    for (const stale of document.querySelectorAll('#xfr-host, button[data-xfr="btn"]')) stale.remove();
    document.documentElement.append(host);
    theme();
    place();
    sync();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (Object.keys(changes).some((k) => k.startsWith('xfr_'))) scheduleSync();
    });
    // The reply tells the worker this page has a working script.
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg) return;
      if (msg.type === 'toggle') setOpen(!open);
      else if (msg.type === 'open') setOpen(true);
      else if (msg.type === 'toast') showToast(msg.text, null);
      else return;
      reply({ ok: true });
    });

    let pageTimer = 0;
    mo = new MutationObserver(() => {
      if (gone()) return;
      if (!scanQueued) {
        scanQueued = true;
        requestAnimationFrame(scanArticles);
      }
      if (pageTimer) return;
      pageTimer = setTimeout(() => {
        pageTimer = 0;
        if (gone()) return;
        if (!host.isConnected) document.documentElement.append(host); // the page was rebuilt around us
        scanPage();
        place();
      }, 400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    const on = { signal: life.signal };
    window.addEventListener('resize', place, on);
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && open) setOpen(false);
      },
      on
    );
    // Keys pressed inside the panel stay inside it, so typing a name does not
    // set off X's own keyboard shortcuts.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      host.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape' && open) setOpen(false);
      });
    }
    document.addEventListener(
      'visibilitychange',
      () => {
        if (gone()) return;
        if (document.visibilityState !== 'visible') {
          flushRead();
          stopWatching();
          stopTimelineWatching();
          return;
        }
        stopTimelineWatching();
        for (const el of watch) io.observe(el);
        stopWatching();
        if (open) for (const el of body.querySelectorAll('.item[data-id]')) cardWatch.observe(el);
        maybePopup();
        maybeCheck();
      },
      on
    );

    scanPage();
    scanArticles();
    setTimeout(() => {
      sync();
      maybeCheck();
    }, 1500);
  }

  const whenReady = (fn) => {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  };

  if (window.top !== window.self) return;
  if (location.hash.includes(SCAN_MARK)) {
    readTimeline().then((ok) => {
      if (!ok) whenReady(bootNormal);
    });
  } else {
    whenReady(bootNormal);
  }
})();
