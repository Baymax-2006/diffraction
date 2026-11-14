#!/usr/bin/env node
/* direct_sum_regression.js — 第二问直接叠加回归。
 * 1. 页面用的取点：同相中心、泊松斑、线性相位峰、随机相位平均。
 * 2. 与 diffraction-q2.js 的 FFT 在同一套源采样上逐点比光强。
 * 用法：node tools/direct_sum_regression.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');
const D = require('../diffraction.js');
require('../diffraction-q2.js');
const Q = require('../direct-q2.js');

const OUT = path.join(__dirname, '..', 'validation');
fs.mkdirSync(OUT, { recursive: true });
const checks = [];
const ok = (name, cond, detail) => {
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : detail });
  const d = detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (d ? ' — ' + d : ''));
};
const mm = (m) => m * 1e3, um = (m) => m * 1e6;

const params = { lambda_nm: 500, L_cm: 50, A: 1, rMax_mm: 2.2, r4Threshold: 0.05 };
const ph = D.physics(params);
const q1 = D.computeQ1(params, 'standard');
const a = q1.fourthMax.r;
const plan = Q.plan(ph, a, 2.5e-3);
const geom = {
  nObs: plan.nObs, half: plan.halfWidth, halfWidth: plan.halfWidth, dObs: plan.dObs,
  L: plan.L, k: plan.k, lambda: plan.lambda, d: plan.d
};
const srcIn = Q.collectSources(a, plan.d, 'inphase', Q.SEED);
const corner = Q.cornerPathStep(srcIn, plan.halfWidth, plan.L);
const pathFrac = plan.lambda / corner.pathStep;

ok('源间距取 λ/10 一阶上界，不放宽', Math.abs(plan.boundPath - ph.lambda / 10) < 1e-18 && plan.d > 0, { d_um: um(plan.d), bound_nm: plan.boundPath * 1e9 });
ok('轴向相邻到角点的实际光程差 ≤ λ/10', corner.pathStep <= ph.lambda / 10 * (1 + 1e-9) && pathFrac >= 10, { path_nm: corner.pathStep * 1e9, frac: pathFrac });
ok('观察屏 201×201、边长 5 mm、间距 ≤ 25 μm', plan.nObs === 201 && Math.abs(plan.dObs - 25e-6) < 1e-12 && Math.abs(2 * plan.halfWidth - 5e-3) < 1e-15, { dObs_um: um(plan.dObs) });
ok('子光源都在圆孔内', (() => {
  for (let s = 0; s < srcIn.N; s++) if (srcIn.x[s] * srcIn.x[s] + srcIn.y[s] * srcIn.y[s] > a * a + 1e-18) return false;
  return srcIn.N > 200000;
})(), { N: srcIn.N });
ok('Hash(种子, m, n) 与 FFT 内核的 u01hash 一致（含负下标）', (() => {
  for (let m = -40; m <= 40; m += 3) for (let n = -25; n <= 25; n += 5) {
    if (Q.hash01(Q.SEED, m, n) !== D.u01hash(Q.SEED, m, n)) return false;
  }
  return Q.SEED === D.Q2_DEFAULT_SEED && Q.linearPhase(0.2e-3, a) === D.linearPhaseAt(0.2e-3, a);
})(), Q.SEED);

const tCenter = Date.now();
const c0 = Q.sumPoints(srcIn, geom, [0, 0], [0, 0]);
const Ihole = c0.re[0] * c0.re[0] + c0.im[0] * c0.im[0];
const Idisk = (1 - c0.re[0]) * (1 - c0.re[0]) + c0.im[0] * c0.im[0];
ok('同相中心 I ≈ 4，与 r₄ 处 3.999986 一致（|ΔI| < 5×10⁻⁴）', Math.abs(Ihole - 3.999986) < 5e-4 && Math.abs(Ihole - q1.fourthMax.I) < 5e-4, { I: Ihole, I4: q1.fourthMax.I, ms: Date.now() - tCenter });
ok('泊松斑 I ≈ 1（|I−1| < 2×10⁻³）', Math.abs(Idisk - 1) < 2e-3, Idisk);

const srcLin = Q.collectSources(a, plan.d, 'linear', Q.SEED);
const shift = 2 * ph.lambda * ph.z / a;
const row0 = (plan.nObs - 1) >> 1;
const tRow = Date.now();
const row = Q.sumRows(srcLin, geom, row0, row0 + 1);
const Irow = new Float32Array(plan.nObs * plan.nObs);
let iBest = 0, vBest = -1;
for (let i = 0; i < plan.nObs; i++) {
  const re = row.re[i], im = row.im[i];
  const v = re * re + im * im;
  Irow[row0 * plan.nObs + i] = v;
  if (v > vBest) { vBest = v; iBest = i; }
}
const peak = Q.peakOnAxis({ I: Irow, nObs: plan.nObs, halfWidth: plan.halfWidth, dObs: plan.dObs });
const at = Q.sumPoints(srcLin, geom, [peak.x, shift, 0], [0, 0, 0]);
const Ipeak = at.re[0] * at.re[0] + at.im[0] * at.im[0];
const Ishift = at.re[1] * at.re[1] + at.im[1] * at.im[1];
const Ilin0 = at.re[2] * at.re[2] + at.im[2] * at.im[2];
ok('线性相位峰朝 +X′，与 2λL/a 相差 < 8 μm', peak.x > 0 && Math.abs(peak.x - shift) < 8e-6, { peak_mm: mm(peak.x), shift_mm: mm(shift), d_um: um(peak.x - shift), row_ms: Date.now() - tRow });
ok('线性相位在几何偏移处 I 接近 4，O′ 不再是极大', Ishift > 3.9 && Ilin0 < 2 && Ilin0 < Ishift, { Ishift, Ilin0, Ipeak });

function mapMean(kind) {
  const src = kind === 'inphase' ? srcIn : Q.collectSources(a, plan.d, kind, Q.SEED);
  const nW = Math.max(1, Math.min(4, os.cpus().length || 1));
  const workers = [];
  for (let w = 0; w < nW; w++) workers.push(new Worker(path.join(__dirname, 'direct_row_worker.js')));
  return new Promise((resolve, reject) => {
    let pending = 0, sum = 0, n = 0, Imax = 0;
    const t0 = Date.now();
    workers.forEach((w) => {
      w.on('message', (m) => {
        for (let k = 0; k < m.re.length; k++) {
          const v = m.re[k] * m.re[k] + m.im[k] * m.im[k];
          sum += v; n++; if (v > Imax) Imax = v;
        }
        pending--;
        if (pending === 0) {
          workers.forEach((x) => x.terminate());
          resolve({ mean: sum / n, Imax, n, ms: Date.now() - t0 });
        }
      });
      w.on('error', reject);
    });
    for (let w = 0; w < nW; w++) {
      const r0 = Math.floor(w * plan.nObs / nW);
      const r1 = Math.floor((w + 1) * plan.nObs / nW);
      if (r1 <= r0) continue;
      pending++;
      workers[w].postMessage({ type: 'sum', src, geom, row0: r0, row1: r1 });
    }
  });
}

function fftSources(samp, prec, kind) {
  const n = samp.Nfft, d = samp.dSrc, mid = n >> 1, edge = prec.edgeSub;
  const x = [], y = [], tr = [], ti = [];
  for (let j = 0; j < n; j++) {
    const Y = (j - mid) * d;
    for (let i = 0; i < n; i++) {
      const X = (i - mid) * d;
      const cov = D.pixelCoverage(X, Y, d, a, edge);
      if (!(cov > 0)) continue;
      let re = cov, im = 0;
      if (kind === 'linear') {
        const phi = D.linearPhaseAt(X, a);
        re = cov * Math.cos(phi); im = cov * Math.sin(phi);
      } else if (kind === 'random') {
        const phi = 2 * Math.PI * D.u01hash(Q.SEED, i, j);
        re = cov * Math.cos(phi); im = cov * Math.sin(phi);
      }
      x.push(X); y.push(Y); tr.push(re); ti.push(im);
    }
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y), tr: Float64Array.from(tr), ti: Float64Array.from(ti), N: x.length, d: d };
}

function compareFFT(kind) {
  const t0 = Date.now();
  const res = D.computeQ2(params, 'standard', {
    a, halfWidth: 2.5e-3, caseKey: kind, seed: Q.SEED, randomMode: 'independent', skipSpot: true
  });
  const src = fftSources(res.samp, res.prec, kind === 'disk' ? 'inphase' : kind);
  const g = { L: ph.z, k: ph.k, lambda: ph.lambda, d: res.samp.dSrc };
  const samp = res.samp;
  const nHalf = (samp.nObs - 1) >> 1;
  const picks = [
    [nHalf, nHalf],
    [nHalf + Math.round(1e-3 / samp.dObs), nHalf],
    [nHalf, nHalf + Math.round(1e-3 / samp.dObs)],
    [0, 0],
    [samp.nObs - 1, samp.nObs - 1],
    [nHalf + Math.round(shift / samp.dObs), nHalf]
  ];
  let maxDI = 0;
  const rows = [];
  picks.forEach(([i, j]) => {
    if (i < 0 || j < 0 || i >= samp.nObs || j >= samp.nObs) return;
    const xp = (i - nHalf) * samp.dObs, yp = (j - nHalf) * samp.dObs;
    const k = j * samp.nObs + i;
    const Uh = { re: res.mapHole ? res.mapHole.re[k] : res.map.re[k], im: res.mapHole ? res.mapHole.im[k] : res.map.im[k] };
    let Ifft = Uh.re * Uh.re + Uh.im * Uh.im;
    const got = Q.sumPoints(src, g, [xp], [yp]);
    let Idir = got.re[0] * got.re[0] + got.im[0] * got.im[0];
    if (kind === 'disk') {
      Ifft = (1 - Uh.re) * (1 - Uh.re) + Uh.im * Uh.im;
      Idir = (1 - got.re[0]) * (1 - got.re[0]) + got.im[0] * got.im[0];
    }
    const dI = Math.abs(Ifft - Idir);
    if (dI > maxDI) maxDI = dI;
    rows.push({ i, j, x_mm: mm(xp), y_mm: mm(yp), Ifft, Idir, dI });
  });
  const axisGot = Q.sumPoints(src, g, [0], [0]);
  let IaxisDir = axisGot.re[0] * axisGot.re[0] + axisGot.im[0] * axisGot.im[0];
  let IaxisFft = res.axis.I_hole != null && kind !== 'disk' ? res.axis.I : res.axis.I;
  if (kind === 'disk') {
    IaxisDir = (1 - axisGot.re[0]) * (1 - axisGot.re[0]) + axisGot.im[0] * axisGot.im[0];
    IaxisFft = res.axis.I;
  } else if (kind === 'inphase') IaxisFft = res.axis.I_hole != null ? res.axis.I : res.axis.I;
  const dAxis = Math.abs(IaxisFft - IaxisDir);
  if (dAxis > maxDI) maxDI = dAxis;
  return { maxDI, dAxis, IaxisFft, IaxisDir, rows, N: src.N, d_um: um(res.samp.dSrc), ms: Date.now() - t0 };
}

(async () => {
  const tRand = Date.now();
  const rnd = await mapMean('random');
  const model = srcIn.N * Math.pow(plan.d * plan.d / (ph.lambda * ph.z), 2);
  const ratio = rnd.mean / model;
  ok('随机相位平均光强 ≈ N(d²/λL)²（相对差 < 15%）', Math.abs(ratio - 1) < 0.15 && rnd.n === plan.nObs * plan.nObs, { mean: rnd.mean, model, ratio, Imax: rnd.Imax, ms: rnd.ms, N: srcIn.N });
  console.log('随机相位全图 ' + (Date.now() - tRand) / 1000 + ' s');

  const fft = {};
  let maxAll = 0;
  for (const kind of ['inphase', 'linear', 'random', 'disk']) {
    fft[kind] = compareFFT(kind);
    maxAll = Math.max(maxAll, fft[kind].maxDI);
    ok('同一源采样下 ' + kind + ' 与 FFT 的 max|ΔI| < 1e-4', fft[kind].maxDI < 1e-4, { maxDI: fft[kind].maxDI, dAxis: fft[kind].dAxis, N: fft[kind].N, ms: fft[kind].ms });
  }

  const summary = {
    generated: new Date().toISOString(),
    pass: checks.filter((c) => c.pass).length,
    total: checks.length,
    checks,
    page: {
      N: srcIn.N, d_um: um(plan.d), dObs_um: um(plan.dObs), nObs: plan.nObs,
      path_nm: corner.pathStep * 1e9, pathFrac, bound_nm: plan.boundPath * 1e9,
      I_hole: Ihole, I_disk: Idisk, I4: q1.fourthMax.I,
      shift_mm: mm(shift), peak_mm: mm(peak.x), Ipeak, Ishift, Ilin0,
      random: { mean: rnd.mean, model, ratio, Imax: rnd.Imax, ms: rnd.ms }
    },
    fft: Object.fromEntries(Object.entries(fft).map(([k, v]) => [k, { maxDI: v.maxDI, dAxis: v.dAxis, N: v.N, d_um: v.d_um, ms: v.ms, rows: v.rows }])),
    maxAbsDI: maxAll
  };
  fs.writeFileSync(path.join(OUT, 'direct_sum_regression.json'), JSON.stringify(summary, null, 2));
  console.log('\n' + summary.pass + '/' + summary.total + ' 通过。同一源采样 max|ΔI| = ' + maxAll);
  if (summary.pass !== summary.total) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
