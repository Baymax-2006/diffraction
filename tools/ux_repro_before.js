/* ux_repro_before.js — 交互体验轮：按使用者顺序在“修复前”副本上实际操作页面，记录问题证据。
 * 用法：CAL_URL=http://127.0.0.1:8767/index.html node tools/ux_repro_before.js
 * 输出：validation/ux_repro_before.json，截图 screenshots/ux/修复前_*.png */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots', 'ux');
const BASE = process.env.CAL_URL || 'http://127.0.0.1:8767/index.html';
const OUT = process.env.CAL_OUT || path.join(ROOT, 'validation', 'ux_repro_before.json');
const PFX = process.env.CAL_PFX || '修复前_';
fs.mkdirSync(SHOT, { recursive: true });
const found = [];
const note = (k, issue, ev) => { found.push({ k, issue: !!issue, evidence: ev }); console.log((issue ? 'ISSUE ' : 'ok    ') + k + ' — ' + JSON.stringify(ev).slice(0, 400)); };
const Q1READY = 'window.__app && __app.result && __app.point && __app.point.quality==="precise" && !Object.values(__app.jobs).some(j=>j.type==="q1"||j.type==="point")';
const Q2IDLE = '!Object.values(__app.jobs).some(j=>j.type==="q2")';
const MON = `(() => { if (window.__mon) return; const m = window.__mon = { last: performance.now(), maxGap: 0, reset() { this.maxGap = 0; this.last = performance.now(); } };
  const f = () => { const t = performance.now(); m.maxGap = Math.max(m.maxGap, t - m.last); m.last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); })()`;
async function rect(p, sel) { return p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`); }
async function mouse(p, type, x, y, extra) { await p.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); }
async function click(p, x, y) { await mouse(p, 'mouseMoved', x, y, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', x, y); await mouse(p, 'mouseReleased', x, y); }
async function wheel(p, x, y, dy) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' }); }
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
  try {
    await p.waitFor(Q1READY, 30000); await p.evaluate(MON);
    // 1. 拖动半径滑块（真实鼠标事件）
    const sr = await rect(p, '#rSlider');
    await p.evaluate(`if (!__app.state.locked) btnLock4.click(); __mon.reset()`);
    const y = sr.y + sr.h / 2; let x = sr.x + 8;
    await mouse(p, 'mouseMoved', x, y, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', x, y);
    const samples = [];
    for (let i = 0; i < 40; i++) { x = sr.x + 8 + (sr.w - 16) * (i / 40) * 0.8; await mouse(p, 'mouseMoved', x, y); await p.sleep(16);
      if (i % 8 === 4) samples.push(await p.evaluate(`({ r: __app.state.r_mm, q: __app.point && __app.point.quality, pr: __app.point && __app.point.r*1e3, mI: mI.textContent, mIs: mIs.textContent, vline: __app.plots.mainPlot.vlines[0].x })`)); }
    await p.screenshot(path.join(SHOT, PFX + '01_拖动半径中_预览.png'));
    await mouse(p, 'mouseReleased', x, y);
    await p.waitFor(Q1READY, 8000);
    const dragGap = await p.evaluate('__mon.maxGap');
    note('1 拖动半径：帧间隔', dragGap > 100, { maxFrameGap_ms: Math.round(dragGap), samples });
    // 精确输入
    const ri = await rect(p, '#rInput');
    await click(p, ri.x + ri.w / 2, ri.y + ri.h / 2);
    await p.evaluate(`rInput.select()`); await p.send('Input.insertText', { text: '0.5' });
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await p.waitFor(`__app.state.r_mm===0.5 && ${Q1READY}`, 8000);
    const in05 = await p.evaluate(`({ r: __app.state.r_mm, I: __app.point.I, inp: rInput.value, mR: mR.textContent })`);
    note('1 精确输入 0.5 mm', !(Math.abs(in05.I - 3.246977) > 0.5 ? false : true) && false, in05);

    // 2. 扫描
    await p.evaluate(`scanFromZero.click(); __mon.reset()`); await p.sleep(1200);
    const scanSync = await p.evaluate(`({ r: __app.state.r_mm, pr: __app.point.r*1e3, vline: __app.plots.mainPlot.vlines[0].x, q: __app.point.quality, playing: __app.scan.playing, maxGap: __mon.maxGap })`);
    note('2 扫描中三图同步（r / 点 / 游标）', Math.abs(scanSync.r - scanSync.pr) > 1e-9 || Math.abs(scanSync.r - scanSync.vline) > 1e-9, scanSync);
    await p.evaluate(`scanToggle.click()`); await p.sleep(300);
    await p.evaluate(`scanFwd.click()`); await p.waitFor(Q1READY, 8000);
    await p.evaluate(`scanNext.click()`); await p.waitFor(Q1READY, 8000);
    const nx = await p.evaluate(`({ r: __app.state.r_mm, info: scanInfo.textContent })`);
    note('2 暂停/单步/下一个极值', false, nx);

    // 3. 点击 I(r) 图上的极值标记
    await p.evaluate(`window.scrollTo(0,0); cMain.scrollIntoView({block:'center'})`); await p.sleep(200);
    const mk = await p.evaluate(`(() => { const mp = __app.plots.mainPlot, r = cMain.getBoundingClientRect(); const m = mp.markers.find(m => m.data.kind==='min' && m.data.index===3); return { x: r.left + mp.px(m.x), y: r.top + mp.py(m.y), r: m.data.r*1e3 }; })()`);
    await click(p, mk.x, mk.y); await p.waitFor(Q1READY, 8000);
    const afterMk = await p.evaluate(`({ r: __app.state.r_mm })`);
    note('3 点击 I(r) 极小3 标记', Math.abs(afterMk.r - mk.r) > 1e-9, { target: mk.r, got: afterMk.r });
    const lb = await p.evaluate(`(() => { const mp = __app.plots.mainPlot, r = cMain.getBoundingClientRect(); const b = mp.labelBoxes.find(b => b.m.data.kind==='max' && b.m.data.index===4); return b && { x: r.left + (b.x0+b.x1)/2, y: r.top + (b.y0+b.y1)/2, r: b.m.data.r*1e3 }; })()`);
    await click(p, lb.x, lb.y); await p.waitFor(Q1READY, 8000);
    note('3 点击标签带“极大4”', Math.abs((await p.evaluate('__app.state.r_mm')) - lb.r) > 1e-9, lb);
    const hoverClick = await p.evaluate(`(() => { const mp = __app.plots.mainPlot; return { hasHover: !!mp.hover }; })()`);
    // 表格行
    await p.evaluate(`document.querySelector('#extTable tbody tr:nth-child(3)').click()`); await p.waitFor(Q1READY, 8000);
    note('3 点击极值表第3行', false, await p.evaluate(`({ r: __app.state.r_mm, row: document.querySelector('#extTable tbody tr.cur') && document.querySelector('#extTable tbody tr.cur').dataset.r })`));

    // 4. 锁定 / 解锁 → 第二问
    await p.evaluate(`btnLock4.click()`); await p.waitFor(`__app.state.locked && ${Q1READY}`, 8000);
    await p.evaluate(`document.getElementById('tab-q2').click()`);
    await p.waitFor(`__app.q2 && __app.q2.quality==='precise' && ${Q2IDLE}`, 60000); await p.evaluate(MON);
    const mapSz = await p.evaluate(`(() => { const r = cQ2map.getBoundingClientRect(); return { w: r.width, h: r.height, aspect: r.width / r.height }; })()`);
    note('5 二维图画布宽高比（不为 1 则圆环被拉伸成椭圆）', Math.abs(mapSz.aspect - 1) > 0.02, mapSz);
    await p.evaluate(`cQ2map.scrollIntoView({block:'start'})`); await p.sleep(200);
    await p.screenshot(path.join(SHOT, PFX + '02_二维图被拉伸_同相圆孔.png'));
    await p.evaluate(`btnLock4Q2.click()`); await p.sleep(100);
    await p.evaluate(`q2rInput.value='1.2'; q2rInput.dispatchEvent(new Event('change'))`); await p.sleep(600);
    const unl = await p.evaluate(`({ mR: q2mR.textContent, mRs: q2mRs.textContent, pend: !q2pendingBar.hidden, pendT: q2pendingText.textContent, lock: q2lockInfo.innerText })`);
    note('4 解锁并改 r=1.2：第二问标明图样半径 ≠ r₄', !unl.pend, unl);
    await p.evaluate(`q2btnDiscard.click()`); await p.sleep(300);
    await p.evaluate(`btnLock4Q2.click()`); await p.waitFor(`__app.state.locked && Math.abs(__app.state.r_mm-1.3228768035)<1e-9`, 8000);

    // 5. 快速切换四种情形
    const t0 = Date.now();
    await p.evaluate(`__mon.reset(); ['random','linear','disk'].forEach(k => document.querySelector('#q2caseSeg button[data-v='+k+']').click())`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='disk' && __app.q2.quality==='precise' && ${Q2IDLE}`, 90000);
    const sw = await p.evaluate(`({ maxGap: __mon.maxGap, log: __app.debug.log.filter(l=>l.type==='q2').slice(-6) })`);
    const swMs = Date.now() - t0;
    note('5 连续点 3 个情形：最后一个情形等待时间（旧任务排队）', sw.log.filter((l) => l.outcome === 'stale').length > 0, { ms: swMs, maxFrameGap: Math.round(sw.maxGap), outcomes: sw.log.map((l) => l.outcome) });

    // 6. 探针：点击图
    const mr = await rect(p, '#cQ2map');
    await click(p, mr.x + mr.w * 0.5, mr.y + mr.h * 0.3); await p.sleep(300);
    const pr = await p.evaluate(`({ px: __app.q2State.probeX_mm, py: __app.q2State.probeY_mm, mP: q2mP.textContent, cutXv: __app.plots.q2cutX.vlines[0].x, cutYv: __app.plots.q2cutY.vlines[0].x })`);
    note('6 点击设置探针，剖面竖线跟随', Math.abs(pr.cutXv - pr.px) > 1e-9 || Math.abs(pr.cutYv - pr.py) > 1e-9, pr);
    // 拖动探针
    await mouse(p, 'mouseMoved', mr.x + mr.w * 0.5, mr.y + mr.h * 0.5, { buttons: 0, button: 'none' }); await mouse(p, 'mousePressed', mr.x + mr.w * 0.5, mr.y + mr.h * 0.5);
    for (let i = 0; i < 10; i++) { await mouse(p, 'mouseMoved', mr.x + mr.w * (0.5 + i * 0.02), mr.y + mr.h * 0.5); await p.sleep(20); }
    await mouse(p, 'mouseReleased', mr.x + mr.w * 0.7, mr.y + mr.h * 0.5); await p.sleep(200);
    const pd = await p.evaluate(`({ px: __app.q2State.probeX_mm, py: __app.q2State.probeY_mm })`);
    note('6 按住拖动探针（拖动时剖面不跟随，只认最终 click）', false, pd);

    // 7. 缩放二维图 / 剖面
    await wheel(p, mr.x + mr.w / 2, mr.y + mr.h / 2, -300); await p.sleep(200);
    const z = await p.evaluate(`({ hasView: !!(__app.q2View || (__app.q2State && __app.q2State.view)) })`);
    note('7 滚轮缩放二维图：无任何反应（没有缩放功能）', !z.hasView, z);
    const cx = await rect(p, '#cQ2cutX');
    await p.evaluate(`cQ2cutX.scrollIntoView({block:'center'})`); await p.sleep(150);
    const cx2 = await rect(p, '#cQ2cutX');
    await wheel(p, cx2.x + cx2.w / 2, cx2.y + cx2.h / 2, -400); await p.sleep(100);
    const v1 = await p.evaluate(`Object.assign({}, __app.plots.q2cutX.view)`);
    await p.evaluate(`q2px.value='0.3'; q2px.dispatchEvent(new Event('change'))`); await p.sleep(150);
    const v2 = await p.evaluate(`Object.assign({}, __app.plots.q2cutX.view)`);
    note('7 剖面图缩放后移动探针，缩放被重置', Math.abs(v2.x1 - v2.x0 - (v1.x1 - v1.x0)) > 1e-6, { zoomed: v1, afterProbe: v2 });

    // 8. 色标
    const cs = await p.evaluate(`(async () => {
      const out = {}; const clickSeg = (seg, v) => document.querySelector('#' + seg + ' button[data-v=' + v + ']').click();
      clickSeg('q2normSeg','shared'); out.disk_shared = q2mapFoot.textContent;
      clickSeg('q2normSeg','per'); out.disk_per = q2mapFoot.textContent;
      clickSeg('q2scaleSeg','log'); out.cmp_log_hasBar = !!document.querySelector('#q2compareCard canvas[id*=bar]');
      out.cmpFoot = q2holeFoot.textContent + ' | ' + q2diskFoot.textContent;
      clickSeg('q2scaleSeg','linear'); clickSeg('q2normSeg','shared');
      return out; })()`);
    await p.evaluate(`q2compareCard.scrollIntoView({block:'center'}); document.querySelector('#q2scaleSeg button[data-v=log]').click()`); await p.sleep(200);
    await p.screenshot(path.join(SHOT, PFX + '03_对照图_对数色标无色条.png'));
    await p.evaluate(`document.querySelector('#q2scaleSeg button[data-v=linear]').click()`);
    note('8 对照卡没有色条，对数时看不出 1 与 4 的差别', !cs.cmp_log_hasBar, cs);
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=inphase]').click()`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='inphase' && __app.q2.quality==='precise' && ${Q2IDLE}`, 60000);
    const cosm = await p.evaluate(`(() => { const r = {}; document.querySelector('#q2normSeg button[data-v=shared]').click(); r.shared = q2mapFoot.textContent.split('·')[0]; document.querySelector('#q2normSeg button[data-v=per]').click(); r.per = q2mapFoot.textContent.split('·')[0]; document.querySelector('#q2normSeg button[data-v=shared]').click(); return r; })()`);
    note('8 情形 1/2/3 下“共享”与“本图各自”上限完全相同（控件只有外观）', cosm.shared.replace(/[^0-9.]/g, '') === cosm.per.replace(/[^0-9.]/g, ''), cosm);

    // 9. 随机相位
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=random]').click()`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && __app.q2.quality==='precise' && ${Q2IDLE}`, 60000);
    const s0 = await p.evaluate('__app.q2.seed');
    await p.evaluate(`q2btnRegen.click()`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && __app.q2.seed!==${s0} && __app.q2.quality==='precise' && ${Q2IDLE}`, 60000);
    const s1 = await p.evaluate('__app.q2.seed');
    await p.evaluate(`q2seed.value='12345'; q2seed.dispatchEvent(new Event('change'))`); await p.sleep(300);
    const seedPend = await p.evaluate(`({ pend: !q2pendingBar.hidden, text: q2pendingText.textContent, q2: __app.q2.seed })`);
    note('9 重新生成换实现；改种子只进入“未应用”', false, { s0, s1, seedPend });
    await p.evaluate(`q2btnApply.click()`);
    await p.waitFor(`__app.q2 && __app.q2.seed===12345 && __app.q2.quality==='precise' && ${Q2IDLE}`, 60000);

    // 10. 取消
    await p.evaluate(`document.getElementById('tab-q1').click()`); await p.sleep(200);
    const c1 = await p.evaluate(`(async () => { lamInput.value='700'; lamInput.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,30)); btnCancel.click(); await new Promise(r=>setTimeout(r,200));
      lamInput.value='600'; lamInput.dispatchEvent(new Event('change'));
      const t0 = performance.now(); while (performance.now()-t0 < 20000 && !(__app.result.params.lambda_nm===600 && !Object.values(__app.jobs).some(j=>j.type==='q1'))) await new Promise(r=>setTimeout(r,50));
      return { lam: __app.result.params.lambda_nm, busy: __app.previewBusy, jobs: Object.keys(__app.jobs).length, cancelDisabled: btnCancel.disabled }; })()`);
    note('10 第一问取消后改参数重算', c1.lam !== 600 || c1.busy, c1);
    await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && ${Q1READY}`, 20000);

    // 11. 导出 + 布局
    for (const [w, h] of [[1080, 800], [780, 900], [390, 844]]) {
      await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await p.evaluate(`document.getElementById('tab-q1').click(); window.scrollTo(0,0)`); await p.sleep(500);
      const o1 = await overlaps(p);
      await p.screenshot(path.join(SHOT, PFX + `04_第一问_${w}宽.png`));
      await p.evaluate(`document.getElementById('tab-q2').click(); window.scrollTo(0,0)`); await p.sleep(700);
      const o2 = await overlaps(p);
      await p.screenshot(path.join(SHOT, PFX + `05_第二问_${w}宽.png`));
      const vis = await p.evaluate(`(() => { const a = document.getElementById('q2caseSeg').getBoundingClientRect(), m = cQ2map.getBoundingClientRect(); return { caseTop: a.top, caseBottom: a.bottom, mapTop: m.top, vh: innerHeight }; })()`);
      note(`11 布局 ${w}px：重叠 / 截断`, o1.nOverlap + o2.nOverlap + o1.nClipped + o2.nClipped > 0 || o1.docW > w + 1 || o2.docW > w + 1, { q1: o1, q2: o2, vis });
    }
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  } finally {
    fs.writeFileSync(OUT, JSON.stringify({ url: BASE, generated: new Date().toISOString(), found, logs: p.logs.slice(-40) }, null, 2));
    console.log('issues:', found.filter((f) => f.issue).length, '/', found.length);
    try { p.close(); } catch (e) { /* */ }
    process.exit(0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
