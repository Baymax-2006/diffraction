/*
 * diffraction.js — 圆孔衍射数值内核（无 DOM，可在主线程 / Web Worker / Node 中运行）
 *
 * 物理模型（标量衍射，第一类瑞利–索末菲积分，时谐因子 e^{-iωt}）：
 *
 *   U(P) = (1/(iλ)) ∬_Σ U_inc(Q) · (z/R) · e^{ikR}/R  dS ,   I = |U|²
 *
 *   省略了严格 RS1 核中的 (1 − 1/(ikR)) 因子，其相对影响 ≤ 1/(k z) ≈ 1.6×10⁻⁷（λ=500 nm, z=50 cm）。
 *
 * 轴上点 O′：利用圆对称，dS = 2πρ dρ，R = √(z²+ρ²)，
 *
 *   U(O′) = (A/(iλ)) ∫₀^a 2πρ (z/R) e^{ikR}/R dρ
 *
 * 为避免 kR ~ 6×10⁶ rad 的大数相减，内核计算“约化场” U′ = U·e^{-ikz}，
 * 相位用 k(R−z) = kρ²/(R+z) 计算（无相消误差）；|U′|² = |U|²。
 *
 * 归一化：入射振幅 A = 1（实数，孔内均匀），入射光强 I_inc = |A|² = 1。
 * 不加遮挡的同一平面波，用同一积分约定在 O′ 处给出 |U|² = I_0 = I_inc = 1
 * （validate.js 用高斯渐变孔径数值验证）。因此界面上的 I/I_inc 与 I/I_0 数值相同。
 *
 * 所有长度内部一律用 SI 米；nm/μm/mm/cm 的换算只在 UNITS / toSI / fromSI 中进行。
 *
 * 本文件中“解析”函数（analyticCheck*, pathConditionRadius）只用于独立验算，
 * 绝不参与生成曲线、极值或 r⁴ 区间。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Diffraction = api;
    /* 仅模块包装：保存工厂函数源码，供 file:// 下用 Blob 创建 Web Worker（不改变任何物理） */
    (root.__kernelSrc = root.__kernelSrc || {}).diffraction = 'self.Diffraction = (' + String(factory) + ')();';
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 单位（集中换算） ---------------- */
  const UNITS = { m: 1, cm: 1e-2, mm: 1e-3, um: 1e-6, nm: 1e-9 };
  const toSI = (v, unit) => v * UNITS[unit];
  const fromSI = (v, unit) => v / UNITS[unit];

  /* ---------------- 题目预设（只读） ---------------- */
  const PRESET = Object.freeze({
    lambda_nm: 500,      // 波长 λ
    L_cm: 50,            // 衍射屏 → 观察屏距离 L = z
    A: 1,                // 入射振幅（实数，均匀）
    rMax_mm: 2.2,        // 第一问半径扫描上限（扩展参数，非题目条件）
    r4Threshold: 0.05,   // r⁴ 适用区默认判据：相对偏差 ≤ 5 %
    q2HalfWidth_mm: 2.5  // 第二问观察区半宽（5 mm × 5 mm）
  });

  /* 与界面输入框 min/max 同一套范围。jobs.js 入口与配置载入都用它，避免 λ=1 nm 之类的值进入求积。 */
  const PARAM_RANGES = Object.freeze({
    lambda_nm: Object.freeze({ min: 100, max: 2000, label: 'λ', unit: 'nm' }),
    L_cm: Object.freeze({ min: 1, max: 1000, label: 'L', unit: 'cm' }),
    rMax_mm: Object.freeze({ min: 0.3, max: 6, label: 'r_max', unit: 'mm' }),
    r4Threshold: Object.freeze({ min: 0.0001, max: 0.5, label: 'r⁴ 阈值', unit: '' }),
    r_mm: Object.freeze({ min: 0, max: 6, label: 'r', unit: 'mm' }),
    cell_um: Object.freeze({ min: 5, max: 200, label: '单元格', unit: 'μm' }),
    seed: Object.freeze({ min: 0, max: 4294967295, label: '种子', unit: '' })
  });
  function inRange(key, x) {
    const r = PARAM_RANGES[key];
    return Number.isFinite(x) && x >= r.min && x <= r.max;
  }
  function validateParams(p) {
    if (!p || typeof p !== 'object') throw new Error('缺少参数');
    const bad = [];
    if (!inRange('lambda_nm', Number(p.lambda_nm))) bad.push('λ ∈ [' + PARAM_RANGES.lambda_nm.min + ', ' + PARAM_RANGES.lambda_nm.max + '] nm');
    if (!inRange('L_cm', Number(p.L_cm))) bad.push('L ∈ [' + PARAM_RANGES.L_cm.min + ', ' + PARAM_RANGES.L_cm.max + '] cm');
    if (p.rMax_mm != null && !inRange('rMax_mm', Number(p.rMax_mm))) bad.push('r_max ∈ [' + PARAM_RANGES.rMax_mm.min + ', ' + PARAM_RANGES.rMax_mm.max + '] mm');
    if (p.r4Threshold != null && !inRange('r4Threshold', Number(p.r4Threshold))) bad.push('r⁴ 阈值 ∈ [' + (PARAM_RANGES.r4Threshold.min * 100) + ', ' + (PARAM_RANGES.r4Threshold.max * 100) + '] %');
    if (p.A != null && !(Number(p.A) > 0)) bad.push('A > 0');
    if (bad.length) throw new Error('参数超出合法范围：' + bad.join('；'));
    return true;
  }

  /* ---------------- 精度预设 ----------------
   * 两类采样彼此独立：
   * (a) 源平面积分采样（孔面 ρ 方向）：
   *     pathFrac = q：径向积分面板宽度 h 使相邻面板端点在最远处的传播光程差 ≤ λ/q
   *     gl       ：每个面板内的 Gauss–Legendre 节点数
   * (b) 观察量的半径扫描采样（I(r) 曲线上的 r 点）：
   *     nr          ：最少半径采样点数（题目预设下就是实际点数）
   *     rPhaseStep  ：相邻两个半径采样点之间边缘相位 k(R−L) 的最大增量（弧度）。
   *                   I(r) 的振荡周期对应相位 2π（ΔN_F ≈ 2），所以每周期至少 2π/rPhaseStep 个点。
   *                   实际 N_r = max(nr, ⌈r_max/Δr⌉+1)，Δr = rPhaseStep·R_max/(k·r_max)，上限 nrCap。
   *     refineBudget：极值精化（dI/dr=0 的 Brent 求根）允许的被积函数求值次数估计上限；
   *                   超出时（只可能在预览档遇到）改用三点抛物线插值，并在结果中注明。
   */
  const PRECISION = Object.freeze({
    preview:  Object.freeze({ key: 'preview',  label: '预览', pathFrac: 10, gl: 4,  nr: 800,   rPhaseStep: Math.PI / 4,  nrCap: 60000,  refineBudget: 4e7 }),
    standard: Object.freeze({ key: 'standard', label: '标准', pathFrac: 20, gl: 8,  nr: 4000,  rPhaseStep: Math.PI / 20, nrCap: 200000, refineBudget: Infinity }),
    high:     Object.freeze({ key: 'high',     label: '高精', pathFrac: 40, gl: 12, nr: 16000, rPhaseStep: Math.PI / 80, nrCap: 400000, refineBudget: Infinity })
  });

  function physics(p) {
    const lambda = toSI(p.lambda_nm, 'nm');
    const z = toSI(p.L_cm, 'cm');
    const A = p.A == null ? 1 : p.A;
    return { lambda, z, k: 2 * Math.PI / lambda, A, lambda_nm: p.lambda_nm, L_cm: p.L_cm };
  }

  /* ---------------- Gauss–Legendre 节点 ---------------- */
  const glCache = {};
  function glNodes(n) {
    if (glCache[n]) return glCache[n];
    const x = new Float64Array(n), w = new Float64Array(n);
    const m = Math.ceil(n / 2);
    for (let i = 0; i < m; i++) {
      let t = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp = 0, t1;
      do {
        let p1 = 1, p2 = 0;
        for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * t * p2 - (j - 1) * p3) / j; }
        pp = n * (t * p1 - p2) / (t * t - 1);
        t1 = t; t = t1 - p1 / pp;
      } while (Math.abs(t - t1) > 1e-15);
      x[i] = -t; x[n - 1 - i] = t;
      w[i] = w[n - 1 - i] = 2 / ((1 - t * t) * pp * pp);
    }
    return (glCache[n] = { x, w, n });
  }

  /* ---------------- 采样（源平面径向） ----------------
   * 轴上点：dR/dρ = ρ/R，面板宽 h 产生的最大光程差 ΔR ≈ (ρmax/Rmax)·h。
   * 令 ΔR ≤ λ/q  ⇒  h = λ·Rmax / (q·ρmax)。整个 [0, ρmax] 用同一 h（保守）。
   */
  function makeQuad(ph, rhoMax, prec) {
    const Rmax = Math.hypot(ph.z, rhoMax);
    const h = ph.lambda * Rmax / (prec.pathFrac * rhoMax);
    const g = glNodes(prec.gl);
    // GL 节点在面板内的最大相邻间距（含跨面板）
    let maxGap = 0;
    for (let i = 1; i < g.n; i++) maxGap = Math.max(maxGap, (g.x[i] - g.x[i - 1]) / 2);
    maxGap = Math.max(maxGap, (1 + g.x[0]) / 2 * 2); // 面板边界两侧节点距离
    const nodeGap = maxGap * h;
    const pathPerPanel = h * rhoMax / Rmax;               // 面板对应光程差（米）
    const pathPerNode = nodeGap * rhoMax / Rmax;           // 相邻节点光程差（米）
    return {
      h, gl: prec.gl, pathFrac: prec.pathFrac, rhoMax,
      nodeGap, pathPerPanel, pathPerNode,
      phasePerPanel: ph.k * pathPerPanel, phasePerNode: ph.k * pathPerNode
    };
  }

  /* ---------------- 采样（观察量：半径扫描 r） ----------------
   * 与 makeQuad（源平面积分）分开：这里决定 I(r) 曲线在 r 上取多少点，防止振荡被混叠。
   * 边缘相位 φ(r) = k(R(r) − L)，dφ/dr = k·r/R ≤ k·r_max/R_max。令相邻采样 Δφ ≤ rPhaseStep：
   *   Δr ≤ rPhaseStep·R_max/(k·r_max)，ΔN_F ≈ Δφ/π。
   */
  function radiusSampling(ph, rMax, prec) {
    const Rmax = Math.hypot(ph.z, rMax);
    const step = prec.rPhaseStep || Math.PI / 4;
    const base = Math.max(2, prec.nr || 2);
    const drNeed = step * Rmax / (ph.k * rMax);
    const nNeed = Math.ceil(rMax / drNeed - 1e-9) + 1;
    const cap = prec.nrCap || 400000;
    const nr = Math.min(cap, Math.max(base, nNeed));
    const dr = rMax / (nr - 1);
    const phaseStep = ph.k * dr * rMax / Rmax;      // 实际相邻采样边缘相位增量上界（rad）
    const NFmax = rMax * rMax / (ph.lambda * ph.z);
    return { nr, nrBase: base, nrNeed: nNeed, capped: nNeed > cap, dr, phaseStepBound: step, phaseStep,
      dNF: 2 * rMax * dr / (ph.lambda * ph.z), samplesPerPeriod: 2 * Math.PI / phaseStep, NFmax };
  }

  /* 径向被积函数（约化）：2πρ (z/R) e^{ik(R−z)}/R ，返回 [amp, phase] */
  function radialIntegrand(rho, ph) {
    const R = Math.sqrt(ph.z * ph.z + rho * rho);
    return [2 * Math.PI * rho * ph.z / (R * R), ph.k * rho * rho / (R + ph.z)];
  }

  /* 在 [r0, r1] 上用一个 GL 面板积分，结果累加进 acc = [Sre, Sim]（未乘 A/(iλ)） */
  function integratePanel(r0, r1, ph, g, acc) {
    const mid = 0.5 * (r0 + r1), half = 0.5 * (r1 - r0);
    let sr = 0, si = 0;
    for (let i = 0; i < g.n; i++) {
      const rho = mid + half * g.x[i];
      const R = Math.sqrt(ph.z * ph.z + rho * rho);
      const amp = g.w[i] * 2 * Math.PI * rho * ph.z / (R * R);
      const phi = ph.k * rho * rho / (R + ph.z);
      sr += amp * Math.cos(phi); si += amp * Math.sin(phi);
    }
    acc[0] += half * sr; acc[1] += half * si;
  }

  /* S → U′ = (A/(iλ))·S */
  function finish(S, ph) {
    return { re: ph.A * S[1] / ph.lambda, im: -ph.A * S[0] / ph.lambda };
  }

  /* 直接积分：给定半径 a，面板宽度 ≤ quad.h，面板边界随 a 自适应 */
  function onAxisField(a, ph, quad) {
    if (a <= 0) return { re: 0, im: 0 };
    const g = glNodes(quad.gl);
    const N = Math.max(1, Math.ceil(a / quad.h - 1e-12));
    const w = a / N, S = [0, 0];
    for (let j = 0; j < N; j++) integratePanel(j * w, (j + 1) * w, ph, g, S);
    return finish(S, ph);
  }

  /* 对照用：等面积权重“环带求和”（中点规则）。每环面积 π(ρ₂²−ρ₁²)，核值取在环中点 */
  function onAxisFieldRingSum(a, ph, dr) {
    const N = Math.max(1, Math.ceil(a / dr - 1e-12));
    const w = a / N; let sr = 0, si = 0;
    for (let j = 0; j < N; j++) {
      const r0 = j * w, r1 = r0 + w, rm = 0.5 * (r0 + r1);
      const area = Math.PI * (r1 * r1 - r0 * r0);
      const R = Math.sqrt(ph.z * ph.z + rm * rm);
      const amp = area * ph.z / (R * R), phi = ph.k * rm * rm / (R + ph.z);
      sr += amp * Math.cos(phi); si += amp * Math.sin(phi);
    }
    return finish([sr, si], ph);
  }

  const intensity = (U) => U.re * U.re + U.im * U.im;
  /* 圆屏 = 无遮挡平面波减去圆孔，在复振幅上做。 */
  function babinetField(U, A) {
    const a = A == null ? 1 : A;
    return { re: a - U.re, im: -U.im };
  }
  /* 第二问直接积分的 GL 点数：pathFrac/2，至少 4。 */
  function glForPath(pathFrac) { return Math.max(4, Math.round((pathFrac || 10) / 2)); }
  /* I[j] 相对左右邻居是极大、极小，或都不是。 */
  function extremumKind(I, j) {
    if (I[j] > I[j - 1] && I[j] >= I[j + 1]) return 'max';
    if (I[j] < I[j - 1] && I[j] <= I[j + 1]) return 'min';
    return '';
  }

  /* 被积函数在边缘的值 K(a) = (A/(iλ))·2πa(z/R)e^{ik(R−z)}/R，即 dU′/da（微积分基本定理） */
  function edgeKernel(a, ph) {
    const [amp, phi] = radialIntegrand(a, ph);
    const re = amp * Math.cos(phi), im = amp * Math.sin(phi);
    return { re: ph.A * im / ph.lambda, im: -ph.A * re / ph.lambda };
  }
  /* dI/da = 2 Re(conj(U′)·dU′/da)，U′ 来自数值积分 */
  function dIda(a, ph, quad) {
    const U = onAxisField(a, ph, quad), K = edgeKernel(a, ph);
    return 2 * (U.re * K.re + U.im * K.im);
  }

  /* ---------------- I(r) 曲线：面板前缀和 + 末段部分面板 ----------------
   * 面板 [jh,(j+1)h] 的积分做前缀和；对每个半径 x，fieldAt(x) = 前缀[m] + ∫_{mh}^{x}（GL）。
   * 极值精化与 r⁴ 二分都走 fieldAt，不再从 0 重积分。
   * 这与 onAxisField 是同一个求积规则族，只是面板边界不同，二者的差可作为交叉检查。
   */
  function panelPrefix(ph, rMax, quad, onProgress) {
    const g = glNodes(quad.gl);
    const Np = Math.ceil(Math.max(rMax, 0) / quad.h) + 1;
    const prefix = new Float64Array(2 * (Np + 1));
    const S = [0, 0];
    for (let j = 0; j < Np; j++) {
      integratePanel(j * quad.h, (j + 1) * quad.h, ph, g, S);
      prefix[2 * (j + 1)] = S[0]; prefix[2 * (j + 1) + 1] = S[1];
      if (onProgress && (j & 1023) === 0) onProgress(j / Np);
    }
    return prefix;
  }
  /* prefix[2m], prefix[2m+1] = ∫_0^{m h}。x 落在第 m 块时只再积一段部分面板。 */
  function fieldAtPrefix(x, ph, quad, prefix) {
    if (!(x > 0)) return { re: 0, im: 0 };
    const h = quad.h, g = glNodes(quad.gl);
    const nPanels = (prefix.length >> 1) - 1;
    let m = Math.floor(x / h);
    if (m < 0) m = 0;
    if (m >= nPanels) {
      const T = [prefix[2 * nPanels], prefix[2 * nPanels + 1]];
      let left = nPanels * h;
      while (left + h < x - 1e-15) { integratePanel(left, left + h, ph, g, T); left += h; }
      if (x > left) integratePanel(left, x, ph, g, T);
      return finish(T, ph);
    }
    const T = [prefix[2 * m], prefix[2 * m + 1]];
    if (x > m * h) integratePanel(m * h, x, ph, g, T);
    return finish(T, ph);
  }
  function makeFieldAt(ph, rMax, quad) {
    const prefix = panelPrefix(ph, rMax, quad);
    return { prefix, fieldAt: (x) => fieldAtPrefix(x, ph, quad, prefix) };
  }
  function onAxisCurve(ph, rMax, nr, quad, onProgress) {
    const Np = Math.ceil(rMax / quad.h) + 1;
    const pre = panelPrefix(ph, rMax, quad, onProgress && ((f) => onProgress(0.5 * f)));
    const fieldAt = (x) => fieldAtPrefix(x, ph, quad, pre);
    const r = new Float64Array(nr), re = new Float64Array(nr), im = new Float64Array(nr), I = new Float64Array(nr);
    const denom = Math.max(1, nr - 1);
    for (let i = 0; i < nr; i++) {
      const ri = rMax * i / denom;
      r[i] = ri;
      const U = fieldAt(ri);
      re[i] = U.re; im[i] = U.im; I[i] = U.re * U.re + U.im * U.im;
      if (onProgress && (i & 2047) === 0) onProgress(0.5 + 0.5 * i / nr);
    }
    return { r, re, im, I, nr, rMax, panels: Np, prefix: pre, fieldAt };
  }

  /* ---------------- 极值：离散峰值检测 + dI/dr 求根精化 ---------------- */
  function brentRoot(f, a, b, fa, fb, tol, maxIt) {
    // Brent 方法（Numerical Recipes 形式）
    let c = b, fc = fb, d = b - a, e = d;
    for (let it = 0; it < (maxIt || 200); it++) {
      if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) { c = a; fc = fa; e = d = b - a; }
      if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
      const tol1 = 2 * 1e-16 * Math.abs(b) + 0.5 * tol, xm = 0.5 * (c - b);
      if (Math.abs(xm) <= tol1 || fb === 0) return { x: b, it };
      if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
        let p, q, r, s = fb / fa;
        if (a === c) { p = 2 * xm * s; q = 1 - s; }
        else { q = fa / fc; r = fb / fc; p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1); }
        if (p > 0) q = -q; p = Math.abs(p);
        if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; }
        else { d = xm; e = d; }
      } else { d = xm; e = d; }
      a = b; fa = fb;
      b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
      fb = f(b);
    }
    return { x: b, it: maxIt };
  }

  /* 黄金分割（无导数）：求 sign·f 的极小。极大用 sign = −1，极小用 sign = +1 */
  function goldenExtremum(f, a, b, sign, tol) {
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = b - gr * (b - a), d = a + gr * (b - a), fc = sign * f(c), fd = sign * f(d);
    while (Math.abs(b - a) > tol) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = sign * f(c); }
      else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = sign * f(d); }
    }
    return 0.5 * (a + b);
  }

  function findExtrema(curve, ph, quad, opts) {
    opts = opts || {};
    const { r, I } = curve, n = r.length, out = [];
    /* 优先用曲线自带的面板前缀：每次求值只积最后一块，而不是从 0 重来。 */
    const fieldAt = opts.fieldAt || curve.fieldAt || ((x) => onAxisField(x, ph, quad));
    const dI = (x) => { const U = fieldAt(x), K = edgeKernel(x, ph); return 2 * (U.re * K.re + U.im * K.im); };
    let nMax = 0, nMin = 0;
    for (let j = 1; j < n - 1; j++) {
      if (opts.onProgress && (j & 255) === 0) opts.onProgress(j / n);
      const kind = extremumKind(I, j);
      if (!kind) continue;
      const isMax = kind === 'max';
      let rr = r[j];
      if (opts.refine === 'parabolic') {
        // 三点抛物线插值（仅用于预览档、极值很多时；不是 dI/dr=0 精化）
        const den = I[j - 1] - 2 * I[j] + I[j + 1];
        const dx = den !== 0 ? 0.5 * (I[j - 1] - I[j + 1]) / den : 0;
        rr = r[j] + Math.max(-0.5, Math.min(0.5, dx)) * (r[j + 1] - r[j - 1]) / 2;
      } else if (opts.refine !== false) {
        const f = dI;
        let a = r[j - 1], b = r[j + 1], fa = f(a), fb = f(b);
        if (fa * fb < 0) rr = brentRoot(f, a, b, fa, fb, opts.tol || 1e-14, 200).x;
        else rr = goldenExtremum((x) => intensity(fieldAt(x)), a, b, isMax ? -1 : 1, 1e-12);
      }
      let U, Iv;
      if (opts.refine === 'parabolic') {   // 由曲线复振幅线性插值（与 I(r) 曲线同源）
        const k0 = rr < r[j] ? j - 1 : j, k1 = k0 + 1;
        const u = (rr - r[k0]) / (r[k1] - r[k0]);
        U = { re: curve.re[k0] * (1 - u) + curve.re[k1] * u, im: curve.im[k0] * (1 - u) + curve.im[k1] * u };
      } else U = fieldAt(rr);
      Iv = intensity(U);
      const NF = rr * rr / (ph.lambda * ph.z);
      const idx = isMax ? ++nMax : ++nMin;
      out.push({ kind, index: idx, r: rr, rDiscrete: r[j], I: Iv, IDiscrete: I[j], NF, zone: Math.round(NF), U });
    }
    return out;
  }

  /* ---------------- r⁴ 适用区 ----------------
   * 系数 C 由数值积分在极小半径 r_s 处得到：C = I(r_s)/r_s⁴（r_s = 10⁻³·√(λz)，N_F = 10⁻⁶）。
   * 误差标准：ε(r) = | I(r) / (C r⁴) − 1 |；适用区 = 从 0 起 ε 连续 ≤ 阈值的最大 r（二分精化）。
   */
  function r4Coefficient(ph, quad) {
    const rs = 1e-3 * Math.sqrt(ph.lambda * ph.z);
    const q = Object.assign({}, quad, { h: Math.min(quad.h, rs / 4) });
    const I = intensity(onAxisField(rs, ph, q));
    return { C: I / Math.pow(rs, 4), rs };
  }
  function r4Analysis(curve, ph, quad, threshold) {
    const { C, rs } = r4Coefficient(ph, quad);
    const { r, I } = curve, n = r.length;
    const eps = new Float64Array(n);
    eps[0] = 0;
    for (let i = 1; i < n; i++) eps[i] = Math.abs(I[i] / (C * Math.pow(r[i], 4)) - 1);
    let j = 1;
    while (j < n && eps[j] <= threshold) j++;
    let rLim = r[n - 1], refined = false;
    const fieldAt = curve.fieldAt || ((x) => onAxisField(x, ph, quad));
    if (j < n) {
      const f = (x) => Math.abs(intensity(fieldAt(x)) / (C * Math.pow(x, 4)) - 1) - threshold;
      let a = r[j - 1], b = r[j];
      for (let it = 0; it < 80; it++) { const m = 0.5 * (a + b); if (f(m) <= 0) a = m; else b = m; if (b - a < 1e-13) break; }
      rLim = 0.5 * (a + b); refined = true;
    }
    return { C, rs, eps, threshold, rLimit: rLim, NFLimit: rLim * rLim / (ph.lambda * ph.z), refined };
  }

  /* ---------------- 振动曲线（相量）分段：每段由完整 GL 求积给出 ---------------- */
  function segmentPhasors(a, M, ph, quad) {
    const out = [];
    let acc = { re: 0, im: 0 };
    const g = glNodes(quad.gl);
    for (let s = 0; s < M; s++) {
      const r0 = a * s / M, r1 = a * (s + 1) / M;
      const N = Math.max(1, Math.ceil((r1 - r0) / quad.h));
      const S = [0, 0];
      for (let j = 0; j < N; j++) integratePanel(r0 + (r1 - r0) * j / N, r0 + (r1 - r0) * (j + 1) / N, ph, g, S);
      const d = finish(S, ph);
      out.push({ r0, r1, re: d.re, im: d.im, nodes: N * quad.gl, startRe: acc.re, startIm: acc.im });
      acc = { re: acc.re + d.re, im: acc.im + d.im };
    }
    return { segments: out, sum: acc };
  }

  /* 共享传播核（约化）：h(ξ,η) = (z/R) e^{ik(R−z)}/R，R=√(z²+ξ²+η²)。
   * 第一问径向积分、fieldAtPoint2D 与第二问 FFT 卷积都用同一核；不含 1/(iλ) 与面积元。
   */
  function rsKernelReduced(dx, dy, ph) {
    const s2 = dx * dx + dy * dy, R = Math.sqrt(ph.z * ph.z + s2);
    return { amp: ph.z / (R * R), phi: ph.k * s2 / (R + ph.z), R };
  }

  /* ---------------- 通用二维直接积分（为第二问准备，极坐标网格） ----------------
   * 观察点 (xp, yp, z)，孔面点 (X, Y) = (ρcosθ, ρsinθ)；入射相位 phaseFn(X,Y)（弧度，可空）。
   * 网格：ρ 用 GL 面板（宽 ≤ d），θ 均匀 Nθ = ceil(2πa/d)（周期函数用梯形 = 谱精度）。
   * 返回完整（非约化）复振幅中提取 e^{ikz} 后的 U′。
   * opts.babinetDisk：在复振幅层面做 U′_disk = U′_free − U′_hole，U′_free = A（与 I_0 → 1 的归一化一致）。
   */
  function fieldAtPoint2D(xp, yp, a, ph, opts) {
    const d = opts.d, gl = glNodes(opts.gl || 6), phaseFn = opts.phaseFn || null;
    const Np = Math.max(1, Math.ceil(a / d)), w = a / Np;
    const Nt = Math.max(16, Math.ceil(2 * Math.PI * a / d));
    const dth = 2 * Math.PI / Nt;
    const cs = new Float64Array(Nt), sn = new Float64Array(Nt);
    for (let t = 0; t < Nt; t++) { cs[t] = Math.cos(t * dth); sn[t] = Math.sin(t * dth); }
    let sr = 0, si = 0;
    for (let p = 0; p < Np; p++) {
      const mid = (p + 0.5) * w, half = 0.5 * w;
      for (let i = 0; i < gl.n; i++) {
        const rho = mid + half * gl.x[i], wr = gl.w[i] * half * rho * dth;
        for (let t = 0; t < Nt; t++) {
          const X = rho * cs[t], Y = rho * sn[t];
          const kn = rsKernelReduced(xp - X, yp - Y, ph);
          const phi = kn.phi + (phaseFn ? phaseFn(X, Y) : 0);
          const amp = wr * kn.amp;
          sr += amp * Math.cos(phi); si += amp * Math.sin(phi);
        }
      }
    }
    let U = finish([sr, si], ph);
    if (opts.babinetDisk) U = babinetField(U, ph.A);
    return { U, samples: Np * gl.n * Nt, Nrho: Np * gl.n, Ntheta: Nt, babinetDisk: !!opts.babinetDisk };
  }

  /* 轴上互补屏：从 ρ = a 积到外侧。渐变 exp(−((ρ−a)/w)²) 在孔边 ρ = a 处为 1，
   * 只用来让远处积分收敛，不在孔边人为削掉一截。对照 1 − U_hole（圆孔无渐变）。 */
  function complementaryOnAxis(ph, a, wTaper, prec) {
    prec = prec || { pathFrac: 10, gl: 6 };
    wTaper = wTaper || 12e-3;
    const rhoMax = Math.max(a + 6 * wTaper, 6 * wTaper);
    const quad = makeQuad(ph, rhoMax, prec);
    const g = glNodes(quad.gl);
    const N = Math.max(1, Math.ceil((rhoMax - a) / quad.h));
    const w = (rhoMax - a) / N;
    let sr = 0, si = 0;
    for (let j = 0; j < N; j++) {
      const mid = a + (j + 0.5) * w, half = 0.5 * w;
      for (let i = 0; i < g.n; i++) {
        const rho = mid + half * g.x[i];
        if (rho < a) continue;
        const [amp, phi] = radialIntegrand(rho, ph);
        const x = (rho - a) / wTaper;
        const taper = Math.exp(-x * x);
        const aa = g.w[i] * half * amp * taper;
        sr += aa * Math.cos(phi); si += aa * Math.sin(phi);
      }
    }
    return { U: finish([sr, si], ph), rhoMax, wTaper, panels: N, h: w };
  }

  /* 不加遮挡平面波的数值 I_0（高斯渐变孔径，避免硬截断振荡），用于验证归一化 */
  function freeFieldTapered(ph, wTaper, prec) {
    const rhoMax = 6 * wTaper;
    const quad = makeQuad(ph, rhoMax, prec);
    const g = glNodes(quad.gl), N = Math.ceil(rhoMax / quad.h), w = rhoMax / N;
    let sr = 0, si = 0;
    for (let j = 0; j < N; j++) {
      const mid = (j + 0.5) * w, half = 0.5 * w;
      for (let i = 0; i < g.n; i++) {
        const rho = mid + half * g.x[i];
        const [amp, phi] = radialIntegrand(rho, ph);
        const a = g.w[i] * half * amp * Math.exp(-(rho / wTaper) * (rho / wTaper));
        sr += a * Math.cos(phi); si += a * Math.sin(phi);
      }
    }
    return { U: finish([sr, si], ph), panels: N, h: w };
  }

  /* ---------------- 第二问采样规划（λ/10 光程判据 + 入射相位梯度） ---------------- */
  function phase2Plan(ph, a, halfWidth, opts) {
    opts = opts || {};
    const frac = opts.pathFrac || 10, incSpan = opts.incPhaseSpan == null ? 0 : opts.incPhaseSpan;
    if (!(a > 0) || !(halfWidth >= 0)) {
      return {
        a: a || 0, halfWidth: halfWidth || 0, pathFrac: frac, target: ph.lambda / frac,
        edgeLever: halfWidth || 0, cornerLever: 0, gEdge: 0, gCorner: 0, dEdge: Infinity, dCorner: Infinity,
        incGrad: 0, incPhaseSpan: incSpan, incPhaseStepAtD: 0, dCombined: Infinity, dSrc: 0,
        pathStepCornerAtD: 0, nAcross: 0, nDisc: 0, fMax: 0, dObsNyq: Infinity, dObsPlan: Infinity, nObs: 2,
        tiltSin: 0, shiftOnScreen: 0
      };
    }
    const z = ph.z;
    // 边缘点 (halfWidth, 0)：沿 X 相邻采样 |∂R/∂X| ≤ (a+halfWidth)/R
    const edgeLever = a + halfWidth;
    const cornerLever = a + Math.SQRT2 * halfWidth;
    const Redge = Math.hypot(z, edgeLever), Rcorner = Math.hypot(z, cornerLever);
    const gEdge = edgeLever / Redge, gCorner = cornerLever / Rcorner;   // |∇R| 上界
    const target = ph.lambda / frac;
    const dEdge = target / gEdge, dCorner = target / gCorner;
    const incGrad = incSpan / (2 * a);                                  // rad/m（情形 3）
    // 合并：相邻采样相位步 ≤ k·|∇R|·d + |∇φ_inc|·d ≤ 2π/frac
    const dCombined = (2 * Math.PI / frac) / (ph.k * gCorner + incGrad);
    const dSrc = Math.min(dCorner, dCombined);
    const nAcross = Math.ceil(2 * a / dSrc);
    const nDisc = Math.round(Math.PI * a * a / (dSrc * dSrc));
    // 观察面：强度图样空间频率上限 ≈ 2a/(λz)（孔径自相关宽度），Nyquist 间距 λz/(4a)
    const fMax = 2 * a / (ph.lambda * z);
    const dObsNyq = 1 / (2 * fMax);
    const dObsPlan = dObsNyq / 2; // 每周期 ≥ 4 点
    const nObs = Math.ceil(2 * halfWidth / dObsPlan) + 1;
    const tilt = incGrad / ph.k;                    // sinθ
    return {
      a, halfWidth, pathFrac: frac, target,
      edgeLever, cornerLever, gEdge, gCorner, dEdge, dCorner,
      incGrad, incPhaseSpan: incSpan, incPhaseStepAtD: incGrad * dSrc, dCombined, dSrc,
      pathStepCornerAtD: gCorner * dSrc, nAcross, nDisc,
      fMax, dObsNyq, dObsPlan, nObs,
      tiltSin: tilt, shiftOnScreen: z * Math.tan(Math.asin(tilt))
    };
  }

  /* ---------------- 仅供独立验算的解析式（不得用于生成结果） ---------------- */
  function analyticCheckIntensity(r, ph) {   // 菲涅耳/近轴：I/I0 = 4 sin²(k(√(z²+r²)−z)/2)
    const d = r * r / (Math.sqrt(ph.z * ph.z + r * r) + ph.z);
    const s = Math.sin(ph.k * d / 2);
    return 4 * s * s;
  }
  function analyticCheckR4(r, ph) { const x = Math.PI * r * r / (ph.lambda * ph.z); return x * x; }
  function pathConditionRadius(n, ph) {      // √(z²+r²) − z = nλ/2
    const zz = ph.z + n * ph.lambda / 2; return Math.sqrt(zz * zz - ph.z * ph.z);
  }

  /* ---------------- 一次完整的第一问计算 ---------------- */
  function computeQ1(params, precKey, opts) {
    opts = opts || {};
    const prec = typeof precKey === 'string' ? PRECISION[precKey] : precKey;
    const ph = physics(params);
    const rMax = toSI(params.rMax_mm, 'mm');
    const quad = makeQuad(ph, rMax, prec);                // (a) 源平面积分采样
    const rs = radiusSampling(ph, rMax, prec);            // (b) 半径扫描采样（独立）
    const t0 = Date.now();
    const prog = opts.onProgress || null;
    const curve = onAxisCurve(ph, rMax, rs.nr, quad, prog && ((f) => prog(0.4 * f)));
    curve.rsamp = rs;
    const t1 = Date.now();
    // 极值精化方式：Brent 求根的代价 ≈ 候选数 × 12 次 × (面板数 × GL)；超过预算（仅预览档）改用抛物线插值
    let nCand = 0; for (let j = 1; j < curve.nr - 1; j++) if (extremumKind(curve.I, j)) nCand++;
    const cost = nCand * 12 * curve.panels * quad.gl;
    const refineMode = opts.refine || (cost > (prec.refineBudget == null ? Infinity : prec.refineBudget) ? 'parabolic' : 'brent');
    const extrema = findExtrema(curve, ph, quad, { refine: refineMode === 'parabolic' ? 'parabolic' : true, onProgress: prog && ((f) => prog(0.4 + 0.55 * f)) });
    const r4 = r4Analysis(curve, ph, quad, params.r4Threshold == null ? PRESET.r4Threshold : params.r4Threshold);
    const t2 = Date.now();
    const maxima = extrema.filter((e) => e.kind === 'max');
    const fourth = maxima[3] || null;
    return { ph, prec, quad, rsamp: rs, refineMode, curve, extrema, r4, fourthMax: fourth, timing: { curve: t1 - t0, analysis: t2 - t1 } };
  }

  /* ---------------- 收敛检查 ---------------- */
  function convergenceStudy(params, onProgress) {
    const ph = physics(params);
    const rMax = toSI(params.rMax_mm, 'mm');
    const ref = { pathFrac: 160, gl: 16, nr: 8000 };
    const refQuad = makeQuad(ph, rMax, ref);
    const refCurve = onAxisCurve(ph, rMax, ref.nr, refQuad);
    const refExt = findExtrema(refCurve, ph, refQuad);
    const refField = refCurve.fieldAt;
    const refMax = refExt.filter((e) => e.kind === 'max');
    // 目标极值：第 4 个极大；扫描范围内不足 4 个极大时退而检查最后一个极大；一个也没有则跳过极值位置检查
    const ref4 = refMax[3] || refMax[refMax.length - 1] || null;
    const targetIndex = ref4 ? ref4.index : null, hasFourth = !!refMax[3];
    const tests = []; for (let i = 1; i <= 400; i++) tests.push(rMax * i / 400);
    const refI = tests.map((x) => intensity(refField(x)));
    const grid = [];
    const configs = [];
    for (const gl of [2, 4, 8]) for (const q of [5, 10, 20, 40, 80]) configs.push({ method: 'GL', gl, pathFrac: q });
    for (const q of [10, 20, 40, 80, 160, 320]) configs.push({ method: 'ring', gl: 1, pathFrac: q });
    configs.forEach((c, ci) => {
      const quad = makeQuad(ph, rMax, { pathFrac: c.pathFrac, gl: c.gl, nr: 0 });
      const fieldFn = c.method === 'GL' ? makeFieldAt(ph, rMax, quad).fieldAt : (x) => onAxisFieldRingSum(x, ph, quad.h);
      let maxErr = 0;
      tests.forEach((x, i) => { maxErr = Math.max(maxErr, Math.abs(intensity(fieldFn(x)) - refI[i])); });
      // 目标极大位置：在参考位置附近对该求积规则求 dI/dr = 0（无目标时跳过）
      let rt = null, I4 = null;
      if (ref4) {
        const g = (x) => { const U = fieldFn(x), K = edgeKernel(x, ph); return 2 * (U.re * K.re + U.im * K.im); };
        const a = ref4.r * 0.995, b = Math.min(rMax, ref4.r * 1.005), ga = g(a), gb = g(b);
        rt = ga * gb < 0 ? brentRoot(g, a, b, ga, gb, 1e-14, 200).x : goldenExtremum((x) => intensity(fieldFn(x)), a, b, -1, 1e-13);
        I4 = intensity(fieldFn(rt));
      }
      grid.push({ method: c.method, gl: c.gl, pathFrac: c.pathFrac, h_um: fromSI(quad.h, 'um'),
        pathPerPanel_nm: fromSI(quad.pathPerPanel, 'nm'), maxAbsErrI: maxErr,
        r4max_mm: rt === null ? null : fromSI(rt, 'mm'), dr4_nm: rt === null ? null : fromSI(rt - ref4.r, 'nm'),
        I4, dI4: rt === null ? null : I4 - ref4.I });
      if (onProgress) onProgress(0.6 * (ci + 1) / configs.length);
    });
    // 半径采样加密
    const rsamp = [];
    const stdQuad = makeQuad(ph, rMax, PRECISION.standard);
    const nrs = [250, 500, 1000, 2000, 4000, 8000, 16000];
    let prevAll = null;
    nrs.forEach((nr, i) => {
      const cv = onAxisCurve(ph, rMax, nr, stdQuad);
      const ex = findExtrema(cv, ph, stdQuad);
      const exRaw = findExtrema(cv, ph, stdQuad, { refine: false });
      const pick = (arr) => (targetIndex ? arr.filter((e) => e.kind === 'max')[targetIndex - 1] : null) || null;
      const m4 = ref4 ? pick(ex) : null;
      const m4raw = ref4 ? pick(exRaw) : null;
      rsamp.push({ nr, dr_um: fromSI(rMax / (nr - 1), 'um'), nExtrema: ex.length,
        r4raw_mm: m4raw ? fromSI(m4raw.r, 'mm') : null, r4ref_mm: m4 ? fromSI(m4.r, 'mm') : null,
        dRawVsRef_nm: m4raw ? fromSI(m4raw.r - ref4.r, 'nm') : null,
        dRefinedVsRef_nm: m4 ? fromSI(m4.r - ref4.r, 'nm') : null,
        maxShiftAllExtrema_nm: prevAll && ex.length && prevAll.length === ex.length ? Math.max(...ex.map((e, k) => Math.abs(fromSI(e.r - prevAll[k].r, 'nm')))) : null });
      prevAll = ex;
      if (onProgress) onProgress(0.6 + 0.4 * (i + 1) / nrs.length);
    });
    // 精度预设之间所有极值位置对比
    const presets = {};
    for (const key of Object.keys(PRECISION)) {
      const res = computeQ1(params, key);
      const dr = res.extrema.map((e, i) => refExt[i] ? Math.abs(fromSI(e.r - refExt[i].r, 'nm')) : NaN);
      const dI = res.extrema.map((e, i) => refExt[i] ? Math.abs(e.I - refExt[i].I) : NaN);
      presets[key] = {
        nExtrema: res.extrema.length,
        maxAbsDr_nm: dr.length ? Math.max(...dr) : null,
        maxAbsDI: dI.length ? Math.max(...dI) : null,
        r4max_mm: res.fourthMax ? fromSI(res.fourthMax.r, 'mm') : null,
        r4lim_mm: fromSI(res.r4.rLimit, 'mm'), nr: res.curve.nr, refineMode: res.refineMode
      };
    }
    return { reference: { pathFrac: ref.pathFrac, gl: ref.gl, h_um: fromSI(refQuad.h, 'um'), r4max_mm: ref4 ? fromSI(ref4.r, 'mm') : null, I4: ref4 ? ref4.I : null, nExtrema: refExt.length,
      nMaxima: refMax.length, targetIndex, hasFourth },
      grid, rsamp, presets };
  }

  return {
    UNITS, toSI, fromSI, PRESET, PARAM_RANGES, inRange, validateParams, PRECISION, physics, glNodes, makeQuad, radiusSampling,
    onAxisField, onAxisFieldRingSum, onAxisCurve, panelPrefix, fieldAtPrefix, makeFieldAt, intensity, babinetField, glForPath, extremumKind, edgeKernel, dIda,
    findExtrema, goldenExtremum, brentRoot, r4Coefficient, r4Analysis, segmentPhasors,
    rsKernelReduced, fieldAtPoint2D, freeFieldTapered, complementaryOnAxis, phase2Plan, computeQ1, convergenceStudy,
    analyticCheckIntensity, analyticCheckR4, pathConditionRadius,
    VERSION: 'review-2026-11-12'
  };
});
