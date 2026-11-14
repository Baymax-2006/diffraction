/*
 * direct-q2.js — 第二问：在圆孔上取子光源，对观察屏逐点把复振幅加起来。
 *
 * 一阶瑞利–索末菲（精确距离 R，无旁轴近似），A = 1：
 *   U(X′,Y′) = (d² / (iλ)) Σ_j  t_j · L · exp(ik R_j) / R_j²
 *   R_j = sqrt( (X′−x_j)² + (Y′−y_j)² + L² )
 *   I = |U|²
 *
 * 数值上先提出公共相位 exp(ikL)，累加约化场 U′ = U exp(−ikL)。
 * |U′|² = |U|²。k(R−L) = k ρ² / (R+L)，避免 kR 的大数相减。
 * 1/i = −i，所以 U′ = (d²/λ) (S_im − i S_re)，S = Σ t_j (L/R²) exp(i k(R−L))。
 *
 * 子光源是正方形网格上、圆心在孔内的点，间距 d，每个代表面积 d²。
 * d 取角点光程差判据允许的最大值（尽量稀疏）：
 *   d = (λ/10) · sqrt(ρmax²+L²) / ρmax，ρmax = a + √2 · (W/2)
 * 观察屏用另一套更稀的网格，与源网格不必同间距。
 * 不透明圆屏不在这里取点：屏外是无限大透光区，见 diskFromHole。
 */
(function directQ2Module(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.DirectQ2 = api;
    (root.__kernelSrc = root.__kernelSrc || {}).direct = 'self.DirectQ2 = (' + factory + ')();';
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function directQ2Factory() {
  'use strict';

  /* 与 diffraction-q2.js 的 u01hash 同一算法：相位 = 2π · Hash(seed, m, n)。
   * m、n 是源网格整数下标，x = m d，y = n d，可以是负数。 */
  const SEED = 20261111;
  function hash01(seed, m, n) {
    let h = (seed >>> 0) ^ 0xA511E9B3;
    h = Math.imul(h ^ Math.imul(m | 0, 0x9E3779B9), 0x85EBCA6B);
    h = Math.imul(h ^ Math.imul(n | 0, 0xC2B2AE35), 0x27D4EB2D);
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 4294967296;
  }
  function hashPhase(seed, m, n) { return 2 * Math.PI * hash01(seed, m, n); }

  /* 沿 +X 从孔的 −a 到 +a 增加 8π。t = exp(i φ)，φ(−a) = 0，φ(+a) = 8π。 */
  function linearPhase(x, a) { return 8 * Math.PI * (x + a) / (2 * a); }

  /* 观察屏：至少 5 mm × 5 mm。散斑约 λL/(2a) ≈ 94 μm，间距取 25 μm（5 mm / 200），
   * 一边 201 点，能分开条纹和散斑，又比源网格稀得多。 */
  const N_OBS = 201;
  const HALF_M = 2.5e-3;

  function plan(ph, a, halfWidth) {
    halfWidth = halfWidth == null ? HALF_M : halfWidth;
    const nObs = N_OBS;
    const rhoMax = a + Math.SQRT2 * halfWidth;
    const Rmax = Math.hypot(rhoMax, ph.z);
    const d = (ph.lambda / 10) * Rmax / rhoMax;
    const dObs = nObs > 1 ? (2 * halfWidth) / (nObs - 1) : 0;
    const speckle = ph.lambda * ph.z / (2 * a);
    return {
      d: d, dObs: dObs, nObs: nObs, halfWidth: halfWidth,
      rhoMax: rhoMax, Rmax: Rmax,
      lambda: ph.lambda, L: ph.z, k: ph.k,
      speckle: speckle,
      boundPath: ph.lambda / 10
    };
  }

  /* 孔内子光源。kind：inphase | linear | random。t_j 预先写成实部、虚部。 */
  function collectSources(a, d, kind, seed) {
    const mMax = Math.floor(a / d + 1e-12);
    const x = [], y = [], tr = [], ti = [];
    for (let n = -mMax; n <= mMax; n++) {
      const Y = n * d;
      const yy = Y * Y;
      for (let m = -mMax; m <= mMax; m++) {
        const X = m * d;
        if (X * X + yy > a * a) continue;
        let re = 1, im = 0;
        if (kind === 'linear') {
          const phi = linearPhase(X, a);
          re = Math.cos(phi); im = Math.sin(phi);
        } else if (kind === 'random') {
          const phi = hashPhase(seed >>> 0, m, n);
          re = Math.cos(phi); im = Math.sin(phi);
        }
        x.push(X); y.push(Y); tr.push(re); ti.push(im);
      }
    }
    return {
      x: Float64Array.from(x), y: Float64Array.from(y),
      tr: Float64Array.from(tr), ti: Float64Array.from(ti),
      N: x.length, kind: kind, d: d, seed: seed >>> 0
    };
  }

  /* 相邻子光源到观察区角点 (half, half) 的实际光程差，取轴向邻居的最大 |ΔR|。 */
  function cornerPathStep(src, half, L) {
    const d = src.d, x = src.x, y = src.y, N = src.N;
    const Xc = half, Yc = half;
    const key = new Map();
    const R = new Float64Array(N);
    for (let s = 0; s < N; s++) {
      R[s] = Math.hypot(Xc - x[s], Yc - y[s], L);
      key.set(Math.round(x[s] / d) + ',' + Math.round(y[s] / d), s);
    }
    let maxStep = 0, pairs = 0;
    for (let s = 0; s < N; s++) {
      const m = Math.round(x[s] / d), n = Math.round(y[s] / d);
      const right = key.get((m + 1) + ',' + n);
      const up = key.get(m + ',' + (n + 1));
      if (right != null) { maxStep = Math.max(maxStep, Math.abs(R[s] - R[right])); pairs++; }
      if (up != null) { maxStep = Math.max(maxStep, Math.abs(R[s] - R[up])); pairs++; }
    }
    return { pathStep: maxStep, pairs: pairs };
  }

  /* 一个观察点：把全部子光源的复振幅加起来。返回 S 的实部、虚部（尚未乘 d²/(iλ)）。 */
  function accumulate(src, Xp, Yp, L, L2, k) {
    const x = src.x, y = src.y, tr = src.tr, ti = src.ti, N = src.N;
    let sr = 0, si = 0;
    for (let s = 0; s < N; s++) {
      const dx = Xp - x[s];
      const dy = Yp - y[s];
      const rho2 = dx * dx + dy * dy;
      const Rj = Math.sqrt(rho2 + L2);             // R_j
      const phi = k * rho2 / (Rj + L);             // k(R_j − L)
      const amp = L / (Rj * Rj);                   // L / R_j²
      const c = Math.cos(phi), sn = Math.sin(phi); // exp(i k(R−L))
      const pr = tr[s], pi = ti[s];                // t_j
      sr += amp * (pr * c - pi * sn);
      si += amp * (pr * sn + pi * c);
    }
    return { sr: sr, si: si };
  }

  function finishU(S, scale) {
    /* U′ = (d²/(iλ)) S = (d²/λ) (S_im − i S_re) */
    return { re: scale * S.si, im: -scale * S.sr };
  }

  /* 外层是观察点（按行），内层在 accumulate 里扫子光源。
   * 行范围 [row0, row1)。几何：X′ 沿 i，Y′ 沿 j，都从 −half 到 +half。 */
  function sumRows(src, geom, row0, row1, onRow) {
    const nObs = geom.nObs, half = geom.half, dObs = geom.dObs;
    const L = geom.L, L2 = L * L, k = geom.k;
    const scale = geom.d * geom.d / geom.lambda;
    const rows = row1 - row0;
    const re = new Float64Array(rows * nObs);
    const im = new Float64Array(rows * nObs);
    for (let j = row0; j < row1; j++) {
      const Yp = -half + j * dObs;
      const base = (j - row0) * nObs;
      for (let i = 0; i < nObs; i++) {
        const Xp = -half + i * dObs;
        const U = finishU(accumulate(src, Xp, Yp, L, L2, k), scale);
        re[base + i] = U.re;
        im[base + i] = U.im;
      }
      if (onRow) onRow(j);
    }
    return { re: re, im: im, row0: row0, row1: row1 };
  }

  /* 若干任意观察点，公式与 sumRows 相同。回归和峰值抽查用。 */
  function sumPoints(src, geom, xs, ys) {
    const L = geom.L, L2 = L * L, k = geom.k;
    const scale = geom.d * geom.d / geom.lambda;
    const n = xs.length;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      const U = finishU(accumulate(src, xs[p], ys[p], L, L2, k), scale);
      re[p] = U.re; im[p] = U.im;
    }
    return { re: re, im: im };
  }

  function intensityOf(re, im) {
    const n = re.length;
    const I = new Float32Array(n);
    let Imax = 0, Imin = Infinity, sum = 0;
    for (let k = 0; k < n; k++) {
      const v = re[k] * re[k] + im[k] * im[k];
      I[k] = v; sum += v;
      if (v > Imax) Imax = v;
      if (v < Imin) Imin = v;
    }
    return { I: I, Imax: Imax, Imin: Imin, mean: n ? sum / n : 0 };
  }

  /* U′_屏 = 1 − U′_孔。复振幅相减，不是光强相减。
   * 圆屏外面是无限大的开放区域，没法用有限个子光源把它铺满，所以用巴比涅关系。 */
  function diskFromHole(re, im) {
    const n = re.length;
    const dr = new Float64Array(n), di = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      dr[k] = 1 - re[k];
      di[k] = -im[k];
    }
    return { re: dr, im: di };
  }

  function packMap(re, im, geom) {
    const iv = intensityOf(re, im);
    return {
      re: re, im: im, I: iv.I, Imax: iv.Imax, Imin: iv.Imin, mean: iv.mean,
      nObs: geom.nObs, dObs: geom.dObs, halfWidth: geom.half
    };
  }

  /* Y′ = 0 的那一行上，用三点抛物线找峰值位置。 */
  function peakOnAxis(map) {
    const n = map.nObs, j = (n - 1) >> 1;
    let k = 0, best = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = map.I[j * n + i];
      if (v > best) { best = v; k = i; }
    }
    let x = -map.halfWidth + k * map.dObs;
    if (k > 0 && k < n - 1) {
      const y1 = map.I[j * n + (k - 1)], y2 = map.I[j * n + k], y3 = map.I[j * n + (k + 1)];
      const den = y1 - 2 * y2 + y3;
      if (den !== 0) {
        const delta = Math.max(-1, Math.min(1, 0.5 * (y1 - y3) / den));
        x += delta * map.dObs;
      }
    }
    return { x: x, Igrid: best, index: k };
  }

  function centerValue(re, im, nObs) {
    const c = (nObs - 1) >> 1;
    const k = c * nObs + c;
    return { re: re[k], im: im[k], I: re[k] * re[k] + im[k] * im[k] };
  }

  /* Worker 入口。direct-worker.js 和 file:// 的 Blob 都调用它。 */
  function workerOnMessage(ev) {
    const m = ev.data;
    if (!m || m.type !== 'sum') return;
    const part = sumRows(m.src, m.geom, m.row0, m.row1, function (row) {
      self.postMessage({ type: 'progress', id: m.id, row: row, row0: m.row0, row1: m.row1 });
    });
    self.postMessage({
      type: 'rows', id: m.id, row0: m.row0, row1: m.row1, re: part.re, im: part.im
    }, [part.re.buffer, part.im.buffer]);
  }

  return {
    SEED: SEED, N_OBS: N_OBS, HALF_M: HALF_M,
    hash01: hash01, hashPhase: hashPhase, linearPhase: linearPhase,
    plan: plan, collectSources: collectSources, cornerPathStep: cornerPathStep,
    accumulate: accumulate, sumRows: sumRows, sumPoints: sumPoints,
    intensityOf: intensityOf, diskFromHole: diskFromHole, packMap: packMap,
    peakOnAxis: peakOnAxis, centerValue: centerValue, workerOnMessage: workerOnMessage
  };
});
