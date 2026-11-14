/* lab-q1.js — 第一问曲线、孔径示意、扫描与参数控件。 */
'use strict';

  function renderStatus() {
    const busy = Object.values(jobs).some((p) => p.type !== 'conv');
    const qb = $('qBadge');
    if (lastError) { qb.className = 'qbadge error'; qb.textContent = '计算出错'; $('sText').textContent = lastError.split('\n')[0]; }
    else if (busy) { qb.className = 'qbadge busy'; qb.textContent = '计算中…'; $('sText').textContent = '后台积分中，可继续操作'; }
    else if (result && result.quality === 'preview') { qb.className = 'qbadge preview'; qb.textContent = '预览结果（粗采样）'; $('sText').textContent = '松开滑块后自动精算'; }
    else if (result) {
      qb.className = 'qbadge precise'; qb.textContent = '精确结果 · ' + D.PRECISION[result.precision].label;
      const capWarn = result.curve && result.curve.rsamp && result.curve.rsamp.capped ? ' · 半径采样已达上限，极值可能混叠，第 4 极大编号可能不正确' : '';
      $('sText').textContent = (importNote ? importNote + ' · ' : '') + (cancelledNote || ('曲线+极值用时 ' + (result.ms != null ? result.ms + ' ms' : '—'))) + (staleDropped ? ` · 已丢弃过期结果 ${staleDropped} 个` : '') + capWarn;
    }
    if (!busy && !lastError) setProgress(result ? 1 : 0);
    $('btnCancel').disabled = !busy;
    if (result) {
      const q = result.quad, P = result.params;
      $('sTag').textContent = `图形与数值对应（已应用）：λ = ${P.lambda_nm} nm · L = ${P.L_cm} cm · r_max = ${P.rMax_mm} mm · ${D.PRECISION[result.precision].label}（h = ${D.fromSI(q.h, 'um').toFixed(3)} μm，GL ${q.gl}，N_r = ${result.curve.nr}）· 任务 #${result.id}`;
    }
    const chip = $('presetChip'), P = appliedParams();
    chip.className = 'preset-chip' + (isPreset() ? '' : ' off');
    chip.textContent = isPreset() ? '题目预设 · λ = 500 nm · L = 50 cm' : `⚠ 扩展参数 · λ = ${P.lambda_nm} nm · L = ${P.L_cm} cm`;
    $('presetWarn').hidden = isPreset() && isPresetParams(curParams());
    renderPending();
  }
  /* 未应用编辑提示条 */
  function renderPending() {
    const list = pendingEdits(), bar = $('pendingBar');
    const busyQ1 = Object.values(jobs).some((j) => j.type === 'q1');
    document.querySelectorAll('.pending-edit').forEach((el) => el.classList.remove('pending-edit'));
    list.forEach((e) => e.ids.forEach((id) => $(id) && $(id).classList.add('pending-edit')));
    if (!list.length || !result) { bar.hidden = true; return; }
    bar.hidden = false;
    const items = list.map((e) => `<b>${e.label} = ${e.edit}</b>（已应用 ${e.applied}）`).join('；');
    $('pendingText').innerHTML = (busyQ1 ? `<span class="pend-state busy">计算中</span>新参数正在计算；完成前，曲线、当前点、相量、r⁴、极值、说明与导出仍全部对应任务 #${result.id}。未应用：`
      : `<span class="pend-state">未应用</span>以下编辑尚未计算，图形与导出仍对应任务 #${result.id}：`) + items;
    $('btnApply').disabled = busyQ1;
  }
  function renderMode() {
    $('modeInfo').textContent = eng.label;
    $('modeInfo').title = eng.why || '';
    if ($('q2modeInfo')) { $('q2modeInfo').textContent = engQ2.label; $('q2modeInfo').title = engQ2.why || ''; }
    const main = eng.mode === 'main' || engQ2.mode === 'main';
    document.querySelectorAll('.mainwarn').forEach((el) => { el.hidden = !main; });
  }

  /* ======================= 渲染：指标与概念卡 ======================= */
  var fmtI = (v) => (v >= 1e-3 ? v.toFixed(6) : v.toExponential(4));
  /* r₄ 界面显示 7 位有效数字。末位对应约 10⁻⁶ mm，比求积误差粗，也盖过略去的 (1−1/(ikR))。 */
  var sig7 = (v) => Number.isFinite(v) ? Number(v).toPrecision(7) : '—';
  var R4_ERR = '数值误差：求积把 r₄ 定到远好于 10⁻⁶ mm（比这里显示的最后一位还细）。模型误差：略去的 (1 − 1/(ikR)) 本身约 1/(kR) ≈ 10⁻⁷；在 r₄ 处加回去，光强相对变化约 7.8×10⁻¹⁴。导出与校验日志保留全精度。';
  function curR4() { return (r4override && result && r4override.resultId === result.id && r4override.threshold === state.thr) ? r4override : (result && result.r4); }
  function renderMetrics() {
    const ph = AP(), r = SI_MM(state.r_mm), NF = r * r / (ph.lambda * ph.z);
    $('mR').textContent = state.r_mm.toFixed(6) + ' mm';
    $('mRs').textContent = 'r² = ' + (state.r_mm * state.r_mm).toFixed(6) + ' mm²';
    $('mNF').textContent = NF.toFixed(5);
    $('mNFs').textContent = '≈ 孔内半波带数（λL = ' + MM(MM(ph.lambda * ph.z)).toFixed(4) + ' mm²）';
    if (point) {
      $('mI').textContent = fmtI(point.I);
      $('mIs').textContent = point.quality === 'precise' ? '精确：直接积分（' + D.PRECISION[point.precision].label + '）' : '预览：由曲线插值，停顿后精算';
      $('mIs').style.color = point.quality === 'precise' ? 'var(--green)' : 'var(--amber)';
    }
    if (result && result.fourth) {
      const f = result.fourth;
      $('m4').textContent = sig7(MM(f.r)) + ' mm';
      $('m4').title = '全精度 ' + MM(f.r).toFixed(10) + ' mm。' + R4_ERR;
      $('m4s').textContent = `I/I_inc = ${f.I.toFixed(6)} · N_F = ${f.NF.toFixed(5)} · ${D.PRECISION[result.precision].label}曲线 + dI/dr=0 精化。${R4_ERR}`;
      $('lockInfo').innerHTML = `第 4 个极大：<b>r = ${sig7(MM(f.r))} mm</b>（任务 #${result.id} 的数值曲线检测、Brent 求根精化）。${state.locked ? '已锁定：参数变化后自动跟随。' : '点击按钮锁定。'}<br><span class="dim">${R4_ERR}</span>`;
      $('q2r').textContent = sig7(MM(f.r)) + ' mm'; $('q2rBig').textContent = sig7(MM(f.r)) + ' mm';
      if ($('q2rBig')) $('q2rBig').title = '全精度 ' + MM(f.r).toFixed(10) + ' mm。' + R4_ERR;
    } else if (result) {
      // 极值不足：清除一切旧的 r₄ / 锁定 / 第二问半径信息
      const need = Math.sqrt(7 * ph.lambda * ph.z);   // 仅作提示的估计（光程条件 N_F ≈ 7）
      $('m4').textContent = '未找到';
      $('m4s').textContent = `r_max = ${result.params.rMax_mm} mm 内只有 ${result.maxima.length} 个极大（需 ≥ 4）`;
      $('lockInfo').innerHTML = `<span class="badtxt">无法锁定：</span>当前扫描范围 0–${result.params.rMax_mm} mm 内只找到 ${result.maxima.length} 个极大、${result.minima.length} 个极小（任务 #${result.id}）。第 4 个极大约在 N<sub>F</sub> ≈ 7 处，需 r<sub>max</sub> ≳ ${MM(need).toFixed(2)} mm（估计）。${lockNote}`;
      $('q2r').textContent = '—（未求得）'; $('q2rBig').textContent = '—（极大不足 4 个）'; $('q2rBig').title = '当前 r_max 内不足 4 个极大（任务 #' + result.id + '）';
    }
    $('btnLock4').classList.toggle('locked', state.locked);
    $('btnLock4').textContent = state.locked ? '🔒 已锁定第 4 个极大半径' : '锁定第 4 个极大半径';
    $('btnLock4').disabled = !(result && result.fourth);
    $('rOut').textContent = state.r_mm.toFixed(4) + ' mm';
  }
  function nearestExt(r) { if (!result) return null; let b = null, bd = Infinity; for (const e of result.extrema) { const d = Math.abs(e.r - r); if (d < bd) { bd = d; b = e; } } return b; }
  function renderConcept() {
    if (!result || !point) return;
    const ph = AP(), r = SI_MM(state.r_mm), NF = r * r / (ph.lambda * ph.z), R4 = curR4();
    const C = R4.C, eps = r > 0 ? Math.abs(point.I / (C * Math.pow(r, 4)) - 1) : 0;
    const ne = nearestExt(r), near = ne && Math.abs(ne.r - r) < SI_MM(0.002);
    let badge, title, text;
    if (r <= R4.rLimit) {
      badge = '小孔区 · I ∝ r⁴';
      title = `r⁴ 适用区内：ε = ${(eps * 100).toFixed(3)} % ≤ ${(state.thr * 100).toFixed(2)} %`;
      text = `N_F = ${NF.toFixed(4)} ≪ 1，孔边缘与中心到 O′ 的光程差只有 ${(D.fromSI(r * r / (Math.hypot(ph.z, r) + ph.z), 'nm')).toFixed(1)} nm（< λ/2 = ${(result.params.lambda_nm / 2)} nm 的一部分），各子波几乎同相，U 随面积 πr² 线性增长，I = |U|² ∝ r⁴。题目把这一段称为“夫琅禾费衍射”区。`;
    } else {
      const zones = NF, parity = Math.round(NF) % 2 === 1 ? '奇数' : '偶数';
      badge = near ? (ne.kind === 'max' ? `第 ${ne.index} 个极大附近` : `第 ${ne.index} 个极小附近`) : '振荡区 · 半波带';
      title = `孔内约含 ${zones.toFixed(3)} 个半波带` + (near ? `（最近整数 ${Math.round(NF)} 为${parity} → ${ne.kind === 'max' ? '极大' : '极小'}）` : '');
      text = `偏离 r⁴（ε = ${eps > 10 ? eps.toExponential(2) : (eps * 100).toFixed(1) + ' %'}）。孔边缘光程差 R − L = ${(D.fromSI(r * r / (Math.hypot(ph.z, r) + ph.z), 'nm')).toFixed(1)} nm = ${(r * r / (Math.hypot(ph.z, r) + ph.z) / (ph.lambda / 2)).toFixed(3)} × λ/2。相邻半波带贡献相反，奇数个时剩一个未抵消（I ≈ 4I₀），偶数个时近乎抵消（I ≈ 0）。` + (result.fourth && Math.abs(result.fourth.r - r) < SI_MM(1e-6) ? ' 当前正是第 4 个极大（第二问默认半径）。' : '');
    }
    $('cBadge').textContent = badge; $('cTitle').textContent = title; $('cText').textContent = text;
  }

  /* ======================= 主图 I(r) ======================= */
  var mainPlot = new window.LinePlot($('cMain'), { xlabel: '圆孔半径 r (mm)', ylabel: 'I / I_inc', pad: { l: 58, r: 18, t: 8, b: 40 },
    labelBand: { top: 'auto', bottom: 'auto' }, laneTitles: { top: '极大 r (mm)', bottom: '极小 r (mm)' } });
  var xFn = () => {
    const ph = AP();
    if (state.xAxis === 'r2') return { f: (r) => MM(r) * MM(r), inv: (x) => SI_MM(Math.sqrt(Math.max(0, x))), label: 'r² (mm²)　—　振荡在 r² 上近似等间隔（周期 ≈ 2λL）', name: 'r²', unit: 'mm²' };
    if (state.xAxis === 'nf') return { f: (r) => r * r / (ph.lambda * ph.z), inv: (x) => Math.sqrt(Math.max(0, x) * ph.lambda * ph.z), label: '菲涅耳数 N_F = r²/(λL)　—　极大在奇数、极小在偶数附近', name: 'N_F', unit: '' };
    return { f: (r) => MM(r), inv: (x) => SI_MM(x), label: '圆孔半径 r (mm)　—　极值在 r 上越来越密，并不等间隔', name: 'r', unit: 'mm' };
  };
  function homeMain() {
    if (!result) return;
    const X = xFn();
    mainPlot.setHome({ x0: 0, x1: X.f(result.curve.rMax), y0: 0, y1: Math.max(4.4, Math.max(...result.extrema.map((e) => e.I)) * 1.1) });
  }
  function transformArr(src, f) { const o = new Float64Array(src.length); for (let i = 0; i < src.length; i++) o[i] = f(src[i]); return o; }
  var cacheX = { key: '', x: null };
  function renderMain() {
    if (!result) { mainPlot.draw(); return; }
    const X = xFn(), c = result.curve, R4 = curR4();
    const key = result.id + state.xAxis;
    if (cacheX.key !== key) {
      const ph = D.physics(result.params);
      cacheX = { key, x: transformArr(c.r, X.f), r4: transformArr(c.r, (r) => { const v = R4.C * Math.pow(r, 4); return v > 6 ? NaN : v; }), chk: transformArr(c.r, (r) => D.analyticCheckIntensity(r, ph)) };
    }
    mainPlot.o.xlabel = X.label;
    // 参数扫描时：0…r 段亮、r 之后淡（表示“r 正在增大”，不是光强随时间变化）
    const tracing = scan.on;
    let traceX = null, traceY = null;
    if (tracing) { const jr = Math.min(c.nr, Math.floor(SI_MM(state.r_mm) / c.rMax * (c.nr - 1)) + 1); traceX = cacheX.x.subarray(0, jr); traceY = c.I.subarray(0, jr); }
    mainPlot.series = [
      { x: cacheX.x, y: c.I, color: '#57dbe8', width: 1.9, label: 'I 数值', alpha: tracing ? 0.28 : 1 },
      { x: traceX, y: traceY, color: '#57dbe8', width: 2.2, visible: tracing },
      { x: cacheX.x, y: cacheX.r4, color: '#ee79aa', width: 1.4, dash: [6, 4], visible: $('chkR4').checked },
      { x: cacheX.x, y: cacheX.chk, color: '#74e3a8', width: 1.1, dash: [3, 4], visible: $('chkCheck').checked, alpha: 0.9 }
    ];
    mainPlot.markers = [];
    // 极值标注：标签放在绘图框外的上下标签带（极大在上、极小在下），含半径数值，防重叠排布
    const many = result.extrema.length > 60;   // 极值很多时（如 λ=380 nm, L=10 cm, r_max=6 mm）只在缩放后显示标签
    const showLabels = $('chkExtLabels').checked;
    if ($('chkExt').checked) for (const e of result.extrema) {
      const is4 = result.fourth && e === result.fourth;
      const name = (e.kind === 'max' ? '极大' : '极小') + e.index;
      const lab = showLabels && (!many || mainPlotZoomedFew()) ? `${is4 ? '★' : ''}${name}  ${MM(e.r).toFixed(5)}` : '';
      mainPlot.markers.push({ x: X.f(e.r), y: e.I, color: e.kind === 'max' ? '#ffc074' : '#57dbe8', shape: e.kind === 'max' ? 'down' : 'up',
        lane: e.kind === 'max' ? 'top' : 'bottom', label: lab, ring: is4 ? '#ffc074' : null, data: e, labelColor: is4 ? '#ffd9a8' : null });
    }
    mainPlot.vlines = [{ x: X.f(SI_MM(state.r_mm)), color: point && point.quality === 'precise' ? '#eaf4ff' : '#ffc074', width: 1.5, dash: point && point.quality === 'precise' ? [] : [4, 3],
      label: `当前 r = ${state.r_mm.toFixed(5)} mm${scan.on ? (scan.playing ? '（扫描中）' : '（扫描暂停）') : point && point.quality !== 'precise' ? '（预览）' : ''}`, labelBottom: true }];
    mainPlot.cursor = point ? { x: X.f(SI_MM(state.r_mm)), y: point.I, color: point.quality === 'precise' ? '#eaf4ff' : '#ffc074' } : null;
    if ($('chkR4').checked || $('chkZones').checked) mainPlot.vlines.push({ x: X.f(R4.rLimit), color: '#ee79aa', dash: [2, 3], label: `r⁴ 区边界 ε=${(state.thr * 100).toFixed(1)}%`, labelY: 24 });
    mainPlot.bands = $('chkZones').checked ? [{ x0: 0, x1: X.f(R4.rLimit), color: 'rgba(43,74,104,.45)', label: 'I ∝ r⁴', textColor: '#ee79aa' }] : [];
    mainPlot.hlines = [{ y: 4, color: 'rgba(255,192,116,.35)', dash: [2, 5], label: '4 I_inc', labelLeft: true }];
    mainPlot.texts = result.quality === 'preview' ? [{ plotX: 12, plotY: 8, text: '预览（粗采样）· 松开后精算', color: '#ffc074', font: '600 12px "Microsoft YaHei",sans-serif' }] : [];
    if (many && showLabels && !mainPlotZoomedFew()) mainPlot.texts.push({ plotX: 12, plotY: result.quality === 'preview' ? 26 : 8, text: `共 ${result.extrema.length} 个极值：标签过密已隐藏，滚轮放大到 ≤ 60 个极值后自动显示半径标签（完整列表见极值表）`, color: '#93aac2' });
    mainPlot.draw();
  }
  function mainPlotZoomedFew() {
    const v = mainPlot.view; if (!v || !result) return false;
    const X = xFn(); let n = 0;
    for (const e of result.extrema) { const x = X.f(e.r); if (x >= Math.min(v.x0, v.x1) && x <= Math.max(v.x0, v.x1)) n++; }
    return n <= 60;
  }
  mainPlot.onView = () => { if (result && result.extrema.length > 60) renderMain(); };
  mainPlot.onHover = (x) => {
    if (!result) return [];
    const X = xFn(), r = X.inv(x); if (r < 0 || r > result.curve.rMax) return [];
    const U = interpU(r), I = U.re * U.re + U.im * U.im, ph = D.physics(result.params), R4 = curR4();
    const out = [
      { text: `r = ${MM(r).toFixed(5)} mm   r² = ${(MM(r) ** 2).toFixed(5)} mm²` },
      { text: `N_F = ${(r * r / (ph.lambda * ph.z)).toFixed(4)}` },
      { text: `I/I_inc = ${fmtI(I)}（数值）`, color: '#57dbe8' },
      { text: `C·r⁴ = ${fmtI(R4.C * r ** 4)}   ε = ${r > 0 ? (Math.abs(I / (R4.C * r ** 4) - 1) * 100).toFixed(2) : '0'} %`, color: '#ee79aa' }
    ];
    if ($('chkCheck').checked) out.push({ text: `验算 4sin² = ${fmtI(D.analyticCheckIntensity(r, ph))}  差 ${(I - D.analyticCheckIntensity(r, ph)).toExponential(2)}`, color: '#74e3a8' });
    out.push({ text: '点击：跳到该半径', color: '#93aac2' });
    out.dots = [{ x, y: I, color: '#57dbe8' }];
    return out;
  };
  mainPlot.onMarkerClick = (m) => setRadius(MM(m.data.r), { precise: true, forceInput: true });
  mainPlot.c.addEventListener('wheel', () => { if (result && result.extrema.length > 60) renderMain(); });
  mainPlot.onClickX = (x) => { const r = xFn().inv(x); setRadius(MM(r), { precise: true, forceInput: true }); };

  /* ======================= r⁴ 图 ======================= */
  var r4Plot = new window.LinePlot($('cR4'), { xlog: true, ylog: true, xlabel: 'r (mm)，对数', ylabel: 'I / I_inc', pad: { l: 54, r: 12, t: 10, b: 34 } });
  var errPlot = new window.LinePlot($('cErr'), { xlog: true, xlabel: 'r (mm)，对数', ylabel: 'ε (%)', pad: { l: 54, r: 12, t: 8, b: 32 } });
  var r4cache = { key: '' };
  function renderR4() {
    if (!result) return;
    const c = result.curve, R4 = curR4();
    if (r4cache.key !== result.id) {
      const n = c.nr, xm = new Float64Array(n - 1), I = new Float64Array(n - 1), cr4 = new Float64Array(n - 1), e = new Float64Array(n - 1);
      for (let i = 1; i < n; i++) { xm[i - 1] = MM(c.r[i]); I[i - 1] = c.I[i]; cr4[i - 1] = result.r4.C * Math.pow(c.r[i], 4); e[i - 1] = c.eps[i] * 100; }
      r4cache = { key: result.id, xm, I, cr4, e };
      const rm = result.params.rMax_mm, x0 = Math.max(xm[0], rm * 2e-3);
      r4Plot.setHome({ x0, x1: rm, y0: Math.max(1e-12, result.r4.C * Math.pow(SI_MM(x0), 4) * 0.5), y1: 20 });
      errPlot.setHome({ x0, x1: rm, y0: 0, y1: Math.max(15, state.thr * 300) });
    }
    errPlot.home.y1 = Math.max(15, state.thr * 300);
    if (!errPlot.drag) errPlot.view.y1 = errPlot.home.y1;
    const curX = state.r_mm, lim = MM(R4.rLimit);
    r4Plot.series = [{ x: r4cache.xm, y: r4cache.I, color: '#57dbe8', width: 1.8 }, { x: r4cache.xm, y: r4cache.cr4, color: '#ee79aa', width: 1.3, dash: [6, 4] }];
    r4Plot.vlines = [{ x: lim, color: '#ee79aa', dash: [2, 3], label: `r⁴ 区 ≤ ${lim.toFixed(4)} mm` }];
    if (curX > 0) r4Plot.vlines.push({ x: curX, color: '#eaf4ff', label: '当前 r', labelBottom: true });
    r4Plot.bands = [{ x0: r4Plot.view ? r4Plot.view.x0 : 1e-4, x1: lim, color: 'rgba(43,74,104,.35)' }];
    errPlot.series = [{ x: r4cache.xm, y: r4cache.e, color: '#ffc074', width: 1.6 }];
    errPlot.hlines = [{ y: state.thr * 100, color: '#ee79aa', dash: [5, 4], label: `阈值 ${(state.thr * 100).toFixed(2)} %` }];
    errPlot.vlines = [{ x: lim, color: '#ee79aa', dash: [2, 3] }];
    if (curX > 0) errPlot.vlines.push({ x: curX, color: '#eaf4ff' });
    r4Plot.draw(); errPlot.draw();
    const ph = D.physics(result.params), Cth = D.analyticCheckR4(1, ph);
    // 局部斜率 d lnI / d lnr（来自数值曲线）
    const j1 = Math.max(1, Math.round(c.nr * 0.004)), j2 = 2 * j1;
    const slope = Math.log(c.I[j2] / c.I[j1]) / Math.log(c.r[j2] / c.r[j1]);
    $('r4Foot').innerHTML = `判据 ε(r) = |I/(C r⁴) − 1| ≤ <b>${(state.thr * 100).toFixed(2)} %</b> ⇒ <b>r ≤ ${lim.toFixed(5)} mm</b>（N_F ≤ ${R4.NFLimit.toFixed(4)}${R4.refined ? '，二分精化' : ''}${r4override ? '' : (R4.threshold !== state.thr ? '，精化中…' : '')}）<br>` +
      `C = I(r_s)/r_s⁴ = ${(R4.C * 1e-12).toExponential(6)} mm⁻⁴（数值，r_s = ${D.fromSI(R4.rs, 'um').toFixed(3)} μm）；验算 π²/(λL)² = ${(Cth * 1e-12).toExponential(6)}，相对差 ${((R4.C / Cth - 1)).toExponential(1)}。r = ${MM(c.r[j1]).toFixed(4)}–${MM(c.r[j2]).toFixed(4)} mm 处 d lnI/d lnr = ${slope.toFixed(5)}`;
  }
  var syncX = (src, dst) => (v) => { if (!dst.view) return; dst.view.x0 = v.x0; dst.view.x1 = v.x1; renderR4(); };
  r4Plot.onView = syncX(r4Plot, errPlot); errPlot.onView = syncX(errPlot, r4Plot);
  var r4hover = (x) => {
    if (!result) return [];
    const r = SI_MM(x); if (r <= 0 || r > result.curve.rMax) return [];
    const U = interpU(r), I = U.re * U.re + U.im * U.im, R4 = curR4(), e = Math.abs(I / (R4.C * r ** 4) - 1);
    const o = [{ text: `r = ${x.toFixed(5)} mm` }, { text: `I = ${I.toExponential(4)}`, color: '#57dbe8' }, { text: `C r⁴ = ${(R4.C * r ** 4).toExponential(4)}`, color: '#ee79aa' }, { text: `ε = ${(e * 100).toFixed(3)} %`, color: '#ffc074' }];
    return o;
  };
  r4Plot.onHover = r4hover; errPlot.onHover = r4hover;
  r4Plot.onClickX = errPlot.onClickX = (x) => setRadius(x, { precise: true, forceInput: true });

  /* ======================= 孔径示意 ======================= */
  function prepCanvas2d(cv, opt) {
    opt = opt || {};
    const dpr = window.devicePixelRatio || 1, rc = cv.getBoundingClientRect();
    const W = Math.max(opt.min || 0, rc.width), H = Math.max(opt.min || 0, rc.height);
    const w = Math.round(W * dpr), h = Math.round(H * dpr);
    if (opt.always || cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (opt.fill) { ctx.fillStyle = opt.fill; ctx.fillRect(0, 0, W, H); }
    return { ctx, W, H, dpr };
  }
  function prepCanvas(cv) { return prepCanvas2d(cv, { fill: '#060c16', always: true }); }
  var hue = (phi) => `hsl(${((phi / (2 * Math.PI)) % 1 + 1) % 1 * 360},80%,62%)`;
  function renderAperture() {
    const { ctx, W, H } = prepCanvas($('cAp'));
    const ph = AP(), r = SI_MM(state.r_mm);
    const NF = r * r / (ph.lambda * ph.z);
    // 正视图（孔径自动缩放到画框，便于看清半波带；比例尺见下方文字）
    const cx = W * 0.27, cy = H * 0.47, Rpix = Math.min(W * 0.23, H * 0.4);
    const rp = r > 0 ? Rpix * 0.92 : 0, sc = r > 0 ? rp / r : 0;
    ctx.fillStyle = '#5d7a95'; ctx.font = '10.5px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`自动缩放：圆直径 = 2r = ${(2 * state.r_mm).toFixed(4)} mm`, cx, cy + Rpix + 16);
    // 半波带（几何示意：R = L + nλ/2 的环）
    const nZ = Math.ceil(NF - 1e-9);
    if (nZ <= 60) {
      for (let n = nZ; n >= 1; n--) {
        const rn = Math.min(r, D.pathConditionRadius(n, ph)), px = sc * rn;
        ctx.fillStyle = n % 2 ? 'rgba(255,192,116,.55)' : 'rgba(87,219,232,.35)';
        ctx.beginPath(); ctx.arc(cx, cy, px, 0, 2 * Math.PI); ctx.fill();
      }
    } else { ctx.fillStyle = 'rgba(160,190,220,.35)'; ctx.beginPath(); ctx.arc(cx, cy, rp, 0, 2 * Math.PI); ctx.fill(); }
    ctx.strokeStyle = '#eaf4ff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, Math.max(rp, 0.8), 0, 2 * Math.PI); ctx.stroke(); ctx.lineWidth = 1;
    // 轴
    ctx.strokeStyle = '#57dbe8'; ctx.fillStyle = '#57dbe8';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - Rpix - 8); ctx.stroke(); ctx.fillText('+X', cx + 12, cy - Rpix - 4);
    ctx.strokeStyle = '#93aac2'; ctx.fillStyle = '#93aac2';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - Rpix - 8, cy); ctx.stroke(); ctx.fillText('+Y', cx - Rpix - 14, cy - 4);
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fill(); ctx.fillText('⊙ z', cx + 14, cy + 14);
    ctx.fillStyle = '#eaf4ff'; ctx.font = '600 12px "Microsoft YaHei",sans-serif';
    ctx.fillText(`r = ${state.r_mm.toFixed(4)} mm`, cx, cy - Rpix - 24);
    ctx.font = '10.5px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#ffc074'; ctx.fillText('■ 奇数带', cx - 34, H - 12); ctx.fillStyle = '#57dbe8'; ctx.fillText('■ 偶数带', cx + 34, H - 12);
    // 侧视图
    const x0 = W * 0.56, x1 = W - 22, ay = H * 0.47, half = H * 0.36;
    ctx.strokeStyle = '#3a526d'; ctx.lineWidth = 4;
    const hp = r > 0 ? half * 0.92 : 0;
    ctx.beginPath(); ctx.moveTo(x0, ay - half - 6); ctx.lineTo(x0, ay - hp); ctx.moveTo(x0, ay + hp); ctx.lineTo(x0, ay + half + 6); ctx.stroke(); ctx.lineWidth = 1;
    ctx.strokeStyle = '#26384f'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x0, ay); ctx.lineTo(x1, ay); ctx.stroke(); ctx.setLineDash([]);
    const nr = 9;
    for (let i = 0; i < nr; i++) {
      const s = -1 + 2 * i / (nr - 1), rho = Math.abs(s) * r;
      const phi = ph.k * rho * rho / (Math.hypot(ph.z, rho) + ph.z);
      ctx.strokeStyle = hue(phi); ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.moveTo(x0, ay - s * hp); ctx.lineTo(x1, ay); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = hue(phi); ctx.beginPath(); ctx.arc(x0, ay - s * hp, 2.4, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.fillStyle = '#ee79aa'; ctx.beginPath(); ctx.arc(x1, ay, 3.5, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = '#eaf4ff'; ctx.textAlign = 'right'; ctx.fillText('O′', x1 + 2, ay + 16);
    ctx.textAlign = 'center'; ctx.fillStyle = '#93aac2'; ctx.fillText('孔面', x0, ay + half + 20); ctx.fillText('L（压缩）', (x0 + x1) / 2, ay + half + 20);
    ctx.fillText('射线颜色 = 传播相位', (x0 + x1) / 2, ay - half - 22); ctx.fillText('k(R−L) mod 2π', (x0 + x1) / 2, ay - half - 8);
    const dEdge = r * r / (Math.hypot(ph.z, r) + ph.z);
    if (scan.on) { ctx.fillStyle = '#ffc074'; ctx.textAlign = 'left'; ctx.font = '600 11px "Microsoft YaHei",sans-serif'; ctx.fillText(scan.playing ? '▶ 半径扫描中（r 增大）' : '⏸ 半径扫描暂停', 8, 16); }
    $('apFoot').innerHTML = `边缘光程差 R<sub>edge</sub> − L = <b>${D.fromSI(dEdge, 'nm').toFixed(2)} nm</b> = ${(dEdge / (ph.lambda / 2)).toFixed(4)} × (λ/2)；N<sub>F</sub> = ${NF.toFixed(4)}。半波带边界按光程条件 R = L + nλ/2 画出，仅为几何示意。`;
  }

  /* ======================= 相量图 ======================= */
  function renderPhasor() {
    const { ctx, W, H } = prepCanvas($('cPh'));
    if (!result || !point) return;
    const c = result.curve;
    // 视窗：包住整条振动曲线
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (let i = 0; i < c.nr; i += 4) { x0 = Math.min(x0, c.re[i]); x1 = Math.max(x1, c.re[i]); y0 = Math.min(y0, c.im[i]); y1 = Math.max(y1, c.im[i]); }
    const span = Math.max(x1 - x0, y1 - y0, 1e-6) * 1.12, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const S = Math.min(W - 30, H - 50) / span, ox = W / 2 - mx * S, oy = (H - 20) / 2 + my * S;
    const P = (re, im) => [ox + re * S, oy - im * S];
    // 坐标轴
    ctx.strokeStyle = '#1b2a3e'; ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.moveTo(ox, 0); ctx.lineTo(ox, H); ctx.stroke();
    ctx.fillStyle = '#5d7a95'; ctx.font = '10.5px Consolas,monospace'; ctx.textAlign = 'left';
    ctx.fillText('Re U′', W - 44, oy - 4); ctx.fillText('Im U′', ox + 4, 12);
    for (const t of [1, 2]) { const [px] = P(t, 0); if (px < W - 10) { ctx.fillText(String(t), px - 3, oy + 12); ctx.beginPath(); ctx.moveTo(px, oy - 3); ctx.lineTo(px, oy + 3); ctx.stroke(); } }
    // 全曲线（淡）与 0..r（亮），来自数值曲线
    ctx.strokeStyle = '#2b4a68'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < c.nr; i++) { const [a, b] = P(c.re[i], c.im[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); } ctx.stroke();
    const jr = Math.min(c.nr - 1, Math.floor(point.r / c.rMax * (c.nr - 1)));
    ctx.strokeStyle = 'rgba(87,219,232,.55)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= jr; i++) { const [a, b] = P(c.re[i], c.im[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
    { const [a, b] = P(point.U.re, point.U.im); ctx.lineTo(a, b); } ctx.stroke(); ctx.lineWidth = 1;
    // M 段相量箭头
    const ph = AP();
    const arrow = (xa, ya, xb, yb, col, w) => {
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
      const ang = Math.atan2(yb - ya, xb - xa), L = Math.min(8 + w, Math.hypot(xb - xa, yb - ya) * 0.5);
      ctx.beginPath(); ctx.moveTo(xb, yb); ctx.lineTo(xb - L * Math.cos(ang - 0.4), yb - L * Math.sin(ang - 0.4)); ctx.lineTo(xb - L * Math.cos(ang + 0.4), yb - L * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill(); ctx.lineWidth = 1;
    };
    for (const s of point.seg.segments) {
      const rm = 0.5 * (s.r0 + s.r1), phi = ph.k * rm * rm / (Math.hypot(ph.z, rm) + ph.z);
      const [a, b] = P(s.startRe, s.startIm), [cx2, cy2] = P(s.startRe + s.re, s.startIm + s.im);
      arrow(a, b, cx2, cy2, hue(phi), 1.4);
    }
    const [ex, ey] = P(point.U.re, point.U.im), [zx, zy] = P(0, 0);
    if (Math.hypot(ex - zx, ey - zy) > 3) arrow(zx, zy, ex, ey, '#ffc074', 2.6);
    ctx.fillStyle = '#ffc074'; ctx.font = '600 12px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`合成 U′ → I = |U′|² = ${fmtI(point.I)}`, 10, H - 12);
    ctx.fillStyle = point.quality === 'precise' ? '#74e3a8' : '#ffc074'; ctx.textAlign = 'right'; ctx.font = '11px "Microsoft YaHei",sans-serif';
    ctx.fillText(point.quality === 'precise' ? '精确：每段 GL 直接积分' : '预览：曲线插值', W - 10, H - 12);
    const nodes = point.nodes || (result ? Math.ceil(point.r / result.quad.h) * result.quad.gl : 0);
    $('phFoot').innerHTML = `显示 M = ${point.seg.segments.length} 段箭头（<b>教学示意</b>），实际积分节点 ≈ ${nodes} 个，并非全部样本。箭头颜色 = 该段平均传播相位；淡蓝曲线 = 0…r_max 的数值振动曲线，转一圈 ≈ 2 个半波带。`;
  }

  /* ======================= 极值表 ======================= */
  function renderExtTable() {
    if (!result) return;
    const ph = D.physics(result.params), tb = $('extTable').querySelector('tbody');
    const prevOf = {};
    let html = '';
    for (const e of result.extrema) {
      const pv = prevOf[e.kind]; prevOf[e.kind] = e;
      const rn = D.pathConditionRadius(e.zone, ph);
      const cls = e.kind + (result.fourth === e ? ' fourth' : '') + (Math.abs(MM(e.r) - state.r_mm) < 5e-7 ? ' cur' : '');
      html += `<tr class="${cls}" data-r="${MM(e.r)}"><td>${e.kind === 'max' ? '极大' : '极小'} ${e.index}${result.fourth === e ? ' ★' : ''}</td><td>${e.kind === 'max' ? '极大' : '极小'}</td>` +
        `<td class="num">${MM(e.r).toFixed(7)}</td><td class="num">${(MM(e.r) ** 2).toFixed(6)}</td><td class="num">${e.NF.toFixed(5)}</td><td class="num">${e.zone}</td>` +
        `<td class="num">${e.I >= 1e-4 ? e.I.toFixed(7) : e.I.toExponential(2)}</td>` +
        `<td class="num">${pv ? D.fromSI(e.r - pv.r, 'um').toFixed(3) : '—'}</td><td class="num">${pv ? (MM(e.r) ** 2 - MM(pv.r) ** 2).toFixed(6) : '—'}</td>` +
        `<td class="num">${D.fromSI(e.r - rn, 'nm').toFixed(2)}</td></tr>`;
    }
    tb.innerHTML = html;
    const mx = result.maxima, mn = result.minima;
    const dr2 = []; for (let i = 1; i < mx.length; i++) dr2.push(MM(mx[i].r) ** 2 - MM(mx[i - 1].r) ** 2);
    const avg = dr2.reduce((a, b) => a + b, 0) / Math.max(1, dr2.length);
    const lz = MM(MM(ph.lambda * ph.z));
    if (!result.extrema.length) {
      tb.innerHTML = `<tr><td colspan="10" class="muted">r_max = ${result.params.rMax_mm} mm 内没有极值（N<sub>F</sub> ≤ ${(SI_MM(result.params.rMax_mm) ** 2 / (ph.lambda * ph.z)).toFixed(3)} &lt; 1）。增大扩展参数中的 r<sub>max</sub> 后重算。</td></tr>`;
      $('extFoot').innerHTML = `找到 <b>0</b> 个极大、<b>0</b> 个极小；<span class="bad">不足 5 个完整周期，也没有第 4 个极大</span>（任务 #${result.id}）。`;
      return;
    }
    const maxRefShift = Math.max(...result.extrema.map((e) => Math.abs(e.r - e.rDiscrete)));
    const cycles = Math.max(0, mx.length - 1);
    const maxPathDiff = Math.max(...result.extrema.map((e) => Math.abs(D.fromSI(e.r - D.pathConditionRadius(e.zone, ph), 'nm'))));
    const refineTxt = result.curve.refineMode === 'parabolic' ? `<span class="warntxt">预览档极值很多，本次用三点抛物线插值定位（未做 dI/dr = 0 精化），松开后标准档会精化。</span>` : '';
    $('extFoot').innerHTML = refineTxt + `找到 <b>${mx.length}</b> 个极大、<b>${mn.length}</b> 个极小（不计 r = 0）；相邻极大之间 <b>${cycles}</b> 个完整周期 ${cycles >= 5 ? '<span class="good">≥ 5 ✓</span>' : '<span class="bad">&lt; 5，请增大 r_max</span>'}。` +
      `相邻极大 Δ(r²) 平均 ${avg.toFixed(6)} mm²（2λL = ${(2 * lz).toFixed(6)} mm²），Δr 从 ${mx.length > 1 ? D.fromSI(mx[1].r - mx[0].r, 'um').toFixed(1) : '—'} μm 减到 ${mx.length > 1 ? D.fromSI(mx[mx.length - 1].r - mx[mx.length - 2].r, 'um').toFixed(1) : '—'} μm：<b>在 r 上不等间隔，在 r² 上近似等间隔</b>。` +
      `精化：离散采样峰与 dI/dr = 0 精化位置最大相差 ${D.fromSI(maxRefShift, 'um').toFixed(3)} μm（半径采样间隔 ${D.fromSI(result.curve.rMax / (result.curve.nr - 1), 'um').toFixed(3)} μm）。最后一列为独立验算（光程条件），非结果来源：两者最大相差 ${maxPathDiff.toFixed(3)} nm；极大值略小于 4、极小值约 10⁻¹² 而非 0，来自倾斜因子 L/R 与 1/R。`;
  }
  $('extTable').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-r]'); if (tr) setRadius(parseFloat(tr.dataset.r), { precise: true, forceInput: true }); });

  /* ======================= 采样表 ======================= */
  function renderSampling() {
    if (!result) return;
    const ph = D.physics(result.params), q = result.quad, nm = (m) => D.fromSI(m, 'nm'), um = (m) => D.fromSI(m, 'um');
    const a = result.fourth ? result.fourth.r : SI_MM(state.r_mm);
    const plan = D.phase2Plan(ph, a, SI_MM(D.PRESET.q2HalfWidth_mm));
    const rows = [
      ['<b>第一问 · 源平面（径向）</b>', '', ''],
      ['面板宽度 h = λR<sub>max</sub>/(q r<sub>max</sub>)', `${um(q.h).toFixed(4)} μm`, `q = ${q.pathFrac}（${D.PRECISION[result.precision].label}）`],
      ['每面板 Gauss–Legendre 节点', `${q.gl}`, `面板数 ${result.curve.panels}，总节点 ${result.curve.panels * q.gl}`],
      ['面板跨度造成的最大光程差（ρ = r<sub>max</sub>）', `${nm(q.pathPerPanel).toFixed(3)} nm = λ/${(ph.lambda / q.pathPerPanel).toFixed(1)}`, `相位 ${q.phasePerPanel.toFixed(4)} rad`],
      ['相邻积分节点最大光程差', `${nm(q.pathPerNode).toFixed(3)} nm = λ/${(ph.lambda / q.pathPerNode).toFixed(1)}`, `节点最大间距 ${um(q.nodeGap).toFixed(4)} μm（λ/10 判据 ✓）`],
      ['<b>第一问 · 半径扫描采样（与源平面采样分开）</b>', '', ''],
      ['半径采样（I(r) 曲线）', `N<sub>r</sub> = ${result.curve.nr}`, `Δr = ${um(result.curve.rMax / (result.curve.nr - 1)).toFixed(4)} μm；` + (result.curve.refineMode === 'parabolic' ? '极值用抛物线插值（预览）' : '极值另用 dI/dr = 0 精化到 ~10⁻¹⁴ m')],
      ['相邻半径采样的边缘相位增量 k·Δr·r<sub>max</sub>/R<sub>max</sub>', result.curve.rsamp ? `${result.curve.rsamp.phaseStep.toFixed(4)} rad` : '—', result.curve.rsamp ? `上限 π/${Math.round(Math.PI / result.curve.rsamp.phaseStepBound)}；ΔN<sub>F</sub> ≤ ${result.curve.rsamp.dNF.toExponential(2)}，每个振荡周期（ΔN<sub>F</sub> = 2）≥ ${result.curve.rsamp.samplesPerPeriod.toFixed(1)} 点；N<sub>r</sub> = max(${result.curve.rsamp.nrBase}, ${result.curve.rsamp.nrNeed})${result.curve.rsamp.capped ? '（已达上限，可能欠采样！）' : ''}` : ''],
      ['入射相位梯度（第一问）', '0', '同相：孔面入射相位为常数，只有传播相位 k(R−L)'],
      ['<b>第二问规划 · 观察区 5 mm × 5 mm</b>', `a = ${MM(a).toFixed(6)} mm`, result.fourth ? '取本项目求得的第 4 极大半径' : '<span class="warntxt">当前 r_max 内不足 4 个极大：第二问默认半径未求得，此处仅用当前 r 估算规划</span>'],
      ['边缘点 (2.5 mm, 0) 的 |∂R/∂X| 上界 (a + 2.5 mm)/R', plan.gEdge.toExponential(4), `λ/10 ⇒ 源采样 d ≤ ${um(plan.dEdge).toFixed(3)} μm`],
      ['角点 (2.5, 2.5) mm 的 |∇R| 上界 (a + 3.536 mm)/R', plan.gCorner.toExponential(4), `λ/10 ⇒ d ≤ ${um(plan.dCorner).toFixed(3)} μm`],
      ['情形 3 入射相位梯度 8π/(2a)', `${plan.incGrad.toFixed(1)} rad/m`, `与传播相位合计 ≤ 0.2π ⇒ d ≤ ${um(plan.dCombined).toFixed(3)} μm`],
      ['计划源采样间距 d', `${um(plan.dSrc).toFixed(3)} μm`, `直径方向约 ${plan.nAcross} 点，孔内约 ${plan.nDisc.toLocaleString()} 个样本；角点相邻光程差上界 ${nm(plan.pathStepCornerAtD).toFixed(2)} nm（含入射相位的合并判据更严）`],
      ['观察面：强度最高空间频率 ≈ 2a/(λL)', `${(plan.fMax / 1000).toFixed(3)} mm⁻¹`, `Nyquist 间距 ${um(plan.dObsNyq).toFixed(2)} μm；计划 ≤ ${um(plan.dObsPlan).toFixed(2)} μm（${plan.nObs} × ${plan.nObs}）`],
      ['情形 3 预计偏移（几何估计，待阶段 2 数值验证）', `${MM(plan.shiftOnScreen).toFixed(4)} mm`, `sinθ = 4λ/(2a) = ${plan.tiltSin.toExponential(3)}，朝相位延迟端 +X′`]
    ];
    const html = '<tr><th>项目</th><th>数值</th><th>说明</th></tr>' + rows.map((r) => r[1] === '' && r[2] === '' ? `<tr><td colspan="3">${r[0]}</td></tr>` : `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join('');
    $('sampTable').querySelector('tbody').innerHTML = html;
    $('q2PlanTable').querySelector('tbody').innerHTML = '<tr><th>项目</th><th>数值</th><th>说明</th></tr>' + rows.slice(rows.findIndex((r) => r[0].includes('第二问规划'))).map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join('');
    $('precHint').textContent = precText(state.precision);
    if (typeof renderQ2Sampling === 'function') renderQ2Sampling();
  }

  /* ======================= 收敛检查 ======================= */
  function renderConvergence(m) {
    const R = m.result, ref = R.reference;
    const fe = (v) => v === null || v === undefined || !isFinite(v) ? '—' : (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toFixed(4));
    const f9 = (v) => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(9);
    const f7 = (v) => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(7);
    const f1 = (v) => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(1);
    const ex2 = (v) => v === null || v === undefined || !isFinite(v) ? '—' : v.toExponential(2);
    const tgt = ref.targetIndex ? (ref.hasFourth ? '第 4 极大' : `第 ${ref.targetIndex} 极大（范围内不足 4 个极大，退而检查最后一个）`) : null;
    let h = `<p>参考解：q = ${ref.pathFrac}、GL ${ref.gl} 点（h = ${ref.h_um.toFixed(4)} μm），` + (tgt ? `${tgt} r = ${f9(ref.r4max_mm)} mm，I = ${f9(ref.I4)}` : '<span class="warntxt">扫描范围内没有极大，极值位置的收敛项跳过，只检查 I(r) 误差</span>') + `；共 ${ref.nExtrema} 个极值。用时 ${m.ms} ms。参数（任务 #${m.resultId || '—'} 的已应用参数）：λ = ${m.params.lambda_nm} nm，L = ${m.params.L_cm} cm，r_max = ${m.params.rMax_mm} mm。</p>`;
    h += '<h4>A. 源平面网格加密（400 个测试半径上的最大 |ΔI|、第 4 极大位置）</h4><div class="tablewrap"><table><tr><th>求积规则</th><th>q（面板光程差 λ/q）</th><th>h (μm)</th><th>max |I − I_ref|</th><th>r₄ (mm)</th><th>Δr₄ (nm)</th><th>ΔI₄</th></tr>';
    for (const g of R.grid) h += `<tr><td>${g.method === 'GL' ? 'GL ' + g.gl + ' 点' : '环带面积中点和'}</td><td class="num">${g.pathFrac}</td><td class="num">${g.h_um.toFixed(3)}</td><td class="num">${g.maxAbsErrI.toExponential(2)}</td><td class="num">${f9(g.r4max_mm)}</td><td class="num">${fe(g.dr4_nm)}</td><td class="num">${ex2(g.dI4)}</td></tr>`;
    h += '</table></div><h4>B. 半径采样加密（标准精度求积）</h4><div class="tablewrap"><table><tr><th>N_r</th><th>Δr (μm)</th><th>极值数</th><th>离散峰 r₄ (mm)</th><th>离散误差 (nm)</th><th>精化 r₄ (mm)</th><th>精化误差 (nm)</th><th>全部极值相对上一行最大移动 (nm)</th></tr>';
    for (const s of R.rsamp) h += `<tr><td class="num">${s.nr}</td><td class="num">${s.dr_um.toFixed(3)}</td><td class="num">${s.nExtrema}</td><td class="num">${f7(s.r4raw_mm)}</td><td class="num">${f1(s.dRawVsRef_nm)}</td><td class="num">${f9(s.r4ref_mm)}</td><td class="num">${fe(s.dRefinedVsRef_nm)}</td><td class="num">${fe(s.maxShiftAllExtrema_nm)}</td></tr>`;
    h += '</table></div><h4>C. 三档精度预设 vs 参考解（全部极值）</h4><div class="tablewrap"><table><tr><th>预设</th><th>极值数</th><th>max |Δr| (nm)</th><th>max |ΔI|</th><th>r₄ (mm)</th><th>r⁴ 区边界 (mm)</th></tr>';
    for (const k of Object.keys(R.presets)) { const p = R.presets[k]; h += `<tr><td>${D.PRECISION[k].label}</td><td class="num">${p.nExtrema}</td><td class="num">${fe(p.maxAbsDr_nm)}</td><td class="num">${ex2(p.maxAbsDI)}</td><td class="num">${f9(p.r4max_mm)}</td><td class="num">${f7(p.r4lim_mm)}</td></tr>`; }
    const ring10 = R.grid.find((g) => g.method === 'ring' && g.pathFrac === 10), gl8 = R.grid.find((g) => g.method === 'GL' && g.gl === 8 && g.pathFrac === 20);
    const maxRefMove = Math.max(...R.rsamp.map((s) => Math.abs(s.dRefinedVsRef_nm || 0)));
    h += `</table></div><p>结论（由上表数值得出）：GL 求积随面板加密快速收敛，标准档（GL 8，λ/20）max|ΔI| = ${gl8 ? gl8.maxAbsErrI.toExponential(1) : '—'}；环带面积中点和按 O(h²) 收敛（h 减半误差约降为 1/4），在 λ/10 采样下 max|ΔI| = ${ring10 ? ring10.maxAbsErrI.toExponential(1) : '—'}，说明“相邻光程差 ≤ λ/10”是可用的下限而不是高精度保证。经 dI/dr = 0 精化后，第 4 极大位置与半径采样密度无关（各 N_r 下偏离参考 ≤ ${maxRefMove.toExponential(1)} nm），离散峰位置误差在 Δr/2 量级。</p>`;
    $('convOut').innerHTML = h;
    $('convStatus').textContent = `完成（任务 #${m.id}，${m.ms} ms）` + (ref.hasFourth ? '' : ' · 范围内不足 4 个极大，已按可用极值处理');
    lastConv = m;
  }
  var lastConv = null;
  $('btnConv').addEventListener('click', () => {
    if (!result) return;
    supersede(engConv, 'conv');
    $('convStatus').textContent = '已提交，后台运行中…（使用任务 #' + result.id + ' 的已应用参数）';
    submit('conv', { resultId: result.id }, 'final', engConv, { params: result.params, precision: result.precision });
  });

  /* ======================= 汇总渲染 ======================= */
  function renderPointViews() { renderMetrics(); renderConcept(); renderMain(); renderR4(); renderAperture(); renderPhasor(); markCurRow(); renderScanUI(); }
  function markCurRow() { document.querySelectorAll('#extTable tbody tr').forEach((tr) => tr.classList.toggle('cur', Math.abs(parseFloat(tr.dataset.r) - state.r_mm) < 5e-7)); }
  function renderAll() { renderMetrics(); renderConcept(); renderMain(); renderR4(); renderAperture(); renderPhasor(); renderExtTable(); renderSampling(); renderStatus(); renderScanUI(); }

  /* ======================= 控件事件 ======================= */
  var slider = $('rSlider');
  slider.addEventListener('input', () => setRadius(parseFloat(slider.value)));
  slider.addEventListener('change', () => setRadius(parseFloat(slider.value), { precise: true, forceInput: true }));
  $('rInput').addEventListener('change', () => {
    commitNumber($('rInput'), { label: 'r (mm)', revert: () => { $('rInput').value = state.r_mm.toFixed(7); }, apply: (v) => setRadius(v, { precise: true, forceInput: true }) });
  });
  $('rInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rInput').dispatchEvent(new Event('change')); });
  $('rMinus').addEventListener('click', () => setRadius(state.r_mm - 0.001, { precise: true, forceInput: true }));
  $('rPlus').addEventListener('click', () => setRadius(state.r_mm + 0.001, { precise: true, forceInput: true }));
  $('btnLock4').addEventListener('click', () => {
    if (!(result && result.fourth)) return;
    scanStop(false);
    state.locked = !state.locked;
    if (state.locked) setRadius(MM(result.fourth.r), { fromLock: true, precise: true, forceInput: true });
    renderMetrics(); renderQ2Lock(); renderQ2Pending();
  });
  function applyInputs() {
    $('lamSlider').value = state.lambda_nm; $('lamInput').value = state.lambda_nm; $('lamOut').textContent = state.lambda_nm + ' nm';
    $('LSlider').value = state.L_cm; $('LInput').value = state.L_cm; $('LOut').textContent = state.L_cm + ' cm';
    $('rMaxInput').value = state.rMax_mm; $('rMaxOut').textContent = state.rMax_mm + ' mm';
    $('thrSlider').value = state.thr * 100; $('thrInput').value = +(state.thr * 100).toFixed(3); $('thrOut').textContent = (state.thr * 100).toFixed(2) + ' %';
    document.querySelectorAll('#precSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.precision));
    document.querySelectorAll('#xAxisSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.xAxis));
    $('rInput').value = state.r_mm.toFixed(7); slider.value = state.r_mm;
    renderPending();
  }
  $('btnPreset').addEventListener('click', () => {
    scanStop(false);
    Object.assign(state, DEFAULTS, { locked: true, xAxis: 'r' });
    applyInputs(); r4override = null; cacheX.key = ''; requestQ1('final'); renderStatus();
  });
  document.querySelectorAll('#precSeg button').forEach((b) => b.addEventListener('click', () => { state.precision = b.dataset.v; applyInputs(); requestQ1('final'); renderSampling(); }));
  document.querySelectorAll('#xAxisSeg button').forEach((b) => b.addEventListener('click', () => {
    state.xAxis = b.dataset.v; applyInputs(); cacheX.key = ''; homeMain(); renderMain();
    $('axisNote').textContent = state.xAxis === 'r' ? '横轴 r：极值在 r 上越来越密（非等间隔）' : state.xAxis === 'r2' ? '横轴 r²：相邻极大间距 ≈ 2λL，近似等间隔' : '横轴 N_F：极大在奇数、极小在偶数附近（倾斜因子造成微小偏差）';
  }));
  ['chkExt', 'chkExtLabels', 'chkR4', 'chkCheck', 'chkZones'].forEach((id) => $(id).addEventListener('change', renderMain));
  $('btnResetView').addEventListener('click', () => mainPlot.resetView());
  // 阈值：本地即时插值（预览）+ 后台二分精化
  function setThr(pct, final) {
    if (!isFinite(pct) || pct <= 0) return;
    state.thr = pct / 100; applyInputs();
    if (result) {
      const c = result.curve; let j = 1; while (j < c.nr && c.eps[j] <= state.thr) j++;
      let rl = c.rMax;
      if (j < c.nr) { const t = (state.thr - c.eps[j - 1]) / (c.eps[j] - c.eps[j - 1]); rl = c.r[j - 1] + t * (c.r[j] - c.r[j - 1]); }
      const ph = D.physics(result.params);
      r4override = { resultId: result.id, C: result.r4.C, rs: result.r4.rs, threshold: state.thr, rLimit: rl, NFLimit: rl * rl / (ph.lambda * ph.z), refined: false };
      renderR4(); renderMain(); renderConcept();
    }
    clearTimeout(setThr.t);
    setThr.t = setTimeout(() => { if (result) requestR4(); }, final ? 0 : 200);   // 用已应用参数 + resultId
  }
  $('thrSlider').addEventListener('input', () => setThr(parseFloat($('thrSlider').value)));
  $('thrInput').addEventListener('change', () => {
    commitNumber($('thrInput'), { label: 'r⁴ 阈值 (%)', revert: () => { $('thrInput').value = +(state.thr * 100).toFixed(3); }, apply: (v) => setThr(v, true) });
  });
  /* 非法输入回到当前状态，并在状态栏写出该输入框自己的 min/max。 */
  function commitNumber(input, spec) {
    spec = spec || {};
    const raw = spec.integer ? parseInt(input.value, 10) : parseFloat(input.value);
    const min = spec.min != null ? spec.min : (input.min === '' ? -Infinity : Number(input.min));
    const max = spec.max != null ? spec.max : (input.max === '' ? Infinity : Number(input.max));
    const bad = !Number.isFinite(raw) || raw < min || raw > max;
    if (bad) {
      input.setAttribute('aria-invalid', 'true');
      if (spec.revert) spec.revert();
      const fmt = (x) => Number.isFinite(x) ? String(x) : '—';
      importNote = (spec.label || '数值') + ' 超出合法范围 [' + fmt(min) + ', ' + fmt(max) + ']，已恢复';
      renderStatus();
      return null;
    }
    input.removeAttribute('aria-invalid');
    importNote = '';
    if (spec.apply) spec.apply(raw);
    return raw;
  }
  // 扩展参数
  function bindExt(sliderId, inputId, key, label) {
    $(sliderId).addEventListener('input', () => { state[key] = parseFloat($(sliderId).value); applyInputs(); cacheX.key = ''; requestQ1('preview'); renderStatus(); });
    $(sliderId).addEventListener('change', () => { state[key] = parseFloat($(sliderId).value); applyInputs(); requestQ1('final'); });
    $(inputId).addEventListener('change', () => {
      commitNumber($(inputId), { label: label, revert: () => { $(inputId).value = state[key]; }, apply: (v) => { state[key] = v; applyInputs(); cacheX.key = ''; requestQ1('final'); } });
    });
  }
  bindExt('lamSlider', 'lamInput', 'lambda_nm', 'λ (nm)'); bindExt('LSlider', 'LInput', 'L_cm', 'L (cm)');
  $('rMaxInput').addEventListener('change', () => {
    commitNumber($('rMaxInput'), {
      label: 'r_max (mm)',
      revert: () => { $('rMaxInput').value = state.rMax_mm; },
      apply: (v) => { state.rMax_mm = v; applyInputs(); cacheX.key = ''; r4cache.key = ''; requestQ1('final'); }
    });
  });
  function cancelMainJobs(note) {
    for (const e of [eng, engPt, engConv]) {
      const ids = e.cancel();
      ids.forEach((id) => { if (jobs[id]) endJob(id, 'cancelled'); });
      for (const k of Object.keys(jobs)) if (jobs[k].engine === e) endJob(+k, 'cancelled');
    }
    latest.q1 = ++seq; latest.point = ++seq; latest.r4 = ++seq; latest.conv = ++seq; previewJob = null; previewDirty = false;
    pendingQ2AfterQ1 = false;
    cancelledNote = note || ('已取消；显示的是上一次完成的结果（任务 #' + (result ? result.id : '—') + '）');
    renderStatus();
    if (result && point && point.quality !== 'precise') requestPoint();   // 取消后把当前点补算为精确值（仍是已应用参数）
  }
  $('btnCancel').addEventListener('click', () => cancelMainJobs());
  $('btnApply').addEventListener('click', () => { cacheX.key = ''; r4cache.key = ''; requestQ1('final'); });
  $('btnDiscard').addEventListener('click', () => {
    if (!result) return;
    if (Object.values(jobs).some((j) => j.type === 'q1')) cancelMainJobs('已放弃未应用的编辑');
    const P = result.params;
    Object.assign(state, { lambda_nm: P.lambda_nm, L_cm: P.L_cm, rMax_mm: P.rMax_mm, precision: result.quality === 'preview' ? state.precision : result.precision });
    cancelledNote = '已放弃未应用的编辑，控件恢复为任务 #' + result.id + ' 的参数';
    applyInputs(); renderStatus();
  });
  $('btnRecalc').addEventListener('click', () => { cacheX.key = ''; r4cache.key = ''; requestQ1('final'); });
  // 页签
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    // 离开第一问时暂停半径扫描：否则隐藏的扫描仍在改 r，第二问会不断出现“r 未应用”的提示
    if (b.id === 'tab-q2' && scan.playing) scanStop(true, '切换到第二问，扫描已暂停');
    $('q1-panel').hidden = b.id !== 'tab-q1'; $('q2-panel').hidden = b.id !== 'tab-q2';
    if (b.id === 'tab-q1') requestAnimationFrame(renderAll);
    if (b.id === 'tab-q2') requestAnimationFrame(() => { renderQ2All(); maybeStartQ2(); });
  }));
  window.addEventListener('resize', () => { renderAperture(); renderPhasor(); if (!$('q2-panel').hidden) { renderQ2Maps(); renderQ2Cuts(); } });

  /* ======================= 导出 ======================= */

  var NFof = (r_mm) => { const ph = AP(), r = SI_MM(r_mm); return r * r / (ph.lambda * ph.z); };
  var rOfNF = (nf) => { const ph = AP(); return MM(Math.sqrt(Math.max(0, nf) * ph.lambda * ph.z)); };
  var scanOpt = { fromScan: true, noIdle: true, forceInput: true, renderNow: true };
  function scanPlay() {
    if (!result) return;
    if (state.r_mm >= rMaxApplied() - 1e-9) setRadius(0, scanOpt);
    scan.on = true; scan.playing = true; scan.note = ''; scan.lastT = performance.now();
    cancelAnimationFrame(scan.raf); scan.raf = requestAnimationFrame(scanFrame);
    renderScanUI(); renderPointViews();
  }
  function scanFromZero() { if (!result) return; scanStop(true); scan.on = true; setRadius(0, scanOpt); scanPlay(); }
  function scanFrame(t) {
    if (!scan.playing) return;
    const dt = Math.max(0, Math.min(0.1, (t - scan.lastT) / 1000)); scan.lastT = t;
    const speed = parseFloat($('scanSpeed').value) || 0.5;          // 每秒增加的 N_F（半波带数）
    const rm = rMaxApplied();
    let r = rOfNF(NFof(state.r_mm) + speed * dt);
    if (r >= rm) { setRadius(rm, scanOpt); scanStop(true, '已扫描到 r_max'); return; }
    setRadius(r, scanOpt);
    scan.raf = requestAnimationFrame(scanFrame);
  }
  /* keepOn = true：暂停但保留扫描模式；false：退出扫描模式（用户手动改半径等） */
  function scanStop(keepOn, note) {
    if (!scan.on && !scan.playing) return;
    const was = scan.playing;
    scan.playing = false; cancelAnimationFrame(scan.raf);
    if (note) scan.note = note;
    if (!keepOn) { scan.on = false; scan.note = ''; }
    if (was && result) requestPoint();     // 停下后把当前点精算
    renderScanUI(); if (result) renderPointViews();
  }
  function scanToggle() { if (scan.playing) scanStop(true); else scanPlay(); }
  function scanStep(dir) {
    if (!result) return;
    scanStop(true); scan.on = true;
    const step = parseFloat($('scanStepSize').value) || 0.1;
    const nf = Math.max(0, NFof(state.r_mm) + (dir || 1) * step);
    setRadius(Math.min(rMaxApplied(), rOfNF(nf)), { fromScan: true, precise: true, forceInput: true });
    renderScanUI();
  }
  function jumpExt(dir) {
    if (!result) return;
    scanStop(true);
    const r = SI_MM(state.r_mm), tol = 1e-10;
    const list = result.extrema;
    let e = null;
    if (dir > 0) e = list.find((x) => x.r > r + tol) || null;
    else for (let i = list.length - 1; i >= 0; i--) if (list[i].r < r - tol) { e = list[i]; break; }
    if (!e) { scan.note = dir > 0 ? '后面没有更多极值（已到 r_max 内最后一个）' : '前面没有极值'; renderScanUI(); return; }
    scan.note = '';
    setRadius(MM(e.r), { fromScan: true, precise: true, forceInput: true });
    renderScanUI();
  }
  function renderScanUI() {
    const st = $('scanState'); if (!st) return;
    st.textContent = scan.playing ? '扫描中' : scan.on ? '已暂停' : '未扫描';
    st.className = 'scanstate' + (scan.playing ? ' on' : scan.on ? ' paused' : '');
    $('scanToggle').textContent = scan.playing ? '⏸ 暂停' : '▶ 继续扫描';
    $('scanToggle').setAttribute('aria-pressed', String(scan.playing));
    if (!result) { $('scanInfo').textContent = '等待计算结果…'; return; }
    const nf = NFof(state.r_mm), rm = rMaxApplied();
    const ne = nearestExt(SI_MM(state.r_mm));
    const at = ne && Math.abs(ne.r - SI_MM(state.r_mm)) < 1e-10 ? `；正位于${ne.kind === 'max' ? '极大' : '极小'} ${ne.index}` : '';
    $('scanInfo').innerHTML = `r = <b>${state.r_mm.toFixed(5)} mm</b>，N<sub>F</sub> = ${nf.toFixed(3)}；扫描进度 ${(100 * state.r_mm / rm).toFixed(1)} %${at}` + (scan.note ? `<br><span class="warntxt">${scan.note}</span>` : '');
    $('scanPrev').disabled = !result.extrema.some((x) => x.r < SI_MM(state.r_mm) - 1e-10);
    $('scanNext').disabled = !result.extrema.some((x) => x.r > SI_MM(state.r_mm) + 1e-10);
  }
  $('scanFromZero').addEventListener('click', scanFromZero);
  $('scanToggle').addEventListener('click', scanToggle);
  $('scanBack').addEventListener('click', () => scanStep(-1));
  $('scanFwd').addEventListener('click', () => scanStep(1));
  $('scanPrev').addEventListener('click', () => jumpExt(-1));
  $('scanNext').addEventListener('click', () => jumpExt(1));

  /* ======================= 第二问 ======================= */
