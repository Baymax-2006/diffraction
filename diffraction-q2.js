/*
 * diffraction-q2.js — 第二问二维图样数值内核（无 DOM）。
 * 依赖已加载的 Diffraction（diffraction.js）。扩展同一 RS1 约化核 rsKernelReduced，
 * 不用 Airy / 闭式光强公式生成图样；解析/几何估计只作独立验算。
 *
 * 方案：在笛卡尔源网格上用与 fieldAtPoint2D 相同的核 h = (z/R) e^{ik(R−z)}/R 做
 * 线性卷积 U′ = (A/(iλ)) (u ⊛ h) ΔxΔy，用零填充 FFT 加速；观察区从 FFT 网格抽取。
 * 直接极坐标积分 fieldAtPoint2D 用于探针抽检。圆屏：U′_disk = A − U′_hole（复振幅相减）。
 */
(function q2KernelModule(root) {
  'use strict';
  const D = root.Diffraction || (typeof require === 'function' ? require('./diffraction.js') : null);
  if (!D) throw new Error('diffraction-q2.js 需要先加载 diffraction.js');
  if (!root.Diffraction) root.Diffraction = D;

  const Q2_CASES = Object.freeze({
    inphase: Object.freeze({ key: 'inphase', index: 1, label: '同相圆孔' }),
    random:  Object.freeze({ key: 'random',  index: 2, label: '随机相位（单次实现）' }),
    linear:  Object.freeze({ key: 'linear',  index: 3, label: '沿 X 线性相位 8π' }),
    disk:    Object.freeze({ key: 'disk',    index: 4, label: '不透明圆屏（泊松亮斑）' })
  });

  /* 第二问精度：源采样 pathFrac 与观察网格、FFT 窗口彼此独立记录。
   * pathFrac：相邻源采样在观察区角点的传播相位 + 8π 倾斜入射相位合计 ≤ 2π/pathFrac。 */
  const Q2_PRECISION = Object.freeze({
    preview:  Object.freeze({ key: 'preview',  label: '预览', pathFrac: 6,  nObs: 97,  nCut: 201, pad: 1.05, fftCap: 1024, edgeSub: 2, nSpot: 5,  apN: 193 }),
    standard: Object.freeze({ key: 'standard', label: '标准', pathFrac: 10, nObs: 213, nCut: 401, pad: 1.25, fftCap: 2048, edgeSub: 4, nSpot: 9,  apN: 257 }),
    high:     Object.freeze({ key: 'high',     label: '高精', pathFrac: 15, nObs: 257, nCut: 513, pad: 1.40, fftCap: 4096, edgeSub: 6, nSpot: 13, apN: 321 })
  });

  const DEFAULT_SEED = 20261111;
  const DEFAULT_CELL_UM = 40;   // 随机相位物理单元格边长（μm），与求积网格无关

  /* ---------------- 可复现的单元格相位（与求积网格、调用次序无关） ----------------
   * 单元格 [ix δ, (ix+1)δ) × [iy δ, (iy+1)δ)，ix = ⌊X/δ⌋，iy = ⌊Y/δ⌋。
   * 相位 = 2π · Hash(seed, ix, iy)/2³²，在单元格内为常数。加密网格只是更密地采样同一块状场。
   */
  function u01hash(seed, ix, iy) {
    let h = (seed >>> 0) ^ 0xA511E9B3;
    h = Math.imul(h ^ Math.imul(ix | 0, 0x9E3779B9), 0x85EBCA6B);
    h = Math.imul(h ^ Math.imul(iy | 0, 0xC2B2AE35), 0x27D4EB2D);
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 4294967296;
  }
  function cellIndex(x, delta) { return Math.floor(x / delta); }
  function randomPhaseAt(X, Y, seed, cellSize) {
    return 2 * Math.PI * u01hash(seed, cellIndex(X, cellSize), cellIndex(Y, cellSize));
  }
  /* 像素与至多若干相位格重叠时的面积加权相量：Σ (重叠面积/像素面积) e^{iφ}。
   * 格边界不必落在采样点上；δ < d 时一个像素覆盖许多格，不能整格取中心相位。 */
  function areaWeightedPhasor(X, Y, d, seed, cellSize) {
    const delta = cellSize;
    if (!(delta > 0) || !(d > 0)) return { re: 1, im: 0 };
    const x0 = X - 0.5 * d, x1 = X + 0.5 * d, y0 = Y - 0.5 * d, y1 = Y + 0.5 * d;
    const eps = delta * 1e-12;
    const ix0 = Math.floor(x0 / delta), ix1 = Math.floor((x1 - eps) / delta);
    const iy0 = Math.floor(y0 / delta), iy1 = Math.floor((y1 - eps) / delta);
    let re = 0, im = 0;
    const pix = d * d;
    for (let ix = ix0; ix <= ix1; ix++) {
      const ox = Math.min(x1, (ix + 1) * delta) - Math.max(x0, ix * delta);
      if (!(ox > 0)) continue;
      for (let iy = iy0; iy <= iy1; iy++) {
        const oy = Math.min(y1, (iy + 1) * delta) - Math.max(y0, iy * delta);
        if (!(oy > 0)) continue;
        const phi = 2 * Math.PI * u01hash(seed, ix, iy);
        const frac = (ox * oy) / pix;
        re += frac * Math.cos(phi);
        im += frac * Math.sin(phi);
      }
    }
    return { re, im };
  }
  /* 情形 3：沿 +X（向上）线性相位，孔顶相对孔底延迟 8π。φ(X) = 8π (X + a)/(2a)，φ(−a)=0，φ(+a)=8π。
   * 总体常数相位不影响光强；梯度 dφ/dX = 4π/a 才是物理内容。两端相位模 2π 相同，并不等于同相情形。 */
  function linearPhaseAt(X, a) { return 8 * Math.PI * (X + a) / (2 * a); }

  function makePhaseFn(spec) {
    const kind = spec.caseKey || spec.kind;
    if (kind === 'linear') {
      const a = spec.a;
      return function (X, Y) { return linearPhaseAt(X, a); };
    }
    /* 未声明 randomMode 时仍返回固定单元格相位（供加密不重抽的演示与旧调用）。
     * 题目预设的“逐点独立”没有连续的 φ(X,Y)，由源像素下标决定。 */
    if (kind === 'random' && spec.randomMode !== 'independent') {
      const seed = spec.seed >>> 0, cs = spec.cellSize;
      return function (X, Y) { return randomPhaseAt(X, Y, seed, cs); };
    }
    return null; // 同相圆孔 / 圆屏 / 逐点独立：入射相位不由连续函数给出
  }

  function tiltGeometry(ph, a) {
    const incGrad = 8 * Math.PI / (2 * a);
    const sinTh = incGrad / ph.k;
    const th = Math.asin(Math.min(1, Math.max(-1, sinTh)));
    return { incGrad, sinTh, theta: th, shiftOnScreen: ph.z * Math.tan(th),
      note: '相位延迟端在 +X（孔顶）。e^{-iωt} 约定下孔径场乘 e^{+iφ}、φ 随 X 增大，等效 k_x>0 的倾斜平面波，图样朝 +X′ 平移。' };
  }

  /* 覆盖 half 所需的半边节点数。向上取整，使网格略大于请求半宽；比值刚好是整数时不多加一格。 */
  function nHalfCover(half, step) {
    if (!(step > 0)) return 1;
    return Math.max(1, Math.ceil(half / step - 1e-9));
  }

  /* ---------------- 采样规划（实际采用的网格） ----------------
   * 8π 倾斜只进入线性相位情形的源间距。FFT 窗口必须盖住 2(W+a)，否则圆周卷积把图样卷回来；
   * 顶到 fftCap 时放宽 d，使 N·d ≥ 2(W+a)·1.02，并记下实际达到的 λ/q。
   * 观察半宽、剖面半宽都向上取整到节点，保证实际半宽 ≥ 请求的 ±W（至少 5 mm × 5 mm）。
   * 若因此节点越出 FFT 网格，或窗口短于 2(实际半宽+a)，用同一套放大把 N 加倍或放宽 d。 */
  function q2Sampling(ph, a, halfWidth, prec, opts) {
    opts = opts || {};
    prec = typeof prec === 'string' ? Q2_PRECISION[prec] : prec;
    const linear = !!opts.linear;
    const nObs = prec.nObs || 213;
    const base = {
      prec: prec.key, pathFrac: prec.pathFrac, pathFracActual: Infinity, a: a || 0, halfWidth,
      dSrc: 0, dSrcPlan: 0, Nfft: 0, Lfft: 0, Lneed: 0, Lmin: 0, padRequested: prec.pad, padActual: Infinity,
      nObs, dObs: nObs > 1 ? 2 * halfWidth / (nObs - 1) : 0, nCut: prec.nCut || nObs, nAcross: 0, nDisc: 0,
      gCorner: 0, gEdge: 0, incGrad: 0, pathStepCorner: 0, phaseStepAxial: 0, phaseStepDiag: 0,
      phaseStepLimit: 2 * Math.PI / prec.pathFrac, fMax: 0, dObsNyq: 0, dObsPlan: 0,
      tilt: { incGrad: 0, sinTh: 0, theta: 0, shiftOnScreen: 0, note: '' },
      capped: false, dEnlarged: false, linear, degenerate: true
    };
    if (!(a > 0)) return base;
    const plan = D.phase2Plan(ph, a, halfWidth, { pathFrac: prec.pathFrac, incPhaseSpan: linear ? 8 * Math.PI : 0 });
    const dSrcPlan = plan.dSrc;
    const span0 = 2 * (halfWidth + a);
    const cap = prec.fftCap || 2048;
    let span = span0;
    let Nfft, dSrc, capped, dEnlarged, Lneed, Lmin, Lfft, padActual;
    let stride, dObs, nHalf, halfObs, nHalfCut;
    const sizeWindow = () => {
      Lneed = span * (prec.pad || 1.25);
      Lmin = span * 1.02;
      Nfft = 256;
      dSrc = dSrcPlan;
      capped = false;
      dEnlarged = false;
      while (Nfft * dSrc < Lneed && Nfft < cap) Nfft *= 2;
      if (Nfft * dSrc < Lmin) {
        dSrc = Lmin / Nfft;
        dEnlarged = true;
        capped = true;
      } else if (Nfft >= cap && Nfft * dSrcPlan < Lneed) capped = true;
      Lfft = Nfft * dSrc;
      padActual = span0 > 0 ? Lfft / span0 : Infinity;
    };
    const placeObs = () => {
      /* 观察点落在 FFT 节点上：步长取最接近计划间距的整数个源像素，避免再做一次双线性插值。 */
      const dWant = 2 * halfWidth / Math.max(2, (prec.nObs || 213) - 1);
      stride = Math.max(1, Math.floor(dWant / dSrc + 1e-9));
      dObs = stride * dSrc;
      nHalf = nHalfCover(halfWidth, dObs);
      halfObs = nHalf * dObs;
      nHalfCut = nHalfCover(halfWidth, dSrc);
    };
    sizeWindow();
    placeObs();
    /* 向上取整后半宽最多多出不到一格。窗口若盖不住实际观察区，沿用原来的放大：先加倍 N，顶到上限再放宽 d。 */
    for (let guard = 0; guard < 8; guard++) {
      const midLim = (Nfft >> 1) - 1;
      const spanObs = 2 * (halfObs + a);
      if (nHalf * stride <= midLim && nHalfCut <= midLim && Lfft + 1e-12 >= spanObs && padActual >= 1) break;
      const next = Math.max(span * 1.02, spanObs);
      span = next > span + 1e-15 ? next : span * 1.05;
      sizeWindow();
      placeObs();
    }
    const incGrad = linear ? plan.incGrad : 0;
    /* 轴向：沿 X 或 Y，杠杆是边缘 |∇R|；对角：√2 倍角点杠杆。入射梯度只加一次，不随方向乘 √2。 */
    const phaseStepAxial = (ph.k * plan.gEdge + incGrad) * dSrc;
    const phaseStepDiag = (Math.SQRT2 * ph.k * plan.gCorner + incGrad) * dSrc;
    /* 与规划同一口径：d 被放宽时，实际 λ/q = 计划 pathFrac × d计划/d。不用边缘梯度，否则会显得比目标更细。 */
    const pathFracActual = dSrc > 0 ? prec.pathFrac * (dSrcPlan / dSrc) : Infinity;
    const belowTarget = pathFracActual + 1e-6 < prec.pathFrac;
    const refused = pathFracActual < 4;
    const nObsNodes = 2 * nHalf + 1;
    const nCutNodes = 2 * nHalfCut + 1;
    return {
      prec: prec.key, pathFrac: prec.pathFrac, pathFracActual, belowTarget, refused, a, halfWidth,
      dSrc, dSrcPlan, Nfft, Lfft, Lneed, Lmin, padRequested: prec.pad, padActual,
      stride, nObs: nObsNodes, dObs, halfObs, nCut: nCutNodes, onNodes: true,
      nAcross: Math.ceil(2 * a / dSrc), nDisc: Math.round(Math.PI * a * a / (dSrc * dSrc)),
      gCorner: plan.gCorner, gEdge: plan.gEdge, incGrad,
      pathStepCorner: plan.gCorner * dSrc, phaseStepAxial, phaseStepDiag,
      phaseStepLimit: 2 * Math.PI / prec.pathFrac,
      fMax: plan.fMax, dObsNyq: plan.dObsNyq, dObsPlan: plan.dObsPlan,
      tilt: tiltGeometry(ph, a),
      capped, dEnlarged, linear, degenerate: false
    };
  }

  /* 像素与圆孔相交的面积比例（子采样）。像素中心 (X,Y)，边长 d。 */
  function pixelCoverage(X, Y, d, a, sub) {
    const r = Math.hypot(X, Y), half = 0.5 * d * Math.SQRT2;
    if (r + half <= a) return 1;
    if (r - half >= a) return 0;
    sub = sub || 4;
    const h = d / sub; let c = 0;
    const x0 = X - 0.5 * d, y0 = Y - 0.5 * d;
    for (let i = 0; i < sub; i++) {
      const x = x0 + (i + 0.5) * h;
      for (let j = 0; j < sub; j++) {
        const y = y0 + (j + 0.5) * h;
        if (x * x + y * y <= a * a) c++;
      }
    }
    return c / (sub * sub);
  }

  /* ---------------- 基数-2 二维 FFT（复，行主序） ----------------
   * 正变换 exp(−2πi)，逆变换 exp(+2πi)/N²。只做卷积工具，与时谐约定无关。 */
  function fft1d(re, im, n, sign) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = sign * 2 * Math.PI / len;
      const wlr = Math.cos(ang), wli = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let j = 0; j < half; j++) {
          const p = i + j, q = p + half;
          const vr = re[q] * wr - im[q] * wi;
          const vi = re[q] * wi + im[q] * wr;
          re[q] = re[p] - vr; im[q] = im[p] - vi;
          re[p] += vr; im[p] += vi;
          const nwr = wr * wlr - wi * wli;
          wi = wr * wli + wi * wlr; wr = nwr;
        }
      }
    }
  }
  function fft2(re, im, n, inv) {
    const sign = inv ? 1 : -1;
    const tr = new Float64Array(n), ti = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      const off = r * n;
      tr.set(re.subarray(off, off + n)); ti.set(im.subarray(off, off + n));
      fft1d(tr, ti, n, sign);
      re.set(tr, off); im.set(ti, off);
    }
    const s = inv ? 1 / (n * n) : 1;
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) { tr[r] = re[r * n + c]; ti[r] = im[r * n + c]; }
      fft1d(tr, ti, n, sign);
      if (inv) for (let r = 0; r < n; r++) { re[r * n + c] = tr[r] * s; im[r * n + c] = ti[r] * s; }
      else for (let r = 0; r < n; r++) { re[r * n + c] = tr[r]; im[r * n + c] = ti[r]; }
    }
  }
  /* fftshift / ifftshift，n 为偶数时是对合，原地交换每一对点，不再另开整幅数组。 */
  function shift2inplace(re, im, n) {
    const h = n >> 1;
    for (let r = 0; r < n; r++) {
      const r2 = (r + h) & (n - 1);
      for (let c = 0; c < n; c++) {
        const c2 = (c + h) & (n - 1);
        const i = r * n + c, j = r2 * n + c2;
        if (i >= j) continue;
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
  }

  function coordAt(i, n, d) { return (i - (n >> 1)) * d; }

  /* 双线性插值（原点在 n/2）。超出网格返回 0。 */
  function interpGrid(re, im, n, d, x, y) {
    const i = x / d + (n >> 1), j = y / d + (n >> 1);
    if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return { re: 0, im: 0 };
    return { re: bilinearSample(re, n, i, j), im: bilinearSample(im, n, i, j) };
  }

  /* 网格约定：索引 (col, row) = (i, j) 对应 (X, Y) = ((i−n/2)d, (j−n/2)d)。
   * 存储：idx = j * n + i（行 = Y，列 = X）。 */

  /* kind: none | fn | cell（面积加权）| independent（每个源像素一个相位，δ = d） */
  function aperturePhasor(X, Y, i, j, d, spec) {
    if (!spec || spec.kind === 'none') return { re: 1, im: 0 };
    if (spec.kind === 'independent') {
      const phi = 2 * Math.PI * u01hash(spec.seed, i, j);
      return { re: Math.cos(phi), im: Math.sin(phi) };
    }
    if (spec.kind === 'cell') return areaWeightedPhasor(X, Y, d, spec.seed, spec.cellSize);
    if (spec.kind === 'fn' && spec.fn) {
      const phi = spec.fn(X, Y);
      return { re: Math.cos(phi), im: Math.sin(phi) };
    }
    return { re: 1, im: 0 };
  }
  function buildAperture(n, d, a, phaseSpec, edgeSub) {
    const spec = typeof phaseSpec === 'function' ? { kind: 'fn', fn: phaseSpec } : (phaseSpec || { kind: 'none' });
    const uRe = new Float32Array(n * n), uIm = new Float32Array(n * n);
    let nPix = 0, sumCov = 0;
    const mid = n >> 1;
    for (let j = 0; j < n; j++) {
      const Y = (j - mid) * d;
      for (let i = 0; i < n; i++) {
        const X = (i - mid) * d;
        const cov = pixelCoverage(X, Y, d, a, edgeSub);
        if (cov === 0) continue;
        nPix++; sumCov += cov;
        const phasor = aperturePhasor(X, Y, i, j, d, spec);
        const k = j * n + i;
        uRe[k] = cov * phasor.re;
        uIm[k] = cov * phasor.im;
      }
    }
    return { uRe, uIm, nPix, areaEst: sumCov * d * d, areaExact: Math.PI * a * a, specKind: spec.kind };
  }

  function buildKernel(n, d, ph) {
    const hRe = new Float32Array(n * n), hIm = new Float32Array(n * n);
    const mid = n >> 1;
    for (let j = 0; j < n; j++) {
      const dy = (j - mid) * d;
      for (let i = 0; i < n; i++) {
        const kn = D.rsKernelReduced((i - mid) * d, dy, ph);
        const k = j * n + i;
        hRe[k] = kn.amp * Math.cos(kn.phi);
        hIm[k] = kn.amp * Math.sin(kn.phi);
      }
    }
    return { hRe, hIm };
  }

  /* 卷积原地进行：孔径与核各一对数组，移位和变换都写回自己，乘积留在孔径数组里，最后就地换成 U。
   * 不再同时保留 aRe/bRe 副本和单独的 Ure/Uim。孔径、核用 Float32（相位是 cos/sin，幅度 O(1)）。 */
  function convolveRS(uRe, uIm, hRe, hIm, n, d, ph, onProgress) {
    let peakAB = 0;
    const noteMem = () => {
      if (typeof process !== 'undefined' && process.memoryUsage) {
        const m = process.memoryUsage().arrayBuffers || 0;
        if (m > peakAB) peakAB = m;
      }
    };
    if (onProgress) onProgress(0.08);
    shift2inplace(uRe, uIm, n);
    fft2(uRe, uIm, n, false);
    noteMem();
    if (onProgress) onProgress(0.38);
    shift2inplace(hRe, hIm, n);
    fft2(hRe, hIm, n, false);
    noteMem();
    if (onProgress) onProgress(0.62);
    for (let k = 0; k < n * n; k++) {
      const ar = uRe[k], ai = uIm[k], br = hRe[k], bi = hIm[k];
      uRe[k] = ar * br - ai * bi;
      uIm[k] = ar * bi + ai * br;
    }
    hRe = hIm = null;
    fft2(uRe, uIm, n, true);
    shift2inplace(uRe, uIm, n);
    noteMem();
    if (onProgress) onProgress(0.82);
    const area = d * d, invL = 1 / ph.lambda, A = ph.A;
    for (let k = 0; k < n * n; k++) {
      const Sr = uRe[k] * area, Si = uIm[k] * area;
      uRe[k] = A * Si * invL;
      uIm[k] = -A * Sr * invL;
    }
    return { Ure: uRe, Uim: uIm, peakAB };
  }

  function nodeAt(Ure, Uim, n, ix, iy) {
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) return { re: 0, im: 0 };
    const k = iy * n + ix;
    return { re: Ure[k], im: Uim[k] };
  }
  /* 观察图：每隔 stride 个 FFT 节点取一点，坐标就是节点坐标，不再插值。光强用 Float32。 */
  function extractMap(Ure, Uim, n, d, samp, babinetDisk, A) {
    const stride = samp.stride || 1, nObs = samp.nObs, dObs = samp.dObs, half = samp.halfObs;
    const nHalf = (nObs - 1) >> 1, mid = n >> 1;
    const I = new Float32Array(nObs * nObs);
    const re = new Float64Array(nObs * nObs);
    const im = new Float64Array(nObs * nObs);
    let Imax = 0, Imin = Infinity;
    for (let j = 0; j < nObs; j++) {
      const iy = mid + (j - nHalf) * stride;
      for (let i = 0; i < nObs; i++) {
        const ix = mid + (i - nHalf) * stride;
        let U = nodeAt(Ure, Uim, n, ix, iy);
        if (babinetDisk) U = D.babinetField(U, A);
        const k = j * nObs + i;
        re[k] = U.re; im[k] = U.im;
        const Iv = U.re * U.re + U.im * U.im;
        I[k] = Iv; if (Iv > Imax) Imax = Iv; if (Iv < Imin) Imin = Iv;
      }
    }
    return { I, re, im, nObs, dObs, halfWidth: half, Imax, Imin, onNodes: true, stride };
  }

  /* 剖面沿 FFT 节点（步长 1 个源像素）。other 先落到最近的节点行/列。 */
  function extractCut(Ure, Uim, n, d, halfWidth, axis, other, babinetDisk, A) {
    const mid = n >> 1;
    /* 与 q2Sampling 同一向上取整。索引夹在 FFT 网格内，避免剖面端点读到越界 0。 */
    let nHalf = nHalfCover(halfWidth, d);
    const maxHalf = Math.max(1, mid - 1);
    if (nHalf > maxHalf) nHalf = maxHalf;
    const nCut = 2 * nHalf + 1;
    const off = Math.round((other || 0) / d);
    const x = new Float64Array(nCut), I = new Float32Array(nCut), re = new Float64Array(nCut), im = new Float64Array(nCut);
    for (let i = 0; i < nCut; i++) {
      const di = i - nHalf;
      const ix = axis === 'x' ? mid + di : mid + off;
      const iy = axis === 'x' ? mid + off : mid + di;
      let U = nodeAt(Ure, Uim, n, ix, iy);
      if (babinetDisk) U = D.babinetField(U, A);
      x[i] = di * d;
      re[i] = U.re; im[i] = U.im; I[i] = U.re * U.re + U.im * U.im;
    }
    return { axis, other: off * d, n: nCut, x, I, re, im, onNodes: true };
  }

  function fieldFromFFT(Ure, Uim, n, d, xp, yp, babinetDisk, A) {
    const i = xp / d + (n >> 1), j = yp / d + (n >> 1);
    let U;
    if (Number.isFinite(i) && Number.isFinite(j) && Math.abs(i - Math.round(i)) < 1e-6 && Math.abs(j - Math.round(j)) < 1e-6) {
      U = nodeAt(Ure, Uim, n, Math.round(i), Math.round(j));
    } else U = interpGrid(Ure, Uim, n, d, xp, yp);
    if (babinetDisk) U = D.babinetField(U, A);
    return U;
  }
  /* 标量网格的双线性插值。i、j 是以左下角为 0 的连续下标。 */
  function bilinearSample(arr, n, i, j) {
    if (!(i >= 0) || !(j >= 0) || i > n - 1 || j > n - 1) return 0;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(i))), j0 = Math.max(0, Math.min(n - 2, Math.floor(j)));
    const ui = i - i0, uj = j - j0;
    const a = (1 - ui) * (1 - uj), b = ui * (1 - uj), c = (1 - ui) * uj, e = ui * uj;
    return a * arr[j0 * n + i0] + b * arr[j0 * n + i0 + 1] + c * arr[(j0 + 1) * n + i0] + e * arr[(j0 + 1) * n + i0 + 1];
  }

  /* 孔径振幅/相位预览。固定单元格用物理坐标；逐点独立用预览网格自己的下标（示意，传播用 FFT 源像素）。 */
  function aperturePreview(a, phaseSpec, caseKey, n, padFac) {
    padFac = padFac || (caseKey === 'disk' ? 2.4 : 1.25);
    const half = Math.max(padFac * (a > 0 ? a : 1e-6), 1e-6), d = 2 * half / (n - 1);
    const spec = typeof phaseSpec === 'function' ? { kind: 'fn', fn: phaseSpec } : phaseSpec;
    const amp = new Float64Array(n * n), phs = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      const Y = -half + j * d;
      for (let i = 0; i < n; i++) {
        const X = -half + i * d, k = j * n + i;
        const inside = a > 0 && X * X + Y * Y <= a * a;
        if (caseKey === 'disk') {
          amp[k] = inside ? 0 : 1;
          phs[k] = 0;
        } else {
          amp[k] = inside ? 1 : 0;
          if (!inside) phs[k] = 0;
          else if (spec && spec.kind === 'independent') phs[k] = 2 * Math.PI * u01hash(spec.seed, i, j);
          else if (spec && spec.kind === 'cell') phs[k] = randomPhaseAt(X, Y, spec.seed, spec.cellSize);
          else if (spec && spec.kind === 'fn' && spec.fn) phs[k] = spec.fn(X, Y);
          else if (typeof phaseSpec === 'function') phs[k] = phaseSpec(X, Y);
          else phs[k] = 0;
        }
      }
    }
    return { n, half, d, amp, phase: phs, caseKey };
  }

  function squareHitsDisk(x0, x1, y0, y1, a) {
    const cx = x0 > 0 ? x0 : (x1 < 0 ? x1 : 0);
    const cy = y0 > 0 ? y0 : (y1 < 0 ? y1 : 0);
    return cx * cx + cy * cy <= a * a;
  }
  /* 固定单元格：整格在圆内用 GL；被圆边切开的格子递归四分，直到边长 ≤ δ/subDiv，再在小块上 GL。
   * 圆是凸的，四角都在圆内则整块在圆内。只在切边的小块上丢掉圆外节点。 */
  function fieldAtRandomCells(xp, yp, a, ph, opts) {
    const delta = opts.cellSize, seed = (opts.seed >>> 0);
    const gIn = D.glNodes(opts.gl || 8);
    const gEdge = D.glNodes(Math.min(gIn.n, 4));
    const subDiv = opts.subDiv || 32;
    const minH = delta / subDiv;
    const a2 = a * a;
    let sr = 0, si = 0, samples = 0;
    function addRect(x0, x1, y0, y1, cph, sph, edge) {
      const hx = 0.5 * (x1 - x0), hy = 0.5 * (y1 - y0);
      const mx = x0 + hx, my = y0 + hy;
      const g = edge ? gEdge : gIn;
      for (let p = 0; p < g.n; p++) {
        const X = mx + hx * g.x[p];
        for (let q = 0; q < g.n; q++) {
          const Y = my + hy * g.x[q];
          if (edge && X * X + Y * Y > a2) continue;
          const w = g.w[p] * g.w[q] * hx * hy;
          const kn = D.rsKernelReduced(xp - X, yp - Y, ph);
          const amp = w * kn.amp;
          const ck = Math.cos(kn.phi), sk = Math.sin(kn.phi);
          sr += amp * (ck * cph - sk * sph);
          si += amp * (ck * sph + sk * cph);
          samples++;
        }
      }
    }
    function walk(x0, x1, y0, y1, cph, sph) {
      if (!squareHitsDisk(x0, x1, y0, y1, a)) return;
      const inside = x0 * x0 + y0 * y0 <= a2 && x0 * x0 + y1 * y1 <= a2 && x1 * x1 + y0 * y0 <= a2 && x1 * x1 + y1 * y1 <= a2;
      if (inside) { addRect(x0, x1, y0, y1, cph, sph, false); return; }
      if ((x1 - x0) > minH * 1.01) {
        const mx = 0.5 * (x0 + x1), my = 0.5 * (y0 + y1);
        walk(x0, mx, y0, my, cph, sph); walk(mx, x1, y0, my, cph, sph);
        walk(x0, mx, my, y1, cph, sph); walk(mx, x1, my, y1, cph, sph);
        return;
      }
      addRect(x0, x1, y0, y1, cph, sph, true);
    }
    const i0 = Math.floor(-a / delta), i1 = Math.floor((a - delta * 1e-15) / delta);
    for (let ix = i0; ix <= i1; ix++) {
      const x0 = ix * delta, x1 = x0 + delta;
      for (let iy = i0; iy <= i1; iy++) {
        const y0 = iy * delta, y1 = y0 + delta;
        if (!squareHitsDisk(x0, x1, y0, y1, a)) continue;
        const phi = 2 * Math.PI * u01hash(seed, ix, iy);
        walk(x0, x1, y0, y1, Math.cos(phi), Math.sin(phi));
      }
    }
    return { U: { re: ph.A * si / ph.lambda, im: -ph.A * sr / ph.lambda }, samples, method: 'cell-gl-edge' };
  }
  /* 与 FFT 同一套源像素（同一 n、d、同一相位）做直接求和，用来核对卷积，不另起一套相位。 */
  function fieldAtSourceSum(xp, yp, a, ph, opts) {
    const n = opts.n, d = opts.d, spec = opts.spec, edgeSub = opts.edgeSub;
    const mid = n >> 1;
    let sr = 0, si = 0, samples = 0;
    const lim = a + d;
    for (let j = 0; j < n; j++) {
      const Y = (j - mid) * d;
      if (Y > lim || Y < -lim) continue;
      for (let i = 0; i < n; i++) {
        const X = (i - mid) * d;
        if (X > lim || X < -lim) continue;
        const cov = pixelCoverage(X, Y, d, a, edgeSub);
        if (cov === 0) continue;
        const phasor = aperturePhasor(X, Y, i, j, d, spec);
        const pr = cov * phasor.re, pi = cov * phasor.im;
        const kn = D.rsKernelReduced(xp - X, yp - Y, ph);
        const w = kn.amp * d * d;
        const ck = Math.cos(kn.phi), sk = Math.sin(kn.phi);
        sr += w * (pr * ck - pi * sk);
        si += w * (pr * sk + pi * ck);
        samples++;
      }
    }
    return { U: { re: ph.A * si / ph.lambda, im: -ph.A * sr / ph.lambda }, samples, method: 'cartesian' };
  }
  /* 图面平均光强相对 N_cell (δ²/λL)²，以及方形单元 sinc² 包络在观察窗上的平均。 */
  function speckleMeanModel(map, a, ph, delta) {
    const n = map.nObs, W = map.halfWidth, dObs = map.dObs;
    const Icenter = Math.PI * a * a * delta * delta / Math.pow(ph.lambda * ph.z, 2);
    const k0 = Math.PI * delta / (ph.lambda * ph.z);
    let sumI = 0, sumE = 0, m = 0;
    for (let j = 0; j < n; j++) {
      const yp = -W + j * dObs, ey = k0 * yp;
      const sy = Math.abs(ey) < 1e-8 ? 1 : Math.sin(ey) / ey;
      for (let i = 0; i < n; i++) {
        const xp = -W + i * dObs, ex = k0 * xp;
        const sx = Math.abs(ex) < 1e-8 ? 1 : Math.sin(ex) / ex;
        sumI += map.I[j * n + i];
        sumE += sx * sx * sy * sy;
        m++;
      }
    }
    const mapMean = m ? sumI / m : 0, envMean = m ? sumE / m : 0;
    return { Icenter, mapMean, envMean, ratio: Icenter > 0 ? mapMean / Icenter : 0, Ncell: delta > 0 ? Math.PI * a * a / (delta * delta) : 0 };
  }

  function peakOnCut(cut) {
    let k = 0;
    for (let i = 1; i < cut.n; i++) if (cut.I[i] > cut.I[k]) k = i;
    // 三点抛物线
    let x = cut.x[k];
    if (k > 0 && k < cut.n - 1) {
      const y1 = cut.I[k - 1], y2 = cut.I[k], y3 = cut.I[k + 1];
      const den = y1 - 2 * y2 + y3;
      if (den !== 0) {
        const d = 0.5 * (y1 - y3) / den;
        x = cut.x[k] + Math.max(-1, Math.min(1, d)) * (cut.x[k] - cut.x[k - 1]);
      }
    }
    return { x, I: cut.I[k], index: k };
  }

  function centroid1D(cut, window) {
    let m = 0, w = 0;
    for (let i = 0; i < cut.n; i++) {
      if (window && (cut.x[i] < window[0] || cut.x[i] > window[1])) continue;
      m += cut.x[i] * cut.I[i]; w += cut.I[i];
    }
    return w > 0 ? m / w : 0;
  }

  /* 默认探针：O′、轴上偏移、边缘、角点，以及情形 3 的预计偏移点 */
  function defaultProbes(halfWidth, tilt, caseKey) {
    const mm = (v) => v; // already SI if we pass SI
    const W = halfWidth, list = [
      { name: 'O′', x: 0, y: 0 },
      { name: '(1,0) mm', x: 1e-3, y: 0 },
      { name: '(0,1) mm', x: 0, y: 1e-3 },
      { name: '(−1,0) mm', x: -1e-3, y: 0 },
      { name: '边缘 (W,0)', x: W, y: 0 },
      { name: '边缘 (0,W)', x: 0, y: W },
      { name: '角点 (W,W)', x: W, y: W },
      { name: '角点 (−W,W)', x: -W, y: W }
    ];
    if (tilt) list.push({ name: '预计偏移点', x: tilt.shiftOnScreen, y: 0 });
    return list;
  }

  function directAtQ2(xp, yp, a, ph, samp, prec, phaseSpec, babinet) {
    let r;
    if (phaseSpec && phaseSpec.kind === 'cell') {
      r = fieldAtRandomCells(xp, yp, a, ph, { cellSize: phaseSpec.cellSize, seed: phaseSpec.seed, gl: Math.max(6, Math.round((prec.pathFrac || 10) / 2)) });
    } else if (phaseSpec && phaseSpec.kind === 'independent') {
      r = fieldAtSourceSum(xp, yp, a, ph, { n: samp.Nfft, d: samp.dSrc, edgeSub: prec.edgeSub, spec: phaseSpec });
    } else {
      r = D.fieldAtPoint2D(xp, yp, a, ph, {
        d: samp.dSrc, gl: D.glForPath(prec.pathFrac),
        phaseFn: phaseSpec && phaseSpec.fn ? phaseSpec.fn : null, babinetDisk: false
      });
    }
    if (babinet) r = { U: D.babinetField(r.U, ph.A), samples: r.samples, method: r.method };
    return r;
  }

  function degenerateQ2(ph, prec, a, halfWidth, caseKey, seed, cellSize, randomMode) {
    const babinet = caseKey === 'disk';
    const nObs = prec.nObs || 97, nCut = prec.nCut || nObs;
    const map = (function () {
      const I = new Float64Array(nObs * nObs), re = new Float64Array(nObs * nObs), im = new Float64Array(nObs * nObs);
      if (babinet) { I.fill(ph.A * ph.A); re.fill(ph.A); }
      return { I, re, im, nObs, dObs: 2 * halfWidth / Math.max(1, nObs - 1), halfWidth, Imax: babinet ? ph.A * ph.A : 0, Imin: babinet ? ph.A * ph.A : 0 };
    })();
    const x = new Float64Array(nCut), Ic = new Float64Array(nCut), rec = new Float64Array(nCut), imc = new Float64Array(nCut);
    for (let i = 0; i < nCut; i++) {
      x[i] = -halfWidth + (nCut > 1 ? i * 2 * halfWidth / (nCut - 1) : 0);
      if (babinet) { Ic[i] = ph.A * ph.A; rec[i] = ph.A; }
    }
    const cut = (axis) => ({ axis, other: 0, n: nCut, x, I: Ic, re: rec, im: imc });
    const Uh = { re: 0, im: 0 }, Ud = { re: ph.A, im: 0 }, U = babinet ? Ud : Uh;
    const samp = q2Sampling(ph, 0, halfWidth, prec, { linear: caseKey === 'linear' });
    samp.nObs = nObs; samp.nCut = nCut; samp.halfWidth = halfWidth;
    return {
      ph, prec, samp, caseKey, a: 0, halfWidth, seed, cellSize, randomMode, degenerate: true,
      map, mapHole: babinet ? null : map, mapDisk: babinet ? map : null,
      cutX: cut('x'), cutY: cut('y'), cutXhole: null, cutYhole: null,
      ap: aperturePreview(0, null, caseKey, prec.apN || 193),
      tilt: samp.tilt, shiftMeas: null,
      axis: {
        U_hole: Uh, U, I: D.intensity(U), I_hole: 0, I_disk: ph.A * ph.A,
        direct: { U, I: D.intensity(U), samples: 0, U_hole: Uh, I_hole: 0, I_disk: ph.A * ph.A },
        directShift: null
      },
      checks: [], babinetChecks: [], maxAbsDI: 0, maxAbsDU: 0,
      apertureBuild: { nPix: 0, areaEst: 0, areaExact: 0 },
      timing: { ms: 0 },
      quality: prec.key === 'preview' ? 'preview' : 'precise',
      conventions: {
        kernel: 'a≤0：孔场 U′=0，圆屏 U′=1，不做 FFT',
        Ufree: 'U′_free = A = 1',
        babinet: 'U′_disk = 1 − U′_hole',
        phaseDelay: '延迟 φ ⇒ 乘 e^{+iφ}（e^{-iωt}）',
        coords: '+X/+X′ 向上，迎着光 +Y/+Y′ 向左',
        random: ''
      }
    };
  }

  function computeQ2(params, precKey, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const prec = typeof precKey === 'string' ? Q2_PRECISION[precKey] : precKey;
    const ph = D.physics(params);
    const a = opts.a;
    const halfWidth = opts.halfWidth == null ? D.toSI(D.PRESET.q2HalfWidth_mm, 'mm') : opts.halfWidth;
    const caseKey = opts.caseKey || 'inphase';
    const seed = (opts.seed == null ? DEFAULT_SEED : opts.seed) >>> 0;
    const cellSize = opts.cellSize == null ? D.toSI(DEFAULT_CELL_UM, 'um') : opts.cellSize;
    const randomMode = opts.randomMode === 'cell' ? 'cell' : 'independent';
    const prog = opts.onProgress || null;
    if (!(a > 0)) return degenerateQ2(ph, prec, a, halfWidth, caseKey, seed, cellSize, randomMode);
    const samp = q2Sampling(ph, a, halfWidth, prec, { linear: caseKey === 'linear' });
    if (samp.refused) {
      throw new Error('源采样被 FFT 点数上限压到约 λ/' + samp.pathFracActual.toFixed(1) + '，比 λ/4 还粗，图样不再可靠。请减小孔径半径或观察区，或换用 FFT 上限更高的精度档。本次不计算。');
    }
    let phaseSpec = null;
    if (caseKey === 'linear') phaseSpec = { kind: 'fn', fn: makePhaseFn({ caseKey: 'linear', a }) };
    else if (caseKey === 'random' && randomMode === 'cell') phaseSpec = { kind: 'cell', seed, cellSize };
    else if (caseKey === 'random') phaseSpec = { kind: 'independent', seed };
    const tilt = samp.tilt;
    const babinet = caseKey === 'disk';

    const built = buildAperture(samp.Nfft, samp.dSrc, a, phaseSpec, prec.edgeSub);
    if (prog) prog(0.06);
    const ker = buildKernel(samp.Nfft, samp.dSrc, ph);
    const conv = convolveRS(built.uRe, built.uIm, ker.hRe, ker.hIm, samp.Nfft, samp.dSrc, ph, prog && ((f) => prog(0.06 + 0.70 * f)));
    const mapHole = extractMap(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, samp, false, ph.A);
    const map = babinet ? extractMap(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, samp, true, ph.A) : mapHole;
    const mapDisk = (caseKey === 'inphase' || babinet) ? (babinet ? map : extractMap(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, samp, true, ph.A)) : null;

    const cutX = extractCut(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, halfWidth, 'x', 0, babinet, ph.A);
    const cutY = extractCut(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, halfWidth, 'y', 0, babinet, ph.A);
    const cutXhole = (caseKey === 'inphase' || babinet) ? extractCut(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, halfWidth, 'x', 0, false, ph.A) : null;
    const cutYhole = (caseKey === 'inphase' || babinet) ? extractCut(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, halfWidth, 'y', 0, false, ph.A) : null;

    const U0hole = fieldFromFFT(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, 0, 0, false, ph.A);
    const U0 = babinet ? D.babinetField(U0hole, ph.A) : U0hole;
    const I0 = D.intensity(U0);
    const I0hole = D.intensity(U0hole);
    const I0disk = D.intensity(D.babinetField(U0hole, ph.A));

    const ap = aperturePreview(a, phaseSpec, caseKey, prec.apN || 257);

    // 情形 3：在 Y′=0 的 X′ 剖面上测量峰值与质心
    let shiftMeas = null;
    if (caseKey === 'linear') {
      const peak = peakOnCut(cutX);
      const cen = centroid1D(cutX, [tilt.shiftOnScreen - 0.8e-3, tilt.shiftOnScreen + 0.8e-3]);
      shiftMeas = { peakX: peak.x, peakI: peak.I, centroidX: cen, predicted: tilt.shiftOnScreen, direction: peak.x > 0 ? '+X′' : (peak.x < 0 ? '−X′' : '无') };
    }

    // 轴上直接积分：随机固定格走每格 GL；逐点独立走与 FFT 相同的源像素；其余走极坐标 fieldAtPoint2D。
    const dir0 = directAtQ2(0, 0, a, ph, samp, prec, phaseSpec, babinet);
    const dir0hole = babinet ? directAtQ2(0, 0, a, ph, samp, prec, phaseSpec, false) : dir0;
    const axisDirect = {
      U: dir0.U, I: D.intensity(dir0.U), samples: dir0.samples, method: dir0.method,
      U_hole: dir0hole.U, I_hole: D.intensity(dir0hole.U),
      I_disk: D.intensity(D.babinetField(dir0hole.U, ph.A))
    };
    if (caseKey === 'inphase' || babinet) {
      const quad = D.makeQuad(ph, a, { pathFrac: 20, gl: 8, nr: 0 });
      const U1 = D.onAxisField(a, ph, quad);
      axisDirect.I_radial = D.intensity(U1);
      axisDirect.U_radial = U1;
    }
    if (caseKey === 'random') axisDirect.speckle = speckleMeanModel(map, a, ph, randomMode === 'cell' ? cellSize : samp.dSrc);
    let dirShift = null;
    if (caseKey === 'linear') {
      const ds = directAtQ2(tilt.shiftOnScreen, 0, a, ph, samp, prec, phaseSpec, false);
      dirShift = { U: ds.U, I: D.intensity(ds.U), x: tilt.shiftOnScreen, samples: ds.samples };
    }

    const probes = (opts.probes || defaultProbes(halfWidth, caseKey === 'linear' ? tilt : null, caseKey)).slice(0, prec.nSpot);
    const checks = [];
    let maxAbsDI = 0, maxAbsDU = 0;
    if (opts.skipSpot !== true) {
      for (let p = 0; p < probes.length; p++) {
        const pr = probes[p];
        const Ufft = fieldFromFFT(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, pr.x, pr.y, babinet, ph.A);
        const dir = directAtQ2(pr.x, pr.y, a, ph, samp, prec, phaseSpec, babinet);
        const Ifft = D.intensity(Ufft), Idir = D.intensity(dir.U);
        const dI = Ifft - Idir;
        const dU = Math.hypot(Ufft.re - dir.U.re, Ufft.im - dir.U.im);
        maxAbsDI = Math.max(maxAbsDI, Math.abs(dI));
        maxAbsDU = Math.max(maxAbsDU, dU);
        checks.push({ name: pr.name, x: pr.x, y: pr.y, I_fft: Ifft, I_direct: Idir, dI: dI,
          U_fft: Ufft, U_direct: dir.U, dU: dU, samples: dir.samples });
        if (prog) prog(0.82 + 0.16 * (p + 1) / probes.length);
      }
    }

    /* 巴比涅：轴上互补屏（从 a 向外、高斯渐变）与 1−U_hole 比较。不是把同一 FFT 场拆成两项再加回去。 */
    const babinetChecks = [];
    if (babinet || caseKey === 'inphase') {
      const quad = D.makeQuad(ph, a, { pathFrac: 20, gl: 8, nr: 0 });
      const Uhole = D.onAxisField(a, ph, quad);
      const comp = D.complementaryOnAxis(ph, a, 12e-3, { pathFrac: 10, gl: 6 });
      const Uref = D.babinetField(Uhole, ph.A);
      babinetChecks.push({
        name: '轴上互补屏', x: 0, y: 0,
        U_hole: Uhole, U_complement: comp.U, U_disk: Uref, U_free: { re: ph.A, im: 0 },
        residual: Math.hypot(comp.U.re - Uref.re, comp.U.im - Uref.im),
        wTaper: comp.wTaper, rhoMax: comp.rhoMax,
        note: '互补屏独立积分（a→外，高斯渐变）对照 1−U_hole'
      });
    }

    /* 角点是 FFT 节点，对照直接 RS。偏差应落在求积误差里，而不是插值造成的百分之几。 */
    let cornerCheck = null;
    if (caseKey !== 'random' && samp.nObs > 2) {
      const xc = samp.halfObs, yc = samp.halfObs;
      const Ufft = fieldFromFFT(conv.Ure, conv.Uim, samp.Nfft, samp.dSrc, xc, yc, babinet, ph.A);
      const dir = directAtQ2(xc, yc, a, ph, samp, prec, phaseSpec, babinet);
      cornerCheck = {
        x: xc, y: yc, onNode: true,
        I_fft: D.intensity(Ufft), I_direct: D.intensity(dir.U),
        dI: D.intensity(Ufft) - D.intensity(dir.U),
        samples: dir.samples
      };
    }

    const timing = { ms: Date.now() - t0, arrayBuffersPeak: conv.peakAB || 0 };
    if (prog) prog(1);

    const randomNote = randomMode === 'independent'
      ? '逐采样点独立相位（δ=d），结果随网格改变，没有连续极限；可比量是平均光强 ≈ N_cell·(δ²/λL)²，约为同相相干叠加的 1/N'
      : (randomMode === 'cell' ? '固定物理单元格，像素内对重叠格做面积加权相量；加密网格不重抽' : '');
    return {
      ph, prec, samp, caseKey, a, halfWidth, seed, cellSize, randomMode,
      map, mapHole: caseKey === 'inphase' || babinet ? mapHole : null,
      mapDisk,
      cutX, cutY, cutXhole, cutYhole,
      ap, tilt, shiftMeas,
      axis: { U_hole: U0hole, U: U0, I: I0, I_hole: I0hole, I_disk: I0disk, direct: axisDirect, directShift: dirShift },
      checks, babinetChecks, cornerCheck, maxAbsDI, maxAbsDU,
      apertureBuild: { nPix: built.nPix, areaEst: built.areaEst, areaExact: built.areaExact },
      timing,
      quality: prec.key === 'preview' ? 'preview' : 'precise',
      conventions: {
        kernel: 'RS1 reduced h=(z/R) exp(ik(R-z))/R, U=(A/(iλ))(u∗h)',
        Ufree: 'U′_free = A = 1（约化场），I_0 = 1',
        babinet: 'U′_disk = U′_free − U′_hole（复振幅，不减光强）；轴上另用互补屏向外积分对照',
        phaseDelay: '延迟 φ ⇒ 乘 e^{+iφ}（e^{-iωt}）',
        coords: '+X/+X′ 向上，迎着光 +Y/+Y′ 向左',
        random: randomNote
      }
    };
  }

  /* 单点直接积分。随机固定格按单元格 GL；逐点独立必须带上与 FFT 相同的 n、d。 */
  function pointQ2(xp, yp, a, ph, opts) {
    opts = opts || {};
    const disk = opts.caseKey === 'disk' || opts.babinetDisk;
    if (!(a > 0)) {
      const Uh = { re: 0, im: 0 };
      return { U: disk ? { re: ph.A, im: 0 } : Uh, samples: 0, degenerate: true };
    }
    const seed = (opts.seed == null ? DEFAULT_SEED : opts.seed) >>> 0;
    const mode = opts.randomMode || (opts.caseKey === 'random' ? 'independent' : null);
    if (opts.caseKey === 'random' && mode === 'cell') {
      const r = fieldAtRandomCells(xp, yp, a, ph, { cellSize: opts.cellSize, seed, gl: opts.gl || 8 });
      if (disk) r.U = D.babinetField(r.U, ph.A);
      return r;
    }
    if (opts.caseKey === 'random') {
      const spec = { kind: 'independent', seed };
      const r = fieldAtSourceSum(xp, yp, a, ph, { n: opts.n, d: opts.d, edgeSub: opts.edgeSub || 4, spec });
      if (disk) r.U = D.babinetField(r.U, ph.A);
      return r;
    }
    const phaseFn = opts.phaseFn || makePhaseFn(opts);
    return D.fieldAtPoint2D(xp, yp, a, ph, {
      d: opts.d, gl: opts.gl || 6, phaseFn: phaseFn, babinetDisk: disk
    });
  }

  function complementMap(map, A) {
    const n = map.nObs, re = new Float64Array(n * n), im = new Float64Array(n * n), I = new Float32Array(n * n);
    let Imax = 0, Imin = Infinity;
    for (let k = 0; k < n * n; k++) {
      const U = D.babinetField({ re: map.re[k], im: map.im[k] }, A);
      re[k] = U.re; im[k] = U.im;
      const Iv = U.re * U.re + U.im * U.im;
      I[k] = Iv; if (Iv > Imax) Imax = Iv; if (Iv < Imin) Imin = Iv;
    }
    return { I, re, im, nObs: n, dObs: map.dObs, halfWidth: map.halfWidth, Imax, Imin, onNodes: map.onNodes, stride: map.stride };
  }
  function complementCut(cut, A) {
    const n = cut.n, re = new Float64Array(n), im = new Float64Array(n), I = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const U = D.babinetField({ re: cut.re[i], im: cut.im[i] }, A);
      re[i] = U.re; im[i] = U.im; I[i] = U.re * U.re + U.im * U.im;
    }
    return { axis: cut.axis, other: cut.other, n, x: cut.x, I, re, im, onNodes: cut.onNodes };
  }
  /* 圆孔与圆屏共用同一次 FFT。已有 mapHole、mapDisk 时直接换视角，不再卷积。 */
  function q2ComplementView(prev, caseKey) {
    if (!prev || !prev.mapHole || !prev.mapDisk) return null;
    if (caseKey !== 'inphase' && caseKey !== 'disk') return null;
    if (prev.caseKey !== 'inphase' && prev.caseKey !== 'disk') return null;
    const A = prev.ph && prev.ph.A != null ? prev.ph.A : 1;
    const disk = caseKey === 'disk';
    const map = disk ? prev.mapDisk : prev.mapHole;
    const cutX = disk ? complementCut(prev.cutXhole, A) : prev.cutXhole;
    const cutY = disk ? complementCut(prev.cutYhole, A) : prev.cutYhole;
    const U0hole = prev.axis.U_hole;
    const U0 = disk ? D.babinetField(U0hole, A) : U0hole;
    const axisDirect = Object.assign({}, prev.axis.direct, {
      U: disk ? D.babinetField(prev.axis.direct.U_hole, A) : prev.axis.direct.U_hole,
      I: disk ? prev.axis.direct.I_disk : prev.axis.direct.I_hole
    });
    return {
      ph: prev.ph, prec: prev.prec, samp: prev.samp, caseKey, a: prev.a, halfWidth: prev.halfWidth,
      seed: prev.seed, cellSize: prev.cellSize, randomMode: prev.randomMode,
      map, mapHole: prev.mapHole, mapDisk: prev.mapDisk,
      cutX, cutY, cutXhole: prev.cutXhole, cutYhole: prev.cutYhole,
      ap: aperturePreview(prev.a, null, caseKey, (prev.prec && prev.prec.apN) || 257),
      tilt: prev.tilt, shiftMeas: null,
      axis: { U_hole: U0hole, U: U0, I: D.intensity(U0), I_hole: prev.axis.I_hole, I_disk: prev.axis.I_disk, direct: axisDirect, directShift: null },
      checks: prev.checks, babinetChecks: prev.babinetChecks, cornerCheck: prev.cornerCheck,
      maxAbsDI: prev.maxAbsDI, maxAbsDU: prev.maxAbsDU,
      apertureBuild: prev.apertureBuild,
      timing: { ms: 0, reused: true, arrayBuffersPeak: 0 },
      quality: prev.quality, conventions: prev.conventions, reusedFFT: true
    };
  }

  D.Q2_CASES = Q2_CASES;
  D.Q2_PRECISION = Q2_PRECISION;
  D.Q2_DEFAULT_SEED = DEFAULT_SEED;
  D.Q2_DEFAULT_CELL_UM = DEFAULT_CELL_UM;
  D.u01hash = u01hash;
  D.randomPhaseAt = randomPhaseAt;
  D.linearPhaseAt = linearPhaseAt;
  D.makePhaseFn = makePhaseFn;
  D.tiltGeometry = tiltGeometry;
  D.q2Sampling = q2Sampling;
  D.pixelCoverage = pixelCoverage;
  D.areaWeightedPhasor = areaWeightedPhasor;
  D.fieldAtRandomCells = fieldAtRandomCells;
  D.speckleMeanModel = speckleMeanModel;
  D.computeQ2 = computeQ2;
  D.q2ComplementView = q2ComplementView;
  D.complementMap = complementMap;
  D.pointQ2 = pointQ2;
  D.aperturePreview = aperturePreview;
  D.interpGrid = interpGrid;
  D.bilinearSample = bilinearSample;
  D.fieldFromFFT = fieldFromFFT;
  D.VERSION = 'review-2026-11-12';
  if (typeof module === 'object' && module.exports) module.exports = D;
  else (root.__kernelSrc = root.__kernelSrc || {}).q2 = '(' + String(q2KernelModule) + ')(self);';   // 供 file:// Blob Worker
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
