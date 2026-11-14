/* regression_phase2.js — 第二问浏览器回归 + 截图（无头 Chrome）。
 * 需要：Chrome --remote-debugging-port=9333；http://127.0.0.1:8765
 * 用法：node tools/regression_phase2.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots'), DL = '/tmp/cal-dl-phase2';
const BASE = process.env.CAL_URL || 'http://127.0.0.1:8765/index.html';
fs.mkdirSync(SHOT, { recursive: true }); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
const checks = [];
const ok = (group, name, cond, detail) => { checks.push({ group, name, pass: !!cond, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) }); console.log((cond ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };
const Q1READY = 'window.__app && __app.result && __app.point && __app.point.quality==="precise" && !Object.values(__app.jobs).some(j=>j.type==="q1"||j.type==="point")';
const Q2READY = 'window.__app && __app.q2 && __app.q2.quality==="precise" && !Object.values(__app.jobs).some(j=>j.type==="q2")';
const Q2IDLE = '!Object.values(__app.jobs).some(j=>j.type==="q2")';

async function setFile(p, sel, file) {
  const doc = await p.send('DOM.getDocument', {}); const q = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
  await p.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
}
async function newestDownload(prefix, before) {
  for (let i = 0; i < 80; i++) {
    const f = fs.readdirSync(DL).filter((x) => x.includes(prefix) && !x.endsWith('.crdownload') && !before.includes(x));
    if (f.length) return path.join(DL, f[0]);
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
async function waitCase(p, key, timeout) {
  await p.waitFor(`__app.q2 && __app.q2.caseKey==="${key}" && __app.q2.quality==="precise" && ${Q2IDLE}`, timeout || 60000);
}

(async () => {
  const W = 1440, H = 1100;
  let p = await connect(9333, BASE, [W, H]);
  await p.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(() => {});
  try {
    await p.waitFor(Q1READY, 30000);
    const bm = await p.evaluate(`({ r4: __app.result.fourth.r*1e3, I4: __app.result.fourth.I, rlim: __app.result.r4.rLimit*1e3, nmax: __app.result.maxima.length, nmin: __app.result.minima.length })`);
    ok('基准', '第一问 r₄ / I / r⁴ 边界 / 极值计数保持', Math.abs(bm.r4 - 1.3228768035) < 1e-9 && Math.abs(bm.I4 - 3.999986) < 5e-9 && Math.abs(bm.rlim - 0.2495438957) < 5e-9 && bm.nmax === 10 && bm.nmin === 9, bm);

    await p.evaluate(`window.scrollTo(0,0); document.getElementById('tab-q2').click()`);
    await p.waitFor(Q2READY, 60000);
    const c1 = await p.evaluate(`({ caseKey: __app.q2.caseKey, r: __app.q2.a*1e3, Idir: __app.q2.axis.direct.I, Ifft: __app.q2.axis.I, Irad: __app.q2.axis.direct.I_radial, nObs: __app.q2.samp.nObs, dSrc: __app.q2.samp.dSrc*1e6, dObs: __app.q2.samp.dObs*1e6, stride: __app.q2.samp.stride, onNodes: __app.q2.samp.onNodes, phase: __app.q2.samp.phaseStepAxial, pad: __app.q2.samp.padActual, maxDI: __app.q2.maxAbsDI, cornerDI: __app.q2.cornerCheck && __app.q2.cornerCheck.dI, q: q2qBadge.textContent, title: q2cTitle.textContent, locked: __app.state.locked, r4note: q2lockInfo.innerText })`);
    ok('情形1', '同相圆孔标准档完成，r=r₄，轴上直接 I≈3.999986', c1.caseKey === 'inphase' && Math.abs(c1.r - 1.3228768035) < 1e-9 && Math.abs(c1.Idir - 3.999986) < 1e-5 && c1.q === '精确' && c1.locked, c1);
    ok('采样', '同相不含 8π，源间距约 5.146 μm，pad≥1，观察点落在 FFT 节点且间距 ≤ 23.62 μm', Math.abs(c1.dSrc - 5.146) < 0.02 && c1.pad >= 1 && c1.dObs <= 23.63 && c1.onNodes && Math.abs(c1.dObs - c1.stride * c1.dSrc) < 1e-6 && c1.maxDI < 0.02 && Math.abs(c1.cornerDI) < 1e-3, c1);
    await p.evaluate(`document.getElementById('cQ2map').scrollIntoView({block:'start'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_01_情形1_同相圆孔_图样孔径剖面.png'));

    // 对数色标
    await p.evaluate(`document.querySelector('#q2scaleSeg button[data-v=log]').click()`);
    await p.sleep(200);
    const logL = await p.evaluate(`({ foot: q2mapFoot.textContent, scale: __app.q2State.scale })`);
    ok('色标', '对数色标标注清楚', logL.scale === 'log' && logL.foot.includes('对数'), logL);
    await p.screenshot(path.join(SHOT, 'p2_07_对数色标.png'));
    await p.evaluate(`document.querySelector('#q2scaleSeg button[data-v=linear]').click()`);

    // 本图各自 / 共享（在圆孔上先拍共享，对照稍后再拍）
    await p.evaluate(`document.querySelector('#q2normSeg button[data-v=shared]').click()`);
    await p.sleep(150);
    const sh = await p.evaluate(`({ foot: q2mapFoot.textContent, norm: __app.q2State.norm })`);
    ok('归一', '共享色标有标签', sh.norm === 'shared' && sh.foot.includes('共享'), sh);
    await p.screenshot(path.join(SHOT, 'p2_05_共享色标_同相圆孔.png'));
    await p.evaluate(`document.querySelector('#q2normSeg button[data-v=per]').click()`);
    await p.sleep(150);
    const pe = await p.evaluate(`({ foot: q2mapFoot.textContent, norm: __app.q2State.norm })`);
    ok('归一', '本图各自归一有标签', pe.norm === 'per' && pe.foot.includes('本图各自'), pe);
    await p.screenshot(path.join(SHOT, 'p2_06_本图各自归一_同相圆孔.png'));
    await p.evaluate(`document.querySelector('#q2normSeg button[data-v=shared]').click()`);

    // 情形 2
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=random]').click()`);
    await waitCase(p, 'random', 60000);
    const c2 = await p.evaluate(`({ caseKey: __app.q2.caseKey, seed: __app.q2.seed, cell: __app.q2.cellSize*1e6, Idir: __app.q2.axis.direct.I, Imax: __app.q2.map.Imax, title: q2cTitle.textContent, ap: q2apFoot.textContent, box: !q2randomBox.hidden })`);
    ok('情形2', '随机相位单次实现，默认种子 20261111，单元格 40 μm', c2.caseKey === 'random' && c2.seed === 20261111 && Math.abs(c2.cell - 40) < 1e-9 && c2.box && c2.ap.includes('种子'), c2);
    const scale = await p.evaluate(`({ norm: __app.q2State.norm, foot: q2mapFoot.textContent, badge: (cQ2map.parentElement.textContent || '') })`);
    ok('情形2', '随机相位自动用本图各自色标，并注明相对同相的亮度', scale.norm === 'per' && /本图各自/.test(scale.foot) && /同相/.test(scale.foot), scale);
    await p.evaluate(`document.getElementById('cQ2map').scrollIntoView({block:'start'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_02_情形2_随机相位_图样孔径剖面.png'));

    // 种子可复现：再点重算，I 图一样
    const firstI = await p.evaluate(`Array.from(__app.q2.map.I.slice(0, 20))`);
    await p.evaluate(`q2btnRecalc.click()`);
    await waitCase(p, 'random', 60000);
    const secondI = await p.evaluate(`Array.from(__app.q2.map.I.slice(0, 20))`);
    ok('种子', '同一种子重算图样一致', firstI.every((v, i) => v === secondI[i]), { firstI: firstI.slice(0, 3), secondI: secondI.slice(0, 3) });

    // 细化不换种子：切到预览再切回标准
    const seed0 = await p.evaluate(`__app.q2.seed`);
    await p.evaluate(`document.querySelector('#q2precSeg button[data-v=preview]').click()`);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='random' && __app.q2.quality==='preview' && ${Q2IDLE}`, 30000);
    const prev = await p.evaluate(`({ seed: __app.q2.seed, I: __app.q2.axis.direct.I, q: __app.q2.quality, mode: __app.q2.randomMode })`);
    await p.evaluate(`document.querySelector('#q2precSeg button[data-v=standard]').click()`);
    await waitCase(p, 'random', 60000);
    const std = await p.evaluate(`({ seed: __app.q2.seed, I: __app.q2.axis.direct.I, q: __app.q2.quality, mode: __app.q2.randomMode })`);
    ok('细化', '题目预设为逐点独立：切精度不改种子（光强可以随网格变）', seed0 === 20261111 && prev.seed === 20261111 && std.seed === 20261111 && prev.mode === 'independent' && std.mode === 'independent', { prev, std });

    // 情形 3
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=linear]').click()`);
    await waitCase(p, 'linear', 60000);
    const c3 = await p.evaluate(`({ caseKey: __app.q2.caseKey, peak: __app.q2.shiftMeas.peakX*1e3, pred: __app.q2.tilt.shiftOnScreen*1e3, dir: __app.q2.shiftMeas.direction, I0: __app.q2.axis.direct.I, Ishift: __app.q2.axis.directShift && __app.q2.axis.directShift.I, title: q2cTitle.textContent, text: q2cText.innerText })`);
    ok('情形3', '偏移方向 +X′，幅度接近预计，O′ 处 I 不是 4', c3.caseKey === 'linear' && c3.dir === '+X′' && Math.abs(c3.peak - c3.pred) < 0.005 && c3.I0 < 2 && c3.Ishift > 3.9 && c3.text.includes('+X′'), c3);
    await p.evaluate(`document.getElementById('cQ2map').scrollIntoView({block:'start'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_03_情形3_线性相位8π_偏移.png'));
    await p.evaluate(`document.getElementById('cQ2cutX').scrollIntoView({block:'center'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_09_情形3_X剖面_预计与数值偏移.png'));

    // 情形 4 + 对照
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=disk]').click()`);
    await waitCase(p, 'disk', 60000);
    const c4 = await p.evaluate(`({ caseKey: __app.q2.caseKey, Idisk: __app.q2.axis.direct.I, Ihole: __app.q2.axis.direct.I_hole, ident: __app.q2.axis.direct.I_disk, cmp: !q2compareCard.hidden, title: q2cTitle.textContent, text: q2cText.innerText, babinet: __app.q2.babinetChecks && Math.max(...__app.q2.babinetChecks.map(b=>b.residual)) })`);
    ok('情形4', '泊松亮斑轴上 I≈1，互补屏残差 < 1e-3，对照图可见', c4.caseKey === 'disk' && Math.abs(c4.Idisk - 1) < 1e-4 && Math.abs(c4.Ihole - 3.999986) < 1e-5 && c4.cmp && c4.babinet < 1e-3, c4);
    await p.evaluate(`document.getElementById('cQ2map').scrollIntoView({block:'start'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_04_情形4_圆屏泊松亮斑_图样孔径剖面.png'));
    await p.evaluate(`document.getElementById('q2compareCard').scrollIntoView({block:'center'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_08_圆孔与圆屏对照_共享色标.png'));

    // 取消 / 过期任务：改到需要重新卷积的情形后立刻取消，保留上一次结果。
    // 圆孔↔圆屏会复用同一次 FFT，没有可取消的任务。
    const before = await p.evaluate(`({ id: __app.q2.id, caseKey: __app.q2.caseKey })`);
    const can = await p.evaluate(`(async () => {
      document.querySelector('#q2caseSeg button[data-v=linear]').click();
      const enabled = !q2btnCancel.disabled;
      q2btnCancel.click();
      await new Promise(r => setTimeout(r, 400));
      return { enabled, id: __app.q2.id, caseKey: __app.q2.caseKey, note: q2sText.textContent, busy: Object.values(__app.jobs).some(j=>j.type==='q2'), previewBusy: __app.q2PreviewBusy };
    })()`);
    ok('任务', '取消后保留上一套已完成图样，previewBusy 已清除', can.enabled && can.id === before.id && can.caseKey === 'disk' && !can.busy && !can.previewBusy, { before, can });
    // 再计算应能开始
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=inphase]').click()`);
    await waitCase(p, 'inphase', 60000);
    ok('任务', '取消后下一次计算仍能完成', true);

    // 失败生命周期
    const fail = await p.evaluate(`(async () => {
      __app.debug.failNext = 'q2';
      q2btnRecalc.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 8000 && !__app.q2State.lastError) await new Promise(r => setTimeout(r, 40));
      const err = !!__app.q2State.lastError, busy = __app.q2PreviewBusy, jobs = Object.values(__app.jobs).some(j=>j.type==='q2');
      q2btnRecalc.click();
      const t1 = performance.now();
      while (performance.now() - t1 < 30000 && !(__app.q2 && __app.q2.quality==='precise' && !Object.values(__app.jobs).some(j=>j.type==='q2'))) await new Promise(r => setTimeout(r, 50));
      return { err, busy, jobs, recovered: __app.q2 && __app.q2.quality==='precise', lastError: __app.q2State.lastError };
    })()`);
    ok('任务', '失败后任务结束且可以重算', fail.err && !fail.busy && !fail.jobs && fail.recovered, fail);

    // 配置往返：含种子，以及 r=0
    await p.evaluate(`document.querySelector('#q2caseSeg button[data-v=random]').click()`);
    await waitCase(p, 'random', 60000);
    const cfg1 = await p.evaluate(`({ json: JSON.stringify(__app.configObject()), r: __app.state.r_mm, seed: __app.q2State.seed, caseKey: __app.q2State.caseKey })`);
    const cfgObj = JSON.parse(cfg1.json);
    ok('配置', '导出含种子、情形、r（非零）且 schema 为 phase2', cfgObj.schema.includes('phase2') && cfgObj.q2.seed === 20261111 && cfgObj.q2.caseKey === 'random' && cfgObj.params.r_mm > 1, { seed: cfgObj.q2.seed, caseKey: cfgObj.q2.caseKey, r: cfgObj.params.r_mm });

    // r=0 往返（解锁）
    await p.evaluate(`document.getElementById('tab-q1').click()`);
    await p.sleep(200);
    await p.evaluate(`if (__app.state.locked) btnLock4.click(); __app.setRadius(0, { precise: true, forceInput: true });`);
    await p.waitFor(`__app.point && __app.point.quality==='precise' && __app.state.r_mm===0`, 8000);
    const cfg0 = await p.evaluate(`JSON.stringify(__app.configObject())`);
    const o0 = JSON.parse(cfg0);
    ok('配置', 'r=0 导出仍为 0（不变成 1）', o0.params.r_mm === 0, o0.params.r_mm);
    fs.writeFileSync(path.join(ROOT, 'validation', 'config_phase2_r0.json'), cfg0);
    // 先改半径再载入
    await p.evaluate(`__app.setRadius(0.8, { forceInput: true })`);
    const cfgPath = path.join(ROOT, 'validation', 'config_phase2_r0.json');
    await p.evaluate(`document.getElementById('tab-q2').click()`);
    await setFile(p, '#q2fileJson', cfgPath);
    await p.waitFor(`__app.state.r_mm===0 && __app.result && __app.result.quality!=='preview' && ${Q1READY}`, 30000);
    const loaded = await p.evaluate(`({ r: __app.state.r_mm, rInput: rInput.value, q2r: q2rInput.value, locked: __app.state.locked, caseKey: __app.q2State.caseKey, seed: __app.q2State.seed })`);
    ok('配置', 'r=0 载入后仍为 0，随机情形与种子保留', loaded.r === 0 && parseFloat(loaded.rInput) === 0 && loaded.caseKey === 'random' && loaded.seed === 20261111 && !loaded.locked, loaded);
    await p.evaluate(`document.getElementById('tab-q2').click(); window.scrollTo(0,0)`);
    await p.sleep(300);
    await p.screenshot(path.join(SHOT, 'p2_10_r0配置载入后半径仍为0.png'));

    // 恢复题目预设
    await p.evaluate(`q2btnPreset.click()`);
    await p.waitFor(`__app.result.params.lambda_nm===500 && __app.state.locked && ${Q1READY}`, 30000);
    await p.waitFor(`__app.q2 && __app.q2.caseKey==='inphase' && __app.q2.quality==='precise' && Math.abs(__app.q2.a*1e3-1.3228768035)<1e-9 && ${Q2IDLE}`, 60000);
    const back = await p.evaluate(`({ r: __app.state.r_mm, caseKey: __app.q2.caseKey, I: __app.q2.axis.direct.I, chip: presetChip.textContent })`);
    ok('预设', '一键恢复题目预设并回到同相 r₄ 图样', Math.abs(back.r - 1.3228768035) < 1e-9 && back.caseKey === 'inphase' && Math.abs(back.I - 3.999986) < 1e-5, back);

    // 解锁提示
    await p.evaluate(`btnLock4Q2.click()`);
    const un = await p.evaluate(`({ locked: __app.state.locked, info: q2lockInfo.innerText })`);
    ok('锁定', '解锁后可以改半径，界面标明是否为 r₄', !un.locked, un);

    // 分析折叠区存在
    const ana = await p.evaluate(`({ r: !!document.getElementById('q2anaRandom'), l: !!document.getElementById('q2anaLinear'), b: !!document.getElementById('q2anaBabinet') })`);
    ok('说明', '随机 / 8π / 巴比涅分析折叠区存在', ana.r && ana.l && ana.b, ana);

    await p.evaluate(`window.scrollTo(0,0); document.getElementById('q2-panel').scrollTo && document.getElementById('q2-panel').scrollTo(0,0); document.getElementById('cQ2map').scrollIntoView({block:'start'})`);
    await p.sleep(200);
    await p.screenshot(path.join(SHOT, 'p2_11_恢复题目预设_同相圆孔总览.png'));

  } finally {
    const report = { generated: new Date().toISOString(), pass: checks.filter((c) => c.pass).length, total: checks.length, checks, logs: p.logs };
    fs.writeFileSync(path.join(ROOT, 'validation', 'regression_phase2.json'), JSON.stringify(report, null, 2));
    console.log('\n' + report.pass + '/' + report.total + ' 通过');
    try { p.close(); } catch (e) { /* ignore */ }
    if (report.pass !== report.total) process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
