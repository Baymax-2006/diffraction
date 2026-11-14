/* repro_original.js — 在修复前的原始版本上复现 7 个问题（只读观测，不修改页面代码）。
 * 用法：node tools/repro_original.js [URL]   默认 http://127.0.0.1:8766/index.html（原始版本副本）
 * 需要 Chrome --remote-debugging-port=9333。输出 validation/repro_before_fix.json 与 screenshots/repro_*.png */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots'), OUT = path.join(ROOT, 'validation');
const URL = process.argv[2] || 'http://127.0.0.1:8766/index.html';
const KERNEL = process.argv[3] || '/tmp/cal-orig/diffraction.js';
fs.mkdirSync(SHOT, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const rep = {}; const log = (k, v) => { rep[k] = v; console.log('■ ' + k + '\n' + JSON.stringify(v, null, 1)); };
const ready = 'window.__app && __app.result && __app.point && __app.point.quality==="precise"';

(async () => {
  /* Bug 5（内核层面，Node）：固定 800 点预览混叠 */
  {
    const D = require(KERNEL);
    const p = { lambda_nm: 380, L_cm: 10, A: 1, rMax_mm: 6, r4Threshold: 0.05 };
    const out = {};
    for (const k of ['preview', 'standard']) { const t = Date.now(); const r = D.computeQ1(p, k); out[k] = { nr: r.curve.nr, maxima: r.extrema.filter((e) => e.kind === 'max').length, minima: r.extrema.filter((e) => e.kind === 'min').length, ms: Date.now() - t }; }
    const NFmax = (6e-3) ** 2 / (380e-9 * 0.1);
    out.NFmax = NFmax; out.expectedMaxima = Math.floor((NFmax + 1) / 2);
    out.previewDeltaNF_atRmax = 2 * NFmax / (out.preview.nr - 1);
    log('bug5_混叠', out);
  }

  /* Bug 1：λ 500→700，完成前取消，再设 r=0.5 mm */
  let p = await connect(9333, URL, [1400, 900]);
  await p.waitFor(ready, 20000); await p.sleep(300);
  const b1 = await p.evaluate(`(async () => {
    extParams.open = true;
    lamInput.value = '700'; lamInput.dispatchEvent(new Event('change'));
    btnCancel.click();
    await new Promise(r => setTimeout(r, 300));
    rInput.value = '0.5'; rInput.dispatchEvent(new Event('change'));
    const t0 = performance.now();
    while (performance.now() - t0 < 4000 && __app.point.quality !== 'precise') await new Promise(r => setTimeout(r, 50));
    const c = __app.result.curve, j = Math.round(0.5e-3 / c.rMax * (c.nr - 1));
    return { curveParams_lambda: __app.result.params.lambda_nm, stateLambda: __app.state.lambda_nm, curveI_at_0p5: c.I[j], cardI: mI.textContent, cardSrc: mIs.textContent, sTag: sTag.textContent, chip: presetChip.textContent, NF_card: mNF.textContent };
  })()`);
  log('bug1_旧曲线与新参数混用', b1);
  await p.evaluate(`document.querySelector('.metrics').scrollIntoView({block:'start'})`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, 'repro_bug1_修复前_旧曲线与新卡片混用.png'));
  p.close();

  /* Bug 2：极值标签裁剪 */
  p = await connect(9333, URL, [1400, 900]);
  await p.waitFor(ready, 20000); await p.sleep(400);
  const b2 = await p.evaluate(`(() => {
    const mp = __app.plots.mainPlot, ctx = mp.ctx, pd = mp.o.pad;
    const clip = { x0: pd.l, x1: mp.W - pd.r, y0: pd.t, y1: mp.H - pd.b };
    ctx.font = '600 10.5px "Microsoft YaHei",sans-serif';
    const bad = [];
    for (const m of mp.markers) {
      const X = mp.px(m.x), Y = mp.py(m.y), w = ctx.measureText(m.label).width;
      const top = m.shape === 'up' ? Y + 7 : Y - 7 - 11, bot = top + 11;
      const l = X - w / 2, r = X + w / 2;
      if (top < clip.y0 || bot > clip.y1 || l < clip.x0 || r > clip.x1) bad.push({ label: m.label, X: +X.toFixed(1), top: +top.toFixed(1), bot: +bot.toFixed(1), l: +l.toFixed(1), r: +r.toFixed(1) });
    }
    return { clip, nMarkers: mp.markers.length, clippedOrTruncated: bad.length, bad, labelsContainRadius: mp.markers.some(m => /\\d\\.\\d{3}/.test(m.label)) };
  })()`);
  log('bug2_极值标签裁剪', b2);
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'})`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, 'repro_bug2_修复前_极值标签被裁剪.png'));

  /* Bug 3：r_max = 0.3 mm */
  const b3 = await p.evaluate(`(async () => {
    const before = { lock: lockInfo.textContent, q2r: q2r.textContent };
    extParams.open = true; rMaxInput.value = '0.3'; rMaxInput.dispatchEvent(new Event('change'));
    const t0 = performance.now(); while (performance.now() - t0 < 6000 && !(__app.result.params.rMax_mm === 0.3 && __app.point.quality === 'precise')) await new Promise(r => setTimeout(r, 50));
    const after = { rMax: __app.result.params.rMax_mm, maxima: __app.result.maxima.length, m4: m4.textContent, lock: lockInfo.textContent, q2r: q2r.textContent, q2rBig: q2rBig.textContent, locked: __app.state.locked, extFoot: extFoot.textContent.slice(0, 160) };
    convDetails.open = true; btnConv.click();
    await new Promise(r => setTimeout(r, 4000));
    return { before, after, convStatus: convStatus.textContent, qBadge: qBadge.textContent, sText: sText.textContent.slice(0, 200) };
  })()`);
  b3.consoleErrors = p.logs.filter((l) => /error|EXCEPTION/i.test(l)).map((l) => l.slice(0, 300));
  log('bug3_rmax0.3_第四极大不存在', b3);
  await p.evaluate(`document.querySelector('.side').scrollIntoView({block:'start'})`); await p.sleep(200);
  await p.screenshot(path.join(SHOT, 'repro_bug3_修复前_rmax0.3残留锁定.png'));
  p.close();

  /* Bug 4：快速拖动后 previewBusy 卡死 */
  p = await connect(9333, URL, [1400, 900]);
  await p.waitFor(ready, 20000); await p.sleep(300);
  const b4 = await p.evaluate(`(async () => {
    extParams.open = true; const s = lamSlider;
    // 第一次拖动：input（提交预览）后立即松开 change（提交最终任务，latest.q1 被改写）
    s.value = '560'; s.dispatchEvent(new Event('input'));
    s.value = '600'; s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
    const t0 = performance.now(); while (performance.now() - t0 < 8000 && !(__app.result.params.lambda_nm === 600 && __app.result.quality === 'final' && btnCancel.disabled)) await new Promise(r => setTimeout(r, 50));
    const afterFirst = { lam: __app.result.params.lambda_nm, quality: __app.result.quality, stale: __app.staleDropped };
    // 第二次拖动：只发 input，不松开；正常应在 ~1 s 内看到 λ=650 的预览曲线
    s.value = '650'; s.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 2500));
    return { afterFirst, secondDrag: { resultLambda: __app.result.params.lambda_nm, resultQuality: __app.result.quality, stateLambda: __app.state.lambda_nm, badge: qBadge.textContent } };
  })()`);
  log('bug4_previewBusy卡死', b4);
  p.close();

  /* Bug 6：1080 px 宽度布局 */
  p = await connect(9333, URL, [1080, 900]);
  await p.waitFor(ready, 20000); await p.sleep(400);
  const b6 = await p.evaluate(`(() => { const s = document.querySelector('.side').getBoundingClientRect(), r = rSlider.getBoundingClientRect(), m = cMain.getBoundingClientRect(); return { sideTop: Math.round(s.top + scrollY), rSliderTop: Math.round(r.top + scrollY), mainPlotTop: Math.round(m.top + scrollY), mainPlotBottom: Math.round(m.bottom + scrollY), pageHeight: document.documentElement.scrollHeight, viewportH: innerHeight, sideSticky: getComputedStyle(document.querySelector('.side')).position }; })()`);
  log('bug6_1080宽度布局', b6);
  await p.screenshot(path.join(SHOT, 'repro_bug6_修复前_1080宽首屏无控件.png'));
  p.close();

  /* Bug 7：r = 0 配置往返 */
  p = await connect(9333, URL, [1400, 900]);
  await p.waitFor(ready, 20000); await p.sleep(300);
  await p.evaluate(`__app.setRadius(0, { precise: true, forceInput: true })`);
  await p.waitFor(`__app.point.quality==='precise' && __app.state.r_mm===0`, 5000);
  const cfg = await p.evaluate(`JSON.stringify(__app.configObject())`);
  const f = '/tmp/repro_r0_config.json'; fs.writeFileSync(f, cfg);
  const doc = await p.send('DOM.getDocument', {}); const q = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileJson' });
  await p.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [f] });
  await p.sleep(3000);
  const b7 = await p.evaluate(`({ exported_r_mm: ${JSON.parse(cfg).params.r_mm}, loaded_r_mm: __app.state.r_mm, rInput: rInput.value })`);
  log('bug7_r0配置往返', b7);
  p.close();

  fs.writeFileSync(path.join(OUT, 'repro_before_fix.json'), JSON.stringify({ when: new Date().toISOString(), url: URL, results: rep }, null, 2));
  console.log('写入 validation/repro_before_fix.json');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
