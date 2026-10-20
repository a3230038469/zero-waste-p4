// shoot-html.mjs — 零依赖 CDP：把本地 HTML 按多个宽度整页截图（含横向溢出体检）
// 用法： $env:HTML='.agent\audit\mock\home-redesign.html'; $env:WIDTHS='1440,390'; $env:TAG='redesign'; node .agent\audit\tools\shoot-html.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CHROME ||
  'C:\\Users\\a3230\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const HTML = path.resolve(process.env.HTML || '.agent/audit/mock/home-redesign.html');
const OUT = path.resolve(process.env.OUT || path.dirname(HTML));
const TAG = process.env.TAG || 'shot';
const WIDTHS = (process.env.WIDTHS || '1440,390').split(',').map(s => Number(s.trim())).filter(Boolean);
const SCALE = Number(process.env.SCALE || 2);
const PORT = Number(process.env.CDP_PORT || 9344);
const SETTLE = Number(process.env.SETTLE || 600); // ms，等字体与布局落定

const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const profile = path.join(os.tmpdir(), 'shoot-html-' + PORT + '-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--disable-lcd-text',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const bye = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', bye);

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('Chrome 调试端口未就绪');
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0; const waits = new Map(); const events = [];
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) {
      const { res, rej } = waits.get(m.id); waits.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; waits.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { ready, send, events, close: () => ws.close() };
}

const out = [];
try {
  await waitPort();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  for (const W of WIDTHS) {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: 900, deviceScaleFactor: SCALE, mobile: W <= 720,
    });
    await c.send('Page.navigate', { url: pathToFileURL(HTML).href });
    await sleep(SETTLE);
    // 等字体
    await c.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(()=>1) : 1', awaitPromise: true });
    await sleep(200);

    const probe = await c.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const de = document.documentElement, b = document.body;
        const soft = [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > de.clientWidth + 1)
          .map(el => ({ sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''), right: Math.round(el.getBoundingClientRect().right), w: Math.round(el.getBoundingClientRect().width) }));
        return {
          docH: Math.max(de.scrollHeight, b.scrollHeight),
          docW: de.clientWidth,
          overflow: Math.max(de.scrollWidth, b.scrollWidth) > de.clientWidth,
          over: soft.slice(0, 12),
          h2: [...document.querySelectorAll('h1,h2')].map(h => h.tagName + ' ' + h.textContent.trim().slice(0, 30)),
        };
      })()`,
    });
    const m = probe.result.value;

    const shot = await c.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: W, height: m.docH, scale: 1 },
    });
    const file = path.join(OUT, `${TAG}-${W}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    out.push({ width: W, file: path.basename(file), docH: m.docH, docW: m.docW, overflow: m.overflow, over: m.over, h2: m.h2 });
    console.log(`✔ ${W}px  ${m.docW}×${m.docH}  横向溢出=${m.overflow ? '是 ⚠ ' + JSON.stringify(m.over) : '否'}  -> ${path.basename(file)}`);
  }
  writeFileSync(path.join(OUT, `_${TAG}.json`), JSON.stringify(out, null, 2));
  c.close();
} catch (e) {
  console.error('✘ ' + e.message);
  process.exitCode = 1;
} finally {
  bye();
}
