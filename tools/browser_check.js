/* browser_check.js — 在无头 Chrome 中实际运行页面，做交互验证并截图。
 * 需要：Chrome 以 --remote-debugging-port=9333 运行；本地服务器在 8765 端口。
 * 用法：node tools/browser_check.js */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..'), SHOT = path.join(ROOT, 'screenshots'), DL = '/tmp/cal-downloads';
fs.mkdirSync(SHOT, { recursive: true }); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
const checks = []; const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };
const precise = 'window.__app && __app.result && __app.point && __app.point.quality==="precise" && !document.getElementById("btnCancel").disabled===false';

(async () => {
  const W = 1400, H = 900;
  const p = await connect(9333, 'http://127.0.0.1:8765/index.html', [W, H]);
  await p.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await p.waitFor(precise, 20000); await p.sleep(400);
  const s0 = await p.evaluate(`({mode:modeInfo.textContent, r:__app.state.r_mm, I:__app.point.I, r4:m4.textContent, boot:boot.textContent, badge:qBadge.textContent, locked:__app.state.locked, nExt:__app.result.extrema.length, cyc:extFoot.textContent})`);
  ok('页面启动且显示精确结果', s0.badge.includes('精确'), s0.badge + ' / ' + s0.boot);
  ok('计算在 Web Worker 中运行', s0.mode.includes('Worker'), s0.mode);
  ok('默认锁定第 4 极大（数值求得）', s0.locked && Math.abs(s0.r - 1.3228768) < 1e-6, 'r = ' + s0.r + ' mm, I = ' + s0.I);
  ok('极值 ≥ 10 个且 ≥ 5 个完整周期', s0.nExt >= 10 && s0.cyc.includes('≥ 5 ✓'), s0.nExt + ' 个极值');
  await p.screenshot(path.join(SHOT, 'z_常规检查_a_默认总览_1400x900.png'));

  // 拖动滑块：快速发送 input 事件，检查预览即时同步，松开后变精确
  const drag = await p.evaluate(`(async () => {
    const s = document.getElementById('rSlider'); const t0 = performance.now(); let maxFrame = 0, last = performance.now(); const qs = [];
    for (let i = 0; i <= 60; i++) { s.value = (0.30 + i * 0.01).toFixed(4); s.dispatchEvent(new Event('input')); await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); maxFrame = Math.max(maxFrame, n - last); last = n; qs.push(__app.point.quality); }
    const during = { quality: __app.point.quality, r: __app.state.r_mm, metric: document.getElementById('mR').textContent, input: document.getElementById('rInput').value, locked: __app.state.locked };
    s.dispatchEvent(new Event('change'));
    return { during, maxFrame, ms: performance.now() - t0, previews: qs.filter(q => q === 'preview').length };
  })()`);
  ok('拖动时游标/数值同步（预览）', drag.during.quality === 'preview' && Math.abs(drag.during.r - 0.9) < 1e-9 && drag.during.metric.startsWith('0.900000'), JSON.stringify(drag.during));
  ok('拖动期间主线程不卡顿（最大帧间隔 < 100 ms）', drag.maxFrame < 100, 'max frame ' + drag.maxFrame.toFixed(1) + ' ms，61 次 input');
  ok('拖动解除锁定', drag.during.locked === false);
  await p.waitFor(`__app.point.quality==="precise" && Math.abs(__app.state.r_mm-0.9)<1e-9`, 5000);
  const pt = await p.evaluate(`({I:__app.point.I, src:mIs.textContent})`);
  ok('松开后得到精确直接积分值', pt.src.includes('精确'), 'I(0.9 mm) = ' + pt.I);

  // 精确输入
  await p.evaluate(`rInput.value='0.2'; rInput.dispatchEvent(new Event('change'))`);
  await p.waitFor(`__app.point.quality==="precise" && Math.abs(__app.state.r_mm-0.2)<1e-12`, 5000);
  const c02 = await p.evaluate(`({t:cTitle.textContent, b:cBadge.textContent, I:__app.point.I})`);
  ok('数值框精确输入 r = 0.2 mm，判定在 r⁴ 区内', c02.b.includes('r⁴'), c02.t);

  // 阈值改为 1 %
  await p.evaluate(`thrInput.value='1'; thrInput.dispatchEvent(new Event('change'))`);
  await p.waitFor(`r4Foot.textContent.includes('1.00 %') && r4Foot.textContent.includes('二分精化')`, 5000);
  const lim1 = await p.evaluate(`r4Foot.textContent`);
  ok('r⁴ 阈值可调：1 % ⇒ r ≤ 0.1662 mm', /r ≤ 0\.166\d+ mm/.test(lim1), lim1.slice(0, 90));
  await p.evaluate(`thrInput.value='5'; thrInput.dispatchEvent(new Event('change'))`);
  await p.waitFor(`r4Foot.textContent.includes('5.00 %') && r4Foot.textContent.includes('二分精化')`, 5000);
  const lim5 = await p.evaluate(`r4Foot.textContent`);
  ok('5 % ⇒ r ≤ 0.2495 mm', /r ≤ 0\.2495\d* mm/.test(lim5), lim5.slice(0, 90));
  // 截图 b：r⁴ 区 —— 开启阴影，r = 0.2 mm，滚到三张卡片
  await p.evaluate(`chkZones.checked=true; chkZones.dispatchEvent(new Event('change')); document.querySelector('.plotcard').scrollIntoView({block:'start'}); window.scrollBy(0,-8)`);
  await p.sleep(300);
  // 主图放大到 0–0.5 mm 以突出 r⁴ 段
  await p.evaluate(`(() => { const mp = __app.plots.mainPlot; mp.view = {x0:0, x1:0.5, y0:0, y1:1.2}; mp.draw(); })()`);
  await p.sleep(200);
  await p.screenshot(path.join(SHOT, 'z_常规检查_b1_r4区_主图放大与阈值线.png'));
  await p.evaluate(`document.querySelector('.three').scrollIntoView({block:'start'}); window.scrollBy(0,-90)`); await p.sleep(250);
  await p.screenshot(path.join(SHOT, 'z_常规检查_b2_r4区_双对数与偏差曲线.png'));

  // 锁定第 4 极大 + 极值表
  await p.evaluate(`__app.plots.mainPlot.resetView(); btnLock4.click()`);
  await p.waitFor(`__app.state.locked && __app.point.quality==="precise" && Math.abs(__app.state.r_mm-__app.result.fourth.r*1e3)<1e-12`, 5000);
  ok('“锁定第 4 极大半径”按钮', true, await p.evaluate(`lockInfo.textContent`));
  // 点击曲线上的“极小3”标记（真实鼠标事件）
  const mk = await p.evaluate(`(() => { document.querySelector('.plotcard').scrollIntoView({block:'start'}); const mp = __app.plots.mainPlot; const m = mp.markers.find(m => m.data && m.data.kind==='min' && m.data.index===3); const rc = mp.c.getBoundingClientRect(); return {x: rc.left + mp.px(m.x), y: rc.top + mp.py(m.y), r: m.data.r*1e3}; })()`);
  await p.sleep(150);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: mk.x, y: mk.y, button: 'left', clickCount: 1 });
  await p.waitFor(`__app.point.quality==="precise" && Math.abs(__app.state.r_mm-${mk.r})<1e-12`, 5000);
  ok('点击极值标记跳到该半径', true, '极小3 r = ' + mk.r.toFixed(7) + ' mm');
  // 悬停读数
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mk.x - 120, y: mk.y - 100 });
  await p.sleep(200);
  ok('悬停读数存在', await p.evaluate(`!!__app.plots.mainPlot.hover`));
  await p.screenshot(path.join(SHOT, 'z_常规检查_c0_悬停读数与点击跳转.png'));
  // 回到第 4 极大，截图主图 + 表格
  await p.evaluate(`btnLock4.click()`);
  await p.waitFor(`__app.state.locked && __app.point.quality==="precise"`, 5000);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1380, y: 5 });
  await p.evaluate(`document.querySelector('.plotcard').scrollIntoView({block:'start'}); window.scrollBy(0,-6)`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, 'z_常规检查_c1_极值标注_第4极大.png'));
  await p.evaluate(`document.querySelector('.tablecard').scrollIntoView({block:'start'}); window.scrollBy(0,-6)`); await p.sleep(250);
  await p.screenshot(path.join(SHOT, 'z_常规检查_c2_极值表_含第4极大.png'));
  // r² 坐标
  await p.evaluate(`document.querySelector('#xAxisSeg button[data-v=r2]').click(); document.querySelector('.plotcard').scrollIntoView({block:'start'}); window.scrollBy(0,-6)`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, 'z_常规检查_d_r2坐标_近似等间隔.png'));
  await p.evaluate(`document.querySelector('#xAxisSeg button[data-v=r]').click()`);

  // 快速连续改参数：旧结果不能覆盖新结果
  const before = await p.evaluate(`__app.staleDropped + __app.supersededCount`);
  await p.evaluate(`__app.debug.log.length = 0`);
  await p.evaluate(`extParams.open=true; for (const v of [620, 580, 540, 500]) { lamInput.value=v; lamInput.dispatchEvent(new Event('change')); }`);
  await p.waitFor(`__app.result.params.lambda_nm===500 && Object.keys(__app).length && document.getElementById('btnCancel').disabled`, 8000);
  await p.sleep(400);
  const st = await p.evaluate(`({lam:__app.result.params.lambda_nm, id:__app.result.id, stale:__app.staleDropped + __app.supersededCount, doneQ1: __app.debug.log.filter(l => l.type==='q1' && l.quality==='final' && l.outcome==='done').map(l => l.id), chip:presetChip.textContent, warn:presetWarn.hidden})`);
  // 旧任务或被“取代”（终止线程，不再计算），或结果到达后被丢弃；两者都计入。被接受的 q1 结果只能是最后一个（显示中的 id）
  ok('快速连续改 λ：只接受最新任务', st.lam === 500 && st.stale > before && st.doneQ1.every((id) => id === st.id), `最终 λ = ${st.lam} nm，取代 / 丢弃过期任务 ${st.stale - before} 个，被接受的 q1 任务 ${JSON.stringify(st.doneQ1)}，显示 #${st.id}`);
  // 扩展参数偏离预设 → 警示，恢复预设
  await p.evaluate(`LInput.value='80'; LInput.dispatchEvent(new Event('change'))`);
  await p.waitFor(`__app.result.params.L_cm===80`, 6000); await p.sleep(200);
  const dev = await p.evaluate(`({chip:presetChip.textContent, warn:!presetWarn.hidden, r4:m4.textContent})`);
  ok('偏离题目预设时显著提示', dev.warn && dev.chip.includes('扩展参数'), dev.chip + '；L=80 cm 时 r₄ = ' + dev.r4);
  await p.evaluate(`document.querySelector('.side').scrollIntoView({block:'start'})`); await p.sleep(200);
  await p.screenshot(path.join(SHOT, 'z_常规检查_e_扩展参数偏离预设警示.png'));
  await p.evaluate(`btnPreset.click()`);
  await p.waitFor(`__app.result.params.L_cm===50 && __app.result.params.lambda_nm===500 && __app.point.quality==="precise" && __app.state.locked`, 6000);
  const back = await p.evaluate(`({chip:presetChip.textContent, r:__app.state.r_mm, warn:presetWarn.hidden})`);
  ok('恢复题目预设', back.warn && Math.abs(back.r - 1.3228768) < 1e-6, back.chip + '，r = ' + back.r);

  // 精度切换
  await p.evaluate(`document.querySelector('#precSeg button[data-v=high]').click()`);
  await p.waitFor(`__app.result.precision==='high' && __app.point.quality==="precise"`, 8000);
  const hi = await p.evaluate(`({r4:__app.result.fourth.r*1e3, tag:sTag.textContent})`);
  ok('切换到高精', true, hi.tag);
  await p.evaluate(`document.querySelector('#precSeg button[data-v=standard]').click()`);
  await p.waitFor(`__app.result.precision==='standard' && __app.point.quality==="precise"`, 8000);

  // 取消：提交高精后立即取消
  const cancel = await p.evaluate(`(async () => { const id0 = __app.result.id; document.querySelector('#precSeg button[data-v=high]').click(); const enabled = !btnCancel.disabled; btnCancel.click(); await new Promise(r => setTimeout(r, 1500)); return { enabled, id0, id1: __app.result.id, txt: sText.textContent }; })()`);
  ok('取消按钮：取消后保留上一次结果', cancel.enabled && cancel.id0 === cancel.id1 && cancel.txt.includes('已取消'), cancel.txt);
  await p.evaluate(`document.querySelector('#precSeg button[data-v=standard]').click()`);
  await p.waitFor(`__app.result.precision==='standard' && __app.point.quality==="precise"`, 8000);

  // 收敛检查
  await p.evaluate(`convDetails.open=true; btnConv.click()`);
  await p.waitFor(`convStatus.textContent.includes('完成')`, 60000);
  await p.evaluate(`convDetails.scrollIntoView({block:'start'})`); await p.sleep(300);
  ok('界面内收敛检查完成', true, await p.evaluate(`convStatus.textContent`));
  await p.screenshot(path.join(SHOT, 'z_常规检查_f_收敛检查.png'));
  // 展开所有说明，整页截图
  await p.evaluate(`document.querySelectorAll('details').forEach(d => d.open = true); window.scrollTo(0,0)`); await p.sleep(400);
  const fullH = await p.evaluate(`document.documentElement.scrollHeight`);
  await p.screenshot(path.join(SHOT, 'z_常规检查_g_整页_展开全部说明.png'), { captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: fullH, scale: 1 } });

  // 导出
  await p.evaluate(`btnCsv.click(); btnExpExt.click(); btnJson.click(); btnPng.click(); btnPngMain.click();`);
  await p.sleep(2500);
  const files = fs.readdirSync(DL);
  ok('导出 CSV / 极值 CSV / JSON / PNG', files.some(f => f.endsWith('.csv') && f.includes('I(r)')) && files.some(f => f.includes('极值')) && files.some(f => f.endsWith('.json')) && files.some(f => f.endsWith('.png')), files.join(' | '));
  const exportsDir = path.join(ROOT, 'validation', 'sample_exports'); fs.mkdirSync(exportsDir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(DL, f), path.join(exportsDir, f.replace(/_\d{8}-\d{6}/, '')));
  // 第二问页签
  await p.evaluate(`window.scrollTo(0,0); document.getElementById('tab-q2').click()`); await p.sleep(300);
  await p.screenshot(path.join(SHOT, 'z_常规检查_h_第二问页签_采样规划.png'));
  await p.evaluate(`document.getElementById('tab-q1').click()`);

  const errs = p.logs.filter((l) => /error|EXCEPTION/i.test(l));
  ok('控制台无错误', errs.length === 0, errs.join(' ; ') || '无');
  p.close();

  // file:// 回退
  const f = await connect(9333, 'file://' + path.join(ROOT, 'index.html'), [W, H]);
  await f.waitFor(`window.__app && __app.result && __app.point && __app.point.quality==="precise"`, 20000);
  const fm = await f.evaluate(`({mode:modeInfo.textContent, r4:m4.textContent})`);
  ok('file:// 双击打开也能运行（主线程回退）', fm.mode.includes('回退') || fm.mode.includes('Worker'), fm.mode + '；r₄ = ' + fm.r4);
  await f.screenshot(path.join(SHOT, 'z_常规检查_i_file协议回退模式.png'));
  f.close();

  fs.writeFileSync(path.join(ROOT, 'validation', 'browser_check.json'), JSON.stringify({ when: new Date().toISOString(), browser: 'Chrome headless 156, 1400×900', note: '阶段1常规交互检查（修复轮回归见 regression_fix1.json）', checks }, null, 2));
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
