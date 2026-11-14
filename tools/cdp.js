/* cdp.js — 极简 Chrome DevTools Protocol 客户端（Node ≥ 22，内置 WebSocket），用于浏览器自动验证与截图。 */
'use strict';
async function connect(port, url, size) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waits = new Map(); const logs = []; const handlers = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    else if (m.method === 'Log.entryAdded') logs.push('log-' + m.params.entry.level + ': ' + m.params.entry.text);
    handlers.forEach((h) => h(m));
  };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; waits.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // 禁用缓存：保证测试总是加载磁盘上最新的 app.js / plot.js（某些静态服务器不发 no-cache）
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.reload', { ignoreCache: true }); await new Promise((r) => setTimeout(r, 300));
  if (size) await send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const screenshot = async (path, opts) => {
    const r = await send('Page.captureScreenshot', Object.assign({ format: 'png' }, opts || {}));
    require('fs').writeFileSync(path, Buffer.from(r.data, 'base64'));
  };
  const navigate = async (u) => { await send('Page.navigate', { url: u }); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, timeout) => { const t0 = Date.now(); while (Date.now() - t0 < (timeout || 15000)) { try { if (await evaluate(expr)) return true; } catch (e) { /* retry */ } await sleep(100); } throw new Error('waitFor timeout: ' + expr); };
  return { send, evaluate, screenshot, navigate, sleep, waitFor, logs, close: () => { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${list.id}`).catch(() => {}); }, targetId: list.id };
}
module.exports = { connect };
