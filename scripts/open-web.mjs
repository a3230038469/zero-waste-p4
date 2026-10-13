#!/usr/bin/env node
/**
 * 零废弃知识库 · 一键启动器（给小志桌面双击用）
 * ①检查知识库引擎（探端口，不依赖 docker 命令）②检查并启动网站后台 ③打开网页
 * 依赖：node（用户 PATH 里已有）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

const BACKEND_DIR = 'D:\\projects\\zero-waste-p4\\backend';
const URL = 'http://127.0.0.1:4000';
const HEALTH = URL + '/health';
const DOCKER_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

/** 探测本机端口是否有人监听（纯 node，不调外部命令） */
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

/** 网站后台是否就绪（更严格：看 /health 是否返回 ok） */
async function backendUp() {
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  log('');
  log('======================================');
  log('   零废弃知识库 · 正在为你打开');
  log('======================================');
  log('');

  // ---------- 1/3 知识库引擎 ----------
  log('[1/3] 检查知识库引擎...');
  if (await portOpen(8080)) {
    log('      引擎已就绪');
  } else {
    log('      引擎没在跑，正在帮你打开 Docker...');
    if (existsSync(DOCKER_EXE)) {
      try { spawn(DOCKER_EXE, [], { detached: true, stdio: 'ignore' }).unref(); } catch {}
      log('      等引擎醒过来（最多 2 分钟，第一次会更久）...');
      let ok = false;
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        if (await portOpen(8080)) { ok = true; log('      引擎已就绪'); break; }
      }
      if (!ok) log('      引擎还没起来，先继续；稍后刷新页面，或叫管家看看');
    } else {
      log('      ⚠ 没找到 Docker，请手动打开 Docker Desktop 后再试一次');
    }
  }

  // ---------- 2/3 网站后台 ----------
  log('[2/3] 检查网站后台...');
  if (await backendUp()) {
    log('      后台已在运行');
  } else {
    log('      正在启动后台（会弹出一个黑色小窗口，别关它，关它就等于关网站）...');
    spawn('cmd', ['/c', 'start', '/min', 'cmd', '/k', 'node dist/index.js'],
      { cwd: BACKEND_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    let ok = false;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      if (await backendUp()) { ok = true; log('      后台已就绪'); break; }
    }
    if (!ok) log('      ⚠ 后台启动慢了，仍会打开网页，请等半分钟再刷新');
  }

  // ---------- 3/3 打开网页 ----------
  log('[3/3] 打开网页...');
  spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  log('');
  log('完成！网页应该已经打开了。');
  log('小提示：书架要是空的、或 AI 问答转圈，等 1 分钟再刷新一次。');
  if (!(await portOpen(11434))) {
    log('');
    log('（不影响浏览）AI 问答用的本地小服务现在没开 —— 想用 AI 问答时叫管家开一下就行。');
  }
  log('');
  log('这个窗口 5 秒后自动关闭。');
  await sleep(5000);
}

main().catch((e) => {
  log('');
  log('启动过程出了点问题：' + (e && e.message ? e.message : String(e)));
  log('把这句话截图发给管家就行。');
  spawnSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
});
