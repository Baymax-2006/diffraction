/* ux_regression.js — 交互体验轮回归（无头 Chrome，真实鼠标 / 滚轮 / 键盘事件）。
 * 按使用者顺序走 11 步，并对本轮发现的每个问题做断言；同时保存“修复后”截图。
 * 需要：Chrome --remote-debugging-port=9333；http://127.0.0.1:8765
 * 用法：node tools/ux_regression.js   输出：validation/ux_regression.json，screenshots/ux/修复后_*.png */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots', 'ux'), DL = '/tmp/cal-dl-ux';
const BASE = process.env.CAL_URL || 'http://127.0.0.1:8765/index.html';
fs.mkdirSync(SHOT, { recursive: true }); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
const checks = [];
const ok = (g, name, cond, d) => { checks.push({ group: g, name, pass: !!cond, detail: d === undefined ? '' : JSON.stringify(d) }); console.log((cond ? 'PASS ' : 'FAIL ') + '[' + g + '] ' + name + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 500) : '')); };
const Q1READY = 'window.__app && __app.result && __app.point && __app.point.quality==="precise" && !Object.values(__app.jobs).some(j=>j.type==="q1"||j.type==="point")';
const Q2IDLE = '!Object.values(__app.jobs).some(j=>j.type==="q2")';
const Q2READY = `window.__app && __app.q2 && __app.q2.quality==="precise" && ${Q2IDLE}`;
const MON = `(() => { if (window.__mon) return; const m = window.__mon = { last: performance.now(), maxGap: 0, reset() { this.maxGap = 0; this.last = performance.now(); } };
  const f = () => { const t = performance.now(); m.maxGap = Math.max(m.maxGap, t - m.last); m.last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); })()`;
const SH = (n) => path.join(SHOT, '修复后_' + n + '.png');
async function rect(p, sel) { return p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`); }
async function mouse(p, type, x, y, extra) { await p.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); }
async function click(p, x, y) { await mouse(p, 'mouseMoved', x, y, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', x, y); await mouse(p, 'mouseReleased', x, y); }
async function wheel(p, x, y, dy) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' }); }
async function key(p, k, code, vk) { await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); }
async function setFile(p, sel, file) { const doc = await p.send('DOM.getDocument', {}); const q = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel }); await p.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] }); }
async function dl(p, btn, prefix) { for (let k = 0; k < 3; k++) { const before = fs.readdirSync(DL); await p.evaluate(btn + '.click()'); const f = await newest(prefix, before, 40); if (f) return f; } return null; }
async function newest(prefix, before, tries) { for (let i = 0; i < (tries || 100); i++) { const f = fs.readdirSync(DL).filter((x) => x.includes(prefix) && !x.endsWith('.crdownload') && !before.includes(x)); if (f.length) return path.join(DL, f[0]); await new Promise((r) => setTimeout(r, 100)); } return null; }
// 地图视口内某 (X′,Y′)[m] 对应的页面坐标
const mapPt = (sel, xp, yp) => `(() => { const cv = document.querySelector('${sel}'), r = cv.getBoundingClientRect(), vp = cv.__vp, v = __app.q2View; return { x: r.left + vp.x + (1 - (${yp} - v.cy) / v.half) * 0.5 * vp.S, y: r.top + vp.y + (1 - (${xp} - v.cx) / v.half) * 0.5 * vp.S }; })()`;
// 重叠 / 截断检测：每个元素先与其所有 overflow≠visible 祖先的可见区域求交（被侧栏滚动区裁掉的部分不算重叠）
async function overlaps(p) {
  return p.evaluate(`(() => {
    const clipRect = (e) => { let r = e.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom;
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) { const q = a.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } }
      // 页面内容滚到吸顶控制栏下方时被不透明的控制栏盖住：只算露出来的部分
      const sd = [...document.querySelectorAll('.side')].find((x) => x.offsetParent && getComputedStyle(x).position === 'sticky');
      if (sd && !sd.contains(e)) { const q = sd.getBoundingClientRect(); if (Math.min(R, q.right) - Math.max(L, q.left) > 0 && T < q.bottom && q.top <= 1) T = Math.max(T, q.bottom); }
      return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }; };
    const vis = (e) => { const s = getComputedStyle(e); if (s.visibility === 'hidden' || e.closest('[hidden]') || s.display === 'none') return false; const r = clipRect(e); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight * 4; };
    const els = [...document.querySelectorAll('.side button, .side label, .side output, .side .hint, .side select, .side input, .statusbar > *, .pendingbar > *, .metric small, .metric strong, .metric em, .plothead h3, .tools button, .q2tools button, .exportbar > *, .tabs button, .legendrow > *, .scanbtns > *, .stamp')].filter(vis);
    const out = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j]; if (a.contains(b) || b.contains(a)) continue;
      const r = clipRect(a), s = clipRect(b);
      const ix = Math.min(r.right, s.right) - Math.max(r.left, s.left), iy = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
      if (ix > 2 && iy > 2) out.push([a.id || a.className || a.tagName, (a.textContent || '').slice(0, 16), b.id || b.className || b.tagName, (b.textContent || '').slice(0, 16), Math.round(ix), Math.round(iy)]);
    }
    const clipped = [...document.querySelectorAll('.metric strong, .metric em, button, .stag, .lockinfo, .scaninfo')].filter(vis).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => [e.id || e.className, (e.textContent || '').slice(0, 30), e.scrollWidth, e.clientWidth]);
    return { overlaps: out.slice(0, 20), nOverlap: out.length, clipped: clipped.slice(0, 20), nClipped: clipped.length, docW: document.documentElement.scrollWidth, vw: innerWidth };
  })()`);
}

(async () => {
  let p = await connect(9333, BASE, [1440, 1000]);
  await p.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await p.waitFor(Q1READY, 30000); await p.evaluate(MON);
  const mode = await p.evaluate('modeInfo.textContent');
  ok('引擎', 'http 下第一问在 Web Worker 运行', mode.includes('Web Worker'), mode);

  /* 1. 拖动 + 精确输入半径 */
  const sr = await rect(p, '#rSlider');
  await p.evaluate(`if (__app.state.locked) btnLock4.click(); __mon.reset()`);
  const y = sr.y + sr.h / 2; let x = sr.x + 8; const samples = [];
  await mouse(p, 'mouseMoved', x, y, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', x, y);
  for (let i = 0; i < 40; i++) { x = sr.x + 8 + (sr.w - 16) * (i / 40) * 0.8; await mouse(p, 'mouseMoved', x, y); await p.sleep(16);
    if (i % 10 === 5) samples.push(await p.evaluate(`({ r: __app.state.r_mm, vline: __app.plots.mainPlot.vlines[0].x, mIs: mIs.textContent.slice(0, 40) })`)); }
  await p.screenshot({ path: SH('01_拖动半径中_标明预览') }.path);
  await mouse(p, 'mouseReleased', x, y);
  await p.waitFor(Q1READY, 8000);
  const drag = await p.evaluate(`({ gap: __mon.maxGap, r: __app.state.r_mm, pr: __app.point.r*1e3, q: __app.point.quality })`);
  ok('1 半径', '真实鼠标拖动滑块：最大帧间隔 < 100 ms，游标始终与 r 同步', drag.gap < 100 && samples.every((s) => Math.abs(s.vline - s.r) < 1e-9), { maxGap: Math.round(drag.gap), samples });
  ok('1 半径', '松开后精算：点值半径 = 滑块半径，质量 precise', Math.abs(drag.r - drag.pr) < 1e-9 && drag.q === 'precise', drag);
  for (const v of ['0.5', '1.3228768']) {
    const ri = await rect(p, '#rInput'); await click(p, ri.x + ri.w / 2, ri.y + ri.h / 2);
    await p.evaluate(`rInput.select()`); await p.send('Input.insertText', { text: v }); await key(p, 'Enter', 'Enter', 13);
    await p.waitFor(`Math.abs(__app.state.r_mm-${v})<1e-12 && ${Q1READY} && Math.abs(__app.point.r*1e3-${v})<1e-12`, 8000);
  }
  const in4 = await p.evaluate(`({ r: __app.state.r_mm, I: __app.point.I, mI: mI.textContent })`);
  ok('1 半径', '精确输入 0.5 → 1.3228768 mm：点值随之更新，I ≈ 4', Math.abs(in4.I - 4) < 1e-3, in4);

  /* 2. 扫描 */
  await p.evaluate(`scanFromZero.click(); __mon.reset()`); await p.sleep(1200);
  const sc = await p.evaluate(`({ r: __app.state.r_mm, vline: __app.plots.mainPlot.vlines[0].x, playing: __app.scan.playing, gap: __mon.maxGap })`);
  ok('2 扫描', '从 0 扫描：半径自动增加，游标同步，不卡顿', sc.playing && sc.r > 0 && Math.abs(sc.vline - sc.r) < 1e-9 && sc.gap < 120, sc);
  await p.evaluate(`scanToggle.click()`); await p.sleep(250);
  const r0 = await p.evaluate('__app.state.r_mm'); await p.sleep(500);
  const paused = await p.evaluate(`({ r: __app.state.r_mm, playing: __app.scan.playing })`);
  await p.evaluate(`scanFwd.click()`); await p.waitFor(Q1READY, 8000);
  const st = await p.evaluate('__app.state.r_mm');
  await p.evaluate(`scanNext.click()`); await p.waitFor(Q1READY, 8000);
  const nx = await p.evaluate(`(() => { const r = __app.state.r_mm; const e = __app.result.extrema.map(e => e.r*1e3); return { r, isExt: e.some(v => Math.abs(v - r) < 1e-9), info: scanInfo.textContent.slice(0, 60) }; })()`);
  await p.evaluate(`scanNext.click()`); await p.waitFor(Q1READY, 8000);
  nx.r2 = await p.evaluate('__app.state.r_mm');
  await p.evaluate(`scanPrev.click()`); await p.waitFor(Q1READY, 8000);
  const pv = await p.evaluate(`(() => { const r = __app.state.r_mm; return { r, isExt: __app.result.extrema.some(e => Math.abs(e.r*1e3 - r) < 1e-9) }; })()`);
  ok('2 扫描', '暂停后不再变化；单步前进；下一个 / 上一个极值落在极值点', !paused.playing && paused.r === r0 && st > r0 && nx.isExt && nx.r > st && nx.r2 > nx.r && pv.isExt && Math.abs(pv.r - nx.r) < 1e-9, { r0, paused, st, nx, pv });
  await p.screenshot({ path: SH('02_扫描暂停_跳到极值') }.path);

  /* 3. 点选极值 */
  await p.evaluate(`cMain.scrollIntoView({block:'center'})`); await p.sleep(200);
  const mk = await p.evaluate(`(() => { const mp = __app.plots.mainPlot, r = cMain.getBoundingClientRect(); const m = mp.markers.find(m => m.data.kind==='min' && m.data.index===3); return { x: r.left + mp.px(m.x), y: r.top + mp.py(m.y), r: m.data.r*1e3 }; })()`);
  await click(p, mk.x, mk.y); await p.waitFor(Q1READY, 8000);
  const a1 = await p.evaluate('__app.state.r_mm');
  const lb = await p.evaluate(`(() => { const mp = __app.plots.mainPlot, r = cMain.getBoundingClientRect(); const b = mp.labelBoxes.find(b => b.m.data.kind==='max' && b.m.data.index===4); return b && { x: r.left + (b.x0+b.x1)/2, y: r.top + (b.y0+b.y1)/2, r: b.m.data.r*1e3 }; })()`);
  await click(p, lb.x, lb.y); await p.waitFor(Q1READY, 8000);
  const a2 = await p.evaluate('__app.state.r_mm');
  await p.evaluate(`document.querySelector('#extTable tbody tr:nth-child(3)').click()`); await p.waitFor(Q1READY, 8000);
  const a3 = await p.evaluate(`({ r: __app.state.r_mm, row: +document.querySelector('#extTable tbody tr.cur').dataset.r })`);
  ok('3 极值', '点 I(r) 图上的极小3 标记、标签带“极大4”、极值表第 3 行：半径均跳到该极值', Math.abs(a1 - mk.r) < 1e-9 && Math.abs(a2 - lb.r) < 1e-9 && Math.abs(a3.r - a3.row) < 1e-6, { mk: [mk.r, a1], lb: [lb.r, a2], a3 });
  await p.screenshot({ path: SH('03_点选极值') }.path);

  /* 4. 锁定 r₄ → 第二问 */
  await p.evaluate(`btnLock4.click()`); await p.waitFor(`__app.state.locked && ${Q1READY}`, 8000);
  const lk = await p.evaluate(`({ r: __app.state.r_mm })`);
  ok('4 锁定', '锁定第 4 极大：r = r₄ = 1.3228768035 mm', Math.abs(lk.r - 1.3228768035) < 1e-9, lk);
  await p.evaluate(`document.getElementById('tab-q2').click()`);
  await p.waitFor(Q2READY, 60000); await p.sleep(300);
  const q2a = await p.evaluate(`({ mRs: q2mRs.textContent, I: __app.q2.axis.direct.I, a: __app.q2.a*1e3, vp: cQ2map.__vp })`);
  ok('4 锁定', '第二问图样用 r₄，并写明 “= 第 4 极大 r₄”；轴上 I/I_inc = 3.999986', q2a.mRs.includes('= 第 4 极大') && Math.abs(q2a.I - 3.999986) < 2e-6 && Math.abs(q2a.a - 1.3228768035) < 1e-9, q2a);
  ok('5 图样', '二维图视口为正方形（圆环不被拉伸）', q2a.vp && q2a.vp.S > 200, q2a.vp);
  await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(150);
  await p.screenshot({ path: SH('04_锁定r4_二维图正方形') }.path);
  await p.evaluate(`btnLock4Q2.click(); q2rInput.value='1.2'; q2rInput.dispatchEvent(new Event('change'))`); await p.sleep(400);
  const pend = await p.evaluate(`({ pend: !q2pendingBar.hidden, text: q2pendingText.textContent.slice(0, 80) })`);
  await p.evaluate(`q2btnApply.click()`);
  await p.waitFor(`${Q2READY} && Math.abs(__app.q2.a*1e3-1.2)<1e-9`, 60000); await p.sleep(200);
  const neq = await p.evaluate(`({ mRs: q2mRs.textContent, locked: __app.state.locked })`);
  ok('4 锁定', '解锁并改 r = 1.2：先显示“未应用”，应用后标明 “≠ r₄”', pend.pend && neq.mRs.includes('≠ r₄') && !neq.locked, { pend, neq });
  await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(150);
  await p.screenshot({ path: SH('05_解锁r1.2_标明不等于r4') }.path);
  await p.evaluate(`btnLock4Q2.click()`);
  await p.waitFor(`__app.state.locked && ${Q2READY} && Math.abs(__app.q2.a*1e3-1.3228768035)<1e-9`, 60000);
  const relock = await p.evaluate(`({ mRs: q2mRs.textContent, pend: !q2pendingBar.hidden })`);
  ok('4 锁定', '在第二问重新锁定 r₄：立即按 r₄ 重算（不留“未应用”）', relock.mRs.includes('= 第 4 极大') && !relock.pend, relock);

  /* 5. 快速切换四种情形：旧任务不排队，不覆盖新任务 */
  await p.evaluate(`__app.debug.log.length = 0; __mon.reset()`);
  const t0 = Date.now();
  await p.evaluate(`['random','linear','disk'].forEach(k => document.querySelector('#q2caseSeg button[data-v='+k+']').click())`);
  await p.sleep(150);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='disk' && ${Q2READY}`, 60000);
  const sw = await p.evaluate(`({ gap: __mon.maxGap, outs: __app.debug.log.filter(l => l.type==='q2').map(l => l.quality + ':' + l.outcome), sup: __app.supersededCount, case: __app.q2.caseKey, I: __app.q2.axis.direct.I })`);
  const swMs = Date.now() - t0;
  ok('5 情形', '连点 3 个情形：只算最后一个（旧任务 superseded，无 stale 排队），< 5 s 出精确图', swMs < 5000 && !sw.outs.some((o) => o.endsWith('stale')) && sw.outs.some((o) => o.endsWith('superseded')) && sw.case === 'disk', { ms: swMs, sw });
  ok('5 情形', '切换期间主线程不卡（最大帧间隔 < 150 ms），圆屏轴上 I ≈ 1', sw.gap < 150 && Math.abs(sw.I - 0.999993) < 5e-6, { gap: Math.round(sw.gap), I: sw.I });
  const axisVals = {};
  for (const k of ['inphase', 'random', 'linear', 'disk']) {
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=${k}]').click()`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='${k}' && ${Q2READY}`, 60000);
    axisVals[k] = await p.evaluate('__app.q2.axis.direct.I');
    await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(150);
    await p.screenshot({ path: SH('06_情形_' + k) }.path);
  }
  ok('5 情形', '四种情形轴上 I/I_inc 与内核一致（3.999986 / 逐点独立 0.000217 / 0.864754 / 0.999993）', Math.abs(axisVals.inphase - 3.999986) < 2e-6 && Math.abs(axisVals.random - 0.0002172125) < 1e-6 && Math.abs(axisVals.linear - 0.864754) < 2e-6 && Math.abs(axisVals.disk - 0.999993) < 2e-6, axisVals);

  /* 6. 探针 */
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=inphase]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='inphase' && ${Q2READY}`, 60000);
  await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(200);
  // 点击 (0,0) 附近 → 直接积分应与轴上值一致
  await p.evaluate(`__app.setProbe(0, 0)`);
  await p.waitFor(`__app.probeDirect && __app.probeDirect.xp===0 && __app.probeDirect.yp===0`, 10000);
  const pd0 = await p.evaluate(`({ I: __app.probeDirect.I, axis: __app.q2.axis.direct.I, ms: __app.probeDirect.ms, mP: q2mP.textContent, mPs: q2mPs.textContent.slice(0, 80) })`);
  ok('6 探针', '探针直接积分（后台）在 O′ 与轴上精确值一致，读数标明“直接积分”', Math.abs(pd0.I - pd0.axis) < 1e-5 && /直接积分/.test(pd0.mPs + pd0.mP), pd0);
  // 真实拖动探针：拖动过程中剖面竖线就跟随
  const st0 = await p.evaluate(mapPt('#cQ2map', 0, 0));
  await mouse(p, 'mouseMoved', st0.x, st0.y, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', st0.x, st0.y);
  const live = [];
  for (let i = 1; i <= 12; i++) { await mouse(p, 'mouseMoved', st0.x - i * 8, st0.y - i * 5); await p.sleep(25);
    if (i % 4 === 0) live.push(await p.evaluate(`({ px: __app.q2State.probeX_mm, py: __app.q2State.probeY_mm, cx: __app.plots.q2cutX.vlines[0].x, cy: __app.plots.q2cutY.vlines[0].x })`)); }
  await mouse(p, 'mouseReleased', st0.x - 96, st0.y - 60);
  ok('6 探针', '按住拖动探针：拖动中坐标即时变化，两条剖面的游标同步跟随', live.length === 3 && live[2].px > live[0].px && live.every((l) => Math.abs(l.cx - l.px) < 1e-9 && Math.abs(l.cy - l.py) < 1e-9), live);
  async function landProbe(xmm, ymm) {
    await p.evaluate(`__app.setProbe(0, 0)`);
    await p.waitFor(`__app.probeDirect && Math.abs(__app.probeDirect.xp)<1e-12 && Math.abs(__app.probeDirect.yp)<1e-12`, 15000);
    const h0 = await p.evaluate(`q2metrics.getBoundingClientRect().height`);
    const origin = await p.evaluate(mapPt('#cQ2map', 0, 0));
    const target = await p.evaluate(mapPt('#cQ2map', xmm * 1e-3, ymm * 1e-3));
    await mouse(p, 'mouseMoved', origin.x, origin.y, { buttons: 0, button: 'none' });
    await mouse(p, 'mousePressed', origin.x, origin.y);
    const hs = [h0];
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await mouse(p, 'mouseMoved', origin.x + (target.x - origin.x) * i / steps, origin.y + (target.y - origin.y) * i / steps);
      await p.sleep(30);
      if (i === 1 || i === steps) hs.push(await p.evaluate(`q2metrics.getBoundingClientRect().height`));
    }
    await mouse(p, 'mouseReleased', target.x, target.y);
    const got = await p.evaluate(`({ x: __app.q2State.probeX_mm, y: __app.q2State.probeY_mm })`);
    return { got, h0, hs };
  }
  const landA = await landProbe(-1, -1);
  const landB = await landProbe(1, 1);
  const stable = (L) => L.hs.every((h) => Math.abs(h - L.h0) < 1.5);
  ok('6 探针', '拖到 (−1,−1) 与 (1,1) mm：落点误差 < 0.01 mm，指标卡高度不跳', Math.abs(landA.got.x + 1) < 0.01 && Math.abs(landA.got.y + 1) < 0.01 && Math.abs(landB.got.x - 1) < 0.01 && Math.abs(landB.got.y - 1) < 0.01 && stable(landA) && stable(landB), { landA, landB });
  await p.waitFor(`__app.probeDirect && Math.abs(__app.probeDirect.xp*1e3-__app.q2State.probeX_mm)<1e-9 && Math.abs(__app.probeDirect.yp*1e3-__app.q2State.probeY_mm)<1e-9`, 10000);
  const pd1 = await p.evaluate(`(() => { const m = __app.q2.map, n = m.nObs, d = m.dObs, W = m.halfWidth, xp = __app.probeDirect.xp, yp = __app.probeDirect.yp;
    const fi = (xp + W) / d, fj = (yp + W) / d, i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, g = (a, b) => m.I[b * n + a];
    const bil = (1-u)*(1-v)*g(i,j) + u*(1-v)*g(i+1,j) + (1-u)*v*g(i,j+1) + u*v*g(i+1,j+1);
    return { direct: __app.probeDirect.I, bilinear: bil, mP: q2mP.textContent }; })()`);
  ok('6 探针', '松手后直接积分到达；与网格插值相符（|Δ| < 0.05），读数显示直接积分值', Math.abs(pd1.direct - pd1.bilinear) < 0.05 && pd1.mP.includes(pd1.direct.toFixed(4).slice(0, 5)), pd1);
  await p.screenshot({ path: SH('07_拖动探针_剖面跟随_直接积分') }.path);

  /* 7. 缩放 / 平移 / 复位 */
  const half0 = await p.evaluate('__app.q2View.half');
  const c = await p.evaluate(mapPt('#cQ2map', 0, 0));
  await wheel(p, c.x, c.y, -400); await p.sleep(250);
  const half1 = await p.evaluate('__app.q2View.half');
  // 远离探针处按住拖动 → 平移
  await p.evaluate(`__app.setProbe(0, 0)`); await p.sleep(100);
  const far = await p.evaluate(mapPt('#cQ2map', 0, 0));
  const v0 = await p.evaluate('Object.assign({}, __app.q2View)');
  await mouse(p, 'mouseMoved', far.x + 120, far.y + 120, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', far.x + 120, far.y + 120);
  for (let i = 1; i <= 6; i++) { await mouse(p, 'mouseMoved', far.x + 120 - i * 10, far.y + 120 - i * 10); await p.sleep(20); }
  await mouse(p, 'mouseReleased', far.x + 60, far.y + 60); await p.sleep(150);
  const v1 = await p.evaluate(`({ v: Object.assign({}, __app.q2View), px: __app.q2State.probeX_mm, py: __app.q2State.probeY_mm, badge: !!cQ2map })`);
  ok('7 缩放', '滚轮放大二维图；远离探针拖动为平移（探针不动）', half1 < half0 * 0.85 && (Math.abs(v1.v.cx - v0.cx) > 1e-6 || Math.abs(v1.v.cy - v0.cy) > 1e-6) && v1.px === 0 && v1.py === 0, { half0, half1, v0, v1 });
  await p.screenshot({ path: SH('08_二维图放大平移') }.path);
  // 键盘：焦点在图上，方向键移动探针
  await p.evaluate(`cQ2map.focus()`); await key(p, 'ArrowUp', 'ArrowUp', 38); await p.sleep(100);
  const kb = await p.evaluate(`({ px: __app.q2State.probeX_mm, d: __app.q2.map.dObs*1e3 })`);
  ok('7 缩放', '键盘方向键移动探针一个网格步长', Math.abs(kb.px - kb.d) < 1e-9, kb);
  // 剖面缩放后移动探针，缩放保持
  await p.evaluate(`cQ2cutX.scrollIntoView({block:'center'})`); await p.sleep(150);
  const cxr = await rect(p, '#cQ2cutX');
  await wheel(p, cxr.x + cxr.w / 2, cxr.y + cxr.h / 2, -400); await p.sleep(150);
  const cv1 = await p.evaluate('Object.assign({}, __app.plots.q2cutX.view)');
  await p.evaluate(`__app.setProbe(0.3, 0.1)`); await p.sleep(400);
  const cv2 = await p.evaluate('Object.assign({}, __app.plots.q2cutX.view)');
  ok('7 缩放', '剖面图滚轮缩放后移动探针：缩放保持（不被复位）', Math.abs((cv2.x1 - cv2.x0) - (cv1.x1 - cv1.x0)) < 1e-9 && cv1.x1 - cv1.x0 < 4.9, { cv1, cv2 });
  await p.screenshot({ path: SH('09_剖面缩放保持') }.path);
  await p.evaluate(`q2cutReset.click(); q2zoomReset.click()`); await p.sleep(200);
  const rs = await p.evaluate(`({ half: __app.q2View.half, cx: __app.q2View.cx, cy: __app.q2View.cy, cut: Object.assign({}, __app.plots.q2cutX.view) })`);
  ok('7 缩放', '“复位视图 / 复位剖面”回到整幅', Math.abs(rs.half - half0) < 1e-12 && rs.cx === 0 && rs.cy === 0 && rs.cut.x1 - rs.cut.x0 > 4.9, rs);

  /* 8. 色标 */
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=random]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && ${Q2READY}`, 60000);
  const autoNorm = await p.evaluate(`({ norm: __app.q2State.norm, foot: q2mapFoot.textContent })`);
  ok('8 色标', '进入随机相位自动改用本图各自，脚注写出相对同相的亮度', autoNorm.norm === 'per' && /同相圆孔的 1\//.test(autoNorm.foot), autoNorm);
  const dom = await p.evaluate(`(() => { const seg = (v) => document.querySelector('#q2normSeg button[data-v=' + v + ']').click(); const o = {};
    seg('shared'); o.shared = __app.q2Domain('main').Imax; o.sharedFoot = q2mapFoot.textContent.slice(0, 120);
    seg('per'); o.per = __app.q2Domain('main').Imax; o.perFoot = q2mapFoot.textContent.slice(0, 120);
    seg('fixed4'); o.fixed = __app.q2Domain('main').Imax; seg('shared'); o.own = __app.q2.map.Imax; return o; })()`);
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=disk]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='disk' && ${Q2READY}`, 60000);
  Object.assign(dom, await p.evaluate(`(() => { const seg = (v) => document.querySelector('#q2normSeg button[data-v=' + v + ']').click(); const o = {};
    seg('per'); o.cmpPer = __app.q2Domain('cmp').Imax; seg('fixed4'); o.cmpFixed = __app.q2Domain('cmp').Imax; seg('shared'); o.cmpShared = __app.q2Domain('cmp').Imax;
    o.hole = __app.q2.mapHole.Imax; o.disk = __app.q2.mapDisk.Imax; return o; })()`));
  ok('8 色标', '“共享”= 同一 λ、L、r 下已算情形的共同上限（随机情形下 ≈ 4，≠ 本图各自 ≈ 1.10）；固定 = 4', dom.shared > 3.9 && Math.abs(dom.per - dom.own) < 1e-12 && dom.per < 1.2 && dom.fixed === 4 && /共享上限/.test(dom.sharedFoot) && /不能与其他情形比较/.test(dom.perFoot), dom);
  ok('8 色标', '圆孔 / 圆屏对照始终用同一上限（共享 / 各自 → max(I_hole, I_disk)；固定 → 4）', Math.abs(dom.cmpShared - Math.max(dom.hole, dom.disk)) < 1e-12 && dom.cmpPer === dom.cmpShared && dom.cmpFixed === 4, dom);
  await p.evaluate(`document.querySelector('#q2scaleSeg button[data-v=log]').click(); q2compareCard.scrollIntoView({block:'center'})`); await p.sleep(250);
  const cmpLog = await p.evaluate(`({ bar: (() => { const r = cQ2cmpBar.getBoundingClientRect(); return [r.width, r.height]; })(), foot: q2cmpFoot.textContent, mapFoot: q2mapFoot.textContent.slice(0, 80) })`);
  ok('8 色标', '对照卡有自己的色条；对数色标下文字写明亮度相差的数量级', cmpLog.bar[0] > 20 && cmpLog.bar[1] > 50 && /数量级/.test(cmpLog.foot) && /对数/.test(cmpLog.mapFoot), cmpLog);
  await p.screenshot({ path: SH('10_对照卡_对数色标_有色条') }.path);
  await p.evaluate(`document.querySelector('#q2scaleSeg button[data-v=linear]').click()`); await p.sleep(200);
  await p.screenshot({ path: SH('11_对照卡_线性共享色标') }.path);

  /* 9. 随机相位 */
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=random]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && ${Q2READY}`, 60000);
  const s0 = await p.evaluate('__app.q2.seed'), Ir0 = await p.evaluate('__app.q2.axis.direct.I');
  await p.evaluate(`q2btnRegen.click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && __app.q2.seed!==${s0} && ${Q2READY}`, 60000);
  const s1 = await p.evaluate('({ seed: __app.q2.seed, I: __app.q2.axis.direct.I })');
  await p.evaluate(`q2btnRecalc.click()`); await p.sleep(100);
  await p.waitFor(Q2READY, 60000);
  const s2 = await p.evaluate('({ seed: __app.q2.seed, I: __app.q2.axis.direct.I })');
  await p.evaluate(`document.querySelector('#q2precSeg button[data-v=preview]').click()`); await p.sleep(300);
  if (await p.evaluate('!q2pendingBar.hidden')) await p.evaluate(`q2btnApply.click()`);
  await p.waitFor(`${Q2IDLE} && __app.q2 && __app.q2.q2Precision==='preview'`, 60000);
  const s3 = await p.evaluate('({ seed: __app.q2.seed, prec: __app.q2.q2Precision })');
  await p.evaluate(`__app.debug.log.length = 0; document.querySelector('#q2precSeg button[data-v=standard]').click()`); await p.sleep(300);
  if (await p.evaluate('!q2pendingBar.hidden')) await p.evaluate(`q2btnApply.click()`);
  await p.waitFor(`${Q2READY} && __app.q2.q2Precision==='standard'`, 60000);
  s3.backI = await p.evaluate('__app.q2.axis.direct.I');
  s3.q2log = await p.evaluate(`__app.debug.log.filter(l => l.type==='q2').map(l => l.quality + ':' + l.outcome)`);
  await p.evaluate(`q2seed.value='12345'; q2seed.dispatchEvent(new Event('change'))`); await p.sleep(200);
  const sp = await p.evaluate(`({ pend: !q2pendingBar.hidden, shown: __app.q2.seed })`);
  await p.evaluate(`q2btnApply.click()`);
  await p.waitFor(`__app.q2 && __app.q2.seed===12345 && ${Q2READY}`, 60000);
  const s4 = await p.evaluate('__app.q2.axis.direct.I');
  await p.evaluate(`q2seed.value='12345'; q2seed.dispatchEvent(new Event('change')); q2btnRecalc.click()`); await p.waitFor(`__app.q2 && __app.q2.seed===12345 && ${Q2READY}`, 60000);
  const s5 = await p.evaluate('__app.q2.axis.direct.I');
  ok('9 随机', '重新生成换种子与图样；重算 / 切换精度不重新随机；改种子先“未应用”，同种子结果完全复现', s1.seed !== s0 && s1.I !== Ir0 && s2.seed === s1.seed && s2.I === s1.I && s3.seed === s1.seed && s3.backI === s1.I && sp.pend && sp.shown === s1.seed && s4 === s5, { s0, s1, s2, s3, sp, s4, s5 });
  ok('9 随机', '逐点独立切回标准时不先提交粗预览', s3.q2log && s3.q2log.includes('final:done') && !s3.q2log.includes('preview:done'), s3.q2log);
  await p.screenshot({ path: SH('12_随机相位_种子12345') }.path);

  /* 10. 取消 */
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=linear]').click()`); await p.sleep(120);
  await p.evaluate(`q2btnCancel.click()`); await p.sleep(400);
  const qc = await p.evaluate(`({ jobs: Object.values(__app.jobs).filter(j => j.type==='q2').length, pb: __app.q2PreviewBusy, case: __app.q2 && __app.q2.caseKey, cancelDisabled: q2btnCancel.disabled, badge: (document.getElementById('q2state')||{}).textContent })`);
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=disk]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='disk' && ${Q2READY}`, 60000); await p.sleep(400);
  const qc2 = await p.evaluate(`({ case: __app.q2.caseKey, pb: __app.q2PreviewBusy, I: __app.q2.axis.direct.I })`);
  ok('10 取消', '第二问计算中取消：任务清空、忙标志清除；随后换情形重算，结果属于最新请求', qc.jobs === 0 && !qc.pb && qc.cancelDisabled && qc2.case === 'disk' && !qc2.pb && Math.abs(qc2.I - 0.999993) < 5e-6, { qc, qc2 });
  await p.evaluate(`__app.debug.failNext = 'q2'; q2btnRecalc.click()`);
  await p.waitFor(`${Q2IDLE} && __app.q2State.lastError`, 60000);
  const qe = await p.evaluate(`({ q2err: __app.q2State.lastError, q1err: __app.lastError, pb: __app.q2PreviewBusy })`);
  ok('10 取消', '第二问失败只在第二问状态栏报错，不污染第一问 lastError', qe.q2err && !qe.q1err && !qe.pb, qe);
  await p.evaluate(`q2btnRecalc.click()`); await p.waitFor(Q2READY, 60000);
  await p.evaluate(`document.getElementById('tab-q1').click()`); await p.sleep(200);
  const c1 = await p.evaluate(`(async () => { extParams.open = true; lamInput.value='700'; lamInput.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,30)); btnCancel.click(); await new Promise(r=>setTimeout(r,200));
    const mid = { jobs: Object.values(__app.jobs).filter(j=>j.type==='q1').length, busy: __app.previewBusy };
    lamInput.value='600'; lamInput.dispatchEvent(new Event('change'));
    const t0 = performance.now(); while (performance.now()-t0 < 20000 && !(__app.result.params.lambda_nm===600 && __app.result.quality==='final' && !Object.values(__app.jobs).some(j=>j.type==='q1'||j.type==='point'))) await new Promise(r=>setTimeout(r,50));
    return { mid, lam: __app.result.params.lambda_nm, busy: __app.previewBusy, jobs: Object.keys(__app.jobs).length }; })()`);
  ok('10 取消', '第一问取消：任务清空；改参数重算到 λ = 600 nm，忙标志清除', c1.mid.jobs === 0 && !c1.mid.busy && c1.lam === 600 && !c1.busy, c1);
  // 扫描中切到第二问：扫描暂停
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && ${Q1READY}`, 20000);
  await p.evaluate(`scanFromZero.click()`); await p.sleep(400);
  await p.evaluate(`document.getElementById('tab-q2').click()`); await p.sleep(300);
  const sp2 = await p.evaluate(`({ playing: __app.scan.playing, r: __app.state.r_mm })`); await p.sleep(400);
  const sp3 = await p.evaluate(`__app.state.r_mm`);
  ok('2 扫描', '扫描中切到第二问：扫描自动暂停，半径不再变', !sp2.playing && sp2.r === sp3, { sp2, sp3 });
  await p.evaluate(`document.getElementById('tab-q1').click(); btnLock4.click()`); await p.waitFor(`__app.state.locked && ${Q1READY}`, 8000);

  /* 11. 导出 + r = 0 再载入 */
  await p.evaluate(`document.getElementById('tab-q2').click()`);
  await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=inphase]').click()`);
  await p.waitFor(`__app.q2 && __app.q2.caseKey==='inphase' && ${Q2READY} && Math.abs(__app.q2.a*1e3-1.3228768035)<1e-9`, 60000);
  const png = await dl(p, 'q2btnPng', '第二问_inphase'); await p.sleep(1200);
  const csv = await dl(p, 'q2btnCsv', 'I_XY'); await p.sleep(1200);
  const js = await dl(p, 'q2btnJson', '参数配置'); await p.sleep(1200);
  const pngInfo = png && (() => { const b = fs.readFileSync(png); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; })();
  const csvLines = csv ? fs.readFileSync(csv, 'utf8').split('\r\n') : [];
  const n = await p.evaluate('__app.q2.map.nObs');
  const dataLines = csvLines.filter((l) => /^\d+,\d+,/.test(l));
  const center = dataLines.map((l) => l.split(',')).find((c) => +c[0] === (n - 1) / 2 && +c[1] === (n - 1) / 2);
  const cfg = js ? JSON.parse(fs.readFileSync(js, 'utf8')) : {};
  ok('11 导出', '第二问 PNG / CSV / JSON 均下载；CSV 网格完整、中心 I 与图一致；JSON 含 r₄', pngInfo && pngInfo.w > 600 && pngInfo.h > 400 && dataLines.length === n * n && center && Math.abs(+center[6] - (await p.evaluate(`__app.q2.map.I[${(n * n - 1) / 2}]`))) < 1e-9 && Math.abs(cfg.params.r_mm - 1.3228768035) < 1e-9, { pngInfo, rows: dataLines.length, n, center: center && center[6], r: cfg.params && cfg.params.r_mm });
  await p.evaluate(`document.getElementById('tab-q1').click()`); await p.sleep(150);
  await p.evaluate(`if (__app.state.locked) btnLock4.click(); __app.setRadius(0, { precise: true, forceInput: true })`);
  await p.waitFor(`__app.state.r_mm===0 && ${Q1READY}`, 8000);
  const j0 = await dl(p, 'btnJson', '参数配置'); await p.sleep(1200);
  const c0 = await dl(p, 'btnCsv', 'I(r)');
  await p.evaluate(`__app.setRadius(0.8, { forceInput: true })`); await p.sleep(300);
  await setFile(p, '#fileJson', j0);
  await p.waitFor(`__app.state.r_mm===0 && ${Q1READY}`, 30000);
  const r0l = await p.evaluate(`({ r: __app.state.r_mm, inp: rInput.value, I: __app.point.I })`);
  ok('11 导出', '第一问在 r = 0 导出配置 / CSV，再载入后 r 仍为 0（I = 0）', j0 && c0 && JSON.parse(fs.readFileSync(j0, 'utf8')).params.r_mm === 0 && r0l.r === 0 && parseFloat(r0l.inp) === 0 && r0l.I < 1e-12, { r0l, files: [j0 && path.basename(j0), c0 && path.basename(c0)] });
  await p.screenshot({ path: SH('13_r0配置载入') }.path);
  // 基准复测
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && ${Q1READY}`, 20000);
  await p.evaluate(`if (!__app.state.locked) btnLock4.click()`); await p.waitFor(`__app.state.locked && ${Q1READY}`, 8000);
  const bm = await p.evaluate(`({ r4: __app.result.fourth.r*1e3, I4: __app.result.fourth.I, nmax: __app.result.extrema.filter(e=>e.kind==='max').length, nmin: __app.result.extrema.filter(e=>e.kind==='min').length, rlim: (__app.result.r4 && __app.result.r4.rLimit || NaN)*1e3 })`);
  ok('基准', 'r₄ = 1.3228768035 mm，I/I_inc = 3.999986，0–2.2 mm 内 10 极大 9 极小', Math.abs(bm.r4 - 1.3228768035) < 5e-11 && Math.abs(bm.I4 - 3.999986) < 1e-6 && bm.nmax === 10 && bm.nmin === 9, bm);
  await p.evaluate(`lamInput.value='-5'; lamInput.dispatchEvent(new Event('change'))`);
  const badL = await p.evaluate(`({ v: lamInput.value, inv: lamInput.getAttribute('aria-invalid'), st: sText.textContent, lam: __app.state.lambda_nm })`);
  await p.evaluate(`LInput.value='0'; LInput.dispatchEvent(new Event('change'))`);
  const badZ = await p.evaluate(`({ v: LInput.value, inv: LInput.getAttribute('aria-invalid'), st: sText.textContent, L: __app.state.L_cm })`);
  await p.evaluate(`thrInput.value='900'; thrInput.dispatchEvent(new Event('change'))`);
  const badT = await p.evaluate(`({ v: thrInput.value, inv: thrInput.getAttribute('aria-invalid'), st: sText.textContent, thr: __app.state.thr })`);
  await p.evaluate(`lamInput.value='1'; lamInput.dispatchEvent(new Event('change'))`);
  const bad1 = await p.evaluate(`({ v: lamInput.value, inv: lamInput.getAttribute('aria-invalid'), lam: __app.state.lambda_nm })`);
  ok('非法输入', 'λ=-5、L=0、阈值 900%、λ=1 nm 都恢复原值，aria-invalid，状态栏写出合法范围', badL.lam === 500 && badL.inv === 'true' && /合法范围/.test(badL.st) && Math.abs(parseFloat(badL.v) - 500) < 1e-6 && badZ.L === 50 && badZ.inv === 'true' && /合法范围/.test(badZ.st) && Math.abs(badT.thr - 0.05) < 1e-12 && badT.inv === 'true' && /合法范围/.test(badT.st) && bad1.lam === 500 && bad1.inv === 'true', { badL, badZ, badT, bad1 });
  const slide = await p.evaluate(`(() => { __app.debug.log.length = 0; lamInput.value = '610'; lamInput.dispatchEvent(new Event('change')); lamSlider.value = '630'; lamSlider.dispatchEvent(new Event('input')); return __app.debug.log.filter(l => l.type==='q1').map(l => l.quality + ':' + l.outcome); })()`);
  await p.sleep(300);
  ok('预览取代', '拖动 λ 滑块的预览会取代正在跑的最终任务', slide.includes('final:superseded'), slide);
  await p.evaluate(`btnCancel.click(); btnPreset.click()`);
  await p.waitFor(`__app.result && __app.result.params.lambda_nm===500 && ${Q1READY}`, 20000);

  /* 布局：1080 / 780 / 390（先让第二问回到已锁定的 r₄ 图样） */
  await p.evaluate(`document.getElementById('tab-q2').click()`); await p.sleep(300);
  if (await p.evaluate('!q2pendingBar.hidden')) await p.evaluate('q2btnApply.click()');
  await p.waitFor(`${Q2READY} && Math.abs(__app.q2.a*1e3-1.3228768035)<1e-9`, 60000);
  for (const [w, h] of [[1080, 800], [780, 900], [390, 844]]) {
    await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
    await p.evaluate(`document.getElementById('tab-q1').click(); window.scrollTo(0,0)`); await p.sleep(600);
    const o1 = await overlaps(p); await p.screenshot({ path: SH(`14_第一问_${w}宽`) }.path);
    await p.evaluate(`document.getElementById('tab-q2').click(); window.scrollTo(0,0)`); await p.sleep(800);
    const o2 = await overlaps(p); await p.screenshot({ path: SH(`15_第二问_${w}宽`) }.path);
    await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(300);
    const o3 = await overlaps(p); const vp = await p.evaluate('cQ2map.__vp');
    const occ = await p.evaluate(`(() => { const sdE = [...document.querySelectorAll('.side')].find((x) => x.offsetParent), s = sdE.getBoundingClientRect(), m = cQ2map.getBoundingClientRect(), st = getComputedStyle(sdE).position; return { sticky: st, sideTop: Math.round(s.top), sideBottom: Math.round(s.bottom), mapTop: Math.round(m.top), mapBottom: Math.round(m.bottom), vh: innerHeight }; })()`);
    ok('布局', `${w} px：跳到二维图时图不被吸顶控制栏遮住，且整幅可见`, (occ.sticky !== 'sticky' || occ.mapTop >= occ.sideBottom - 1 || occ.sideTop > 5) && occ.mapBottom <= occ.vh + 1, occ);
    await p.screenshot({ path: SH(`16_第二问图样_${w}宽`) }.path);
    ok('布局', `${w} px：无文字重叠 / 截断，无横向滚动，二维图仍为正方形`, o1.nOverlap + o2.nOverlap + o3.nOverlap === 0 && o1.nClipped + o2.nClipped + o3.nClipped === 0 && o1.docW <= w && o2.docW <= w && vp && vp.S > 150, { q1: o1, q2: o2, map: o3, vp });
  }
  p.close();

  /* file://：内联 Blob Worker，切换情形不卡主线程；?engine=main 回退仍可用 */
  const FILE = 'file://' + path.join(ROOT, 'index.html');
  p = await connect(9333, FILE, [1440, 1000]);
  await p.waitFor(Q1READY, 30000); await p.evaluate(MON);
  await p.evaluate(`document.getElementById('tab-q2').click()`); await p.waitFor(Q2READY, 60000);
  await p.evaluate(`__mon.reset(); document.querySelector('#q2caseSeg button[data-v=disk]').click()`);
  await p.waitFor(`__app.q2.caseKey==='disk' && ${Q2READY}`, 60000);
  const fm = await p.evaluate(`({ mode: modeInfo.textContent, q2mode: (document.getElementById('q2modeInfo')||modeInfo).textContent, gap: __mon.maxGap, I: __app.q2.axis.direct.I })`);
  ok('file://', 'file:// 下第一问 / 第二问都在内联 Blob Worker；切换情形最大帧间隔 < 150 ms', fm.mode.includes('Blob') && fm.gap < 150 && Math.abs(fm.I - 0.999993) < 5e-6, fm);
  p.close();
  p = await connect(9333, FILE + '?engine=main', [1440, 1000]);
  await p.waitFor(Q1READY, 30000);
  await p.evaluate(`document.getElementById('tab-q2').click()`); await p.waitFor(Q2READY, 90000);
  const fb = await p.evaluate(`({ mode: modeInfo.textContent, warn: [...document.querySelectorAll('.mainwarn')].some(e => !e.hidden && e.textContent.length), I: __app.q2.axis.direct.I, r4: __app.result.fourth.r*1e3 })`);
  ok('file://', '?engine=main 强制主线程回退：明确警告，结果不变', fb.mode.includes('回退') && fb.warn && Math.abs(fb.I - 3.999986) < 2e-6 && Math.abs(fb.r4 - 1.3228768035) < 5e-11, fb);
  const errs = p.logs.filter((l) => /EXCEPTION|error/i.test(l));
  p.close();
  ok('控制台', '无未捕获异常', errs.length === 0, errs.slice(0, 5));

  fs.writeFileSync(path.join(ROOT, 'validation', 'ux_regression.json'), JSON.stringify({ when: new Date().toISOString(), url: BASE, checks }, null, 2));
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
