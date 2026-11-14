/* regression_fix1.js — 阶段 1 修复轮的浏览器回归测试（无头 Chrome，真实页面、真实事件）。
 * 覆盖：7 个问题的回归 + 半径参数扫描 + 三项数值基准 + file:// 回退。并生成截图。
 * 需要：Chrome --remote-debugging-port=9333；本地服务器 http://127.0.0.1:8765（node server.js 8765）。
 * 用法：node tools/regression_fix1.js            结果写入 validation/regression_fix1.json */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots'), DL = '/tmp/cal-dl-fix1';
const BASE = process.env.CAL_URL || 'http://127.0.0.1:8765/index.html';
fs.mkdirSync(SHOT, { recursive: true }); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
const checks = [];
const ok = (group, name, cond, detail) => { checks.push({ group, name, pass: !!cond, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) }); console.log((cond ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };
const READY = 'window.__app && __app.result && __app.point && __app.point.quality==="precise" && !Object.values(__app.jobs).some(j=>j.type!=="conv")';
const IDLE = '!Object.values(__app.jobs).some(j=>j.type!=="conv")';
// 在页面里检查主图标签框：都在画布内、都在各自标签带内、同一带内互不重叠、都在绘图框左右边界内
const LABEL_CHECK = `(function(boxes, W, H, pad, band){
  const bad = []; const lanes = { top: [], bottom: [] };
  for (const b of boxes) {
    const lane = b.m.lane; lanes[lane].push(b);
    if (b.x0 < 0 || b.x1 > W || b.y0 < 0 || b.y1 > H) bad.push({ label: b.m.label, why: '超出画布' });
    if (b.overflow > 0.5) bad.push({ label: b.m.label, why: '超出标签带 ' + b.overflow.toFixed(1) + 'px' });
    if (b.x0 < pad.l - 8 || b.x1 > W - pad.r + 8) bad.push({ label: b.m.label, why: '超出绘图框左右' });
    if (!/\\d\\.\\d{5}/.test(b.m.label)) bad.push({ label: b.m.label, why: '缺半径数值' });
  }
  for (const k of ['top','bottom']) { const a = lanes[k].slice().sort((p,q)=>p.x0-q.x0); for (let i=1;i<a.length;i++) if (a[i].x0 < a[i-1].x1 - 0.5) bad.push({ label: a[i].m.label, why: '与 ' + a[i-1].m.label + ' 重叠' }); }
  return { n: boxes.length, top: lanes.top.length, bottom: lanes.bottom.length, bad };
})`;

async function setFile(p, sel, file) {
  const doc = await p.send('DOM.getDocument', {}); const q = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
  await p.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
}
async function newestDownload(prefix, before) {
  for (let i = 0; i < 60; i++) {
    const f = fs.readdirSync(DL).filter((x) => x.includes(prefix) && !x.endsWith('.crdownload') && !before.includes(x));
    if (f.length) return path.join(DL, f[0]);
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
const pngSize = (f) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

(async () => {
  const W = 1400, H = 900;
  let p = await connect(9333, BASE, [W, H]);
  await p.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await p.waitFor(READY, 30000); await p.sleep(1300);

  /* ---------- 0. 数值基准（页面内，同一内核） ---------- */
  const bm = await p.evaluate(`({ r4: __app.result.fourth.r*1e3, I4: __app.result.fourth.I, rlim: __app.result.r4.rLimit*1e3, nmax: __app.result.maxima.length, nmin: __app.result.minima.length, mode: modeInfo.textContent, chip: presetChip.textContent, nr: __app.result.curve.nr })`);
  ok('基准', '第 4 极大 r ≈ 1.3228768035 mm', Math.abs(bm.r4 - 1.3228768035) < 5e-11, bm.r4.toFixed(10) + ' mm');
  ok('基准', '第 4 极大 I/I_inc ≈ 3.999986', Math.abs(bm.I4 - 3.999986) < 5e-7, bm.I4.toFixed(7));
  ok('基准', '5% r⁴ 区边界 ≈ 0.2495438957 mm', Math.abs(bm.rlim - 0.2495438957) < 5e-11, bm.rlim.toFixed(10) + ' mm');
  ok('基准', '0–2.2 mm：10 个极大、9 个极小', bm.nmax === 10 && bm.nmin === 9, `${bm.nmax} 极大 / ${bm.nmin} 极小，N_r = ${bm.nr}`);
  ok('基准', 'Web Worker 模式、题目预设', bm.mode.includes('Worker') && bm.chip.includes('题目预设'), bm.mode + ' / ' + bm.chip);
  await p.screenshot(path.join(SHOT, '01_默认题目预设总览_1400x900.png'));

  /* ---------- Bug 2：极值标签 ---------- */
  const lab = await p.evaluate(`(() => { const mp = __app.plots.mainPlot; return ${LABEL_CHECK}(mp.labelBoxes, mp.W, mp.H, mp.pad, mp._band); })()`);
  ok('问题2', '默认主图 19 个极值标签全部完整（不裁剪、不截断、不重叠、含半径）', lab.n === 19 && lab.top === 10 && lab.bottom === 9 && lab.bad.length === 0, lab);
  const off = await p.evaluate(`(() => { const mp = __app.plots.mainPlot; __app.exportPngCanvas(); const o = mp.lastOffscreen; return ${LABEL_CHECK}(o.boxes, o.W, o.H, o.pad, o.band); })()`);
  ok('问题2', 'PNG 导出中的主图（离屏 1752 px 重排）标签同样完整', off.n === 19 && off.bad.length === 0, off);
  const lab4 = await p.evaluate(`__app.plots.mainPlot.labelBoxes.map(b => b.m.label).filter(l => l.includes('★'))`);
  ok('问题2', '第 4 极大标签带 ★ 与半径', lab4.length === 1 && lab4[0].includes('1.32288'), lab4.join());
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'}); window.scrollBy(0,-4)`); await p.sleep(300);
  const pc = await p.evaluate(`(() => { const r = document.querySelector('.plotcard').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await p.screenshot(path.join(SHOT, '02_主图极值标签完整_提交图_页面截图.png'), { clip: { x: pc.x, y: Math.max(0, pc.y), width: pc.w, height: pc.h, scale: 1 } });
  let before = fs.readdirSync(DL);
  await p.evaluate(`btnPngMain.click()`);
  let f = await newestDownload('提交图', before);
  if (f) { fs.copyFileSync(f, path.join(SHOT, '03_导出PNG_提交图_主图极值半径.png')); }
  ok('问题2', '导出提交图 PNG（2×，主图 + 极值半径）', !!f && pngSize(f).w === 3200, f ? JSON.stringify(pngSize(f)) : '未下载');
  before = fs.readdirSync(DL);
  await p.evaluate(`btnPng.click()`);
  f = await newestDownload('图像', before);
  if (f) fs.copyFileSync(f, path.join(SHOT, '04_导出PNG_全部图像_含元数据.png'));
  ok('问题2', '导出全部图像 PNG（含元数据，长文本自动换行）', !!f && pngSize(f).w === 1800, f ? JSON.stringify(pngSize(f)) : '未下载');

  /* ---------- Bug 1：旧曲线与新参数混用 ---------- */
  const b1 = await p.evaluate(`(async () => {
    extParams.open = true;
    lamInput.value = '700'; lamInput.dispatchEvent(new Event('change'));
    const during = { busy: !btnCancel.disabled, bar: !pendingBar.hidden, txt: pendingText.textContent };
    btnCancel.click();
    await new Promise(r => setTimeout(r, 300));
    rInput.value = '0.5'; rInput.dispatchEvent(new Event('change'));
    const t0 = performance.now(); while (performance.now() - t0 < 5000 && !(${READY} && Math.abs(__app.state.r_mm - 0.5) < 1e-12)) await new Promise(r => setTimeout(r, 50));
    const c = __app.result.curve, f = 0.5e-3 / c.rMax * (c.nr - 1), j = Math.floor(f), t = f - j;
    const cI = (c.re[j]*(1-t)+c.re[j+1]*t)**2 + (c.im[j]*(1-t)+c.im[j+1]*t)**2;
    const cfg = __app.configObject();
    return { during, appliedLam: __app.result.params.lambda_nm, editLam: __app.state.lambda_nm, pointResult: __app.point.resultId, resultId: __app.result.id,
      curveI: cI, cardI: parseFloat(mI.textContent), cardSrc: mIs.textContent, NF: mNF.textContent, bar: !pendingBar.hidden, barTxt: pendingText.textContent,
      lamMarked: lamInput.classList.contains('pending-edit'), chip: presetChip.textContent, concept: cText.textContent.slice(0, 80),
      cfgLam: cfg.params.lambda_nm, cfgPending: cfg.unappliedEdits, phFoot: phFoot.textContent.slice(0, 40), cursorY: __app.plots.mainPlot.cursor.y };
  })()`);
  ok('问题1', '编辑 λ=700 后、完成前：提示条立即显示“计算中/未应用”', b1.during.bar, b1.during.txt.slice(0, 80));
  ok('问题1', '取消后设 r=0.5：曲线仍是 λ=500 的已完成结果，卡片 I 也属于同一结果（≈4，不是 3.246977）',
    b1.appliedLam === 500 && b1.pointResult === b1.resultId && Math.abs(b1.cardI - b1.curveI) < 1e-4 && Math.abs(b1.cardI - 3.246977) > 0.5,
    `曲线 I(0.5) = ${b1.curveI.toFixed(6)}，卡片 I = ${b1.cardI}，${b1.cardSrc}，N_F = ${b1.NF}`);
  ok('问题1', '游标点 = 卡片光强（同一结果）', Math.abs(b1.cursorY - b1.cardI) < 1e-6, b1.cursorY);
  ok('问题1', '未应用编辑清楚标出（提示条 + 输入框虚线框）', b1.bar && /λ = 700 nm/.test(b1.barTxt) && /已应用 500 nm/.test(b1.barTxt) && b1.lamMarked, b1.barTxt.slice(0, 120));
  ok('问题1', '预设标签/说明/导出按已应用参数（λ=500），未应用编辑单独列出', b1.chip.includes('题目预设') && b1.cfgLam === 500 && b1.cfgPending && b1.cfgPending.lambda_nm === 700, JSON.stringify({ chip: b1.chip, cfgLam: b1.cfgLam, pend: b1.cfgPending }));
  await p.evaluate(`window.scrollTo(0, 0)`); await p.sleep(250);
  await p.screenshot(path.join(SHOT, '05_问题1修复_取消后未应用编辑与已应用曲线一致.png'));
  await p.evaluate(`btnApply.click()`);
  await p.waitFor(`__app.result.params.lambda_nm===700 && ${READY} && Math.abs(__app.state.r_mm-0.5)<1e-12`, 15000);
  const b1b = await p.evaluate(`(() => { const c = __app.result.curve, f = 0.5e-3 / c.rMax * (c.nr - 1), j = Math.floor(f), t = f - j; const re = c.re[j]*(1-t)+c.re[j+1]*t, im = c.im[j]*(1-t)+c.im[j+1]*t; return { cardI: parseFloat(mI.textContent), curveI: re*re+im*im, bar: !pendingBar.hidden, chip: presetChip.textContent }; })()`);
  ok('问题1', '“应用并计算”后：曲线与卡片同为 λ=700（I(0.5 mm) = 3.246977），提示条消失', Math.abs(b1b.cardI - 3.246977) < 2e-6 && Math.abs(b1b.curveI - b1b.cardI) < 1e-4 && !b1b.bar, b1b);
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && __app.state.locked && ${READY}`, 15000);

  /* ---------- Bug 4：预览任务生命周期 ---------- */
  const waitPreview = (lam) => `(async () => { const t0 = performance.now(); while (performance.now() - t0 < 4000) { if (__app.result.quality === 'preview' && __app.result.params.lambda_nm === ${lam}) return true; await new Promise(r => setTimeout(r, 30)); } return false; })()`;
  // (a) 快速松开
  await p.evaluate(`extParams.open = true; lamSlider.value='560'; lamSlider.dispatchEvent(new Event('input')); lamSlider.value='600'; lamSlider.dispatchEvent(new Event('input')); lamSlider.dispatchEvent(new Event('change'));`);
  await p.waitFor(`__app.result.params.lambda_nm===600 && __app.result.quality==='final' && ${IDLE}`, 15000);
  const a1 = await p.evaluate(`({ busy: __app.previewBusy, stale: __app.staleDropped })`);
  await p.evaluate(`lamSlider.value='650'; lamSlider.dispatchEvent(new Event('input'))`);
  const a2 = await p.evaluate(waitPreview(650));
  ok('问题4', '快速松开后 previewBusy 已清除，下一次拖动仍有预览', a1.busy === false && a2 === true, JSON.stringify({ busyAfterRelease: a1.busy, staleDropped: a1.stale, nextDragPreview: a2 }));
  await p.evaluate(`lamSlider.dispatchEvent(new Event('change'))`); await p.waitFor(`__app.result.params.lambda_nm===650 && __app.result.quality==='final' && ${IDLE}`, 15000);
  // (b) 连续拖动
  const cont = await p.evaluate(`(async () => {
    const ids = new Set(); let maxFrame = 0, last = performance.now();
    for (let i = 0; i <= 40; i++) { lamSlider.value = String(600 + i * 2); lamSlider.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 25)); if (__app.result.quality === 'preview') ids.add(__app.result.id); const n = performance.now(); maxFrame = Math.max(maxFrame, n - last); last = n; }
    const t0 = performance.now(); while (performance.now() - t0 < 3000 && (__app.previewBusy || __app.result.params.lambda_nm !== 680)) await new Promise(r => setTimeout(r, 30));
    const end = { lam: __app.result.params.lambda_nm, q: __app.result.quality, busy: __app.previewBusy, dirty: __app.previewDirty };
    lamSlider.dispatchEvent(new Event('change'));
    return { previews: ids.size, end, maxFrame };
  })()`);
  ok('问题4', '连续拖动：多次预览刷新，停住后预览追上最后的 λ，忙标志清除', cont.previews >= 3 && cont.end.lam === 680 && cont.end.busy === false, cont);
  await p.waitFor(`__app.result.params.lambda_nm===680 && __app.result.quality==='final' && ${IDLE}`, 15000);
  // (c) 拖动中取消
  const c1 = await p.evaluate(`(async () => { lamSlider.value='700'; lamSlider.dispatchEvent(new Event('input')); const b0 = __app.previewBusy; btnCancel.click(); const b1 = __app.previewBusy; await new Promise(r => setTimeout(r, 200)); return { busyBefore: b0, busyAfterCancel: b1, jobs: Object.keys(__app.jobs).length }; })()`);
  await p.evaluate(`lamSlider.value='710'; lamSlider.dispatchEvent(new Event('input'))`);
  const c2 = await p.evaluate(waitPreview(710));
  ok('问题4', '拖动中取消：忙标志立即清除，再拖动仍有预览', c1.busyBefore && !c1.busyAfterCancel && c2, JSON.stringify({ c1, nextPreview: c2 }));
  await p.evaluate(`lamSlider.dispatchEvent(new Event('change'))`); await p.waitFor(`__app.result.params.lambda_nm===710 && __app.result.quality==='final' && ${IDLE}`, 15000);
  // (d) 预览任务失败
  const d1 = await p.evaluate(`(async () => { __app.debug.failNext = 'q1-preview'; lamSlider.value='720'; lamSlider.dispatchEvent(new Event('input'));
    const t0 = performance.now(); while (performance.now() - t0 < 4000 && !__app.lastError) await new Promise(r => setTimeout(r, 30));
    return { err: __app.lastError, busy: __app.previewBusy, badge: qBadge.textContent }; })()`);
  await p.evaluate(`lamSlider.value='730'; lamSlider.dispatchEvent(new Event('input'))`);
  const d2 = await p.evaluate(waitPreview(730));
  const d3 = await p.evaluate(`({ err: __app.lastError })`);
  ok('问题4', '预览任务失败：显示错误、忙标志清除，下一次拖动恢复预览并清除错误', !!d1.err && d1.busy === false && d2 && d3.err === null, JSON.stringify({ d1, nextPreview: d2, errAfter: d3.err }));
  await p.evaluate(`lamSlider.dispatchEvent(new Event('change'))`); await p.waitFor(`__app.result.params.lambda_nm===730 && __app.result.quality==='final' && ${IDLE}`, 15000);
  // (e) 最终任务失败：保留上一结果
  const e1 = await p.evaluate(`(async () => { const id0 = __app.result.id; __app.debug.failNext = 'q1'; lamInput.value='740'; lamInput.dispatchEvent(new Event('change'));
    const t0 = performance.now(); while (performance.now() - t0 < 4000 && !__app.lastError) await new Promise(r => setTimeout(r, 30));
    return { err: __app.lastError, keep: __app.result.id === id0, lam: __app.result.params.lambda_nm, bar: !pendingBar.hidden, busy: !btnCancel.disabled }; })()`);
  ok('问题4', '最终任务失败：保留上一完成结果，λ=740 显示为未应用，任务不残留', !!e1.err && e1.keep && e1.lam === 730 && e1.bar && !e1.busy, e1);
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && __app.state.locked && ${READY}`, 15000);

  /* ---------- Bug 3：r_max = 0.3 mm ---------- */
  await p.evaluate(`extParams.open = true; rMaxInput.value = '0.3'; rMaxInput.dispatchEvent(new Event('change'))`);
  await p.waitFor(`__app.result.params.rMax_mm===0.3 && ${READY}`, 15000);
  const b3 = await p.evaluate(`({ maxima: __app.result.maxima.length, m4: m4.textContent, m4s: m4s.textContent, lock: lockInfo.textContent, q2r: q2r.textContent, q2rBig: q2rBig.textContent, locked: __app.state.locked, lockDisabled: btnLock4.disabled, extFoot: extFoot.textContent, r: __app.state.r_mm })`);
  ok('问题3', '极值不足：不残留旧 r₄ 锁定 / 第二问半径', b3.maxima === 0 && !b3.lock.includes('1.3228768') && b3.lock.includes('无法锁定') && b3.q2r.includes('未求得') && b3.q2rBig.includes('不足') && !b3.locked && b3.lockDisabled, b3);
  ok('问题3', '极值表与汇总无 NaN / Infinity', !/NaN|Infinity/.test(b3.extFoot + b3.m4s), b3.extFoot.slice(0, 80));
  await p.evaluate(`convDetails.open = true; btnConv.click()`);
  await p.waitFor(`convStatus.textContent.includes('完成') || convStatus.textContent.includes('失败')`, 60000);
  const c3 = await p.evaluate(`({ st: convStatus.textContent, err: __app.lastError, out: convOut.textContent.slice(0, 200), nan: /NaN|Infinity/.test(convOut.textContent) })`);
  ok('问题3', '收敛检查在 r_max = 0.3 mm 下正常完成，不抛异常', c3.st.includes('完成') && !c3.err && !c3.nan, c3.st);
  await p.evaluate(`document.querySelector('.side').scrollIntoView({block:'start'}); window.scrollTo(0,0)`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, '06_问题3修复_rmax0.3极值不足_无残留锁定.png'));
  await p.evaluate(`convDetails.scrollIntoView({block:'start'})`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, '07_问题3修复_rmax0.3收敛检查正常完成.png'));
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.rMax_mm===2.2 && __app.state.locked && ${READY}`, 15000);
  const back3 = await p.evaluate(`({ r: __app.state.r_mm, q2r: q2r.textContent })`);
  ok('问题3', '恢复预设后重新锁定第 4 极大', Math.abs(back3.r - 1.3228768035) < 1e-9 && back3.q2r.startsWith('1.322877'), back3);

  /* ---------- Bug 7：r = 0 配置往返 ---------- */
  await p.evaluate(`window.scrollTo(0,0); __app.setRadius(0, { precise: true, forceInput: true })`);
  await p.waitFor(`${READY} && __app.state.r_mm===0`, 8000);
  before = fs.readdirSync(DL);
  await p.evaluate(`btnJson.click()`);
  f = await newestDownload('参数配置', before);
  const cfg0 = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.copyFileSync(f, path.join(ROOT, 'validation', 'config_r0_roundtrip.json'));
  await p.evaluate(`__app.setRadius(0.8, { precise: true, forceInput: true })`); await p.waitFor(`${READY} && __app.state.r_mm===0.8`, 8000);
  await setFile(p, '#fileJson', f);
  await p.waitFor(`${READY} && __app.state.r_mm===0`, 10000).catch(() => {});
  const r7 = await p.evaluate(`({ r: __app.state.r_mm, input: rInput.value, slider: rSlider.value, locked: __app.state.locked, I: __app.point.I, note: sText.textContent, lam: __app.result.params.lambda_nm })`);
  ok('问题7', '导出 r = 0 的配置再载入，r 仍为 0（不再变成 1 mm）', cfg0.params.r_mm === 0 && r7.r === 0 && parseFloat(r7.input) === 0 && r7.I === 0 && !r7.locked, r7);
  await p.evaluate(`document.querySelector('.side').scrollIntoView({block:'start'}); window.scrollTo(0,0)`); await p.sleep(250);
  await p.screenshot(path.join(SHOT, '08_问题7修复_r0配置载入后仍为0.png'));
  // 其它组合往返：扩展参数 + 低阈值 + r² 轴 + 预览精度
  const tmp2 = '/tmp/cal_cfg_ext.json';
  fs.writeFileSync(tmp2, JSON.stringify(Object.assign({}, cfg0, { params: Object.assign({}, cfg0.params, { lambda_nm: 600, L_cm: 30, rMax_mm: 3, r_mm: 0, r4Threshold: 0.01, lockedToFourthMax: false }), precision: { key: 'preview' }, view: { xAxis: 'r2' } })));
  await setFile(p, '#fileJson', tmp2);
  await p.waitFor(`__app.result.params.lambda_nm===600 && __app.result.params.L_cm===30 && ${READY}`, 15000);
  const r7b = await p.evaluate(`({ r: __app.state.r_mm, thr: __app.state.thr, x: __app.state.xAxis, prec: __app.result.precision, rMax: __app.result.params.rMax_mm })`);
  ok('问题7', '扩展参数配置往返（λ=600, L=30, r_max=3, r=0, 阈值 1 %, r² 轴, 预览）', r7b.r === 0 && r7b.thr === 0.01 && r7b.x === 'r2' && r7b.prec === 'preview' && r7b.rMax === 3, r7b);
  // 非法值：缺失 / 负数 / 0 波长 → 默认并提示
  const tmp3 = '/tmp/cal_cfg_bad.json';
  fs.writeFileSync(tmp3, JSON.stringify({ params: { lambda_nm: 0, L_cm: 50, rMax_mm: 2.2, r_mm: -1, r4Threshold: 0.05 } }));
  await setFile(p, '#fileJson', tmp3);
  await p.waitFor(`__app.result.params.lambda_nm===500 && __app.result.params.L_cm===50 && __app.result.precision==='standard' && ${READY}`, 15000);
  const r7c = await p.evaluate(`({ r: __app.state.r_mm, note: sText.textContent })`);
  ok('问题7', '非法字段（λ=0、r=−1）用默认值并提示', r7c.r === 1 && /非法或缺失/.test(r7c.note) && /λ/.test(r7c.note) && /r = -1/.test(r7c.note), r7c.note.slice(0, 100));
  // 官方预设往返（锁定第 4 极大）
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.state.locked && __app.result.params.lambda_nm===500 && __app.state.xAxis==='r' && ${READY}`, 15000);
  const cfgP = await p.evaluate(`JSON.stringify(__app.configObject())`); fs.writeFileSync('/tmp/cal_cfg_preset.json', cfgP);
  await p.evaluate(`__app.setRadius(0.3, { precise: true, forceInput: true })`);
  await setFile(p, '#fileJson', '/tmp/cal_cfg_preset.json');
  await p.waitFor(`__app.state.locked && ${READY} && Math.abs(__app.state.r_mm-1.3228768035)<1e-9`, 15000).catch(() => {});
  const r7d = await p.evaluate(`({ r: __app.state.r_mm, locked: __app.state.locked, chip: presetChip.textContent, thr: __app.state.thr })`);
  ok('问题7', '官方预设配置往返（锁定第 4 极大、阈值 5 %）', r7d.locked && Math.abs(r7d.r - 1.3228768035) < 1e-9 && r7d.chip.includes('题目预设') && r7d.thr === 0.05, r7d);

  /* ---------- 半径参数扫描 ---------- */
  await p.evaluate(`document.getElementById('scanSpeed').value = '1'; scanFromZero.click()`);
  await p.sleep(700);
  const s1 = await p.evaluate(`(() => { const mp = __app.plots.mainPlot, c = __app.result.curve, r = __app.state.r_mm*1e-3, f = r / c.rMax * (c.nr - 1), j = Math.floor(f), t = f - j;
    const re = c.re[j]*(1-t)+c.re[j+1]*t, im = c.im[j]*(1-t)+c.im[j+1]*t;
    return { playing: __app.scan.playing, on: __app.scan.on, r: __app.state.r_mm, pointR: __app.point.r*1e3, cursorX: mp.cursor.x, vline: mp.vlines[0].x, I: __app.point.I, curveI: re*re+im*im, state: scanState.textContent, info: scanInfo.textContent, slider: +rSlider.value, quality: __app.point.quality, segs: __app.point.seg.segments.length }; })()`);
  ok('扫描', '从 0 自动扫描：r 随时间增大，游标 / 竖线 / 当前点 / 滑块同步', s1.playing && s1.r > 0.05 && Math.abs(s1.cursorX - s1.r) < 1e-12 && Math.abs(s1.vline - s1.r) < 1e-12 && Math.abs(s1.pointR - s1.r) < 1e-9 && Math.abs(s1.slider - s1.r) < 1e-3, s1);
  ok('扫描', '扫描帧中的光强 = 该 r 下稳态 I(r)（取自数值曲线），不是时间调制', Math.abs(s1.I - s1.curveI) < 1e-12, `I = ${s1.I.toFixed(6)}，曲线 I(r) = ${s1.curveI.toFixed(6)}`);
  // 播放中采样多帧：每一帧 I 都等于曲线在该 r 的值；r 单调增
  const frames = await p.evaluate(`(async () => { const out = []; for (let i = 0; i < 12; i++) { await new Promise(r => requestAnimationFrame(r)); const c = __app.result.curve, r = __app.state.r_mm*1e-3, f = r / c.rMax * (c.nr - 1), j = Math.floor(f), t = f - j; const re = c.re[j]*(1-t)+c.re[j+1]*t, im = c.im[j]*(1-t)+c.im[j+1]*t; out.push({ r: __app.state.r_mm, dI: Math.abs(__app.point.I - (re*re+im*im)) }); } return out; })()`);
  const mono = frames.every((x, i) => i === 0 || x.r >= frames[i - 1].r), maxdI = Math.max(...frames.map((x) => x.dI));
  ok('扫描', '连续 12 帧：r 单调增大，每帧 I 与 I(r) 曲线一致', mono && maxdI < 1e-12, `r ${frames[0].r.toFixed(4)} → ${frames[11].r.toFixed(4)} mm，max|ΔI| = ${maxdI.toExponential(1)}`);
  await p.evaluate(`window.scrollTo(0,0)`); await p.sleep(80);
  await p.screenshot(path.join(SHOT, '09_半径扫描_播放中_游标同步.png'));
  await p.evaluate(`scanToggle.click()`);
  await p.waitFor(`!__app.scan.playing && __app.point.quality==='precise'`, 6000);
  const s2 = await p.evaluate(`(async () => { const r0 = __app.state.r_mm, vals = []; for (let i = 0; i < 10; i++) { vals.push(mI.textContent); await new Promise(r => setTimeout(r, 100)); } return { r0, r1: __app.state.r_mm, vals: [...new Set(vals)], state: scanState.textContent, on: __app.scan.on, btn: scanToggle.textContent }; })()`);
  ok('扫描', '暂停：r 不变，精确值补算后光强读数在 1 s 内恒定（无闪烁）', s2.r0 === s2.r1 && s2.vals.length === 1 && s2.state === '已暂停' && s2.on && s2.btn.includes('继续'), s2);
  await p.screenshot(path.join(SHOT, '10_半径扫描_已暂停_精确值.png'));
  const st = await p.evaluate(`(async () => { const NF = () => { const r = __app.state.r_mm*1e-3; return r*r/(500e-9*0.5); };
    scanStepSize.value = '0.1'; const n0 = NF(); scanFwd.click(); const n1 = NF(); scanBack.click(); scanBack.click(); const n2 = NF();
    await new Promise(r => setTimeout(r, 400)); return { n0, n1, n2, q: __app.point.quality, playing: __app.scan.playing }; })()`);
  ok('扫描', '单步 ▸ / ◂：N_F 每步 ±0.1，单步后精算', Math.abs(st.n1 - st.n0 - 0.1) < 1e-9 && Math.abs(st.n2 - st.n0 + 0.1) < 1e-9 && !st.playing && st.q === 'precise', st);
  const ex = await p.evaluate(`(async () => { __app.setRadius(1.05, { precise: true, forceInput: true }); await new Promise(r => setTimeout(r, 200));
    const E = __app.result.extrema; scanNext.click(); const a = { r: __app.state.r_mm, k: E.find(e => Math.abs(e.r*1e3 - __app.state.r_mm) < 1e-12) };
    scanNext.click(); const b = { r: __app.state.r_mm, k: E.find(e => Math.abs(e.r*1e3 - __app.state.r_mm) < 1e-12) };
    scanPrev.click(); scanPrev.click(); const c = { r: __app.state.r_mm, k: E.find(e => Math.abs(e.r*1e3 - __app.state.r_mm) < 1e-12) };
    await new Promise(r => setTimeout(r, 500));
    return { a: a.k && a.k.kind + a.k.index, b: b.k && b.k.kind + b.k.index, c: c.k && c.k.kind + c.k.index, info: scanInfo.textContent, rowCur: document.querySelector('#extTable tr.cur td') && document.querySelector('#extTable tr.cur td').textContent, q: __app.point.quality }; })()`);
  ok('扫描', '下一个 / 上一个极值：从 r = 1.05 mm 依次到 极大3 → 极小3 → 再后退两次到 极小2（极值表行同步高亮）', ex.a === 'max3' && ex.b === 'min3' && ex.c === 'min2' && ex.q === 'precise' && /极小 2/.test(ex.rowCur), ex);
  await p.evaluate(`scanNext.click(); scanNext.click(); scanNext.click();`); await p.sleep(400);
  const sync = await p.evaluate(`(() => { const r = __app.state.r_mm, pt = __app.point; return { r, NFcard: mNF.textContent, ap: apFoot.textContent.slice(0, 120), ph: phFoot.textContent.slice(0, 40), phSum: Math.hypot(pt.seg.sum.re - pt.U.re, pt.seg.sum.im - pt.U.im), cursor: __app.plots.mainPlot.cursor.x }; })()`);
  ok('扫描', '孔径半波带说明、相量合成与游标对应同一 r（N_F ≈ 7，相量箭头和 = U）', Math.abs(sync.r - 1.3228768035) < 1e-9 && sync.ap.includes('7.0000') && sync.phSum < 1e-6 && sync.cursor === sync.r, sync);
  await p.screenshot(path.join(SHOT, '11_半径扫描_下一个极值_第4极大_三图同步.png'));
  const endRun = await p.evaluate(`(async () => { scanSpeed.value = '8'; __app.setRadius(2.0, { forceInput: true }); scanToggle.click(); const t0 = performance.now(); while (performance.now() - t0 < 6000 && __app.scan.playing) await new Promise(r => setTimeout(r, 50)); return { r: __app.state.r_mm, playing: __app.scan.playing, note: scanInfo.textContent }; })()`);
  ok('扫描', '扫描到 r_max 自动暂停', endRun.r === 2.2 && !endRun.playing && endRun.note.includes('r_max'), endRun);
  const man = await p.evaluate(`(async () => { scanToggle.click(); await new Promise(r => setTimeout(r, 300)); const was = __app.scan.playing; rSlider.value = '0.7'; rSlider.dispatchEvent(new Event('input')); return { was, on: __app.scan.on, playing: __app.scan.playing }; })()`);
  ok('扫描', '手动拖动半径滑块会退出扫描模式（从 r_max 重新播放时先回到 0）', man.was && !man.on && !man.playing, man);

  /* ---------- Bug 5：混叠（λ=380 nm, L=10 cm, r_max=6 mm） ---------- */
  await p.evaluate(`btnPreset.click()`); await p.waitFor(`__app.result.params.lambda_nm===500 && ${READY}`, 15000);
  await p.evaluate(`document.querySelector('#precSeg button[data-v=preview]').click()`);
  await p.waitFor(`__app.result.precision==='preview' && ${READY}`, 15000);
  await p.evaluate(`extParams.open = true; lamInput.value='380'; lamInput.dispatchEvent(new Event('change')); LInput.value='10'; LInput.dispatchEvent(new Event('change')); rMaxInput.value='6'; rMaxInput.dispatchEvent(new Event('change'));`);
  await p.waitFor(`__app.result.params.rMax_mm===6 && __app.result.params.L_cm===10 && __app.result.precision==='preview' && ${READY}`, 60000);
  const pv = await p.evaluate(`({ nmax: __app.result.maxima.length, nmin: __app.result.minima.length, nr: __app.result.curve.nr, rs: __app.result.curve.rsamp, refine: __app.result.curve.refineMode, ms: __app.result.ms, foot: extFoot.textContent.slice(0, 60) })`);
  ok('问题5', '预览档：按相位约束 N_r，检出 ≈ 473 个极大（原 800 点只有 181）', pv.nmax >= 470 && pv.rs.dNF <= 0.26 && pv.nr >= 7500, `${pv.nmax} 极大 / ${pv.nmin} 极小，N_r = ${pv.nr}，ΔN_F = ${pv.rs.dNF.toFixed(3)}，每周期 ${pv.rs.samplesPerPeriod.toFixed(1)} 点，${pv.refine}，${pv.ms} ms`);
  await p.evaluate(`window.scrollTo(0,0)`); await p.sleep(250);
  await p.screenshot(path.join(SHOT, '12_问题5修复_混叠工况_预览档473个极大.png'));
  const t5 = Date.now();
  await p.evaluate(`document.querySelector('#precSeg button[data-v=standard]').click()`);
  await p.waitFor(`__app.result.precision==='standard' && __app.result.params.rMax_mm===6 && ${READY}`, 120000);
  const sv = await p.evaluate(`({ nmax: __app.result.maxima.length, nmin: __app.result.minima.length, nr: __app.result.curve.nr, rs: __app.result.curve.rsamp, refine: __app.result.curve.refineMode })`);
  ok('问题5', '标准档：473 个极大，与预览档一致（相差 ≤ 3）', sv.nmax === 473 && Math.abs(sv.nmax - pv.nmax) <= 3, `${sv.nmax} 极大 / ${sv.nmin} 极小，N_r = ${sv.nr}，ΔN_F = ${sv.rs.dNF.toFixed(3)}，${sv.refine}，用时 ${((Date.now() - t5) / 1000).toFixed(1)} s`);
  await p.screenshot(path.join(SHOT, '13_问题5修复_混叠工况_标准档473个极大.png'));
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'}); const mp = __app.plots.mainPlot; mp.view = Object.assign({}, mp.view, { x0: 5.85, x1: 6.0 }); mp.onView(mp.view); mp.draw();`); await p.sleep(300);
  const z = await p.evaluate(`(() => { const mp = __app.plots.mainPlot; return ${LABEL_CHECK}(mp.labelBoxes, mp.W, mp.H, mp.pad, mp._band); })()`);
  ok('问题5', '放大 5.85–6.0 mm：极值标签自动出现且完整', z.n > 0 && z.bad.length === 0, z);
  await p.screenshot(path.join(SHOT, '14_问题5修复_混叠工况_放大5.85-6mm_极值可分辨.png'));
  // 预览拖动（λ 滑块）在该工况下的预览也不混叠
  await p.evaluate(`lamSlider.value='381'; lamSlider.dispatchEvent(new Event('input'))`);
  await p.waitFor(`__app.result.quality==='preview' && __app.result.params.lambda_nm===381`, 10000);
  const dv = await p.evaluate(`({ nmax: __app.result.maxima.length, nr: __app.result.curve.nr })`);
  ok('问题5', 'λ 拖动预览（381 nm）同样不混叠', dv.nmax >= 468, dv);
  await p.evaluate(`btnCancel.click(); btnPreset.click()`);
  await p.waitFor(`__app.result.params.lambda_nm===500 && __app.result.params.rMax_mm===2.2 && __app.result.precision==='standard' && ${READY}`, 60000);

  const errs = p.logs.filter((l) => /^(error|EXCEPTION)/i.test(l));
  ok('综合', '控制台无未处理错误（注入失败仅记 warning）', errs.length === 0, errs.join(' ; ') || '无');
  p.close();

  /* ---------- Bug 6：1080 px 布局 ---------- */
  p = await connect(9333, BASE, [1080, 900]);
  await p.waitFor(READY, 30000); await p.sleep(1300);
  const L0 = await p.evaluate(`(() => { const s = document.querySelector('.side').getBoundingClientRect(); return { sideTop: Math.round(s.top + scrollY), sticky: getComputedStyle(document.querySelector('.side')).position, cols: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns }; })()`);
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'})`); await p.sleep(300);
  const L1 = await p.evaluate(`(() => { const vis = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visibleH: Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) }; }; return { slider: vis(rSlider), input: vis(rInput), scan: vis(scanFromZero), plot: vis(cMain), vh: innerHeight }; })()`);
  ok('问题6', '1080 px：两栏布局，控制栏 sticky 且在首屏', L0.sticky === 'sticky' && L0.sideTop < 300, L0);
  ok('问题6', '1080 px：滚动到主图时半径滑块、数值框、扫描按钮与主图同时可见', L1.slider.top >= 0 && L1.slider.bottom <= L1.vh && L1.input.bottom <= L1.vh && L1.scan.bottom <= L1.vh && L1.plot.visibleH >= 400, L1);
  const lab1080 = await p.evaluate(`(() => { const mp = __app.plots.mainPlot; return ${LABEL_CHECK}(mp.labelBoxes, mp.W, mp.H, mp.pad, mp._band); })()`);
  ok('问题6', '1080 px 下主图极值标签仍完整', lab1080.n === 19 && lab1080.bad.length === 0, lab1080);
  await p.screenshot(path.join(SHOT, '15_问题6修复_1080宽_半径控件与主图同屏.png'));
  // 拖动半径滑块时主图游标即时反馈
  const fb = await p.evaluate(`(async () => { rSlider.value = '0.9'; rSlider.dispatchEvent(new Event('input')); await new Promise(r => requestAnimationFrame(r)); return { cursor: __app.plots.mainPlot.cursor.x, card: mR.textContent }; })()`);
  ok('问题6', '1080 px：拖动滑块，主图游标即时跟随', Math.abs(fb.cursor - 0.9) < 1e-9, fb);
  await p.evaluate(`document.querySelector('.three').scrollIntoView({block:'start'})`); await p.sleep(300);
  const L2 = await p.evaluate(`(() => { const r = rSlider.getBoundingClientRect(), a = cAp.getBoundingClientRect(); return { slider: [Math.round(r.top), Math.round(r.bottom)], ap: [Math.round(a.top), Math.round(a.bottom)] }; })()`);
  ok('问题6', '1080 px：滚到孔径/相量图时半径控件仍可见', L2.slider[0] >= 0 && L2.slider[1] <= 900 && L2.ap[0] < 900, L2);
  await p.screenshot(path.join(SHOT, '16_问题6修复_1080宽_滚到孔径相量图控件仍可见.png'));
  p.close();
  p = await connect(9333, BASE, [780, 1000]);
  await p.waitFor(READY, 30000); await p.sleep(1300);
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'})`); await p.sleep(300);
  const N = await p.evaluate(`(() => { const r = rSlider.getBoundingClientRect(), m = cMain.getBoundingClientRect(), sd = document.querySelector('.side').getBoundingClientRect();
    // 主图未被 sticky 顶栏遮挡的可见高度
    const top = Math.max(0, m.top, sd.bottom), vis = Math.max(0, Math.min(innerHeight, m.bottom) - top);
    return { slider: [Math.round(r.top), Math.round(r.bottom)], sideBottom: Math.round(sd.bottom), plot: [Math.round(m.top), Math.round(m.bottom)], plotVisibleUnoccluded: Math.round(vis) }; })()`);
  ok('问题6', '780 px 窄屏：控制栏为 sticky 顶栏，滑块与主图（未被遮挡部分）同时可见', N.slider[0] >= 0 && N.slider[1] <= N.sideBottom && N.plot[0] >= N.sideBottom - 1 && N.plotVisibleUnoccluded >= 380, N);
  await p.screenshot(path.join(SHOT, '17_问题6修复_780窄屏_顶栏控件与主图.png'));
  p.close();

  /* ---------- file:// 回退 ---------- */
  p = await connect(9333, 'file://' + path.join(ROOT, 'index.html'), [1400, 900]);
  await p.waitFor(READY, 30000); await p.sleep(300);
  const fm = await p.evaluate(`({ mode: modeInfo.textContent, r4: __app.result.fourth.r*1e3, n: __app.result.extrema.length })`);
  ok('file://', 'file:// 下以内联 Blob Web Worker 运行（不阻塞主线程），基准一致', fm.mode.includes('Blob') && Math.abs(fm.r4 - 1.3228768035) < 5e-11 && fm.n === 19, fm);
  const fq = await p.evaluate(`(async () => { extParams.open = true; lamSlider.value='560'; lamSlider.dispatchEvent(new Event('input')); lamSlider.value='600'; lamSlider.dispatchEvent(new Event('input')); lamSlider.dispatchEvent(new Event('change'));
    let t0 = performance.now(); while (performance.now() - t0 < 8000 && !(__app.result.params.lambda_nm === 600 && __app.result.quality === 'final' && ${IDLE})) await new Promise(r => setTimeout(r, 40));
    const busy = __app.previewBusy; lamSlider.value='650'; lamSlider.dispatchEvent(new Event('input'));
    t0 = performance.now(); while (performance.now() - t0 < 5000 && !(__app.result.quality === 'preview' && __app.result.params.lambda_nm === 650)) await new Promise(r => setTimeout(r, 40));
    const prev = __app.result.quality === 'preview' && __app.result.params.lambda_nm === 650;
    __app.debug.failNext = 'q1-preview'; lamSlider.value='660'; lamSlider.dispatchEvent(new Event('input'));
    t0 = performance.now(); while (performance.now() - t0 < 4000 && !__app.lastError) await new Promise(r => setTimeout(r, 40));
    const err = !!__app.lastError, busy2 = __app.previewBusy;
    lamSlider.value='670'; lamSlider.dispatchEvent(new Event('input'));
    t0 = performance.now(); while (performance.now() - t0 < 5000 && !(__app.result.quality === 'preview' && __app.result.params.lambda_nm === 670)) await new Promise(r => setTimeout(r, 40));
    return { busyAfterRelease: busy, nextPreview: prev, failShown: err, busyAfterFail: busy2, recovered: __app.result.params.lambda_nm === 670 }; })()`);
  ok('file://', '主线程回退下：快速松开 / 失败后预览均恢复', !fq.busyAfterRelease && fq.nextPreview && fq.failShown && !fq.busyAfterFail && fq.recovered, fq);
  p.close();

  /* ---------- 强制主线程回退（?engine=main，模拟浏览器不支持 Worker） ---------- */
  p = await connect(9333, 'file://' + path.join(ROOT, 'index.html') + '?engine=main', [1400, 900]);
  await p.waitFor(READY, 30000); await p.sleep(300);
  const fbm = await p.evaluate(`({ mode: modeInfo.textContent, r4: __app.result.fourth.r*1e3, n: __app.result.extrema.length })`);
  ok('file://', '?engine=main：主线程回退模式运行并明确标示，基准一致', fbm.mode.includes('回退') && Math.abs(fbm.r4 - 1.3228768035) < 5e-11 && fbm.n === 19, fbm);
  const fbq = await p.evaluate(`(async () => { extParams.open = true; lamSlider.value='560'; lamSlider.dispatchEvent(new Event('input')); lamSlider.value='600'; lamSlider.dispatchEvent(new Event('input')); lamSlider.dispatchEvent(new Event('change'));
    let t0 = performance.now(); while (performance.now() - t0 < 8000 && !(__app.result.params.lambda_nm === 600 && __app.result.quality === 'final' && ${IDLE})) await new Promise(r => setTimeout(r, 40));
    const busy = __app.previewBusy;
    __app.debug.failNext = 'q1-preview'; lamSlider.value='660'; lamSlider.dispatchEvent(new Event('input'));
    t0 = performance.now(); while (performance.now() - t0 < 4000 && !__app.lastError) await new Promise(r => setTimeout(r, 40));
    const err = !!__app.lastError, busy2 = __app.previewBusy;
    lamSlider.value='670'; lamSlider.dispatchEvent(new Event('input'));
    t0 = performance.now(); while (performance.now() - t0 < 5000 && !(__app.result.quality === 'preview' && __app.result.params.lambda_nm === 670)) await new Promise(r => setTimeout(r, 40));
    return { busyAfterRelease: busy, failShown: err, busyAfterFail: busy2, recovered: __app.result.params.lambda_nm === 670 }; })()`);
  ok('file://', '?engine=main 主线程回退下：快速松开 / 失败后预览均恢复', !fbq.busyAfterRelease && fbq.failShown && !fbq.busyAfterFail && fbq.recovered, fbq);
  p.close();

  fs.writeFileSync(path.join(ROOT, 'validation', 'regression_fix1.json'), JSON.stringify({ when: new Date().toISOString(), browser: 'Chrome headless 156', url: BASE, checks }, null, 2));
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
