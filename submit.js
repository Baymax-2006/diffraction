/* submit.js — 精简提交页。
 * 第一问：computeQ1（jobs.js，submit-worker.js）。
 * 第二问：direct-q2.js 在圆孔上取点，观察屏逐点直接叠加。不用 FFT。
 * 不提供参数、精度、扫描、探针或多种导出。 */
(function () {
  'use strict';

  var D = window.Diffraction;
  var $ = function (id) { return document.getElementById(id); };
  var PARAMS = {
    lambda_nm: D.PRESET.lambda_nm,
    L_cm: D.PRESET.L_cm,
    A: 1,
    rMax_mm: D.PRESET.rMax_mm,
    r4Threshold: D.PRESET.r4Threshold
  };
  var P1 = 'standard';
  var SEED = DirectQ2.SEED;
  var FONT = '"WenQuanYi Micro Hei","Microsoft YaHei","Segoe UI",sans-serif';

  /* 与本内核标准精度已核对过的参考值。页面上的数字一律来自本次计算，这里只做比对。 */
  var REF = {
    r4_mm: 1.3228768035,
    I4: 3.999986,
    r5_mm: 0.2495438957,
    nMax: 10,
    nMin: 9,
    shift_mm: 0.378,
    Idisk: 0.99999
  };

  var state = {
    q1: null,
    maps: {},
    q2: null,
    conv: null,
    pool: [],
    statusText: '',
    shared: 1,
    painted: {},
    t0: performance.now(),
    engine: ''
  };
  var seq = 0;
  var jobs = {};

  function mm(m, d) { return (m * 1e3).toFixed(d); }
  function um(m, d) { return (m * 1e6).toFixed(d); }
  function nm(m, d) { return (m * 1e9).toFixed(d); }
  function setAll(cls, text) {
    var list = document.getElementsByClassName(cls);
    for (var i = 0; i < list.length; i++) list[i].textContent = text;
  }
  function sciSmall(x) {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    var a = Math.abs(x);
    if (a < 5e-4 || a >= 1e4) return x.toExponential(2);
    return x.toPrecision(4);
  }
  function supExp(x, digits) {
    var ax = Math.abs(x);
    if (!(ax > 0) || !Number.isFinite(x)) return '—';
    var e = Math.floor(Math.log10(ax));
    var m = x / Math.pow(10, e);
    var map = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    var es = String(e).split('').map(function (c) { return map[c] || c; }).join('');
    return m.toFixed(digits) + '×10' + es;
  }
  function niceStep(span, target) {
    var raw = span / Math.max(1, target);
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function setStatus(text, frac) {
    state.statusText = text;
    paintStatus(frac);
  }
  function paintStatus(frac) {
    var text = state.statusText || '';
    if (!window.__submit.ready) text += '  已用 ' + ((performance.now() - state.t0) / 1000).toFixed(1) + ' s';
    $('status').textContent = text;
    if (frac != null) $('prog').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  }
  function fit(cv) {
    var r = Math.min(2, window.devicePixelRatio || 1);
    var w = cv.clientWidth || 300;
    var h = cv.clientHeight || 200;
    var bw = Math.max(1, Math.round(w * r));
    var bh = Math.max(1, Math.round(h * r));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    var ctx = cv.getContext('2d');
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* ---------- 第一问线程：submit-worker.js；file:// 用内核里的同一份 Blob 源码 ---------- */
  function blobURL() {
    var K = window.__kernelSrc || {};
    if (!K.diffraction || !K.jobs) return null;
    if (!blobURL.cached) {
      var src = [K.diffraction, K.jobs,
        "self.onmessage = (ev) => self.Q1Jobs.run(ev.data, (m, transfer) => self.postMessage(m, transfer || []));",
        "self.postMessage({ type: 'ready', version: self.Diffraction.VERSION, blob: true });"].join('\n;\n');
      blobURL.cached = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return blobURL.cached;
  }
  function directBlob() {
    var K = window.__kernelSrc || {};
    if (!K.direct) return null;
    if (!directBlob.cached) {
      var src = K.direct + '\nself.onmessage = self.DirectQ2.workerOnMessage;\n';
      directBlob.cached = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return directBlob.cached;
  }
  var port = null;
  var mainMode = false;
  function deliver(msg) {
    if (mainMode) setTimeout(function () { window.Q1Jobs.run(msg, onMessage); }, 16);
    else port.postMessage(msg);
  }
  function startEngine() {
    var url = location.protocol === 'file:' ? blobURL() : 'submit-worker.js';
    try {
      port = new Worker(url);
      state.engine = url === 'submit-worker.js' ? 'Web Worker' : 'Blob Worker';
      port.onmessage = function (ev) { onMessage(ev.data); };
      port.onerror = function (e) {
        if (e.preventDefault) e.preventDefault();
        fallMain(e.message || 'Worker 失败');
      };
    } catch (err) { fallMain(err.message || String(err)); }
  }
  function fallMain(why) {
    if (mainMode) return;
    mainMode = true;
    state.engine = '主线程（' + why + '）';
    try { port && port.terminate(); } catch (e) { /* ignore */ }
    port = null;
    Object.keys(jobs).forEach(function (id) { deliver(jobs[id]); });
  }
  function submit(type, extra) {
    var id = ++seq;
    var msg = Object.assign({ type: type, id: id, params: PARAMS, precision: P1 }, extra || {});
    jobs[id] = msg;
    deliver(msg);
    return id;
  }

  function onMessage(m) {
    if (!m || m.type === 'ready') return;
    if (m.type === 'progress') {
      var job = jobs[m.id];
      if (!job) return;
      var base = job._base || 0, span = job._span || 1;
      setStatus(job._label + ' ' + Math.round(m.frac * 100) + '%', base + span * m.frac);
      return;
    }
    var job = jobs[m.id];
    delete jobs[m.id];
    if (m.type === 'error') {
      window.__submit.errors.push(m.message || '计算失败');
      setStatus('计算失败：' + String(m.message || '').split('\n')[0], null);
      return;
    }
    if (m.type === 'q1') acceptQ1(m);
  }

  function fourthOf(extrema) {
    var n = 0;
    for (var i = 0; i < extrema.length; i++) if (extrema[i].kind === 'max' && ++n === 4) return extrema[i];
    return null;
  }

  function acceptQ1(m) {
    var maxima = m.extrema.filter(function (e) { return e.kind === 'max'; });
    var minima = m.extrema.filter(function (e) { return e.kind === 'min'; });
    var fourth = fourthOf(m.extrema);
    state.q1 = { raw: m, maxima: maxima, minima: minima, fourth: fourth };
    state.conv = gridStudy(fourth.r);
    fillAxis();
    renderPlots();
    $('boot').hidden = true;
    prepareQ2(fourth.r);
    setStatus('轴上曲线已完成，正在直接叠加二维图样… ' + describeQ2(), 0.04);
    startDirectPool();
    nextCase();
  }

  /* ---------- 第二问：直接叠加 ---------- */
  var CASE_QUEUE = [
    { kind: 'inphase', label: '同相圆孔', base: 0.04, span: 0.32 },
    { kind: 'linear', label: '线性相位', base: 0.36, span: 0.32 },
    { kind: 'random', label: '随机相位', base: 0.68, span: 0.30 }
  ];
  var casePos = 0;
  var flight = null;

  function q2Geom(plan) {
    return {
      nObs: plan.nObs, half: plan.halfWidth, halfWidth: plan.halfWidth, dObs: plan.dObs,
      L: plan.L, k: plan.k, lambda: plan.lambda, d: plan.d
    };
  }
  function describeQ2() {
    var q = state.q2;
    if (!q) return '';
    return 'N = ' + q.N + '，d = ' + um(q.plan.d, 3) + ' μm，屏 ' + q.plan.nObs + '×' + q.plan.nObs +
      '，角点光程差上界 λ/10，相邻实际 λ/' + q.pathFrac.toFixed(2);
  }
  function prepareQ2(a) {
    var ph = D.physics(PARAMS);
    var half = D.toSI(D.PRESET.q2HalfWidth_mm, 'mm');
    var plan = DirectQ2.plan(ph, a, half);
    var probe = DirectQ2.collectSources(a, plan.d, 'inphase', SEED);
    var corner = DirectQ2.cornerPathStep(probe, plan.halfWidth, plan.L);
    state.q2 = {
      a: a, ph: ph, plan: plan, N: probe.N,
      pathStep: corner.pathStep, pathPairs: corner.pairs,
      pathFrac: plan.lambda / corner.pathStep,
      seed: SEED, shift: 2 * ph.lambda * ph.z / a,
      center: {}, times: {}, peak: null
    };
    fillSamplingFull();
  }
  function startDirectPool() {
    var n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2)));
    var url = location.protocol === 'file:' ? directBlob() : 'direct-worker.js';
    if (!url) { state.directEngine = '主线程（没有 Worker 源码）'; return; }
    try {
      for (var i = 0; i < n; i++) {
        var w = new Worker(url);
        w.onmessage = onDirectMessage;
        w.onerror = onDirectError;
        state.pool.push(w);
      }
      state.directEngine = (url === 'direct-worker.js' ? 'Web Worker' : 'Blob Worker') + ' × ' + state.pool.length;
    } catch (err) {
      state.pool.forEach(function (w) { try { w.terminate(); } catch (e) { /* ignore */ } });
      state.pool = [];
      state.directEngine = '主线程（' + (err.message || err) + '）';
    }
  }
  function onDirectError(e) {
    if (e && e.preventDefault) e.preventDefault();
    window.__submit.errors.push(String((e && e.message) || e || 'Worker 失败'));
    if (state.directFailed) return;
    state.directFailed = true;
    state.pool.forEach(function (w) { try { w.terminate(); } catch (err) { /* ignore */ } });
    state.pool = [];
    state.directEngine = '主线程（Worker 失败，改在页面线程计算）';
    if (flight) runCaseMain();
  }
  function onDirectMessage(ev) {
    var m = ev.data;
    if (!flight || !m || m.id !== flight.kind || state.directFailed) return;
    if (m.type === 'progress') {
      flight.rowsReported++;
      var frac = flight.rowsReported / flight.nObs;
      setStatus(flight.label + ' 直接叠加 ' + Math.round(frac * 100) + '% · ' + describeQ2(), flight.base + flight.span * frac);
      return;
    }
    if (m.type === 'rows') {
      flight.re.set(m.re, m.row0 * flight.nObs);
      flight.im.set(m.im, m.row0 * flight.nObs);
      flight.pending--;
      if (flight.pending === 0) finishCase();
    }
  }
  function nextCase() {
    if (casePos >= CASE_QUEUE.length) { finish(); return; }
    var spec = CASE_QUEUE[casePos++];
    var q = state.q2;
    var src = DirectQ2.collectSources(q.a, q.plan.d, spec.kind, SEED);
    var geom = q2Geom(q.plan);
    flight = {
      kind: spec.kind, label: spec.label, base: spec.base, span: spec.span,
      src: src, geom: geom, nObs: geom.nObs,
      re: new Float64Array(geom.nObs * geom.nObs),
      im: new Float64Array(geom.nObs * geom.nObs),
      pending: 0, rowsReported: 0, row: 0, t0: performance.now()
    };
    setStatus(spec.label + ' 直接叠加 0% · ' + describeQ2(), spec.base);
    if (!state.pool.length || state.directFailed) runCaseMain();
    else {
      var nW = state.pool.length, launched = 0;
      for (var w = 0; w < nW; w++) {
        var row0 = Math.floor(w * geom.nObs / nW);
        var row1 = Math.floor((w + 1) * geom.nObs / nW);
        if (row1 <= row0) continue;
        launched++;
        state.pool[w].postMessage({ type: 'sum', id: spec.kind, row0: row0, row1: row1, src: src, geom: geom });
      }
      flight.pending = launched;
      if (!launched) runCaseMain();
    }
  }
  function runCaseMain() {
    var row = flight.row || 0;
    var nObs = flight.nObs;
    if (row >= nObs) { finishCase(); return; }
    var part = DirectQ2.sumRows(flight.src, flight.geom, row, row + 1);
    flight.re.set(part.re, row * nObs);
    flight.im.set(part.im, row * nObs);
    flight.row = row + 1;
    var frac = flight.row / nObs;
    setStatus(flight.label + ' 直接叠加 ' + Math.round(frac * 100) + '% · ' + describeQ2(), flight.base + flight.span * frac);
    setTimeout(runCaseMain, 0);
  }
  function finishCase() {
    var kind = flight.kind;
    var geom = flight.geom;
    var re = flight.re, im = flight.im;
    state.q2.times[kind] = performance.now() - flight.t0;
    state.maps[kind] = DirectQ2.packMap(re, im, geom);
    state.q2.center[kind] = DirectQ2.centerValue(re, im, geom.nObs);
    if (kind === 'inphase') {
      var disk = DirectQ2.diskFromHole(re, im);
      state.maps.disk = DirectQ2.packMap(disk.re, disk.im, geom);
      state.q2.center.disk = DirectQ2.centerValue(disk.re, disk.im, geom.nObs);
      state.q2.times.disk = 0;
    }
    if (kind === 'linear') {
      var peak = DirectQ2.peakOnAxis(state.maps.linear);
      var extra = DirectQ2.sumPoints(flight.src, geom, [peak.x], [0]);
      var Ir = extra.re[0], Ii = extra.im[0];
      state.q2.peak = { x: peak.x, I: Ir * Ir + Ii * Ii, Igrid: peak.Igrid };
    }
    updateShared();
    renderMaps();
    fillMaps();
    flight = null;
    nextCase();
  }

  function updateShared() {
    var keys = ['inphase', 'linear', 'disk'];
    var m = 1e-12;
    keys.forEach(function (k) { if (state.maps[k]) m = Math.max(m, state.maps[k].Imax); });
    state.shared = m;
  }

  /* 一组网格加密：标准档结果来自整条 I(r)；更密的两档在 r₄ 邻域重解 dI/dr = 0。 */
  function gridStudy(r4) {
    var ph = D.physics(PARAMS);
    var q = state.q1.raw.quad;
    var adopted = state.q1.fourth;
    var configs = [
      { name: '标准档 λ/' + q.pathFrac + '，GL ' + q.gl + '（本页采用）', h: q.h, r: adopted.r, I: adopted.I },
      { name: '加密 λ/80，GL 16', pathFrac: 80, gl: 16 },
      { name: '再加密 λ/160，GL 16', pathFrac: 160, gl: 16 }
    ];
    configs.forEach(function (c) {
      if (c.r != null) return;
      var quad = D.makeQuad(ph, Math.max(D.toSI(PARAMS.rMax_mm, 'mm'), r4 * 1.02), { pathFrac: c.pathFrac, gl: c.gl, nr: 0 });
      var f = function (x) { return D.dIda(x, ph, quad); };
      var a = r4 * 0.997, b = r4 * 1.003, fa = f(a), fb = f(b), r;
      if (fa * fb < 0) r = D.brentRoot(f, a, b, fa, fb, 1e-14, 80).x;
      else r = D.goldenExtremum(function (x) { return D.intensity(D.onAxisField(x, ph, quad)); }, a, b, -1, 1e-13);
      c.h = quad.h;
      c.r = r;
      c.I = D.intensity(D.onAxisField(r, ph, quad));
    });
    var ref = configs[configs.length - 1];
    configs.forEach(function (c) { c.dr_nm = (c.r - ref.r) * 1e9; c.dI = c.I - ref.I; });
    return configs;
  }

  function numbers() {
    var q = state.q1;
    var fourth = q.fourth;
    var r4 = fourth.r, I4 = fourth.I, r5 = q.raw.r4.rLimit;
    var ph = D.physics(PARAMS);
    var geom = 2 * ph.lambda * ph.z / r4;
    var q2 = state.q2;
    var plan = q2 && q2.plan;
    var rnd = state.maps.random;
    var inp = state.maps.inphase;
    var model = (q2 && plan) ? q2.N * Math.pow(plan.d * plan.d / (ph.lambda * ph.z), 2) : NaN;
    var speckle = (q2 && rnd) ? { Ncell: q2.N, mapMean: rnd.mean, Imodel: model } : null;
    return {
      ph: ph, r4: r4, I4: I4, r5: r5, geom: geom,
      nMax: q.maxima.length, nMin: q.minima.length, nPer: Math.max(0, q.maxima.length - 1),
      twoLL: 2 * ph.lambda * ph.z,
      diskI: q2 && q2.center.disk ? q2.center.disk.I : NaN,
      Icenter: q2 && q2.center.inphase ? q2.center.inphase.I : NaN,
      speckle: speckle, ImaxRand: rnd ? rnd.Imax : NaN, ImaxIn: inp ? inp.Imax : NaN,
      peak: q2 && q2.peak ? q2.peak.x : NaN,
      tilt: q2 ? q2.shift : geom,
      Ilin0: q2 && q2.center.linear ? q2.center.linear.I : NaN,
      Ishift: q2 && q2.peak ? q2.peak.I : NaN,
      dSrc: plan ? plan.d : NaN,
      seed: q2 ? q2.seed : SEED
    };
  }

  function fillAxis() {
    var s = numbers();
    var q = state.q1;
    $('pPath').textContent = String(D.PRECISION.standard.pathFrac);
    $('pGl').textContent = String(D.PRECISION.standard.gl);
    $('pNr').textContent = String(q.raw.curve.nr);
    $('p2Path').textContent = '10';
    if ($('pNobs')) $('pNobs').textContent = String(DirectQ2.N_OBS);
    var kl = 1 / (s.ph.k * s.ph.z);
    $('vKl').textContent = kl.toExponential(1);
    $('mR4').textContent = mm(s.r4, 6) + ' mm';
    $('mR4s').textContent = '内核 ' + mm(s.r4, 10) + ' mm';
    $('mI4').textContent = s.I4.toFixed(6);
    $('mI4s').textContent = 'N_F = ' + q.fourth.NF.toFixed(4);
    $('mR5').textContent = mm(s.r5, 10) + ' mm';
    $('mExt').textContent = s.nMax + ' 极大 / ' + s.nMin + ' 极小';
    $('mPer').textContent = s.nPer + ' 个完整周期';
    setAll('n-nmax', String(s.nMax));
    setAll('n-nmin', String(s.nMin));
    setAll('n-nper', String(s.nPer));
    setAll('n-2ll', (s.twoLL * 1e6).toFixed(3));
    setAll('n-r5full', mm(s.r5, 10));
    setAll('n-r4', mm(s.r4, 6));
    setAll('n-i4', s.I4.toFixed(6));
    fillExtrema();
    fillSamplingPartial();
    fillConv();
  }

  function fillSamplingPartial() {
    var q = state.q1.raw;
    var quad = q.quad;
    var ph = D.physics(PARAMS);
    var nodeNm = quad.pathPerNode * 1e9;
    var rows = [
      ['轴上径向积分', '面板 ≤ λ/' + quad.pathFrac, 'h = ' + um(quad.h, 3) + ' μm，GL ' + quad.gl + '，N_r = ' + q.curve.nr,
        '相邻节点 ' + nm(quad.pathPerNode, 2) + ' nm（λ/' + (ph.lambda / quad.pathPerNode).toFixed(0) + '）']
    ];
    paintRows('sampTable', rows);
  }

  function fillSamplingFull() {
    var q = state.q1.raw;
    var quad = q.quad;
    var ph = D.physics(PARAMS);
    var q2 = state.q2;
    if (!q2) { fillSamplingPartial(); return; }
    var plan = q2.plan;
    var ops = q2.N * plan.nObs * plan.nObs;
    var rows = [
      ['轴上径向积分', '面板 ≤ λ/' + quad.pathFrac, 'h = ' + um(quad.h, 3) + ' μm，GL ' + quad.gl + '，N_r = ' + q.curve.nr,
        '相邻节点 ' + nm(quad.pathPerNode, 2) + ' nm（λ/' + (ph.lambda / quad.pathPerNode).toFixed(0) + '）'],
      ['圆孔子光源', '角点光程差 ≤ λ/10，尽量稀疏', 'd = ' + um(plan.d, 3) + ' μm，N = ' + q2.N,
        '一阶上界 ' + nm(plan.boundPath, 2) + ' nm（λ/10），轴向相邻实际 ' + nm(q2.pathStep, 2) + ' nm（λ/' + q2.pathFrac.toFixed(2) + '）'],
      ['观察屏', '5 mm × 5 mm，间距 ≤ 25 μm', plan.nObs + '×' + plan.nObs + '，d = ' + um(plan.dObs, 2) + ' μm',
        '半宽 ±' + mm(plan.halfWidth, 3) + ' mm，散斑约 ' + um(plan.speckle, 0) + ' μm'],
      ['每一张图的加法', '观察点 × 子光源', ops.toExponential(3) + ' 次',
        '同相、线性、随机各算一遍；圆屏用 U′ 相减']
    ];
    paintRows('sampTable', rows);
  }

  function paintRows(tableId, rows) {
    var tb = $(tableId).querySelector('tbody');
    tb.innerHTML = rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
  }

  function fillConv() {
    var rows = state.conv.map(function (c) {
      return [c.name, (c.h * 1e6).toFixed(3), mm(c.r, 10), c.I.toFixed(9), sciSmall(c.dr_nm), sciSmall(c.dI)];
    });
    paintRows('convTable', rows);
  }

  function fillExtrema() {
    var q = state.q1;
    var prev = { max: null, min: null };
    var html = q.raw.extrema.map(function (e) {
      var rmm = e.r * 1e3;
      var r2 = rmm * rmm;
      var prevR = prev[e.kind];
      var d = prevR == null ? '—' : (r2 - prevR).toFixed(4);
      prev[e.kind] = r2;
      var hl = e.kind === 'max' && e.index === 4 ? ' class="hl"' : '';
      var label = (e.kind === 'max' ? '极大 ' : '极小 ') + e.index;
      return '<tr' + hl + '><td>' + label + '</td><td>' +
        mm(e.r, 6) + '</td><td>' + r2.toFixed(4) + '</td><td>' + e.NF.toFixed(4) + '</td><td>' +
        (e.I >= 1e-3 ? e.I.toFixed(6) : e.I.toExponential(2)) + '</td><td>' + d + '</td></tr>';
    }).join('');
    $('extTable').querySelector('tbody').innerHTML = html;
  }

  function fillMaps() {
    if (!state.q2) return;
    var s = numbers();
    fillSamplingFull();
    setAll('n-r4', mm(s.r4, 6));
    setAll('n-i4', s.I4.toFixed(6));
    setAll('n-dsrc', um(s.dSrc, 3));
    setAll('n-seed', String(s.seed >>> 0));
    setAll('n-nsrc', String(state.q2.N));
    setAll('n-nobs', String(state.q2.plan.nObs));
    setAll('n-dobs', um(state.q2.plan.dObs, 2));
    setAll('n-path', 'λ/' + state.q2.pathFrac.toFixed(2));
    var ops = state.q2.N * state.q2.plan.nObs * state.q2.plan.nObs;
    setAll('n-ops', ops.toExponential(2));
    if (Number.isFinite(s.Icenter)) setAll('n-icenter', s.Icenter.toFixed(6));
    if (Number.isFinite(s.ImaxRand)) setAll('n-imax-rand', s.ImaxRand.toFixed(5));
    var inv = s.ImaxIn > 0 && s.ImaxRand > 0 ? s.ImaxIn / s.ImaxRand : NaN;
    setAll('n-inv', Number.isFinite(inv) ? (inv >= 10 ? inv.toFixed(0) : inv.toFixed(1)) : '—');
    setAll('n-imean', s.speckle ? s.speckle.mapMean.toExponential(3) : '—');
    setAll('n-imodel', s.speckle ? s.speckle.Imodel.toExponential(3) : '—');
    setAll('n-geom', mm(s.geom, 3));
    if (Number.isFinite(s.peak)) setAll('n-peak', mm(s.peak, 3));
    setAll('n-ilin0', Number.isFinite(s.Ilin0) ? s.Ilin0.toFixed(3) : '—');
    setAll('n-ishift', Number.isFinite(s.Ishift) ? s.Ishift.toFixed(6) : '—');
    setAll('n-idisk', Number.isFinite(s.diskI) ? s.diskI.toFixed(6) : '—');
  }

  function finish() {
    fillMaps();
    var s = numbers();
    var checks = buildChecks(s);
    $('conclusion').textContent =
      '在 λ = 500 nm、L = 50 cm、标准精度下，轴上 I(r) 从 0 到 2.2 mm 有 ' + s.nMax + ' 个极大和 ' + s.nMin +
      ' 个极小，相邻极大之间有 ' + s.nPer + ' 个完整振荡周期。小孔区用自行选定的 5% 判据，I 与 r⁴ 的相对偏差不超过 5% 一直维持到 r ≤ ' +
      mm(s.r5, 10) + ' mm。第 4 个极大 r₄ = ' + mm(s.r4, 6) + ' mm（' + mm(s.r4, 10) + ' mm），I₄ = ' + s.I4.toFixed(6) +
      '。二维孔径就取这个半径，在孔内取 N = ' + state.q2.N + ' 个子光源（d = ' + um(s.dSrc, 3) +
      ' μm）：同相圆孔的屏中心 I = ' + s.Icenter.toFixed(6) + '；随机相位（种子 ' + (s.seed >>> 0) +
      '）的平均光强约 ' + (s.speckle ? s.speckle.mapMean.toExponential(3) : '—') +
      '；沿 X 的 8π 线性相位使图样朝 +X′ 移动约 ' + mm(s.geom, 3) +
      ' mm；不透明圆屏的泊松亮斑来自复振幅关系 U′_屏 = 1 − U′_孔，轴上 I = ' + s.diskI.toFixed(6) + '，不是光强相减。';
    var ul = $('checks');
    ul.innerHTML = checks.map(function (c) {
      return '<li class="' + (c.pass ? 'pass' : 'fail') + '">' + (c.pass ? '一致' : '不一致') + ' · ' + c.name + ' — ' + c.detail + '</li>';
    }).join('');
    var allPass = checks.every(function (c) { return c.pass; });
    var ms = performance.now() - state.t0;
    $('boot').hidden = true;
    $('app').setAttribute('aria-busy', 'false');
    $('btnExport').disabled = false;
    window.__submit.ready = true;
    setStatus((allPass ? '计算完成，参考值比对通过。' : '计算完成，但有参考值比对未通过。') + ' 用时 ' + (ms / 1000).toFixed(1) + ' s。', 1);
    var mapMs = 0;
    Object.keys(state.q2.times).forEach(function (k) { mapMs += state.q2.times[k]; });
    $('foot').textContent = '第一问 ' + state.engine + ' · 第二问 ' + (state.directEngine || '直接叠加') +
      ' · 全程 ' + (ms / 1000).toFixed(2) + ' s，其中三张图直接叠加 ' + (mapMs / 1000).toFixed(1) +
      ' s（圆屏由复振幅相减得到）。图中的数都是这一次计算得到的。';
    var summary = {
      r4_mm: s.r4 * 1e3, I4: s.I4, Icenter: s.Icenter, r5_mm: s.r5 * 1e3,
      nMax: s.nMax, nMin: s.nMin, nPer: s.nPer,
      geom_mm: s.geom * 1e3, tilt_mm: s.tilt * 1e3, peak_mm: s.peak * 1e3,
      Idisk: s.diskI, Ilin0: s.Ilin0, Ishift: s.Ishift,
      dSrc_um: s.dSrc * 1e6, dObs_um: state.q2.plan.dObs * 1e6, seed: s.seed >>> 0,
      N: state.q2.N, pathFrac: state.q2.pathFrac, pathStep_nm: state.q2.pathStep * 1e9,
      Ncell: s.speckle && s.speckle.Ncell,
      ImeanRand: s.speckle && s.speckle.mapMean, ImodelRand: s.speckle && s.speckle.Imodel,
      ImaxRand: s.ImaxRand, ImaxIn: s.ImaxIn,
      half_mm: state.q2.plan.halfWidth * 1e3,
      nObs: state.q2.plan.nObs,
      times_ms: state.q2.times, mapMs: mapMs,
      shared: state.shared, loadMs: ms, allPass: allPass,
      engine: state.engine, directEngine: state.directEngine
    };
    window.__submit.summary = summary;
    window.__submit.checks = checks;
    window.__submit.painted = state.painted;
    renderAll();
  }

  function buildChecks(s) {
    var r4mm = s.r4 * 1e3, r5mm = s.r5 * 1e3, geom = s.geom * 1e3, peak = s.peak * 1e3;
    var plan = state.q2.plan;
    var halfOk = plan.halfWidth + 1e-12 >= D.toSI(2.5, 'mm');
    var rows = [
      { name: 'r₄', pass: Math.abs(r4mm - REF.r4_mm) < 5e-11, detail: '计算 ' + r4mm.toFixed(10) + ' mm，参考 ' + REF.r4_mm.toFixed(10) + ' mm' },
      { name: 'I₄', pass: Math.abs(s.I4 - REF.I4) < 5e-9, detail: '计算 ' + s.I4.toFixed(9) + '，参考 ' + REF.I4.toFixed(6) },
      { name: '5% 边界', pass: Math.abs(r5mm - REF.r5_mm) < 5e-11, detail: '计算 ' + r5mm.toFixed(10) + ' mm，参考 ' + REF.r5_mm.toFixed(10) + ' mm' },
      { name: '极值个数', pass: s.nMax === REF.nMax && s.nMin === REF.nMin, detail: '计算 ' + s.nMax + ' 极大 / ' + s.nMin + ' 极小' },
      { name: '同相屏中心', pass: Math.abs(s.Icenter - REF.I4) < 5e-4, detail: '直接叠加 I = ' + s.Icenter.toFixed(6) + '，径向积分 I₄ = ' + s.I4.toFixed(6) },
      { name: '线性相位偏移', pass: Number(geom.toFixed(3)) === REF.shift_mm && peak > 0 && Math.abs(peak - geom) < 0.008,
        detail: '2λL/a = ' + geom.toFixed(6) + ' mm，峰值 X′ = ' + peak.toFixed(6) + ' mm，方向 +X′' },
      { name: '泊松亮斑', pass: Math.abs(s.diskI - 1) < 2e-3, detail: '直接叠加 I = ' + s.diskI.toFixed(6) + '（径向参考约 0.999993）' },
      { name: '视场', pass: halfOk && plan.nObs >= 201 && plan.dObs <= 25.05e-6 && state.q2.pathFrac + 1e-6 >= 10,
        detail: '半宽 ±' + mm(plan.halfWidth, 3) + ' mm，' + plan.nObs + '×' + plan.nObs + '，d = ' + um(plan.dObs, 2) + ' μm，角点 λ/' + state.q2.pathFrac.toFixed(2) },
      { name: '周期数', pass: s.nPer >= 5 && state.q1.raw.curve.rMax + 1e-15 >= D.toSI(2.2, 'mm'), detail: s.nPer + ' 个完整周期，r 扫到 ' + mm(state.q1.raw.curve.rMax, 3) + ' mm' }
    ];
    return rows;
  }

  /* ---------- 绘图 ---------- */
  var TURBO = (function () {
    var stops = [[0, 7, 18, 36], [0.17, 27, 16, 91], [0.33, 86, 23, 104], [0.5, 187, 55, 84], [0.67, 249, 142, 48], [0.83, 252, 223, 104], [1, 252, 254, 228]];
    var lut = new Uint8ClampedArray(1024 * 3);
    for (var n = 0; n < 1024; n++) {
      var t = n / 1023, i = 0;
      while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      var a = stops[i], b = stops[i + 1], u = (t - a[0]) / (b[0] - a[0] || 1);
      for (var c = 0; c < 3; c++) lut[n * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
    }
    return lut;
  })();
  function turbo(t) {
    var n = Math.round(Math.max(0, Math.min(1, t)) * 1023) * 3;
    return [TURBO[n], TURBO[n + 1], TURBO[n + 2]];
  }

  function drawAxial() {
    var cv = $('cAxial');
    if (!state.q1) return;
    var box = fit(cv), ctx = box.ctx, W = box.w, H = box.h;
    var curve = state.q1.raw.curve;
    var r = curve.r, I = curve.I, n = curve.nr;
    var r5 = state.q1.raw.r4.rLimit;
    var r4 = state.q1.fourth.r;
    var x0 = 0, x1 = curve.rMax;
    var yMax = 0;
    for (var i = 0; i < n; i++) if (I[i] > yMax) yMax = I[i];
    var y1 = niceStep(yMax * 1.12, 1) > yMax * 1.08 ? yMax * 1.12 : Math.ceil((yMax * 1.15) * 2) / 2;
    if (!(y1 > yMax)) y1 = yMax * 1.15;
    var pad = { l: 58, r: 14, t: 16, b: 36 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    function X(v) { return pad.l + (v - x0) / (x1 - x0) * pw; }
    function Y(v) { return pad.t + (1 - v / y1) * ph; }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    ctx.fillStyle = 'rgba(87, 219, 232, .10)';
    ctx.fillRect(X(0), pad.t, Math.max(0, X(r5) - X(0)), ph);
    ctx.restore();
    ctx.strokeStyle = '#1b2a3e'; ctx.lineWidth = 1; ctx.fillStyle = '#93aac2'; ctx.font = '12px ' + FONT;
    var xs = niceStep((x1 - x0) * 1e3, 6) * 1e-3;
    var ys = niceStep(y1, 5);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= x1 + xs * 0.1; x += xs) {
      ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), pad.t + ph); ctx.stroke();
      ctx.fillText((x * 1e3).toFixed(xs * 1e3 >= 1 ? 0 : 1), X(x), pad.t + ph + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var y = 0; y <= y1 + ys * 0.1; y += ys) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(y)); ctx.lineTo(pad.l + pw, Y(y)); ctx.stroke();
      ctx.fillText(y.toFixed(ys >= 1 ? 0 : 1), pad.l - 6, Y(y));
    }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    ctx.strokeStyle = '#57dbe8'; ctx.lineWidth = 1.6; ctx.beginPath();
    for (i = 0; i < n; i++) {
      var px = X(r[i]), py = Y(I[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ee79aa'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(X(r4), pad.t); ctx.lineTo(X(r4), pad.t + ph); ctx.stroke();
    ctx.setLineDash([]);
    state.q1.raw.extrema.forEach(function (e) {
      ctx.fillStyle = e.kind === 'max' && e.index === 4 ? '#ffc074' : (e.kind === 'max' ? '#ffc074' : '#9eb4c8');
      ctx.globalAlpha = e.kind === 'max' && e.index === 4 ? 1 : 0.85;
      ctx.beginPath(); ctx.arc(X(e.r), Y(e.I), e.index === 4 && e.kind === 'max' ? 4.2 : 2.2, 0, 6.283); ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.fillStyle = '#ffc074'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = '12px ' + FONT;
    var lx = Math.min(X(r4) + 6, pad.l + pw - 120);
    ctx.fillText('r₄ = ' + mm(r4, 6) + ' mm', lx, Y(state.q1.fourth.I) - 8);
    ctx.fillStyle = '#93aac2'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('r (mm)', pad.l + pw / 2, H - 2);
    ctx.save(); ctx.translate(16, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText('I / I_inc', 0, 0); ctx.restore();
    state.painted.axial = true;
  }

  function drawR4() {
    var cv = $('cR4');
    if (!state.q1) return;
    var box = fit(cv), ctx = box.ctx, W = box.w, H = box.h;
    var curve = state.q1.raw.curve;
    var C = state.q1.raw.r4.C;
    var r5 = state.q1.raw.r4.rLimit;
    var x1 = Math.min(curve.rMax, r5 * 1.6);
    var yMax = 0;
    for (var i = 0; i < curve.nr; i++) {
      if (curve.r[i] > x1) break;
      var cr = C * Math.pow(curve.r[i], 4);
      yMax = Math.max(yMax, curve.I[i], cr);
    }
    var y1 = yMax * 1.12;
    var pad = { l: 58, r: 14, t: 16, b: 36 };
    var pw = W - pad.l - pad.r, phh = H - pad.t - pad.b;
    function X(v) { return pad.l + v / x1 * pw; }
    function Y(v) { return pad.t + (1 - v / y1) * phh; }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#1b2a3e'; ctx.fillStyle = '#93aac2'; ctx.font = '12px ' + FONT; ctx.lineWidth = 1;
    var xs = niceStep(x1 * 1e3, 5) * 1e-3;
    var ys = niceStep(y1, 4);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var x = 0; x <= x1 + xs * 0.1; x += xs) {
      ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), pad.t + phh); ctx.stroke();
      ctx.fillText((x * 1e3).toFixed(xs * 1e3 >= 0.1 ? 2 : 3), X(x), pad.t + phh + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var y = 0; y <= y1 + ys * 0.1; y += ys) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(y)); ctx.lineTo(pad.l + pw, Y(y)); ctx.stroke();
      ctx.fillText(y.toFixed(ys >= 1 ? 1 : 2), pad.l - 6, Y(y));
    }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, phh); ctx.clip();
    ctx.fillStyle = 'rgba(255, 192, 116, .12)';
    ctx.fillRect(X(0), pad.t, X(r5) - X(0), phh);
    ctx.strokeStyle = '#ffc074'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.beginPath();
    var started = false;
    for (i = 0; i < curve.nr; i++) {
      if (curve.r[i] > x1) break;
      var yy = C * Math.pow(curve.r[i], 4);
      var px = X(curve.r[i]), py = Y(yy);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#57dbe8'; ctx.lineWidth = 1.7; ctx.beginPath(); started = false;
    for (i = 0; i < curve.nr; i++) {
      if (curve.r[i] > x1) break;
      px = X(curve.r[i]); py = Y(curve.I[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ee79aa'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(r5), pad.t); ctx.lineTo(X(r5), pad.t + phh); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ee79aa'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '12px ' + FONT;
    ctx.fillText('5% · r = ' + mm(r5, 6) + ' mm', Math.min(X(r5) + 6, pad.l + pw - 130), pad.t + 8);
    ctx.fillStyle = '#57dbe8'; ctx.fillText('— 数值 I', pad.l + 8, pad.t + 26);
    ctx.fillStyle = '#ffc074'; ctx.fillText('--- C·r⁴', pad.l + 8, pad.t + 42);
    ctx.fillStyle = '#93aac2'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('r (mm)', pad.l + pw / 2, H - 2);
    ctx.save(); ctx.translate(16, pad.t + phh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText('I / I_inc', 0, 0); ctx.restore();
    state.painted.r4 = true;
  }

  function bilinear(arr, n, i, j) {
    if (!(i >= 0) || !(j >= 0) || i > n - 1 || j > n - 1) return 0;
    var i0 = Math.max(0, Math.min(n - 2, Math.floor(i))), j0 = Math.max(0, Math.min(n - 2, Math.floor(j)));
    var ui = i - i0, uj = j - j0;
    var a = (1 - ui) * (1 - uj), b = ui * (1 - uj), c = (1 - ui) * uj, e = ui * uj;
    return a * arr[j0 * n + i0] + b * arr[j0 * n + i0 + 1] + c * arr[(j0 + 1) * n + i0] + e * arr[(j0 + 1) * n + i0 + 1];
  }
  function sampleMap(map, xp, yp) {
    var n = map.nObs, W = map.halfWidth, d = map.dObs;
    var fi = (xp + W) / d, fj = (yp + W) / d;
    return bilinear(map.I, n, Math.max(0, Math.min(n - 1, fi)), Math.max(0, Math.min(n - 1, fj)));
  }

  function drawMap(id, map, opt) {
    var cv = $(id);
    if (!map) return;
    opt = opt || {};
    var box = fit(cv), ctx = box.ctx, W = box.w, H = box.h;
    var Imax = opt.Imax > 0 ? opt.Imax : map.Imax;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060c16'; ctx.fillRect(0, 0, W, H);
    var ml = 46, mb = 34, mt = 8, mr = 62;
    var S = Math.max(40, Math.min(W - ml - mr, H - mt - mb));
    var vp = { x: ml + Math.max(0, (W - ml - mr - S) / 2), y: mt, S: S };
    var half = map.halfWidth;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var Sd = Math.max(16, Math.round(S * dpr));
    var off = document.createElement('canvas');
    off.width = Sd; off.height = Sd;
    var ictx = off.getContext('2d');
    var img = ictx.createImageData(Sd, Sd), data = img.data;
    var n = map.nObs, dObs = map.dObs, field = map.I;
    for (var y = 0; y < Sd; y++) {
      var xp = half * (1 - 2 * (y + 0.5) / Sd);
      var fi = (xp + half) / dObs;
      for (var x = 0; x < Sd; x++) {
        var yp = half * (1 - 2 * (x + 0.5) / Sd);
        var fj = (yp + half) / dObs;
        var val = bilinear(field, n, Math.max(0, Math.min(n - 1, fi)), Math.max(0, Math.min(n - 1, fj)));
        var t = Imax > 0 ? val / Imax : 0;
        var q = Math.round(Math.max(0, Math.min(1, t)) * 1023) * 3;
        var k = (y * Sd + x) * 4;
        data[k] = TURBO[q]; data[k + 1] = TURBO[q + 1]; data[k + 2] = TURBO[q + 2]; data[k + 3] = 255;
      }
    }
    ictx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, vp.x, vp.y, S, S);
    ctx.strokeStyle = '#3a526d'; ctx.strokeRect(vp.x + 0.5, vp.y + 0.5, S - 1, S - 1);
    function XY(xp0, yp0) {
      return {
        x: vp.x + (0.5 - yp0 / (2 * half)) * S,
        y: vp.y + (0.5 - xp0 / (2 * half)) * S
      };
    }
    var step = niceStep(2 * half * 1e3, 4) * 1e-3;
    ctx.fillStyle = '#93aac2'; ctx.font = '11px ' + FONT; ctx.strokeStyle = '#3a526d';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var tv = Math.ceil((-half) / step) * step; tv <= half + step * 1e-6; tv += step) {
      var p = XY(tv, 0);
      ctx.beginPath(); ctx.moveTo(vp.x - 4, p.y); ctx.lineTo(vp.x, p.y); ctx.stroke();
      ctx.fillText((Math.abs(tv) < step * 1e-6 ? 0 : tv * 1e3).toFixed(step * 1e3 >= 1 ? 0 : 1), vp.x - 6, p.y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (tv = Math.ceil((-half) / step) * step; tv <= half + step * 1e-6; tv += step) {
      p = XY(0, tv);
      ctx.beginPath(); ctx.moveTo(p.x, vp.y + S); ctx.lineTo(p.x, vp.y + S + 4); ctx.stroke();
      ctx.fillText((Math.abs(tv) < step * 1e-6 ? 0 : tv * 1e3).toFixed(step * 1e3 >= 1 ? 0 : 1), p.x, vp.y + S + 6);
    }
    ctx.font = '11px ' + FONT; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
    ctx.fillText("Y′ (mm)，+Y′ 向左", vp.x + S / 2, H - 1);
    ctx.save(); ctx.translate(12, vp.y + S / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle';
    ctx.fillText("X′ (mm)，+X′ 向上", 0, 0); ctx.restore();

    ctx.save(); ctx.beginPath(); ctx.rect(vp.x, vp.y, S, S); ctx.clip();
    var o = XY(0, 0);
    ctx.strokeStyle = 'rgba(234,244,255,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(vp.x, o.y); ctx.lineTo(vp.x + S, o.y); ctx.moveTo(o.x, vp.y); ctx.lineTo(o.x, vp.y + S); ctx.stroke();
    ctx.fillStyle = '#eaf4ff'; ctx.font = '12px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('O′', o.x + 4, o.y - 4);
    if (opt.peakX) {
      var pk = XY(opt.peakX, 0);
      ctx.strokeStyle = '#ffc074'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(pk.x, pk.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pk.x, pk.y); ctx.lineTo(pk.x - 6, pk.y + 9); ctx.lineTo(pk.x + 6, pk.y + 9); ctx.closePath(); ctx.fillStyle = '#ffc074'; ctx.fill();
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ffc074';
      ctx.beginPath(); ctx.moveTo(vp.x, pk.y); ctx.lineTo(vp.x + S, pk.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px ' + FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('朝 +X′', vp.x + S - 4, pk.y - 3);
    }
    if (opt.disk) {
      ctx.strokeStyle = '#ffc074'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(o.x, o.y, 7, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(7,13,24,.78)'; ctx.fillRect(o.x + 10, o.y + 6, 92, 18);
      ctx.fillStyle = '#ffc074'; ctx.font = '12px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('泊松亮斑', o.x + 14, o.y + 15);
    }
    if (opt.randomNote) {
      ctx.font = '12px ' + FONT;
      var lines = opt.randomNote;
      var wmax = 0;
      lines.forEach(function (ln) { wmax = Math.max(wmax, ctx.measureText(ln).width); });
      ctx.fillStyle = 'rgba(7,13,24,.8)';
      ctx.fillRect(vp.x + 6, vp.y + S - 8 - lines.length * 16, wmax + 12, lines.length * 16 + 6);
      ctx.fillStyle = '#ffc074'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach(function (ln, i) { ctx.fillText(ln, vp.x + 12, vp.y + S - 4 - (lines.length - i) * 16); });
    }
    ctx.restore();
    if (opt.peakX) {
      var label = '峰值 X′ = ' + (opt.peakMm || '') + ' mm';
      var sub = '2λL/a = ' + (opt.geomMm || '') + ' mm';
      var size = 12;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      do { ctx.font = size + 'px ' + FONT; size -= 1; }
      while (size >= 9 && Math.max(ctx.measureText(label).width, ctx.measureText(sub).width) > S - 16);
      ctx.font = (size + 1) + 'px ' + FONT;
      var tw2 = Math.min(S - 8, Math.max(ctx.measureText(label).width, ctx.measureText(sub).width) + 12);
      var bx2 = vp.x + 4, by2 = vp.y + S - 34;
      ctx.fillStyle = 'rgba(7,13,24,.82)';
      ctx.fillRect(bx2, by2, tw2, 32);
      ctx.fillStyle = '#ffc074';
      ctx.fillText(label, bx2 + 6, by2 + 10);
      ctx.fillText(sub, bx2 + 6, by2 + 24);
    }

    var bx0 = vp.x + S + 10, bw = 12, bh = S;
    for (var yy = 0; yy < bh; yy++) {
      var c = turbo(1 - yy / Math.max(1, bh - 1));
      ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      ctx.fillRect(bx0, vp.y + yy, bw, 1.2);
    }
    ctx.strokeStyle = '#3a526d'; ctx.strokeRect(bx0 + 0.5, vp.y + 0.5, bw, bh);
    ctx.fillStyle = '#eaf4ff'; ctx.font = '10px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    [0, Imax].forEach(function (v, idx) {
      var yy2 = vp.y + (idx === 0 ? bh : 0);
      ctx.fillText(v === 0 ? '0' : (v >= 0.01 ? v.toFixed(v >= 1 ? 2 : 3) : v.toExponential(1)), bx0 + bw + 3, yy2);
    });
    ctx.fillStyle = '#93aac2'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '10px ' + FONT;
    ctx.fillText(opt.scaleName || '', bx0 - 2, vp.y + bh + 16);
    state.painted[opt.key] = true;
  }

  function renderMaps() {
    var s = state.maps.inphase && state.maps.linear && state.maps.random ? numbers() : null;
    if (state.maps.inphase) drawMap('cIn', state.maps.inphase, { key: 'inphase', Imax: state.shared, scaleName: '共用' });
    if (state.maps.linear) {
      drawMap('cLin', state.maps.linear, {
        key: 'linear', Imax: state.shared, scaleName: '共用',
        peakX: s ? s.peak : null,
        peakMm: s ? mm(s.peak, 3) : '',
        geomMm: s ? mm(s.geom, 3) : ''
      });
    }
    if (state.maps.disk) drawMap('cDisk', state.maps.disk, { key: 'disk', Imax: state.shared, scaleName: '共用', disk: true });
    if (state.maps.random) {
      var note = null;
      if (s && s.ImaxIn > 0) {
        var inv = s.ImaxIn / s.ImaxRand;
        note = ['色标按本图最大值', '约为同相峰值的 1/' + (inv >= 10 ? inv.toFixed(0) : inv.toFixed(1))];
      }
      drawMap('cRand', state.maps.random, { key: 'random', Imax: state.maps.random.Imax, scaleName: '本图', randomNote: note });
    }
  }

  function renderPlots() { drawAxial(); drawR4(); }
  function renderAll() { if (state.q1) renderPlots(); renderMaps(); }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 80);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (state.q1) renderAll(); });

  /* ---------- 唯一的导出：把曲线和四张图合成一张 PNG ---------- */
  function buildSheet() {
    renderAll();
    var W = 1200, gap = 16, head = 78;
    var axial = $('cAxial'), r4 = $('cR4');
    var maps = [$('cIn'), $('cRand'), $('cLin'), $('cDisk')];
    var aw = W - 32, ah = Math.round(aw * axial.height / axial.width);
    var rh = Math.round(aw * r4.height / r4.width);
    var mw = Math.floor((W - 32 - gap * 3) / 4);
    var mh = Math.round(mw * maps[0].height / maps[0].width);
    var H = head + ah + rh + mh + 36;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#eaf4ff'; ctx.font = '600 22px ' + FONT; ctx.textBaseline = 'top';
    ctx.fillText('圆孔衍射 · 精简提交图', 16, 14);
    ctx.fillStyle = '#93aac2'; ctx.font = '14px ' + FONT;
    var s = numbers();
    ctx.fillText('λ = 500 nm，L = 50 cm，标准精度 · r₄ = ' + mm(s.r4, 6) + ' mm · I₄ = ' + s.I4.toFixed(6) +
      ' · 5% 边界 r ≤ ' + mm(s.r5, 7) + ' mm', 16, 44);
    var y = head;
    ctx.drawImage(axial, 16, y, aw, ah); y += ah + 8;
    ctx.drawImage(r4, 16, y, aw, rh); y += rh + 8;
    maps.forEach(function (c, i) { ctx.drawImage(c, 16 + i * (mw + gap), y, mw, mh); });
    return cv;
  }
  function exportPNG() {
    if (!window.__submit.ready) return;
    var cv = buildSheet();
    var a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = '圆孔衍射_精简提交图.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  $('btnExport').addEventListener('click', exportPNG);

  function centerI(map) {
    if (!map) return null;
    var n = map.nObs, c = (n - 1) >> 1;
    return map.I[c * n + c];
  }
  window.__submit.sample = function (key) { return centerI(state.maps[key]); };
  window.__submit.canvasURL = function (id) { return $(id).toDataURL('image/png'); };
  window.__submit.sheetURL = function () { return buildSheet().toDataURL('image/png'); };

  setStatus('正在计算轴上 I(r)…', 0.02);
  $('pPath').textContent = String(D.PRECISION.standard.pathFrac);
  $('pGl').textContent = String(D.PRECISION.standard.gl);
  $('p2Path').textContent = '10';
  if ($('pNobs')) $('pNobs').textContent = String(DirectQ2.N_OBS);
  setInterval(function () {
    if (!window.__submit.ready && state.statusText) paintStatus(null);
  }, 400);
  startEngine();
  var q1id = submit('q1', {});
  jobs[q1id]._label = '轴上曲线';
  jobs[q1id]._base = 0;
  jobs[q1id]._span = 0.08;
})();
