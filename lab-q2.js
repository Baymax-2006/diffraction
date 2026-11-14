/* lab-q2.js — 第二问图样、探针与剖面。 */
'use strict';

  var q2s = {
    caseKey: 'inphase', precision: 'standard',
    seed: D.Q2_DEFAULT_SEED >>> 0, cellSize_um: D.Q2_DEFAULT_CELL_UM, randomMode: 'independent',
    normBeforeRandom: null, normPinned: false,
    scale: 'linear', norm: 'shared', logFloor: 1e-4,
    probeX_mm: 0, probeY_mm: 0,
    lastError: null, cancelledNote: ''
  };
  var q2result = null, q2PreviewJob = null, q2PreviewDirty = false, pendingQ2AfterQ1 = false;
  var q2cutX = null, q2cutY = null;

  function q2PendingEdits() {
    if (!q2result) return [];
    const out = [];
    const rA = D.fromSI(q2result.a, 'mm'), rE = state.r_mm;
    if (Math.abs(rA - rE) > 1e-12) out.push({ key: 'r_mm', label: 'r', edit: rE.toFixed(7) + ' mm', applied: rA.toFixed(7) + ' mm' });
    if (q2s.caseKey !== q2result.caseKey) out.push({ key: 'caseKey', label: '情形', edit: D.Q2_CASES[q2s.caseKey].label, applied: D.Q2_CASES[q2result.caseKey].label });
    if ((q2s.seed >>> 0) !== (q2result.seed >>> 0) && (q2s.caseKey === 'random' || q2result.caseKey === 'random'))
      out.push({ key: 'seed', label: '种子', edit: String(q2s.seed >>> 0), applied: String(q2result.seed >>> 0) });
    if ((q2s.randomMode || 'independent') !== (q2result.randomMode || 'independent') && (q2s.caseKey === 'random' || q2result.caseKey === 'random'))
      out.push({ key: 'randomMode', label: '随机模型', edit: q2s.randomMode === 'cell' ? '固定单元格' : '逐点独立', applied: q2result.randomMode === 'cell' ? '固定单元格' : '逐点独立' });
    if (q2s.randomMode === 'cell' && q2s.cellSize_um !== D.fromSI(q2result.cellSize, 'um') && (q2s.caseKey === 'random' || q2result.caseKey === 'random'))
      out.push({ key: 'cell', label: '单元格', edit: q2s.cellSize_um + ' μm', applied: D.fromSI(q2result.cellSize, 'um') + ' μm' });
    if (q2s.precision !== q2result.q2Precision && q2result.quality !== 'preview')
      out.push({ key: 'precision', label: '精度', edit: D.Q2_PRECISION[q2s.precision].label, applied: D.Q2_PRECISION[q2result.q2Precision].label });
    const P = result ? result.params : null;
    if (P && q2result.params && (P.lambda_nm !== q2result.params.lambda_nm || P.L_cm !== q2result.params.L_cm))
      out.push({ key: 'params', label: 'λ,L', edit: P.lambda_nm + ' nm, ' + P.L_cm + ' cm', applied: q2result.params.lambda_nm + ' nm, ' + q2result.params.L_cm + ' cm' });
    return out;
  }
  function q2Stale() { return !q2result || q2PendingEdits().length > 0; }
  function setQ2Progress(f) { const el = $('q2progBar'); if (el) el.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; }

  /* 第二问请求：一个“请求组” = 预览（约 0.5 s，粗采样，明确标注）+ 所选精度（约 2 s）。
   * 新请求先“取代”旧组（终止 q2 线程），所以连点几个情形只算最后一个。q2s.precision = 'preview' 时只有预览。 */
  var q2Group = 0;
  function sameQ2Physics(R) {
    if (!R || !result) return false;
    return R.params && R.params.lambda_nm === result.params.lambda_nm && R.params.L_cm === result.params.L_cm
      && Math.abs(R.a - SI_MM(state.r_mm)) < 1e-12
      && (R.q2Precision || (R.prec && R.prec.key)) === q2s.precision
      && R.quality !== 'preview';
  }
  /* 圆孔与圆屏是同一次 FFT 的两个视角。参数没变时直接换图，不再卷积。 */
  function reuseComplement(caseKey) {
    if (caseKey !== 'inphase' && caseKey !== 'disk') return false;
    if (!sameQ2Physics(q2result)) return false;
    if (q2result.caseKey !== 'inphase' && q2result.caseKey !== 'disk') return false;
    if (q2result.caseKey === caseKey) return false;
    const view = D.q2ComplementView(q2result, caseKey);
    if (!view) return false;
    supersede(engQ2, 'q2');
    const group = ++q2Group;
    q2PreviewJob = null; q2PreviewDirty = false;
    q2s.cancelledNote = ''; q2s.lastError = null;
    q2result = Object.assign({}, view, {
      id: q2result.id, params: q2result.params, resultId: result.id,
      q2Precision: q2result.q2Precision || q2s.precision, quality: 'precise', group, ms: 0
    });
    recordQ2Imax(q2result);
    probeDirect = null;
    setQ2Progress(1);
    renderQ2All();
    requestProbe(0);
    return true;
  }
  function requestQ2(quality, opt) {
    opt = opt || {};
    if (!result) { q2s.cancelledNote = '请先完成第一问，以确定 λ、L 与半径。'; renderQ2Status(); return; }
    if (quality !== 'preview' && reuseComplement(q2s.caseKey)) return null;
    q2s.cancelledNote = ''; q2s.lastError = null;
    supersede(engQ2, 'q2');
    const group = ++q2Group;
    const base = {
      a: SI_MM(state.r_mm), halfWidth: D.toSI(D.PRESET.q2HalfWidth_mm, 'mm'),
      caseKey: q2s.caseKey, seed: q2s.seed >>> 0, cellSize: D.toSI(q2s.cellSize_um, 'um'), randomMode: q2s.randomMode,
      resultId: result.id
    };
    const so = { params: result.params, precision: result.precision, group };
    const onlyPreview = quality === 'preview' || q2s.precision === 'preview';
    /* 逐点独立：粗网格是另一套相位，不能先闪一张预览再换成精确图。 */
    const independent = base.caseKey === 'random' && base.randomMode !== 'cell';
    let id;
    if (independent) {
      const tier = onlyPreview ? 'preview' : q2s.precision;
      const qual = onlyPreview ? 'preview' : 'final';
      if (onlyPreview) q2PreviewJob = id = submit('q2', Object.assign({ q2Precision: tier }, base), qual, engQ2, so);
      else id = submit('q2', Object.assign({ q2Precision: tier }, base), qual, engQ2, so);
    } else {
      if (onlyPreview || opt.progressive !== false) {
        q2PreviewJob = id = submit('q2', Object.assign({ q2Precision: 'preview' }, base), 'preview', engQ2, so);
      }
      if (!onlyPreview) id = submit('q2', Object.assign({ q2Precision: q2s.precision }, base), 'final', engQ2, so);
    }
    q2PreviewDirty = false;
    setQ2Progress(0);
    renderQ2Pending(); renderQ2Status(); renderQ2Maps();
    return id;
  }
  function maybeStartQ2() {
    if (!result || result.quality === 'preview') { renderQ2All(); return; }
    if (!q2result) { requestQ2(q2s.precision === 'preview' ? 'preview' : 'final'); return; }
    if (q2Stale()) renderQ2Pending();
    renderQ2All();
  }
  function cancelQ2(note) {
    const ids = engQ2.cancel();
    ids.forEach((id) => { if (jobs[id]) endJob(id, 'cancelled'); });
    for (const k of Object.keys(jobs)) if (jobs[k].engine === engQ2) endJob(+k, 'cancelled');
    latest.q2 = ++seq; q2Group++; q2PreviewJob = null; q2PreviewDirty = false;
    q2s.cancelledNote = note || ('已取消；显示的是上一次完成的图样' + (q2result ? '（任务 #' + q2result.id + '）' : ''));
    renderQ2Status(); renderQ2Pending();
  }
  function acceptQ2(m, j) {
    const group = j ? j.group : null, quality = j ? j.quality : m.quality;
    // 同组的精确结果已经显示时，迟到的预览不允许覆盖它
    if (quality === 'preview' && q2result && q2result.group === group && q2result.quality !== 'preview') { staleDropped++; return; }
    q2result = Object.assign({ id: m.id, ms: j ? Math.round(performance.now() - j.t0) : (m.timing && m.timing.ms), quality, group }, m);
    q2s.lastError = null;
    recordQ2Imax(q2result);
    if (q2View.resultKey !== q2ViewKey(q2result)) q2ResetView(false);   // 参数 / 半径变了才复位视图；同一套参数换情形保持缩放
    probeDirect = null;
    const busy = Object.values(jobs).some((x) => x.type === 'q2');
    setQ2Progress(busy ? 0.5 : 1);
    renderQ2All();
    if (quality !== 'preview') requestProbe(0);
  }
  /* ---------- 第二问探针：网格插值（即时）+ 直接积分（停顿后，后台） ---------- */
  var probeDirect = null;
  function requestProbe(delay) {
    clearTimeout(requestProbe.t);
    requestProbe.t = setTimeout(() => {
      if (!q2result || q2result.quality === 'preview') return;
      const P = D.Q2_PRECISION[q2result.q2Precision] || D.Q2_PRECISION.standard;
      supersede(engProbe, 'probe');
      submit('probe', {
        xp: D.toSI(q2s.probeX_mm, 'mm'), yp: D.toSI(q2s.probeY_mm, 'mm'), a: q2result.a, d: q2result.samp.dSrc, n: q2result.samp.Nfft,
        gl: D.glForPath(P.pathFrac), caseKey: q2result.caseKey, seed: q2result.seed >>> 0, cellSize: q2result.cellSize,
        randomMode: q2result.randomMode, edgeSub: P.edgeSub, resultId: q2result.id
      }, 'final', engProbe, { params: q2result.params, precision: result ? result.precision : 'standard' });
      renderQ2Metrics();
    }, delay == null ? 180 : delay);
  }
  function acceptProbe(m) {
    if (!q2result || m.resultId !== q2result.id) { staleDropped++; return; }
    if (Math.abs(m.xp - D.toSI(q2s.probeX_mm, 'mm')) > 1e-12 || Math.abs(m.yp - D.toSI(q2s.probeY_mm, 'mm')) > 1e-12) { staleDropped++; return; }
    probeDirect = m;
    renderQ2Metrics(); renderQ2Maps(true);
  }

  function applyQ2Inputs() {
    document.querySelectorAll('#q2caseSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === q2s.caseKey));
    document.querySelectorAll('#q2precSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === q2s.precision));
    document.querySelectorAll('#q2scaleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === q2s.scale));
    document.querySelectorAll('#q2normSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === q2s.norm));
    if ($('q2seed')) { $('q2seed').value = q2s.seed >>> 0; $('q2seedOut').textContent = String(q2s.seed >>> 0); }
    if ($('q2cell')) {
      $('q2cell').value = q2s.cellSize_um; $('q2cellOut').textContent = q2s.cellSize_um + ' μm';
      $('q2cell').disabled = q2s.randomMode !== 'cell';
    }
    document.querySelectorAll('#q2randMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === q2s.randomMode));
    if ($('q2randHint')) $('q2randHint').textContent = q2s.randomMode === 'cell'
      ? '固定单元格：相位画在物理格子上，加密网格只是把同一块状场采样得更密，不重抽随机数。'
      : '逐点独立（题目）：每个源采样点相位独立，δ 等于源间距。网格一变结果就变，没有连续极限；可比的是平均光强 ≈ N·(δ²/λL)²。';
    $('q2randomBox').hidden = q2s.caseKey !== 'random';
    $('q2px').value = q2s.probeX_mm; $('q2py').value = q2s.probeY_mm;
    const pr = D.Q2_PRECISION[q2s.precision];
    $('q2precHint').textContent = pr.label + '（源采样光程+倾斜 ≤ λ/' + pr.pathFrac + '，观察 ' + pr.nObs + '×' + pr.nObs + '，FFT 上限 ' + pr.fftCap + '）';
    renderQ2Lock();
  }
  function renderQ2Lock() {
    if (!$('btnLock4Q2')) return;
    $('btnLock4Q2').classList.toggle('locked', state.locked);
    $('btnLock4Q2').disabled = !(result && result.fourth);
    $('btnLock4Q2').textContent = state.locked ? '已锁定第 4 个极大 · 点击解锁' : '锁定第 4 个极大半径';
    const r = state.r_mm;
    $('q2rOut').textContent = r.toFixed(6) + ' mm';
    if (document.activeElement !== $('q2rInput')) $('q2rInput').value = r.toFixed(7);
    $('q2rInput').disabled = !!state.locked;
    let info = '';
    if (result && result.fourth) {
      const r4 = MM(result.fourth.r);
      const same = Math.abs(r - r4) < 1e-9;
      info = same ? ('当前 r 等于第 4 极大 <b>' + sig7(r4) + ' mm</b>。')
        : ('当前 r = ' + r.toFixed(7) + ' mm，<span class="warntxt">不是第 4 极大 r₄ = ' + sig7(r4) + ' mm</span>。二维图样使用的是已完成计算的半径。');
      info += '<br><span class="dim">' + R4_ERR + '</span>';
    } else info = '当前尚未求得第 4 极大，无法锁定。';
    if (state.locked) info = '已锁定第 4 极大。' + info;
    $('q2lockInfo').innerHTML = info;
    $('q2rHint').textContent = state.locked
      ? '半径已锁定为第 4 个轴上极大。解锁后可改 r，须点「应用并计算」才会重算二维图。'
      : '未锁定。改 r 后请点「应用并计算」；图样始终对应已完成的那一套参数。';
  }
  function renderQ2Status() {
    if (!$('q2qBadge')) return;
    const busy = Object.values(jobs).some((p) => p.type === 'q2');
    const q = q2result ? (q2result.quality === 'preview' ? 'preview' : 'precise') : (busy ? 'busy' : '');
    const badge = $('q2qBadge');
    badge.className = 'qbadge' + (q2s.lastError ? ' error' : q ? ' ' + (q === 'precise' ? 'precise' : q) : '');
    const busyQ = busy && Object.values(jobs).filter((p) => p.type === 'q2').map((p) => p.quality);
    badge.textContent = q2s.lastError ? '失败' : busy ? (busyQ.includes('preview') ? '预览计算中' : '精确计算中') : (q === 'precise' ? '精确' : q === 'preview' ? '预览' : '—');
    let tag = '尚未计算二维图样';
    if (q2result) {
      const P = q2result.params, c = D.Q2_CASES[q2result.caseKey];
      tag = '已完成 #' + q2result.id + ' · ' + c.label + ' · r = ' + D.fromSI(q2result.a, 'mm').toFixed(6) + ' mm · λ = ' + P.lambda_nm + ' nm · L = ' + P.L_cm + ' cm · ' + D.Q2_PRECISION[q2result.q2Precision].label;
      if (q2result.caseKey === 'random') tag += ' · 种子 ' + (q2result.seed >>> 0) + (q2result.randomMode === 'cell' ? ' · 固定格' : ' · 逐点');
      if (q2result.samp && q2result.samp.belowTarget) tag += ' · 采样粗于目标 λ/' + q2result.samp.pathFracActual.toFixed(1);
      tag += (q2result.quality === 'preview' ? ' · 预览' : ' · 精确');
      if (q2result.ms != null) tag += ' · ' + q2result.ms + ' ms';
    }
    $('q2sTag').textContent = tag;
    const indep = q2s.caseKey === 'random' && q2s.randomMode !== 'cell';
    const busyText = busyQ && busyQ.includes('preview') ? '先算粗采样预览（约 0.5 s），随后精算…' : (indep ? '逐点独立：不先出粗预览（粗网格是另一幅散斑），正在计算所选精度…' : '精确积分中…（可取消）');
    $('q2sText').textContent = q2s.lastError || q2s.cancelledNote || (busy ? busyText : (q2result ? '就绪' : '等待计算')) + (supersededCount ? ' · 已取代旧任务 ' + supersededCount + ' 个' : '');
    $('q2btnCancel').disabled = !busy;
    const cap = $('q2capBadge');
    if (cap) {
      const s = q2result && q2result.samp;
      const on = !!(s && s.belowTarget);
      cap.hidden = !on;
      if (on) {
        cap.textContent = '粗于目标 · 实际约 λ/' + s.pathFracActual.toFixed(1);
        cap.title = '目标是 λ/' + s.pathFrac + '。按规划口径 pathFrac × d计划/d 折算后，源间距被放宽，实际约为 λ/' + s.pathFracActual.toFixed(1) + '。填充因子 ' + (s.padActual ? s.padActual.toFixed(3) : '—') + '。';
      }
    }
  }
  function renderQ2Pending() {
    const bar = $('q2pendingBar'); if (!bar) return;
    const pe = q2PendingEdits();
    const busy = Object.values(jobs).some((p) => p.type === 'q2');
    if (!pe.length && !busy) { bar.hidden = true; return; }
    bar.hidden = false;
    if (!pe.length && busy) $('q2pendingText').innerHTML = '<span class="pend-state busy">计算中</span>正在按当前参数计算二维图样…';
    else $('q2pendingText').innerHTML = '<span class="pend-state' + (busy ? ' busy' : '') + '">' + (busy ? '未应用 / 计算中' : '未应用的编辑') + '</span>图样仍对应已完成的参数；编辑：' + pe.map((e) => e.label + ' ' + e.edit + '（已完成 ' + e.applied + '）').join('；') + '。';
  }
  /* ======================= 第二问：色标上限（本图各自 / 共享 / 固定 4） =======================
   * 共享：同一 λ、L、r 下“已算过”的各情形图样（含圆屏情形附带的圆孔图）取共同上限，并在色标旁列出参与的情形。
   *       以前“共享”只在情形 4 与对照图之间生效，情形 1–3 下与“本图各自”完全相同（控件只有外观）。
   * 对照卡（圆孔 vs 圆屏）始终共用一个色标（固定 4 时用 4），并配色条、标出两图 O′ 处的值。 */
  var Q2SHORT = { inphase: '同相圆孔', random: '随机相位', linear: '线性 8π', disk: '圆屏' };
  var q2ImaxCache = new Map();
  var q2ParamKey = (R) => [R.params.lambda_nm, R.params.L_cm, Number(R.a).toPrecision(12), (R.seed >>> 0), Number(R.cellSize).toPrecision(8), R.randomMode || ''].join('|');
  function recordQ2Imax(R) {
    if (!R || !R.map) return;
    const k = q2ParamKey(R); let e = q2ImaxCache.get(k); if (!e) q2ImaxCache.set(k, e = {});
    const put = (ck, v) => { const o = e[ck]; if (!o || o.quality === 'preview' || R.quality !== 'preview') e[ck] = { Imax: v, quality: R.quality, id: R.id }; };
    put(R.caseKey, R.map.Imax);
    if (R.mapHole) put('inphase', R.mapHole.Imax);
    if (R.mapDisk) put('disk', R.mapDisk.Imax);
  }
  function q2Domain(map, which) {
    if (!map || !q2result) return { Imax: 1, text: '' };
    if (q2s.norm === 'fixed4') return { Imax: 4, text: '固定上限 I/I_inc = 4（四种情形与对照图同一刻度）' };
    if (which === 'cmp' && q2result.mapHole && q2result.mapDisk) {
      const m = Math.max(q2result.mapHole.Imax, q2result.mapDisk.Imax, 1e-12);
      return { Imax: m, text: '对照共享上限 ' + m.toFixed(3) + '（圆孔 I_max ' + q2result.mapHole.Imax.toFixed(3) + '、圆屏 I_max ' + q2result.mapDisk.Imax.toFixed(3) + '）' };
    }
    if (q2s.norm === 'shared') {
      const e = q2ImaxCache.get(q2ParamKey(q2result)) || {};
      let m = map.Imax; const parts = [];
      for (const ck of Object.keys(Q2SHORT)) if (e[ck]) { parts.push(Q2SHORT[ck] + ' ' + e[ck].Imax.toFixed(3)); m = Math.max(m, e[ck].Imax); }
      return { Imax: Math.max(m, 1e-12), text: '共享上限 ' + m.toFixed(3) + '（同一 λ、L、r 下已算情形：' + parts.join('、') + (parts.length < 4 ? '；其余情形算完后自动并入' : '') + '）' };
    }
    return { Imax: Math.max(map.Imax, 1e-12), text: '本图各自上限 ' + map.Imax.toFixed(3) + '（只看形状，亮度不能与其他情形比较）' };
  }
  /* 随机图最亮相对同相圆孔的倍数。同相 Imax 优先用同一套参数下已经算过的图，否则用轴上极大的 4。 */
  function randomBrightNote(R) {
    if (!R || R.caseKey !== 'random' || !R.map) return '';
    const e = q2ImaxCache.get(q2ParamKey(R)) || {};
    const Iref = (e.inphase && e.inphase.Imax > 0) ? e.inphase.Imax : 4;
    const ratio = R.map.Imax / Iref;
    const inv = ratio > 1e-12 ? 1 / ratio : Infinity;
    const invTxt = inv >= 10 ? inv.toFixed(0) : inv.toFixed(1);
    let s = '最亮约为同相圆孔的 1/' + invTxt + '（I_max ' + R.map.Imax.toFixed(4) + ' / ' + Iref.toFixed(2) + '）';
    if (q2s.norm !== 'per') s += '。共享或固定色标下这张图会很暗，请用「本图各自」';
    return s;
  }
  function q2ImaxFor(map) { return q2Domain(map, 'main').Imax; }
  function q2NormLabel(map, which) {
    const dm = q2Domain(map, which);
    if (q2s.scale === 'log') return '对数色标 log₁₀(I/I_inc)，范围 [' + q2s.logFloor.toExponential(0) + ', ' + dm.Imax.toFixed(3) + ']（相差 ' + Math.log10(dm.Imax / q2s.logFloor).toFixed(1) + ' 个数量级）· ' + dm.text;
    return '线性色标 I/I_inc ∈ [0, ' + dm.Imax.toFixed(3) + '] · ' + dm.text;
  }
  var TURBO = (() => {
    const stops = [[0, 7, 18, 36], [0.17, 27, 16, 91], [0.33, 86, 23, 104], [0.5, 187, 55, 84], [0.67, 249, 142, 48], [0.83, 252, 223, 104], [1, 252, 254, 228]];
    const lut = new Uint8ClampedArray(1024 * 3);
    for (let n = 0; n < 1024; n++) {
      const t = n / 1023; let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      const a = stops[i], b = stops[i + 1], u = (t - a[0]) / (b[0] - a[0] || 1);
      for (let c = 0; c < 3; c++) lut[n * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
    }
    return lut;
  })();
  function turboColor(t) { const n = Math.round(Math.max(0, Math.min(1, t)) * 1023) * 3; return [TURBO[n], TURBO[n + 1], TURBO[n + 2]]; }
  function scaleI(I, Imax) {
    if (q2s.scale === 'log') {
      const lo = Math.log10(q2s.logFloor), hi = Math.log10(Math.max(Imax, q2s.logFloor * 10));
      return (Math.log10(Math.max(I, q2s.logFloor)) - lo) / (hi - lo);
    }
    return I / Imax;
  }
  function interpMapVal(map, xp, yp, field) {
    const n = map.nObs, W = map.halfWidth, d = map.dObs;
    if (!(d > 0) || !(n > 1)) return map && map[field] ? map[field][0] : 0;
    /* 夹到实际网格。请求的 ±2.5 mm 落在网格内时读到插值，而不是越界 0。 */
    const x = Math.max(-W, Math.min(W, xp)), y = Math.max(-W, Math.min(W, yp));
    const i = Math.max(0, Math.min(n - 1, (x + W) / d)), j = Math.max(0, Math.min(n - 1, (y + W) / d));
    return D.bilinearSample(map[field], n, i, j);
  }
  function prepCv(cv) { return prepCanvas2d(cv, { min: 50 }); }

  /* ======================= 第二问：二维图视图（缩放 / 平移 / 探针） =======================
   * 修复“二维图被拉伸”：以前图样铺满 625×480 的画布，X′、Y′ 比例不同，圆环被画成椭圆。现在图样画在正方形视口里，
   * 两轴同一 mm/像素，并带 mm 刻度。缩放与平移只改变显示窗口（限制在已计算的 5 mm × 5 mm 内，不外推），
   * 像素值是落在 FFT 节点上的光强网格的双线性显示，不是新的积分；探针的精确值另由直接积分给出。 */
  var q2View = { cx: 0, cy: 0, half: null, resultKey: '' };
  var q2ViewKey = (R) => (R && R.map ? q2ParamKey(R) + '|' + R.map.nObs + '|' + R.map.dObs : '');
  var q2Half = () => (q2result ? q2result.map.halfWidth : D.toSI(D.PRESET.q2HalfWidth_mm, 'mm'));
  var clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function q2ClampView() {
    const W = q2Half(), hmin = q2result ? 6 * q2result.map.dObs : W / 20;
    q2View.half = clampv(q2View.half || W, hmin, W);
    const lim = W - q2View.half; q2View.cx = clampv(q2View.cx, -lim, lim); q2View.cy = clampv(q2View.cy, -lim, lim);
  }
  function q2ResetView(draw) { q2View.cx = 0; q2View.cy = 0; q2View.half = q2Half(); q2View.resultKey = q2ViewKey(q2result); if (draw !== false) { renderQ2Maps(true); renderQ2Cuts(); } }
  function q2Zoom(f, xp, yp) {
    if (!q2result) return;
    if (!q2View.half) q2View.half = q2Half();
    const h0 = q2View.half; q2View.half = h0 * f; q2ClampView();
    const k = q2View.half / h0;
    if (xp != null) { q2View.cx = xp + (q2View.cx - xp) * k; q2View.cy = yp + (q2View.cy - yp) * k; }
    q2ClampView(); renderQ2Maps(true); renderQ2Cuts();
  }
  var q2Zoomed = () => !!(q2result && q2View.half && q2View.half < q2Half() * (1 - 1e-9));
  function mapVP(W, H, axes) {
    const ml = axes ? 46 : 4, mb = axes ? 32 : 4, mt = 6, mr = 8;
    const S = Math.max(40, Math.floor(Math.min(W - ml - mr, H - mt - mb)));
    return { x: ml + Math.floor((W - ml - mr - S) / 2), y: mt + Math.floor((H - mt - mb - S) / 2), S };
  }
  function vpToXY(vp, px, py, v) { const u = (px - vp.x) / vp.S, w = (py - vp.y) / vp.S; return { yp: v.cy + v.half * (1 - 2 * u), xp: v.cx + v.half * (1 - 2 * w) }; }
  function xyToVP(vp, xp, yp, v) { return { x: vp.x + (1 - (yp - v.cy) / v.half) * 0.5 * vp.S, y: vp.y + (1 - (xp - v.cx) / v.half) * 0.5 * vp.S }; }
  var q2bmp = {};
  function mapBitmap(slot, map, v, Sd, Imax) {
    const key = [v.cx, v.cy, v.half, Sd, Imax, q2s.scale, q2s.logFloor].join('|');
    const c = q2bmp[slot];
    if (c && c.map === map && c.key === key) return c.cv;
    const cv = (c && c.cv && c.cv.width === Sd) ? c.cv : document.createElement('canvas');
    cv.width = Sd; cv.height = Sd;
    const ictx = cv.getContext('2d'), img = ictx.createImageData(Sd, Sd), data = img.data;
    const n = map.nObs, W = map.halfWidth, d = map.dObs, I = map.I;
    const log = q2s.scale === 'log', lo = Math.log10(q2s.logFloor), hi = Math.log10(Math.max(Imax, q2s.logFloor * 10));
    for (let y = 0; y < Sd; y++) {
      const xp = v.cx + v.half * (1 - 2 * (y + 0.5) / Sd), fi = (xp + W) / d;
      for (let x = 0; x < Sd; x++) {
        const yp = v.cy + v.half * (1 - 2 * (x + 0.5) / Sd), fj = (yp + W) / d;
        const val = D.bilinearSample(I, n, Math.max(0, Math.min(n - 1, fi)), Math.max(0, Math.min(n - 1, fj)));
        let t = log ? (Math.log10(Math.max(val, q2s.logFloor)) - lo) / (hi - lo) : val / Imax;
        const q = Math.round(Math.max(0, Math.min(1, t)) * 1023) * 3, k = (y * Sd + x) * 4;
        data[k] = TURBO[q]; data[k + 1] = TURBO[q + 1]; data[k + 2] = TURBO[q + 2]; data[k + 3] = 255;
      }
    }
    ictx.putImageData(img, 0, 0);
    q2bmp[slot] = { map, key, cv };
    return cv;
  }
  var niceStepMM = (span, target) => window.niceStep(span, target);
  /* 在 ctx（CSS 像素坐标）上画一张二维光强图：正方形视口 + mm 刻度 + 叠加标记。返回视口。 */
  function paintMap(ctx, W, H, dpr, map, opt) {
    opt = opt || {};
    const v = opt.view || { cx: 0, cy: 0, half: map ? map.halfWidth : 1 };
    const vp = mapVP(W, H, opt.axes !== false);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    if (!map) { ctx.fillStyle = '#93aac2'; ctx.font = '13px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.fillText(opt.empty || '等待计算…', 16, 28); return vp; }
    const Sd = Math.max(16, Math.round(vp.S * dpr));
    const bmp = mapBitmap(opt.slot || 'main', map, v, Sd, opt.Imax);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(bmp, vp.x, vp.y, vp.S, vp.S); ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = '#3a526d'; ctx.lineWidth = 1; ctx.strokeRect(vp.x - 0.5, vp.y - 0.5, vp.S + 1, vp.S + 1);
    const mm = (m) => m * 1e3;
    if (opt.axes !== false) {   // 刻度：左 X′（向上增大），下 Y′（向左增大）
      const step = niceStepMM(mm(2 * v.half), Math.max(3, vp.S / 70)) / 1e3;
      ctx.fillStyle = '#93aac2'; ctx.font = '10.5px Consolas,monospace'; ctx.strokeStyle = '#3a526d';
      const dec = Math.max(0, -Math.floor(Math.log10(step * 1e3) + 1e-9));
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let t = Math.ceil((v.cx - v.half) / step) * step; t <= v.cx + v.half + step * 1e-6; t += step) {
        const y = xyToVP(vp, t, v.cy, v).y; ctx.beginPath(); ctx.moveTo(vp.x - 4, y); ctx.lineTo(vp.x, y); ctx.stroke();
        ctx.fillText((Math.abs(t) < step * 1e-6 ? 0 : mm(t)).toFixed(dec), vp.x - 6, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let t = Math.ceil((v.cy - v.half) / step) * step; t <= v.cy + v.half + step * 1e-6; t += step) {
        const x = xyToVP(vp, v.cx, t, v).x; ctx.beginPath(); ctx.moveTo(x, vp.y + vp.S); ctx.lineTo(x, vp.y + vp.S + 4); ctx.stroke();
        ctx.fillText((Math.abs(t) < step * 1e-6 ? 0 : mm(t)).toFixed(dec), x, vp.y + vp.S + 6);
      }
      ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textBaseline = 'bottom';
      ctx.fillText('Y′ (mm)，+Y′ 向左', vp.x + vp.S / 2, H - 1);
      ctx.save(); ctx.translate(11, vp.y + vp.S / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('X′ (mm)，+X′ 向上', 0, 0); ctx.restore();
    }
    ctx.save(); ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.S, vp.S); ctx.clip();
    const o = xyToVP(vp, 0, 0, v);
    ctx.strokeStyle = 'rgba(234,244,255,0.32)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(vp.x, o.y); ctx.lineTo(vp.x + vp.S, o.y); ctx.moveTo(o.x, vp.y); ctx.lineTo(o.x, vp.y + vp.S); ctx.stroke();
    ctx.fillStyle = '#cfe2f2'; ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('O′', o.x + 5, o.y - 6);
    if (opt.shiftX) {
      const s = xyToVP(vp, opt.shiftX, 0, v);
      ctx.strokeStyle = '#ffc074'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(vp.x, s.y); ctx.lineTo(vp.x + vp.S, s.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffc074'; ctx.fillText('预计 +X′ 偏移', vp.x + 6, Math.max(vp.y + 14, s.y - 6));
    }
    if (opt.probe) {
      const q = xyToVP(vp, opt.probe.xp, opt.probe.yp, v);
      ctx.strokeStyle = '#07111c'; ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(q.x - 11, q.y); ctx.lineTo(q.x + 11, q.y); ctx.moveTo(q.x, q.y - 11); ctx.lineTo(q.x, q.y + 11); ctx.stroke();
      ctx.strokeStyle = '#57dbe8'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(q.x - 11, q.y); ctx.lineTo(q.x + 11, q.y); ctx.moveTo(q.x, q.y - 11); ctx.lineTo(q.x, q.y + 11); ctx.stroke();
      ctx.beginPath(); ctx.arc(q.x, q.y, 5.5, 0, 6.283); ctx.stroke(); ctx.lineWidth = 1;
    }
    if (opt.hover) {
      const h = opt.hover, xy = vpToXY(vp, h.px, h.py, v);
      if (h.px >= vp.x && h.px <= vp.x + vp.S && h.py >= vp.y && h.py <= vp.y + vp.S) {
        const lines = ['X′ = ' + mm(xy.xp).toFixed(4) + ' mm', 'Y′ = ' + mm(xy.yp).toFixed(4) + ' mm', 'I/I_inc = ' + interpMapVal(map, xy.xp, xy.yp, 'I').toFixed(5) + '（网格插值）', '点击：设探针'];
        ctx.font = '11px Consolas,"Microsoft YaHei",monospace';
        const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, hh = lines.length * 15 + 8;
        let bx = h.px + 14, by = h.py + 12; if (bx + w > vp.x + vp.S) bx = h.px - 14 - w; if (by + hh > vp.y + vp.S) by = h.py - 12 - hh;
        ctx.fillStyle = 'rgba(16,27,44,.92)'; ctx.strokeStyle = '#33586d'; ctx.fillRect(bx, by, w, hh); ctx.strokeRect(bx, by, w, hh);
        ctx.fillStyle = '#eaf4ff'; ctx.textBaseline = 'top'; lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 5 + i * 15));
      }
    }
    // 角标：放大倍数 / 预览 / 未应用
    ctx.textBaseline = 'top'; ctx.font = '600 11px "Microsoft YaHei",sans-serif';
    let ty = vp.y + 6;
    (opt.badges || []).forEach((b) => {
      const w = ctx.measureText(b.text).width + 12;
      ctx.fillStyle = 'rgba(7,13,24,.78)'; ctx.fillRect(vp.x + vp.S - w - 6, ty, w, 18);
      ctx.fillStyle = b.color || '#ffc074'; ctx.textAlign = 'left'; ctx.fillText(b.text, vp.x + vp.S - w, ty + 3); ty += 21;
    });
    ctx.restore();
    return vp;
  }
  function drawIntensityMap(cv, map, opt) { const { ctx, W, H, dpr } = prepCv(cv); const vp = paintMap(ctx, W, H, dpr, map, opt); cv.__vp = vp; return vp; }
  /* 色条：刻度 + 标记（O′、探针等，带数值），对数时标出每个数量级 */
  function drawColorBar(cv, Imax, marks, title) {
    const { ctx, W, H } = prepCv(cv);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    const nm = (marks || []).length, padT = 26, padB = 14 + 12 * nm, bh = Math.max(40, H - padT - padB), bx = 10, bw = 14;
    for (let y = 0; y < bh; y++) { const c = turboColor(1 - y / Math.max(1, bh - 1)); ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; ctx.fillRect(bx, padT + y, bw, 1.5); }
    ctx.strokeStyle = '#3a526d'; ctx.strokeRect(bx + 0.5, padT + 0.5, bw, bh);
    const yOf = (v) => padT + (1 - Math.max(0, Math.min(1, scaleI(v, Imax)))) * bh;
    ctx.fillStyle = '#eaf4ff'; ctx.font = '10px Consolas,"Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let ticks;
    if (q2s.scale === 'log') { ticks = []; for (let e = Math.ceil(Math.log10(q2s.logFloor)); Math.pow(10, e) <= Imax * 1.0001; e++) ticks.push(Math.pow(10, e)); }
    else { const st = niceStepMM(Imax, 4); ticks = []; for (let t = 0; t <= Imax * (1 + 1e-9); t += st) ticks.push(t); }
    ticks.forEach((v) => { const y = yOf(v); ctx.fillRect(bx + bw, y - 0.5, 3, 1); ctx.fillText(v === 0 ? '0' : v >= 0.01 ? (v >= 10 ? v.toFixed(0) : v.toFixed(2)) : v.toExponential(0), bx + bw + 5, y); });
    ctx.fillStyle = '#ffd9a8'; ctx.fillText('上限 ' + Imax.toFixed(3), 2, 10);
    (marks || []).forEach((m) => {
      const y = yOf(m.I); ctx.fillStyle = m.color || '#57dbe8';
      ctx.beginPath(); ctx.moveTo(bx - 1, y); ctx.lineTo(bx - 7, y - 4); ctx.lineTo(bx - 7, y + 4); ctx.closePath(); ctx.fill();
    });
    // 标记的文字放在色条下方（避免与刻度重叠）
    ctx.textBaseline = 'top'; ctx.font = '10px "Microsoft YaHei",sans-serif';
    (marks || []).forEach((m, i) => { ctx.fillStyle = m.color || '#57dbe8'; ctx.fillText('◀ ' + m.label + ' ' + (m.I >= 0.01 ? m.I.toFixed(3) : m.I.toExponential(1)), 2, padT + bh + 4 + i * 12); });
    ctx.save(); ctx.fillStyle = '#93aac2'; ctx.font = '10px "Microsoft YaHei",sans-serif';
    ctx.translate(W - 6, padT + bh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(title || (q2s.scale === 'log' ? 'log₁₀(I/I_inc)' : 'I/I_inc（线性）'), 0, 0); ctx.restore();
  }
  function phaseColor(hue, amp) {
    const a = 0.25 + 0.75 * amp, h = hue * 6, i = Math.floor(h), f = h - i, q = 1 - f, t = f;
    let r, g, b;
    switch (i % 6) {
      case 0: r = 1; g = t; b = 0; break; case 1: r = q; g = 1; b = 0; break;
      case 2: r = 0; g = 1; b = t; break; case 3: r = 0; g = q; b = 1; break;
      case 4: r = t; g = 0; b = 1; break; default: r = 1; g = 0; b = q;
    }
    return [255 * r * a, 255 * g * a, 255 * b * a];
  }
  function drawAperture(cv, ap) {
    const { ctx, W, H, dpr } = prepCv(cv);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    if (!ap) return;
    const S = Math.min(W, H) - 24, ox = (W - S) / 2, oy = (H - S) / 2;
    const half = ap.half, n = ap.n;
    const sw = Math.round(S * dpr), sh = sw;
    const img = ctx.createImageData(sw, sh), data = img.data;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const Y = half * (1 - 2 * (x / dpr) / Math.max(1, S - 1));
      const X = half * (1 - 2 * (y / dpr) / Math.max(1, S - 1));
      const i0 = Math.max(0, Math.min(n - 1, Math.round((X + half) / ap.d)));
      const j0 = Math.max(0, Math.min(n - 1, Math.round((Y + half) / ap.d)));
      const k0 = j0 * n + i0, amp = ap.amp[k0], phs = ap.phase[k0], kk = (y * sw + x) * 4;
      if (amp <= 0) { data[kk] = 8; data[kk + 1] = 12; data[kk + 2] = 20; data[kk + 3] = 255; continue; }
      const hue = ((phs % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      const c = phaseColor(hue, amp);
      data[kk] = c[0]; data[kk + 1] = c[1]; data[kk + 2] = c[2]; data[kk + 3] = 255;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, Math.round(ox * dpr), Math.round(oy * dpr));
    ctx.restore();
    ctx.strokeStyle = '#3a526d'; ctx.strokeRect(ox, oy, S, S);
    ctx.fillStyle = '#93aac2'; ctx.font = '11px "Microsoft YaHei",sans-serif';
    ctx.fillText('+X', ox + 6, oy + 14); ctx.fillText('+Y', ox + 6, oy + 28);
  }
  function probeI() {
    if (!q2result) return null;
    const xp = D.toSI(q2s.probeX_mm, 'mm'), yp = D.toSI(q2s.probeY_mm, 'mm');
    return { xp, yp, I: interpMapVal(q2result.map, xp, yp, 'I'), re: interpMapVal(q2result.map, xp, yp, 're'), im: interpMapVal(q2result.map, xp, yp, 'im') };
  }
  function cutThroughProbe(axis) {
    if (!q2result) return null;
    const map = q2result.map, n = map.nObs, W = map.halfWidth;
    const other = axis === 'x' ? D.toSI(q2s.probeY_mm, 'mm') : D.toSI(q2s.probeX_mm, 'mm');
    if (Math.abs(other) < 1e-12) {
      const src = axis === 'x' ? q2result.cutX : q2result.cutY;
      if (src) return Object.assign({ dense: true }, src);
    }
    const x = new Float64Array(n), I = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = -W + i * map.dObs; x[i] = t;
      I[i] = interpMapVal(map, axis === 'x' ? t : other, axis === 'x' ? other : t, 'I');
    }
    return { x, I, n, axis, other };
  }
  function renderQ2Metrics() {
    if (!$('q2mR')) return;
    const r = q2result ? D.fromSI(q2result.a, 'mm') : state.r_mm;
    $('q2mR').textContent = r.toFixed(6) + ' mm';
    const r4 = result && result.fourth ? MM(result.fourth.r) : null;
    const isR4 = r4 != null && Math.abs(r - r4) < 1e-9;
    $('q2mRs').innerHTML = q2result
      ? (isR4 ? '= 第 4 极大 r₄（任务 #' + q2result.id + ' 已完成）' : '<span class="warntxt">≠ r₄' + (r4 != null ? ' = ' + r4.toFixed(6) + ' mm' : '') + '（已完成 #' + q2result.id + '）</span>') +
        (Math.abs(state.r_mm - r) > 1e-12 ? ' · <span class="warntxt">编辑 r = ' + state.r_mm.toFixed(6) + ' 未应用</span>' : '')
      : '尚未计算';
    if (q2result && q2result.axis && q2result.axis.direct) {
      const d = q2result.axis.direct;
      $('q2mI').textContent = d.I.toFixed(6);
      $('q2mIs').textContent = (q2result.a > 0 && isFinite(q2result.axis.I) ? '直接积分；FFT ' + q2result.axis.I.toFixed(6) : '直接积分；r = 0：孔面积为 0，FFT 不适用（U_孔 ≡ 0）') + (q2result.caseKey === 'disk' ? ' · 孔轴上 ' + d.I_hole.toFixed(4) : '') + (q2result.quality === 'preview' ? ' · 预览档' : '');
    } else { $('q2mI').textContent = '—'; $('q2mIs').textContent = '—'; }
    const pr = probeI();
    if (pr) {
      const pos = 'X′ = ' + q2s.probeX_mm.toFixed(4) + '，Y′ = ' + q2s.probeY_mm.toFixed(4) + ' mm';
      const pd = probeDirect && probeDirect.resultId === q2result.id ? probeDirect : null;
      const pending = Object.values(jobs).some((j) => j.type === 'probe');
      const gridTxt = pr.I.toFixed(5);
      if (pd) {
        $('q2mP').textContent = pd.I.toFixed(6);
        $('q2mPs').innerHTML = '<span class="good">直接积分</span>（网格插值 ' + gridTxt + '，差 ' + (pr.I - pd.I).toExponential(1) + '）<br>' + pos;
      } else {
        $('q2mP').textContent = pr.I.toFixed(6);
        const tag = q2result.quality === 'preview' ? '网格插值（预览档）' : (pending ? '网格插值，直接积分核对中' : '网格插值');
        $('q2mPs').innerHTML = '<span class="warntxt">' + tag + '</span>（直接积分 —，差 —）<br>' + pos;
      }
    } else { $('q2mP').textContent = '—'; $('q2mPs').innerHTML = '点击 / 拖动图样设置探针<br>—'; }
    if ($('q2rBig')) $('q2rBig').textContent = result && result.fourth ? sig7(MM(result.fourth.r)) + ' mm' : '—（极大不足 4 个）';
    $('q2mCase').textContent = D.Q2_CASES[q2s.caseKey].label + (q2s.caseKey === 'random' ? ' · 种子 ' + q2s.seed : '') + (result && result.fourth ? ' · 第一问任务 #' + result.id : '');
  }
  function renderQ2Concept() {
    const b = $('q2cBadge'), h = $('q2cTitle'), p = $('q2cText');
    if (!q2result) { b.textContent = '第二问'; h.textContent = '四种二维图样'; p.textContent = '半径默认锁定在第一问数值求得的第 4 个轴上极大。图样由第一类瑞利–索末菲复振幅积分得到，I = |U|²。打开本页或更改情形后将自动计算。'; return; }
    const C = D.Q2_CASES[q2result.caseKey], q = q2result.quality === 'preview' ? '预览' : '精确';
    b.textContent = '第二问 · ' + q + ' · ' + C.label;
    if (q2result.caseKey === 'inphase') {
      h.textContent = '同相圆孔：轴上是第 4 极大时，屏上是一圈圈的菲涅耳衍射环';
      p.innerHTML = '孔面入射场同相，但到观察屏各点的传播光程不同，干涉后得到围绕 O′ 的环状图样。轴上直接积分 I/I<sub>inc</sub> = <b>' + q2result.axis.direct.I.toFixed(6) + '</b>' + (q2result.axis.direct.I_radial != null ? '（径向一维交叉 ' + q2result.axis.direct.I_radial.toFixed(6) + '）' : '') + '。';
    } else if (q2result.caseKey === 'random') {
      const sp = q2result.axis.direct && q2result.axis.direct.speckle;
      if (q2result.randomMode === 'cell') {
        h.textContent = '固定单元格：加密网格不重抽，只把同一块状场采样得更密';
        p.innerHTML = '单元格 <b>' + D.fromSI(q2result.cellSize, 'um') + ' μm</b>，种子 <b>' + (q2result.seed >>> 0) + '</b>。像素取与各格重叠面积加权的相量，所以边界不再整格归到一侧。这是一次实现，不是时间平均。轴上 I/I<sub>inc</sub> = <b>' + q2result.axis.direct.I.toFixed(6) + '</b>。';
      } else {
        h.textContent = '逐点独立相位：没有连续极限，网格一变物理就变';
        p.innerHTML = '每个源采样点相位独立（δ = 源间距）。结果会随预览 / 标准 / 高精改变，这是模型本身，不是没算收敛。可比的量是平均光强 ≈ N<sub>cell</sub>·(δ²/λL)²' + (sp ? ' = <b>' + sp.Icenter.toExponential(2) + '</b>，本图平均 ' + sp.mapMean.toExponential(2) + '（约为中心理论的 ' + sp.ratio.toFixed(2) + '，也约为同相相干峰的 1/N）' : '') + '。种子 <b>' + (q2result.seed >>> 0) + '</b>。这是一次实现，不是时间平均。';
      }
    } else if (q2result.caseKey === 'linear') {
      const s = q2result.shiftMeas, pred = D.fromSI(q2result.tilt.shiftOnScreen, 'mm');
      h.textContent = '线性相位 8π：图样朝 +X′（向上）平移，并不等于同相情形';
      p.innerHTML = '孔顶相对孔底延迟 8π，等效倾斜波使图样移向相位延迟端 <b>+X′</b>。几何预计 ΔX′ = <b>' + pred.toFixed(4) + ' mm</b>；数值峰值在 X′ = <b>' + (s ? D.fromSI(s.peakX, 'mm').toFixed(4) : '—') + ' mm</b>，I ≈ ' + (s ? s.peakI.toFixed(3) : '—') + '。两端相位模 2π 相同，但连续梯度是真实的光程差。';
    } else {
      h.textContent = '不透明圆屏：阴影中心的泊松亮斑（巴比涅：复振幅相减）';
      const d = q2result.axis.direct;
      p.innerHTML = 'U′<sub>disk</sub> = 1 − U′<sub>hole</sub>，I = |U|²。轴上圆屏 I/I<sub>inc</sub> = <b>' + d.I.toFixed(6) + '</b>（直接），圆孔轴上 = ' + d.I_hole.toFixed(6) + '，|1−U′<sub>hole</sub>|² = ' + d.I_disk.toFixed(6) + '。几何阴影中心出现接近 I<sub>0</sub> = 1 的亮斑——约为圆孔极大 4 的 1/4（共享色标下可直接比较）。';
    }
  }
  var q2Hover = null;
  function q2Badges() {
    const out = [];
    if (!q2result) return out;
    if (q2Zoomed()) out.push({ text: '显示放大 ×' + (q2Half() / q2View.half).toFixed(1) + '（网格插值显示）', color: '#cfe2f2' });
    const busy = Object.values(jobs).some((j) => j.type === 'q2');
    if (q2result.quality === 'preview') out.push({ text: '预览（' + q2result.map.nObs + '×' + q2result.map.nObs + ' 粗采样）' + (busy ? '· 精确图计算中…' : ''), color: '#ffc074' });
    else if (busy) out.push({ text: '新参数计算中，仍显示任务 #' + q2result.id, color: '#57dbe8' });
    if (q2PendingEdits().length) out.push({ text: '有未应用编辑 · 图样对应任务 #' + q2result.id, color: '#ffc074' });
    const bright = randomBrightNote(q2result);
    if (bright) out.push({ text: bright.split('。')[0], color: '#ffc074' });
    return out;
  }
  /* light = true：只重画叠加层（探针 / 悬停 / 视图），孔径图不重画；图样位图有缓存，拖动探针时不重新着色 */
  function renderQ2Maps(light) {
    if (!$('cQ2map')) return;
    const R = q2result;
    if (R && !q2View.half) q2ResetView(false);
    const probe = { xp: D.toSI(q2s.probeX_mm, 'mm'), yp: D.toSI(q2s.probeY_mm, 'mm') };
    const shiftX = (R && R.caseKey === 'linear' && R.tilt) ? R.tilt.shiftOnScreen : null;
    const dom = q2Domain(R && R.map, 'main');
    const q2busy = Object.values(jobs).some((j) => j.type === 'q2');
    const indepWait = q2s.caseKey === 'random' && q2s.randomMode !== 'cell';
    drawIntensityMap($('cQ2map'), R && R.map, { slot: 'main', view: q2View, Imax: dom.Imax, probe: R ? probe : null, shiftX, hover: q2Hover, badges: q2Badges(), empty: q2busy ? (indepWait ? '逐点独立：不显示粗预览（那是另一幅散斑），正在计算所选精度…' : '计算中…（先出预览，再出精确图）') : '等待计算…' });
    const pr = probeI();
    const marks = R ? [{ I: R.axis.direct ? R.axis.direct.I : R.axis.I, label: 'O′', color: '#ffc074' }].concat(pr ? [{ I: probeDirect && probeDirect.resultId === R.id ? probeDirect.I : pr.I, label: '探针', color: '#57dbe8' }] : []) : [];
    drawColorBar($('cQ2bar'), dom.Imax, marks);
    if (!light) drawAperture($('cQ2ap'), R && R.ap);
    $('q2mapTitle').textContent = '观察屏光强 I(X′, Y′)' + (R ? ' · ' + D.Q2_CASES[R.caseKey].label : '');
    let vtxt = '';
    if (R) {
      vtxt = '视图 X′ ∈ [' + MM(q2View.cx - q2View.half).toFixed(3) + ', ' + MM(q2View.cx + q2View.half).toFixed(3) + '] mm，Y′ ∈ [' + MM(q2View.cy - q2View.half).toFixed(3) + ', ' + MM(q2View.cy + q2View.half).toFixed(3) + '] mm';
      if (q2Zoomed()) vtxt += '（×' + (q2Half() / q2View.half).toFixed(1) + '，像素为 ' + R.map.nObs + '×' + R.map.nObs + ' 网格（Δ = ' + D.fromSI(R.map.dObs, 'um').toFixed(1) + ' μm）的双线性插值显示，不是新的积分）';
    }
    const bright = randomBrightNote(R);
    const regionTxt = R && R.map ? ('观察区 ±' + D.fromSI(R.map.halfWidth, 'mm').toFixed(3) + ' mm（不少于 5 mm × 5 mm）') : '观察区不少于 5 mm × 5 mm';
    $('q2mapFoot').innerHTML = R ? (q2NormLabel(R.map, 'main') + (bright ? '<br><b>' + bright + '</b>' : '') + '<br>' + regionTxt + '，两轴等比例 · ' + vtxt + ' · ' + (R.quality === 'preview' ? '<span class="warntxt">预览档</span>' : '<span class="good">精确档</span>') + ' · 抽检 max|ΔI| = ' + (R.maxAbsDI != null && isFinite(R.maxAbsDI) ? R.maxAbsDI.toExponential(2) : (R.a > 0 ? '—' : '—（r = 0，无需抽检）'))) : '尚未计算';
    if (!light) {
      let apTxt = '—';
      if (R) {
        if (R.caseKey === 'disk') apTxt = '不透明圆盘（振幅 0）以外为透明、入射相位为 0。';
        else if (R.caseKey === 'random' && R.randomMode === 'cell') apTxt = '固定单元格 ' + D.fromSI(R.cellSize, 'um') + ' μm，种子 ' + (R.seed >>> 0) + '。色环是 [0, 2π) 的入射相位；加密不重抽。';
        else if (R.caseKey === 'random') apTxt = '逐点独立相位，种子 ' + (R.seed >>> 0) + '。预览图上的色块对应这张孔径图自己的采样，传播用的是 FFT 源像素；换网格会换一套相位。';
        else if (R.caseKey === 'linear') apTxt = '颜色沿 +X 绕 4 圈（总延迟 8π）；孔顶在上方。';
        else apTxt = '孔内振幅为 1、入射相位为 0；传播相位不画在这张孔径图上。';
      }
      $('q2apFoot').innerHTML = apTxt;
    }
    const showCmp = !!(R && R.mapHole && R.mapDisk);
    $('q2compareCard').hidden = !showCmp;
    if (showCmp) {
      const dc = q2Domain(R.mapHole, 'cmp');
      drawIntensityMap($('cQ2hole'), R.mapHole, { slot: 'hole', view: q2View, Imax: dc.Imax, probe, axes: true });
      drawIntensityMap($('cQ2disk'), R.mapDisk, { slot: 'disk', view: q2View, Imax: dc.Imax, probe, axes: true });
      const Ih = R.axis.direct ? R.axis.direct.I_hole : R.axis.I_hole, Id = R.axis.direct ? R.axis.direct.I_disk : R.axis.I_disk;
      drawColorBar($('cQ2cmpBar'), dc.Imax, [{ I: Ih, label: '圆孔 O′', color: '#ffc074' }, { I: Id, label: '圆屏 O′', color: '#57dbe8' }]);
      const ph = interpMapVal(R.mapHole, probe.xp, probe.yp, 'I'), pdk = interpMapVal(R.mapDisk, probe.xp, probe.yp, 'I');
      $('q2holeFoot').innerHTML = '同相圆孔 · I<sub>max</sub> = ' + R.mapHole.Imax.toFixed(3) + ' · O′ 直接积分 <b>' + Ih.toFixed(4) + '</b> · 探针 ' + ph.toFixed(4);
      $('q2diskFoot').innerHTML = '不透明圆屏 · I<sub>max</sub> = ' + R.mapDisk.Imax.toFixed(3) + ' · O′ 直接积分 <b>' + Id.toFixed(4) + '</b>（泊松亮斑）· 探针 ' + pdk.toFixed(4);
      $('q2cmpFoot').innerHTML = (q2s.scale === 'log'
        ? '<b>对数色标</b>，两图共用 [' + q2s.logFloor.toExponential(0) + ', ' + dc.Imax.toFixed(3) + ']：泊松亮斑 I(O′) = ' + Id.toFixed(3) + ' 比圆孔 I(O′) = ' + Ih.toFixed(3) + ' 低 <b>' + Math.log10(Ih / Math.max(Id, 1e-12)).toFixed(2) + ' 个数量级</b>（约 1/' + (Ih / Math.max(Id, 1e-12)).toFixed(1) + '），对数下颜色差别看起来较小，请以色条上的标记为准。'
        : '<b>线性共享色标</b> [0, ' + dc.Imax.toFixed(3) + ']：泊松亮斑 I(O′) = ' + Id.toFixed(3) + '，约为圆孔 I(O′) = ' + Ih.toFixed(3) + ' 的 ' + (Id / Math.max(Ih, 1e-12) * 100).toFixed(0) + ' %，颜色亮度可直接比较。') +
        ' 两图与主图同步缩放；' + (q2s.norm === 'per' ? '主图当前为“本图各自”，对照卡仍保持共享色标。' : dc.text + '。');
    }
  }
  function renderQ2Cuts() {
    if (!q2cutX) return;
    const R = q2result;
    const Icap = R ? Math.max(q2ImaxFor(R.map), 0.1) : 4;
    const Wmm = D.PRESET.q2HalfWidth_mm;
    const key = R ? R.id + '|' + q2s.norm + '|' + Icap.toFixed(6) : 'none';
    function paint(plot, cut, axis) {
      plot.series = []; plot.markers = []; plot.vlines = []; plot.hlines = []; plot.bands = []; plot.texts = [];
      // 只有结果或色标上限变化时才复位视图：移动探针不会再把用户的缩放重置
      if (plot.__homeKey !== key) { plot.setHome({ x0: -Wmm, x1: Wmm, y0: 0, y1: Icap * 1.08 }); plot.__homeKey = key; }
      const xs = cut ? Float64Array.from(cut.x, (v) => D.fromSI(v, 'mm')) : null;
      if (cut) plot.series.push({ x: xs, y: cut.I, color: '#57dbe8', width: 1.6 });
      const px = axis === 'x' ? q2s.probeX_mm : q2s.probeY_mm;
      if (q2Zoomed()) {   // 二维图的当前视图范围
        const c = axis === 'x' ? q2View.cx : q2View.cy;
        plot.bands.push({ x0: MM(c - q2View.half), x1: MM(c + q2View.half), color: 'rgba(43,74,104,.35)', label: '二维视图范围', textColor: '#93aac2' });
      }
      plot.vlines.push({ x: px, color: '#57dbe8', dash: [3, 3] });
      if (axis === 'x' && R && R.caseKey === 'linear' && R.tilt) {
        plot.vlines.push({ x: D.fromSI(R.tilt.shiftOnScreen, 'mm'), color: '#ffc074', dash: [5, 4], label: '预计', labelY: 4 });
        if (R.shiftMeas) plot.vlines.push({ x: D.fromSI(R.shiftMeas.peakX, 'mm'), color: '#ee79aa', dash: [2, 2], label: '数值峰', labelY: 20 });
      }
      // 游标点落在剖面曲线上（同一数据），与探针读数一致
      let cy = null;
      if (cut && xs && xs.length) {
        const t = Math.max(xs[0], Math.min(xs[xs.length - 1], px));
        let k = 0; while (k < xs.length - 2 && xs[k + 1] < t) k++;
        const u = (t - xs[k]) / ((xs[k + 1] - xs[k]) || 1);
        cy = cut.I[k] * (1 - u) + cut.I[k + 1] * u;
      }
      plot.cursor = cy != null ? { x: px, y: cy, color: '#ffc074' } : null;
      const note = $(axis === 'x' ? 'q2cutXNote' : 'q2cutYNote');
      if (note) note.innerHTML = cut ? ((axis === 'x' ? 'Y′ = ' + q2s.probeY_mm.toFixed(3) : 'X′ = ' + q2s.probeX_mm.toFixed(3)) + ' mm · ' + (cut.dense ? cut.n + ' 点密剖面（FFT 网格直接抽取）' : '由 ' + R.map.nObs + '×' + R.map.nObs + ' 网格双线性插值') + ' · 游标 I = ' + (cy != null ? cy.toFixed(5) : '—') + (R.quality === 'preview' ? ' · <span class="warntxt">预览</span>' : '')) : '—';
      plot.o.xlabel = axis === 'x' ? 'X′ (mm)　+X′ 向上' : 'Y′ (mm)　+Y′ 向左'; plot.o.ylabel = 'I/I_inc（线性）';
      plot.draw();
    }
    paint(q2cutX, cutThroughProbe('x'), 'x');
    paint(q2cutY, cutThroughProbe('y'), 'y');
  }
  function renderQ2Sampling() {
    const tb = $('q2PlanTable') && $('q2PlanTable').querySelector('tbody'); if (!tb) return;
    const ph = result ? D.physics(result.params) : D.physics(curParams());
    const a = q2result ? q2result.a : (result && result.fourth ? result.fourth.r : SI_MM(state.r_mm));
    const linearPlan = (q2result && q2result.caseKey === 'linear') || (!q2result && q2s.caseKey === 'linear');
    const plan = D.phase2Plan(ph, a > 0 ? a : 0, D.toSI(D.PRESET.q2HalfWidth_mm, 'mm'), { pathFrac: 10, incPhaseSpan: linearPlan ? 8 * Math.PI : 0 });
    const um = (m) => D.fromSI(m, 'um'), mmv = (m) => D.fromSI(m, 'mm');
    const rows = [];
    const add = (A, B, C) => rows.push([A, B, C]);
    add('<b>规划（λ/10' + (linearPlan ? ' + 8π 倾斜' : '，本情形不含 8π') + '）</b>', 'a = ' + mmv(a).toFixed(6) + ' mm', result && result.fourth && Math.abs(a - result.fourth.r) < 1e-12 ? '取本项目第 4 极大半径' : '当前半径');
    add('角点 |∇R| 上界 / 边缘', plan.gCorner.toExponential(4) + ' / ' + plan.gEdge.toExponential(4), 'λ/10 ⇒ d ≤ ' + um(plan.dCorner).toFixed(3) + ' μm（角点）、' + um(plan.dEdge).toFixed(3) + ' μm（边缘）');
    if (linearPlan) add('8π 入射梯度 8π/(2a)', plan.incGrad.toFixed(1) + ' rad/m', '只在线性相位情形并入源间距 ⇒ d ≤ ' + um(plan.dCombined).toFixed(3) + ' μm');
    add('计划源间距 / 观察间距', um(plan.dSrc).toFixed(3) + ' μm / ' + um(plan.dObsPlan).toFixed(2) + ' μm', '孔内约 ' + plan.nDisc.toLocaleString() + ' 点；观察约 ' + plan.nObs + '×' + plan.nObs);
    if (q2result) {
      const s = q2result.samp;
      add('<b>本图实际采用</b>', D.Q2_PRECISION[q2result.q2Precision].label + (q2result.quality === 'preview' ? '（预览结果）' : ''), '任务 #' + q2result.id);
      add('源间距 d / FFT 窗口', um(s.dSrc).toFixed(3) + ' μm / N = ' + s.Nfft + '（L = ' + mmv(s.Lfft).toFixed(3) + ' mm）', '填充因子 ' + (s.padActual >= 100 ? '∞' : s.padActual.toFixed(3)) + (s.capped ? ' · <span class="badtxt">已顶到 FFT 上限' + (s.dEnlarged ? '，源间距已放宽' : '') + '</span>' : '') + '；孔内像素约 ' + q2result.apertureBuild.nPix.toLocaleString() + (q2result.apertureBuild.areaExact > 0 ? '，面积比 ' + (q2result.apertureBuild.areaEst / q2result.apertureBuild.areaExact).toFixed(6) : ''));
      add('轴向相位步 (k·|∇R|<sub>边</sub> + ∇φ)·d', s.phaseStepAxial.toFixed(4) + ' rad', '对角 (√2·k·|∇R|<sub>角</sub> + ∇φ)·d = ' + s.phaseStepDiag.toFixed(4) + ' rad。按规划口径实际约 λ/' + (s.pathFracActual && isFinite(s.pathFracActual) ? s.pathFracActual.toFixed(1) : '—') + '（目标 λ/' + s.pathFrac + (s.belowTarget ? '，已粗于目标' : '') + '）');
      add('观察网格', s.nObs + '×' + s.nObs + '，d = ' + um(s.dObs).toFixed(2) + ' μm', 'Nyquist 约 ' + um(s.dObsNyq).toFixed(2) + ' μm；剖面 ' + s.nCut + ' 点由更密的 FFT 网格抽取');
      add('方案', '同一 RS1 核的零填充 FFT 卷积（非远场近似）', '探针用 fieldAtPoint2D 直接极坐标积分抽检');
      add('抽检 max |I_FFT − I_直接|', q2result.maxAbsDI != null && isFinite(q2result.maxAbsDI) ? q2result.maxAbsDI.toExponential(3) : '—（r = 0 时 FFT 不适用）', 'max |ΔU| = ' + (q2result.maxAbsDU != null && isFinite(q2result.maxAbsDU) ? q2result.maxAbsDU.toExponential(3) : '—') + '；轴上直接 I = ' + (q2result.axis.direct ? q2result.axis.direct.I.toFixed(6) : '—') + '，FFT I = ' + (isFinite(q2result.axis.I) ? q2result.axis.I.toFixed(6) : '—'));
      if (q2result.caseKey === 'linear' && q2result.shiftMeas) add('情形 3 偏移（数值 / 预计）', mmv(q2result.shiftMeas.peakX).toFixed(5) + ' / ' + mmv(q2result.shiftMeas.predicted).toFixed(5) + ' mm', '方向 ' + q2result.shiftMeas.direction + '（朝 +X′，延迟端）');
      if ((q2result.caseKey === 'disk' || q2result.caseKey === 'inphase') && q2result.axis.direct) add('轴上圆孔 / 圆屏（直接）', q2result.axis.direct.I_hole.toFixed(6) + ' / ' + q2result.axis.direct.I_disk.toFixed(6), '巴比涅：I_disk(O′) = |1 − U′_hole(O′)|²，不减光强');
    }
    tb.innerHTML = '<tr><th>项目</th><th>数值</th><th>说明</th></tr>' + rows.map((r) => '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('');
  }
  function renderQ2All() {
    applyQ2Inputs(); renderQ2Metrics(); renderQ2Concept(); renderQ2Maps(); renderQ2Cuts(); renderQ2Sampling(); renderQ2Status(); renderQ2Pending();
  }
  function q2ConfigSlice() {
    return {
      caseKey: q2s.caseKey, seed: q2s.seed >>> 0, cellSize_um: q2s.cellSize_um, randomMode: q2s.randomMode, precision: q2s.precision,
      scale: q2s.scale, norm: q2s.norm, logFloor: q2s.logFloor,
      probeX_mm: q2s.probeX_mm, probeY_mm: q2s.probeY_mm, halfWidth_mm: D.PRESET.q2HalfWidth_mm,
      applied: q2result && {
        job: q2result.id, quality: q2result.quality, caseKey: q2result.caseKey, r_mm: D.fromSI(q2result.a, 'mm'),
        seed: q2result.seed >>> 0, cellSize_um: D.fromSI(q2result.cellSize, 'um'), randomMode: q2result.randomMode, precision: q2result.q2Precision,
        axisI_direct: q2result.axis.direct && q2result.axis.direct.I,
        axisI_fft: q2result.axis.I, Imax: q2result.map.Imax,
        halfWidth_mm: D.fromSI(q2result.map.halfWidth, 'mm'),
        shift_mm: q2result.shiftMeas && D.fromSI(q2result.shiftMeas.peakX, 'mm'),
        maxAbsDI: q2result.maxAbsDI, sampling: q2result.samp
      }
    };
  }
  function applyQ2Config(cfg, bad) {
    const q = (cfg && cfg.q2) || {};
    if (q.caseKey && D.Q2_CASES[q.caseKey]) q2s.caseKey = q.caseKey;
    else if (q.caseKey) bad.push('q2.caseKey');
    q2s.seed = cfgNum(q.seed, D.Q2_DEFAULT_SEED, (x) => D.inRange('seed', x), 'q2.seed', bad) >>> 0;
    q2s.cellSize_um = cfgNum(q.cellSize_um, D.Q2_DEFAULT_CELL_UM, (x) => D.inRange('cell_um', x), 'q2.cellSize_um', bad);
    q2s.randomMode = q.randomMode === 'cell' ? 'cell' : 'independent';
    if (q.precision && D.Q2_PRECISION[q.precision]) q2s.precision = q.precision;
    if (q.scale === 'log' || q.scale === 'linear') q2s.scale = q.scale;
    if (q.norm === 'per' || q.norm === 'shared' || q.norm === 'fixed4') q2s.norm = q.norm;
    q2s.probeX_mm = cfgNum(q.probeX_mm, 0, (x) => Number.isFinite(x), 'q2.probeX_mm', bad);
    q2s.probeY_mm = cfgNum(q.probeY_mm, 0, (x) => Number.isFinite(x), 'q2.probeY_mm', bad);
  }
  function q2MetaLines() {
    const P = q2result.params, s = q2result.samp;
    const halfMm = D.fromSI(q2result.map.halfWidth, 'mm');
    return [
      ['项目', '圆孔衍射 · 第13章研讨题第1题 · 第二问二维图样'],
      ['导出时间', new Date().toString()],
      ['情形', D.Q2_CASES[q2result.caseKey].label + '（' + q2result.caseKey + '）'],
      ['参数状态', '任务 #' + q2result.id + (q2PendingEdits().length ? '；另有未应用编辑（未包含）' : '')],
      ['波长 λ', P.lambda_nm + ' nm'], ['距离 L', P.L_cm + ' cm'], ['半径 r', D.fromSI(q2result.a, 'mm') + ' mm'],
      ['观察区', '±' + halfMm.toFixed(4) + ' mm（实际网格 ' + (2 * halfMm).toFixed(4) + ' mm × ' + (2 * halfMm).toFixed(4) + ' mm；请求至少 ±' + D.PRESET.q2HalfWidth_mm + ' mm）'],
      ['积分', 'U = (1/(iλ)) ∬ U_inc (z/R) e^{ikR}/R dS（RS1，e^{-iωt}）；I = |U|²；FFT 卷积加速，直接积分抽检'],
      ['归一化', 'I_inc = |A|² = 1；U′_free = 1；圆屏 U′_disk = 1 − U′_hole'],
      ['色标', q2NormLabel(q2result.map)],
      ['源采样', 'd = ' + s.dSrc + ' m，N_fft = ' + s.Nfft + '，相位步 ' + s.phaseStepAxial + ' rad'],
      ['观察采样', s.nObs + '×' + s.nObs + '，d = ' + s.dObs + ' m，半宽 ' + q2result.map.halfWidth + ' m'],
      ['精度', D.Q2_PRECISION[q2result.q2Precision].label + ' · ' + (q2result.quality === 'preview' ? '预览' : '精确')],
      ['种子 / 模型', q2result.caseKey === 'random' ? ((q2result.seed >>> 0) + ' / ' + (q2result.randomMode === 'cell' ? '固定单元格 ' + q2result.cellSize + ' m' : '逐点独立 δ=d')) : '（非随机情形）'],
      ['轴上 I 直接 / FFT', (q2result.axis.direct ? q2result.axis.direct.I : '—') + ' / ' + q2result.axis.I],
      ['抽检 max|ΔI|', String(q2result.maxAbsDI)],
      ['坐标', '+X′ 向上，迎着光 +Y′ 向左'],
      ['任务', '#' + q2result.id + '；内核 ' + D.VERSION]
    ];
  }
  function offscreenCss(w, h, fn) {   // 用一个临时的屏外 canvas 调用依赖 CSS 尺寸的绘制函数
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + w + 'px;height:' + h + 'px';
    document.body.appendChild(c);
    try { fn(c); } finally { c.remove(); }
    return c;
  }
  /* PNG 导出：正方形图样（两轴等比例、整幅 5 mm × 5 mm、带 mm 刻度）+ 色条 + 孔径 + 两条剖面 */
  function renderQ2Offscreen(mapS) {
    mapS = mapS || 820;
    const barW = 120, apW = 420, cutH = 240, pad = 14;
    const W = mapS + barW + apW + pad * 3, topH = Math.max(mapS, apW + 40), H = topH + cutH + 50;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, W, H);
    const R = q2result, dom = q2Domain(R && R.map, 'main');
    const home = { cx: 0, cy: 0, half: R ? R.map.halfWidth : 1 };
    paintMap(ctx, mapS, mapS, 1, R && R.map, { slot: 'export', view: home, Imax: dom.Imax, axes: true, probe: R ? { xp: D.toSI(q2s.probeX_mm, 'mm'), yp: D.toSI(q2s.probeY_mm, 'mm') } : null, shiftX: R && R.caseKey === 'linear' ? R.tilt.shiftOnScreen : null, badges: R && R.quality === 'preview' ? [{ text: '预览档（粗采样）' }] : [] });
    const marks = R ? [{ I: R.axis.direct ? R.axis.direct.I : R.axis.I, label: 'O′', color: '#ffc074' }] : [];
    const bar = offscreenCss(barW, mapS - 40, (c) => drawColorBar(c, dom.Imax, marks));
    ctx.drawImage(bar, mapS + pad, 20, barW, mapS - 40);
    const ap = offscreenCss(apW, apW, (c) => drawAperture(c, R && R.ap));
    ctx.drawImage(ap, mapS + barW + pad * 2, 0, apW, apW);
    ctx.fillStyle = '#93aac2'; ctx.font = '12px "Microsoft YaHei",sans-serif';
    ctx.fillText('孔径振幅 / 入射相位（' + (R ? D.Q2_CASES[R.caseKey].label : '') + '）', mapS + barW + pad * 2, apW + 18);
    if (q2cutX && q2cutY) {
      const cx = q2cutX.renderOffscreen(Math.floor((W - pad) / 2), cutH, 1);
      const cy = q2cutY.renderOffscreen(Math.floor((W - pad) / 2), cutH, 1);
      ctx.drawImage(cx, 0, topH + 36);
      ctx.drawImage(cy, Math.floor((W + pad) / 2), topH + 36);
    }
    ctx.fillStyle = '#93aac2'; ctx.font = '12px "Microsoft YaHei",sans-serif';
    ctx.fillText('I(X′,Y′)  ' + (R ? q2NormLabel(R.map, 'main') : ''), 0, topH + 22);
    return cv;
  }
  function exportQ2PngCanvas() {
    const pad = 24;
    const bundle = renderQ2Offscreen(820);
    const W = bundle.width + 2 * pad;
    const meta = q2MetaLines();
    const mctx = document.createElement('canvas').getContext('2d'); mctx.font = '13px Consolas,"Microsoft YaHei",monospace';
    const metaRows = meta.map(([k, v]) => [k, wrapText(mctx, v, W - 2 * pad - 130)]);
    const nL = metaRows.reduce((a, r) => a + r[1].length, 0);
    const headH = 50 + nL * 18 + 8, H = headH + bundle.height + pad;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
    ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#57dbe8'; ctx.font = '800 15px "Microsoft YaHei",sans-serif';
    ctx.fillText('物理光学 · 第13章研讨题 · 第1题 · 第二问 二维图样（RS1 复振幅积分，I = |U|²）', pad, 28);
    ctx.font = '13px Consolas,"Microsoft YaHei",monospace';
    let yy = 50;
    metaRows.forEach(([k, lines]) => { ctx.fillStyle = '#93aac2'; ctx.fillText(k + '：', pad, yy); ctx.fillStyle = '#eaf4ff'; lines.forEach((l) => { ctx.fillText(l, pad + 130, yy); yy += 18; }); });
    ctx.drawImage(bundle, pad, headH);
    return cv;
  }
  document.querySelectorAll('#q2caseSeg button').forEach((b) => b.addEventListener('click', () => {
    const next = b.dataset.v;
    if (next === 'random' && q2s.caseKey !== 'random' && !q2s.normPinned) {
      q2s.normBeforeRandom = q2s.norm;
      q2s.norm = 'per';
    } else if (next !== 'random' && q2s.caseKey === 'random') {
      if (!q2s.normPinned && q2s.normBeforeRandom) q2s.norm = q2s.normBeforeRandom;
      q2s.normBeforeRandom = null;
      q2s.normPinned = false;
    }
    q2s.caseKey = next; applyQ2Inputs(); requestQ2('final');
  }));
  document.querySelectorAll('#q2precSeg button').forEach((b) => b.addEventListener('click', () => {
    q2s.precision = b.dataset.v; applyQ2Inputs(); requestQ2('final');
  }));
  document.querySelectorAll('#q2scaleSeg button').forEach((b) => b.addEventListener('click', () => {
    q2s.scale = b.dataset.v; applyQ2Inputs(); renderQ2Maps(); renderQ2Cuts();
  }));
  document.querySelectorAll('#q2normSeg button').forEach((b) => b.addEventListener('click', () => {
    q2s.norm = b.dataset.v;
    q2s.normPinned = q2s.caseKey === 'random';
    applyQ2Inputs(); renderQ2Maps(); renderQ2Cuts();
  }));
  $('q2btnCancel').addEventListener('click', () => cancelQ2());
  $('q2btnRecalc').addEventListener('click', () => requestQ2('final'));
  $('q2btnApply').addEventListener('click', () => requestQ2('final'));
  $('q2btnDiscard').addEventListener('click', () => {
    if (!q2result) return;
    if (Object.values(jobs).some((j) => j.type === 'q2')) cancelQ2('已放弃未应用的编辑');
    q2s.caseKey = q2result.caseKey; q2s.seed = q2result.seed >>> 0; q2s.cellSize_um = D.fromSI(q2result.cellSize, 'um');
    q2s.randomMode = q2result.randomMode || 'independent';
    if (q2result.quality !== 'preview') q2s.precision = q2result.q2Precision;
    if (Math.abs(state.r_mm - D.fromSI(q2result.a, 'mm')) > 1e-12) setRadius(D.fromSI(q2result.a, 'mm'), { precise: true, forceInput: true, keepLock: true });
    q2s.cancelledNote = '已放弃未应用的编辑';
    applyQ2Inputs(); renderQ2Pending(); renderQ2Status();
  });
  // 第二问里点“锁定 r₄”是明确的命令（与点情形按钮一样）：锁定后立即按 r₄ 重算图样；解锁只解除锁定，不改图样
  $('btnLock4Q2').addEventListener('click', () => {
    $('btnLock4').click();
    if (state.locked && q2result && Math.abs(D.fromSI(q2result.a, 'mm') - state.r_mm) > 1e-12) requestQ2('final');
  });
  $('q2rInput').addEventListener('change', () => {
    commitNumber($('q2rInput'), {
      label: 'r (mm)',
      revert: () => { $('q2rInput').value = state.r_mm.toFixed(7); },
      apply: (v) => setRadius(v, { precise: true, forceInput: true })
    });
    renderQ2Pending();
  });
  $('q2seed').addEventListener('change', () => {
    commitNumber($('q2seed'), {
      label: '种子', integer: true,
      revert: () => { $('q2seed').value = q2s.seed >>> 0; },
      apply: (v) => { q2s.seed = v >>> 0; applyQ2Inputs(); renderQ2Pending(); }
    });
  });
  $('q2cell').addEventListener('change', () => {
    commitNumber($('q2cell'), {
      label: '单元格 (μm)',
      revert: () => { $('q2cell').value = q2s.cellSize_um; },
      apply: (v) => { q2s.cellSize_um = v; applyQ2Inputs(); renderQ2Pending(); }
    });
  });
  document.querySelectorAll('#q2randMode button').forEach((b) => b.addEventListener('click', () => {
    q2s.randomMode = b.dataset.v === 'cell' ? 'cell' : 'independent';
    applyQ2Inputs(); requestQ2('final');
  }));
  $('q2btnRegen').addEventListener('click', () => {
    q2s.seed = ((q2s.seed + 0x9E3779B9) ^ (Date.now() & 0x7fffffff)) >>> 0;
    applyQ2Inputs(); requestQ2('final');
  });
  /* 探针：拖动 / 点击 / 方向键即时更新（网格插值读数 + 剖面 + 色条标记），停顿后在后台做直接积分核对 */
  function setProbe(xmm, ymm, opt) {
    opt = opt || {};
    const lim = D.PRESET.q2HalfWidth_mm;
    const nx = Math.max(-lim, Math.min(lim, Number.isFinite(xmm) ? xmm : 0)), ny = Math.max(-lim, Math.min(lim, Number.isFinite(ymm) ? ymm : 0));
    const changed = nx !== q2s.probeX_mm || ny !== q2s.probeY_mm;
    q2s.probeX_mm = nx; q2s.probeY_mm = ny;
    if (document.activeElement !== $('q2px')) $('q2px').value = +nx.toFixed(5);
    if (document.activeElement !== $('q2py')) $('q2py').value = +ny.toFixed(5);
    if (changed) { probeDirect = null; requestProbe(opt.dragging ? 250 : 120); }
    renderQ2Metrics(); renderQ2Maps(true); renderQ2Cuts();
  }
  var numOr = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
  $('q2px').addEventListener('change', () => setProbe(numOr($('q2px').value, 0), q2s.probeY_mm));
  $('q2py').addEventListener('change', () => setProbe(q2s.probeX_mm, numOr($('q2py').value, 0)));
  $('q2probe0').addEventListener('click', () => setProbe(0, 0));
  (function bindQ2Map() {
    const cv = $('cQ2map');
    let drag = null;
    const rel = (e) => { const r = cv.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; };
    const inVP = (vp, p) => vp && p.px >= vp.x && p.px <= vp.x + vp.S && p.py >= vp.y && p.py <= vp.y + vp.S;
    const toMM = (vp, p) => { const xy = vpToXY(vp, p.px, p.py, q2View); return { x: MM(xy.xp), y: MM(xy.yp) }; };
    cv.addEventListener('pointerdown', (e) => {
      if (!q2result || !cv.__vp) return;
      const p = rel(e); if (!inVP(cv.__vp, p)) return;
      const q = xyToVP(cv.__vp, D.toSI(q2s.probeX_mm, 'mm'), D.toSI(q2s.probeY_mm, 'mm'), q2View);
      const near = Math.hypot(q.x - p.px, q.y - p.py) <= 14;
      // 靠近探针，或图未放大（无处可平移）时：拖动 = 移动探针；放大后在别处拖动 = 平移视图
      drag = { mode: near || !q2Zoomed() ? 'probe' : 'pan', p0: p, v0: Object.assign({}, q2View), moved: false };
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      cv.focus({ preventScroll: true });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const p = rel(e);
      q2Hover = drag ? null : p;
      if (drag) {
        if (Math.abs(p.px - drag.p0.px) + Math.abs(p.py - drag.p0.py) > 3) drag.moved = true;
        if (drag.moved && drag.mode === 'probe') { const m = toMM(cv.__vp, p); setProbe(m.x, m.y, { dragging: true }); return; }
        if (drag.moved && drag.mode === 'pan') {
          const k = 2 * drag.v0.half / cv.__vp.S;
          q2View.cy = drag.v0.cy + (p.px - drag.p0.px) * k; q2View.cx = drag.v0.cx + (p.py - drag.p0.py) * k;
          q2ClampView(); renderQ2Maps(true); renderQ2Cuts(); return;
        }
      }
      if (q2result) renderQ2Maps(true);
    });
    const end = (e) => {
      const d = drag; drag = null;
      if (d && !d.moved && cv.__vp) { const m = toMM(cv.__vp, rel(e)); setProbe(m.x, m.y); }
      else if (d && d.mode === 'probe') requestProbe(60);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => { drag = null; });
    cv.addEventListener('pointerleave', () => { q2Hover = null; if (!drag && q2result) renderQ2Maps(true); });
    cv.addEventListener('wheel', (e) => {
      if (!q2result || !cv.__vp) return;
      e.preventDefault();
      const p = rel(e), xy = inVP(cv.__vp, p) ? vpToXY(cv.__vp, p.px, p.py, q2View) : { xp: q2View.cx, yp: q2View.cy };
      q2Zoom(e.deltaY > 0 ? 1.25 : 0.8, xy.xp, xy.yp);
    }, { passive: false });
    cv.addEventListener('dblclick', () => q2ResetView());
    cv.addEventListener('keydown', (e) => {
      if (!q2result) return;
      const st = MM(q2result.map.dObs) * (e.shiftKey ? 10 : 1);
      const k = { ArrowUp: [st, 0], ArrowDown: [-st, 0], ArrowLeft: [0, st], ArrowRight: [0, -st] }[e.key];
      if (k) { e.preventDefault(); setProbe(q2s.probeX_mm + k[0], q2s.probeY_mm + k[1]); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); q2Zoom(0.8, D.toSI(q2s.probeX_mm, 'mm'), D.toSI(q2s.probeY_mm, 'mm')); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); q2Zoom(1.25); }
      else if (e.key === '0') { e.preventDefault(); q2ResetView(); }
    });
  })();
  $('q2zoomIn').addEventListener('click', () => q2Zoom(0.8, D.toSI(q2s.probeX_mm, 'mm'), D.toSI(q2s.probeY_mm, 'mm')));
  $('q2zoomOut').addEventListener('click', () => q2Zoom(1.25));
  $('q2zoomReset').addEventListener('click', () => q2ResetView());
  $('q2cutReset').addEventListener('click', () => { q2cutX.resetView(); q2cutY.resetView(); });
  $('q2btnPreset').addEventListener('click', () => {
    q2s.caseKey = 'inphase'; q2s.precision = 'standard'; q2s.seed = D.Q2_DEFAULT_SEED >>> 0; q2s.cellSize_um = D.Q2_DEFAULT_CELL_UM; q2s.randomMode = 'independent';
    q2s.scale = 'linear'; q2s.norm = 'shared'; q2s.normBeforeRandom = null; q2s.normPinned = false; q2s.probeX_mm = 0; q2s.probeY_mm = 0;
    q2View.half = null; probeDirect = null;
    applyQ2Inputs();
    $('btnPreset').click();
    pendingQ2AfterQ1 = true;
  });
  $('q2btnPng').addEventListener('click', () => {
    if (!q2result) return;
    exportQ2PngCanvas().toBlob((b) => download('圆孔衍射_第二问_' + q2result.caseKey + '_λ' + q2result.params.lambda_nm + 'nm_' + stamp() + '.png', b), 'image/png');
  });
  $('q2btnCsv').addEventListener('click', () => {
    if (!q2result) return;
    const m = q2result.map, n = m.nObs, WW = m.halfWidth, d = m.dObs;
    const lines = q2MetaLines().map(([k, v]) => '# ' + k + ': ' + v);
    lines.push('# 列：i,j,Xprime_mm,Yprime_mm,Re_U,Im_U,I_over_Iinc。X′ 向上，Y′ 向左。单位 mm / I_inc。');
    lines.push('i,j,Xprime_mm,Yprime_mm,Re_U,Im_U,I_over_Iinc');
    for (let j = 0; j < n; j++) {
      const yp = -WW + j * d;
      for (let i = 0; i < n; i++) {
        const xp = -WW + i * d, k = j * n + i;
        lines.push([i, j, D.fromSI(xp, 'mm').toPrecision(10), D.fromSI(yp, 'mm').toPrecision(10), m.re[k].toPrecision(12), m.im[k].toPrecision(12), m.I[k].toPrecision(12)].join(','));
      }
    }
    download('圆孔衍射_第二问_I_XY_' + q2result.caseKey + '_' + stamp() + '.csv', new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  });
  $('q2btnJson').addEventListener('click', () => download('圆孔衍射_参数配置_' + stamp() + '.json', new Blob([JSON.stringify(configObject(), null, 2)], { type: 'application/json' })));
  bindConfigFile('q2fileJson');

  q2cutX = new window.LinePlot($('cQ2cutX'), { pad: { l: 52, r: 10, t: 10, b: 36 }, xlabel: 'X′ (mm)', ylabel: 'I/I_inc' });
  q2cutY = new window.LinePlot($('cQ2cutY'), { pad: { l: 52, r: 10, t: 10, b: 36 }, xlabel: 'Y′ (mm)', ylabel: 'I/I_inc' });
