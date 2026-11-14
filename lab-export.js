/* lab-export.js — 配置 JSON 与 PNG/CSV 导出。 */
'use strict';

  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  var stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
  function metaLines() {
    const ph = D.physics(result.params), q = result.quad;
    return [
      ['项目', '圆孔衍射 · 第13章研讨题第1题 · 阶段2（第一问导出）'],
      ['导出时间', new Date().toString()],
      ['题目预设', isPreset() ? '是（λ = 500 nm, L = 50 cm）' : '否（扩展参数）'],
      ['参数状态', '本导出全部对应已完成的任务 #' + result.id + (pendingEdits().length ? '；另有未应用的编辑（未包含）：' + pendingEdits().map((e) => e.label + '=' + e.edit).join('，') : '')],
      ['波长 λ', `${result.params.lambda_nm} nm = ${ph.lambda} m`], ['距离 L = z', `${result.params.L_cm} cm = ${ph.z} m`], ['入射振幅 A', '1（实数，孔内均匀）'],
      ['积分', 'U = (1/(iλ)) ∬ U_inc (z/R) e^{ikR}/R dS（RS1，时谐因子 e^{-iωt}）；轴上 dS = 2πρ dρ；I = |U|²'],
      ['归一化', 'I_inc = |A|² = 1；I/I_inc = I/I_0（不加遮挡平面波同约定 I_0 = 1）'],
      ['约化场', 'Re_U、Im_U 为 U·e^{-ikL}（去掉公共相位因子），|U|² 不变'],
      ['求积', `复合 Gauss–Legendre：面板宽 h = ${q.h} m（面板最大光程差 λ/${q.pathFrac}），每面板 ${q.gl} 点，面板数 ${result.curve.panels}`],
      ['半径采样', `N_r = ${result.curve.nr}，r ∈ [0, ${result.params.rMax_mm}] mm 等间隔` + (result.curve.rsamp ? `；相邻边缘相位增量 ≤ ${result.curve.rsamp.phaseStep.toFixed(4)} rad（ΔN_F ≤ ${result.curve.rsamp.dNF.toExponential(2)}）` : '')],
      ['精度预设', D.PRECISION[result.precision].label + '（' + result.precision + '）'],
      ['r⁴ 判据', `ε = |I/(C r⁴) − 1| ≤ ${curR4().threshold}；C = ${curR4().C} m⁻⁴（数值）；r_lim = ${curR4().rLimit} m`],
      ['第4极大', result.fourth ? `r = ${result.fourth.r} m，I/I_inc = ${result.fourth.I}` : '未找到'],
      ['任务', '#' + result.id + '；内核版本 ' + D.VERSION]
    ];
  }
  $('btnCsv').addEventListener('click', () => {
    if (!result) return;
    const c = result.curve, ph = D.physics(result.params), C = curR4().C;
    const lines = metaLines().map(([k, v]) => `# ${k}: ${v}`);
    lines.push('# 列说明: r_mm 半径(mm); r2_mm2 (mm²); NF = r²/(λL); Re_U, Im_U 约化复振幅(√I_inc 单位); I_over_Iinc 数值光强; eps_r4 = |I/(C r⁴)−1|; I_check_analytic 为 4sin²(k(√(L²+r²)−L)/2) 仅作验算，不是结果');
    lines.push('r_mm,r2_mm2,NF,Re_U,Im_U,I_over_Iinc,eps_r4,I_check_analytic');
    for (let i = 0; i < c.nr; i++) {
      const r = c.r[i];
      lines.push([MM(r).toPrecision(10), (MM(r) ** 2).toPrecision(10), (r * r / (ph.lambda * ph.z)).toPrecision(10), c.re[i].toPrecision(12), c.im[i].toPrecision(12), c.I[i].toPrecision(12), (i ? Math.abs(c.I[i] / (C * r ** 4) - 1) : 0).toPrecision(8), D.analyticCheckIntensity(r, ph).toPrecision(12)].join(','));
    }
    download(`圆孔轴上光强I(r)_λ${result.params.lambda_nm}nm_L${result.params.L_cm}cm_${D.PRECISION[result.precision].label}_${stamp()}.csv`, new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  });
  $('btnExpExt').addEventListener('click', () => {
    if (!result) return;
    const ph = D.physics(result.params);
    const lines = metaLines().map(([k, v]) => `# ${k}: ${v}`);
    lines.push('# r_path_check_mm 为独立验算（光程条件 √(L²+r²)−L = nλ/2），不是结果来源');
    lines.push('kind,index,r_mm,r2_mm2,NF,n,I_over_Iinc,r_discrete_mm,I_discrete,r_path_check_mm,diff_nm');
    for (const e of result.extrema) { const rn = D.pathConditionRadius(e.zone, ph); lines.push([e.kind, e.index, MM(e.r).toPrecision(12), (MM(e.r) ** 2).toPrecision(12), e.NF.toPrecision(10), e.zone, e.I.toPrecision(12), MM(e.rDiscrete).toPrecision(10), e.IDiscrete.toPrecision(10), MM(rn).toPrecision(12), D.fromSI(e.r - rn, 'nm').toPrecision(6)].join(',')); }
    download(`圆孔轴上光强_极值表_${stamp()}.csv`, new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  });
  function configObject() {
    const q = result ? result.quad : null, P = appliedParams();
    const prec = result && result.quality !== 'preview' ? result.precision : state.precision;
    const pe = pendingEdits();
    return {
      schema: 'circular-aperture-lab/phase2-config', kernelVersion: D.VERSION, exportedAt: new Date().toISOString(),
      isProblemPreset: isPreset(),
      appliedJob: result ? result.id : null,
      params: { lambda_nm: P.lambda_nm, L_cm: P.L_cm, A: 1, rMax_mm: P.rMax_mm, r_mm: state.r_mm, r4Threshold: state.thr, lockedToFourthMax: state.locked },
      unappliedEdits: pe.length ? Object.fromEntries(pe.map((e) => [e.key, e.key === 'precision' ? state.precision : state[e.key]])) : null,
      precision: Object.assign({}, D.PRECISION[prec], { rPhaseStep: D.PRECISION[prec].rPhaseStep }),
      quadrature: q && { panelWidth_m: q.h, panelWidth_um: D.fromSI(q.h, 'um'), glNodesPerPanel: q.gl, pathFrac: q.pathFrac, pathPerPanel_nm: D.fromSI(q.pathPerPanel, 'nm'), pathPerNode_nm: D.fromSI(q.pathPerNode, 'nm'), panels: result.curve.panels, nr: result.curve.nr },
      conventions: { timeFactor: 'exp(-i ω t)', propagator: '(1/(iλ)) (z/R) exp(ikR)/R, RS1', areaWeight: '2πρ dρ (轴上)', intensity: 'I = |U|^2', normalization: 'I_inc = |A|^2 = 1；I/I_inc = I/I_0', coordinates: '+z 光传播；孔面 (X,Y)、观察屏 (X′,Y′)，+X、+X′ 向上，右手系', units: '内部 SI 米；显示 nm/μm/mm/cm' },
      view: { xAxis: state.xAxis, showExtrema: $('chkExt').checked, showR4: $('chkR4').checked, showAnalyticCheck: $('chkCheck').checked, showR4Band: $('chkZones').checked, mainView: mainPlot.view },
      results: result && {
        job: result.id, precision: result.precision, quality: result.quality,
        fourthMax: result.fourth && { r_mm: MM(result.fourth.r), I_over_Iinc: result.fourth.I, NF: result.fourth.NF },
        r4: { C_per_m4: curR4().C, rLimit_mm: MM(curR4().rLimit), NFLimit: curR4().NFLimit, threshold: curR4().threshold },
        extrema: result.extrema.map((e) => ({ kind: e.kind, index: e.index, r_mm: MM(e.r), I_over_Iinc: e.I, NF: e.NF, n: e.zone })),
        currentPoint: point && { r_mm: MM(point.r), I_over_Iinc: point.I, quality: point.quality }
      },
      q2: q2ConfigSlice(),
      reproduce: '用“载入配置 JSON”导入本文件，或在 Node 中：require("./diffraction.js").computeQ1(params, precision.key)；二维：require("./diffraction-q2.js").computeQ2(...)'
    };
  }
  $('btnJson').addEventListener('click', () => download(`圆孔衍射_参数配置_${stamp()}.json`, new Blob([JSON.stringify(configObject(), null, 2)], { type: 'application/json' })));
  function bindConfigFile(id) {
    const el = $(id); if (!el) return;
    el.addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { loadConfig(JSON.parse(await f.text())); }
      catch (e) { importNote = '配置文件无法解析：' + e.message; renderStatus(); }
      ev.target.value = '';
    });
  }
  bindConfigFile('fileJson');
  /* 配置载入：合法的 0（如 r = 0）必须保留，不能用 “|| 默认值”（0 是假值）。非法字段用默认值并提示。 */
  function cfgNum(v, def, ok, name, bad) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) { bad.push(name + '（缺失）'); return def; }
    const x = Number(v);
    if (!Number.isFinite(x) || !ok(x)) { bad.push(name + ' = ' + JSON.stringify(v)); return def; }
    return x;
  }
  function loadConfig(cfg) {
    const p = (cfg && cfg.params) || {}, bad = [];
    scanStop(false);
    const next = {
      lambda_nm: cfgNum(p.lambda_nm, DEFAULTS.lambda_nm, (x) => D.inRange('lambda_nm', x), 'λ', bad),
      L_cm: cfgNum(p.L_cm, DEFAULTS.L_cm, (x) => D.inRange('L_cm', x), 'L', bad),
      rMax_mm: cfgNum(p.rMax_mm, DEFAULTS.rMax_mm, (x) => D.inRange('rMax_mm', x), 'r_max', bad),
      thr: cfgNum(p.r4Threshold, DEFAULTS.thr, (x) => D.inRange('r4Threshold', x), 'r⁴ 阈值', bad),
      locked: p.lockedToFourthMax === true,
      precision: (cfg && cfg.precision && D.PRECISION[cfg.precision.key]) ? cfg.precision.key : 'standard',
      xAxis: (cfg && cfg.view && ['r', 'r2', 'nf'].includes(cfg.view.xAxis)) ? cfg.view.xAxis : 'r'
    };
    const r = cfgNum(p.r_mm, 1, (x) => x >= 0, 'r', bad);       // r = 0 合法
    Object.assign(state, next);
    applyQ2Config(cfg, bad);
    importNote = '已载入配置' + (bad.length ? '；以下字段非法或缺失，已用默认值：' + bad.join('，') : '');
    applyInputs(); applyQ2Inputs(); cacheX.key = ''; r4cache.key = '';
    const id = requestQ1('final');
    pendingRadius = { r: Math.min(r, next.rMax_mm), jobId: id };    // 结果完成后恢复（锁定时由第 4 极大覆盖）
    if (next.locked) pendingRadius = null;
    pendingQ2AfterQ1 = true;           // 第一问完成后再按载入的第二问参数计算
    renderStatus();
    return id;
  }
  /* 文本自动换行（PNG 导出中的长说明不被截断） */
  function wrapText(ctx, text, maxW) {
    const out = []; let line = '';
    for (const ch of String(text)) { if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; }
    if (line) out.push(line); return out;
  }
  function exportPngCanvas() {
    const W = 1800, pad = 24, meta = metaLines();
    const cr4 = $('cR4'), cerr = $('cErr'), cap = $('cAp'), cph = $('cPh');
    // 主图按导出尺寸离屏重绘（标签带按 1752 px 宽重新排布，与当前窗口宽度无关）
    const mw = W - 2 * pad, mh = 640;
    const hv = mainPlot.hover; mainPlot.hover = null;
    const main = mainPlot.renderOffscreen(mw, mh, 1);
    mainPlot.hover = hv;
    const colW = Math.floor((W - 4 * pad) / 3);
    const r4h = Math.round(colW * cr4.height / cr4.width), errh = Math.round(colW * cerr.height / cerr.width), aph = Math.round(colW * cap.height / cap.width);
    // 先量出元数据换行后的总行数
    const mctx = document.createElement('canvas').getContext('2d'); mctx.font = '13px Consolas,"Microsoft YaHei",monospace';
    const metaRows = meta.map(([k, v]) => [k, wrapText(mctx, v, W - 2 * pad - 120)]);
    const caption = wrapText(mctx, `主图横轴：${xFn().label}；纵轴 I/I_inc（线性）。上方标签带 = 极大半径、下方标签带 = 极小半径（mm，dI/dr = 0 精化值）。粉色虚线 C·r⁴（C 为数值系数）；绿色虚线（若显示）为解析验算，非结果。当前半径 r = ${state.r_mm.toFixed(7)} mm，I = ${point ? point.I : '—'}（${point && point.quality === 'precise' ? '精确' : '预览'}）`, W - 2 * pad);
    const nMetaLines = metaRows.reduce((a, r) => a + r[1].length, 0);
    const headH = 60 + nMetaLines * 19 + caption.length * 19 + 8;
    const H = headH + mh + pad * 2 + Math.max(r4h + errh, aph) + 60;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
    ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#57dbe8'; ctx.font = '800 15px "Microsoft YaHei",sans-serif'; ctx.fillText('物理光学 · 第13章研讨题 · 第1题 · 第一问 轴上光强 I(r)（数值积分）', pad, 32);
    ctx.font = '13px Consolas,"Microsoft YaHei",monospace';
    let yy = 60;
    metaRows.forEach(([k, lines]) => { ctx.fillStyle = '#93aac2'; ctx.fillText(k + '：', pad, yy); ctx.fillStyle = '#eaf4ff'; lines.forEach((l) => { ctx.fillText(l, pad + 120, yy); yy += 19; }); });
    ctx.fillStyle = '#93aac2'; caption.forEach((l) => { ctx.fillText(l, pad, yy); yy += 19; });
    let y = headH;
    ctx.drawImage(main, pad, y, mw, mh); y += mh + pad + 16;
    ctx.fillStyle = '#93aac2'; ctx.fillText('r⁴ 区（双对数）与偏差 ε(r)', pad, y - 6); ctx.fillText('孔径与半波带（示意）', pad * 2 + colW, y - 6); ctx.fillText('相量叠加（M 段为示意）', pad * 3 + colW * 2, y - 6);
    ctx.drawImage(cr4, pad, y, colW, r4h); ctx.drawImage(cerr, pad, y + r4h, colW, errh);
    ctx.drawImage(cap, pad * 2 + colW, y, colW, aph); ctx.drawImage(cph, pad * 3 + colW * 2, y, colW, aph);
    return cv;
  }
  $('btnPng').addEventListener('click', () => {
    if (!result) return;
    const cv = exportPngCanvas();
    cv.toBlob((b) => download(`圆孔轴上光强_图像_λ${result.params.lambda_nm}nm_L${result.params.L_cm}cm_${stamp()}.png`, b), 'image/png');
  });
  /* 提交图：只含主图（高分辨率 2×），标签带中每个极大 / 极小半径都完整可读 */
  $('btnPngMain').addEventListener('click', () => {
    if (!result) return;
    const hv = mainPlot.hover; mainPlot.hover = null;
    const W = 1600, Hm = 620, head = 56;
    const plotCv = mainPlot.renderOffscreen(W, Hm, 2); mainPlot.hover = hv;
    const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = (Hm + head) * 2;
    const ctx = cv.getContext('2d'); ctx.scale(2, 2); ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, W, Hm + head);
    const P = result.params;
    ctx.fillStyle = '#57dbe8'; ctx.font = '800 15px "Microsoft YaHei",sans-serif';
    ctx.fillText(`圆孔轴上光强 I(r)（RS1 复振幅数值积分，I = |U|²）· λ = ${P.lambda_nm} nm · L = ${P.L_cm} cm · ${D.PRECISION[result.precision].label} · 任务 #${result.id}`, 16, 24);
    ctx.fillStyle = '#93aac2'; ctx.font = '12px "Microsoft YaHei",sans-serif';
    ctx.fillText(`上方标签 = 极大半径 r (mm)，下方标签 = 极小半径 r (mm)（dI/dr = 0 精化）；★ = 第 4 个极大${result.fourth ? ' r = ' + sig7(MM(result.fourth.r)) + ' mm, I/I_inc = ' + result.fourth.I.toFixed(6) : '（未找到）'}`, 16, 44);
    ctx.drawImage(plotCv, 0, head, W, Hm);
    cv.toBlob((b) => download(`圆孔轴上光强_提交图_极值半径_λ${P.lambda_nm}nm_L${P.L_cm}cm_${stamp()}.png`, b), 'image/png');
  });

  /* ======================= 半径参数扫描（自动扫描 / 暂停 / 单步 / 上一个·下一个极值） =======================
   * 动画表达的是“参数 r 随时间增大”：每一帧把 r 设为新值，显示该半径下**稳态、时间平均**的光强 I(r)
   * （由已完成的数值曲线插值，暂停或单步后再用直接积分精算）。光强本身不随时间变化，所以界面里不画
   * 任何随时间明暗闪烁的光斑；变化的只有游标位置、已扫过的曲线段、半波带圈数和相量箭头链的长度。
   * r 按 N_F = r²/(λL) 匀速增加（每秒若干个半波带），使振荡在时间上均匀出现。 */
