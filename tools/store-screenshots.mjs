// Render the real extension with clearly labelled demonstration data.
// Reuses the offline X fixture from the acceptance suite; never reads a real account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const test = fs.readFileSync(path.join(root, 'test/e2e.mjs'), 'utf8');
const marker = "  console.log('\\n1. 从博主主页快速添加');";
if (!test.includes(marker)) throw new Error('Offline fixture setup changed');
const prefix = test.slice(0, test.indexOf(marker)).replace(
  "const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
  `const EXT = ${JSON.stringify(root)};`
);
const capture = String.raw`
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('https://x.com/home');
  await page.locator('#xfr-host .fab').waitFor();
  await (await worker()).evaluate(async () => {
    const now = Date.now();
    const subs = [{ handle: 'radar_product', name: '产品观察', primed: true, addedAt: now - 86400000 },
      { handle: 'radar_tech', name: '科技日刊', primed: true, addedAt: now - 86400000 }];
    const texts = ['今天的产品更新，终于不用翻时间线找了。\n\n把关注的博主加入雷达，更新集中在一个列表里。看过的内容会保留在历史中，下次打开只看未读。',
      '少一点重复刷，多一点认真读。\n\n这周想关注的三个方向：开源工具、产品设计、AI 开发实践。',
      '一个值得保存的小习惯：先读你主动选择的信息，再决定要不要看推荐流。'];
    const tweets = Object.fromEntries(texts.map((text, i) => {
      const id = String(88001 + i), author = subs[i % 2];
      return [id, { id, handle: author.handle, name: author.name, text, conv: id,
        ts: now - (i + 1) * 360000, url: 'https://x.com/' + author.handle + '/status/' + id,
        state: 'shown', seen: false, media: [], via: [] }];
    }));
    await chrome.storage.local.set({ xfr_subs: subs, xfr_tweets: tweets,
      xfr_meta: { lastCheck: now, checking: false, lastCount: 3 } });
  });
  await page.evaluate(() => {
    document.body.style.cssText = 'background:#000;color:#e7e9ea;font:15px system-ui;margin:0';
    document.body.innerHTML = '<aside style="position:fixed;left:36px;top:34px;width:160px;font-size:20px;line-height:2.8;font-weight:600">X<br>首页<br>探索<br>通知<br>书签<br>个人资料</aside><main style="margin-left:222px;width:570px;border-left:1px solid #2f3336;border-right:1px solid #2f3336;min-height:800px"><header style="padding:30px 24px;border-bottom:1px solid #2f3336"><div style="color:#1d9bf0;font-size:13px">X 关注雷达 · 功能演示</div><h1 style="font-size:32px;line-height:1.3;margin:16px 0">只追你关心的</h1><p style="color:#71767b">新帖集中看，已读不重复。</p></header><article data-testid="tweet" style="padding:24px;border-bottom:1px solid #2f3336"><div data-testid="User-Name" style="display:flex;gap:8px;align-items:center"><a href="/radar_product" style="color:inherit;font-weight:700;text-decoration:none">产品观察</a><div style="display:flex;gap:8px;align-items:center"><span style="color:#71767b">@radar_product ·</span><a href="/radar_product/status/88001" style="color:#71767b;text-decoration:none"><time>6 分钟前</time></a></div></div><div data-testid="tweetText" style="line-height:1.8;margin-top:18px">今天的产品更新，终于不用翻时间线找了。<br><br>把关心的博主加入名单，在右侧雷达里集中阅读。</div><div style="color:#71767b;margin-top:24px">♡　 ↗　 ▢</div></article><article style="padding:24px;border-bottom:1px solid #2f3336;line-height:1.8"><b>科技日刊</b><span style="color:#71767b">　@radar_tech</span><p>少一点重复刷，多一点认真读。</p></article><p style="padding:24px;color:#71767b;font-size:12px">示例页面与演示内容，非真实用户帖子。</p></main>';
  });
  await page.locator('button[data-xfr-placement="tweet"]').waitFor();
  await page.locator('#xfr-host .fab').click();
  await cards.first().waitFor();
  const out = path.join(EXT, 'store/assets');
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, '01-unread.png') });
  await tabBtn('博主').click();
  await page.screenshot({ path: path.join(out, '02-authors.png') });
  await tabBtn('全部').click();
  await page.screenshot({ path: path.join(out, '03-history.png') });
  console.log('Store screenshots saved to', out);
`;
const suffix = test.slice(test.lastIndexOf('} catch (e) {\n  failed++;'));
const runner = path.join(os.tmpdir(), `xfr-store-${process.pid}.mjs`);
try {
  fs.writeFileSync(runner, prefix + capture + suffix);
  const result = spawnSync(process.execPath, [runner], { stdio: 'inherit', env: {
    ...process.env, PW: process.env.PW || path.join(root, 'node_modules/playwright')
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally { fs.rmSync(runner, { force: true }); }
