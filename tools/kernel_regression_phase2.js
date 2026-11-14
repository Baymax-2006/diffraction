#!/usr/bin/env node
/* kernel_regression_phase2.js — 第二问内核回归（Node）。
 * 用法：node tools/kernel_regression_phase2.js
 * 结果：validation/kernel_regression_phase2.json
 */
'use strict';
const fs = require('fs'), path = require('path');
const D = require('../diffraction.js');
require('../diffraction-q2.js');
const OUT = path.join(__dirname, '..', 'validation');
fs.mkdirSync(OUT, { recursive: true });
const checks = [];
const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };
const mm = (m) => D.fromSI(m, 'mm'), um = (m) => D.fromSI(m, 'um');
const params = { lambda_nm: 500, L_cm: 50, A: 1, rMax_mm: 2.2, r4Threshold: 0.05 };
const ph = D.physics(params);
const W = D.toSI(2.5, 'mm');
const t0 = Date.now();

/* --- 第一问基准不得回退 --- */
const q1 = D.computeQ1(params, 'standard');
const r4 = q1.fourthMax;
ok('官方预设 r₄ = 1.3228768035 mm', Math.abs(mm(r4.r) - 1.3228768035) < 5e-10, mm(r4.r));
ok('官方预设 I/I_inc = 3.999986', Math.abs(r4.I - 3.999986) < 5e-9, r4.I);
ok('5% r⁴ 边界 = 0.2495438957 mm', Math.abs(mm(q1.r4.rLimit) - 0.2495438957) < 5e-9, mm(q1.r4.rLimit));
ok('0–2.2 mm：10 个极大、9 个极小', q1.extrema.filter((e) => e.kind === 'max').length === 10 && q1.extrema.filter((e) => e.kind === 'min').length === 9, { max: q1.extrema.filter((e) => e.kind === 'max').length, min: q1.extrema.filter((e) => e.kind === 'min').length });
const a = r4.r;

const cases = ['inphase', 'random', 'linear', 'disk'];
const results = {};
for (const c of cases) {
  const t = Date.now();
  results[c] = D.computeQ2(params, c === 'inphase' || c === 'linear' || c === 'disk' ? 'standard' : 'preview', {
    a, halfWidth: W, caseKey: c, seed: D.Q2_DEFAULT_SEED, cellSize: D.toSI(D.Q2_DEFAULT_CELL_UM, 'um')
  });
  results[c]._ms = Date.now() - t;
  ok('情形 ' + c + ' 计算完成', results[c] && results[c].map && results[c].map.I.length === results[c].samp.nObs ** 2, { ms: results[c]._ms, nObs: results[c].samp.nObs, I0dir: results[c].axis.direct.I, I0fft: results[c].axis.I });
}

const hole = results.inphase, disk = results.disk, lin = results.linear, rnd = results.random;

/* 巴比涅：复振幅 U_disk + U_hole = U_free = 1 */
let maxBabFft = 0, maxBabDir = 0;
const probes = hole.checks;
for (const ch of probes) {
  const Uh = hole.checks.find((x) => x.name === ch.name);
  const Ud = disk.checks.find((x) => x.name === ch.name);
  if (!Uh || !Ud) continue;
  maxBabFft = Math.max(maxBabFft, Math.hypot(Uh.U_fft.re + Ud.U_fft.re - 1, Uh.U_fft.im + Ud.U_fft.im));
  maxBabDir = Math.max(maxBabDir, Math.hypot(Uh.U_direct.re + Ud.U_direct.re - 1, Uh.U_direct.im + Ud.U_direct.im));
}
ok('巴比涅 FFT：探针上 U_hole+U_disk = 1（由复振幅相减构造）', maxBabFft < 1e-12, maxBabFft);
ok('圆屏直接积分仍满足 I_disk = |1−U_hole|²', maxBabDir < 1e-8 && Math.abs(disk.axis.direct.I - disk.axis.direct.I_disk) < 1e-12, { maxBabDir, I: disk.axis.direct.I });
const bab = (disk.babinetChecks && disk.babinetChecks[0]) || (hole.babinetChecks && hole.babinetChecks[0]);
ok('巴比涅：互补屏在孔边渐变为 1，残差 < 1e-3', bab && bab.residual < 1e-3, bab && bab.residual);

/* 泊松亮斑 */
ok('泊松亮斑：圆屏轴上 I ≈ 1（直接，与 I_0 比）', Math.abs(disk.axis.direct.I - 1) < 1e-4, disk.axis.direct.I);
ok('对照：圆孔轴上 I ≈ 4（直接）', Math.abs(hole.axis.direct.I - 3.999986) < 1e-5, hole.axis.direct.I);
ok('圆屏轴上远小于圆孔轴上（不是光强相减会得到负值）', disk.axis.direct.I > 0.5 && disk.axis.direct.I < 1.5 && hole.axis.direct.I > 3.9, { hole: hole.axis.direct.I, disk: disk.axis.direct.I });

/* 8π 偏移 */
const pred = lin.tilt.shiftOnScreen, peak = lin.shiftMeas.peakX;
ok('8π 偏移方向为 +X′（向上，朝延迟端）', lin.shiftMeas.direction === '+X′' && peak > 0, lin.shiftMeas);
ok('8π 偏移幅度接近几何预计（|Δ| < 5 μm）', Math.abs(peak - pred) < 5e-6, { peak_mm: mm(peak), pred_mm: mm(pred), d_um: um(peak - pred) });
ok('8π 不是同相：O′ 处 I 明显小于 4，预计偏移点 I 接近 4', lin.axis.direct.I < 2 && lin.axis.directShift && lin.axis.directShift.I > 3.9, { I0: lin.axis.direct.I, Ishift: lin.axis.directShift && lin.axis.directShift.I });

/* 随机相位：种子可复现，细化不重抽 */
const rnd2 = D.computeQ2(params, 'preview', { a, halfWidth: W, caseKey: 'random', seed: D.Q2_DEFAULT_SEED, cellSize: D.toSI(40, 'um'), skipSpot: true });
let maxd = 0; for (let i = 0; i < rnd.map.I.length; i++) maxd = Math.max(maxd, Math.abs(rnd.map.I[i] - rnd2.map.I[i]));
ok('同一种子预览图样逐点复现（max|ΔI|=0）', maxd === 0, maxd);
const fnA = D.makePhaseFn({ caseKey: 'random', a, seed: D.Q2_DEFAULT_SEED, cellSize: 40e-6 });
const fnB = D.makePhaseFn({ caseKey: 'random', a, seed: D.Q2_DEFAULT_SEED, cellSize: 40e-6 });
const fnC = D.makePhaseFn({ caseKey: 'random', a, seed: 1, cellSize: 40e-6 });
let same = true, npts = 0;
const pts = [];
for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) {
  const X = i * 3e-5, Y = j * 3e-5; if (X * X + Y * Y > a * a) continue;
  npts++; if (fnA(X, Y) !== fnB(X, Y)) same = false;
  pts.push(fnA(X, Y));
}
ok('细化前：同一种子在任意 (X,Y) 相位一致（与调用次序无关）', same && npts > 100, { npts });
ok('不同种子产生不同相位场', fnA(0.2e-3, -0.1e-3) !== fnC(0.2e-3, -0.1e-3), { a: fnA(0.2e-3, -0.1e-3), c: fnC(0.2e-3, -0.1e-3) });
// 固定单元格：面积加权后，预览 / 标准 / 高精的 FFT 轴上光强都靠近独立参考 0.22770
const cellOpt = { a, halfWidth: W, caseKey: 'random', randomMode: 'cell', seed: D.Q2_DEFAULT_SEED, cellSize: 40e-6, skipSpot: true };
const cellPv = D.computeQ2(params, 'preview', cellOpt);
const cellStd = D.computeQ2(params, 'standard', cellOpt);
const cellHi = D.computeQ2(params, 'high', cellOpt);
const truth = 0.22770;
for (const [name, R] of [['预览', cellPv], ['标准', cellStd], ['高精', cellHi]]) {
  const rel = Math.abs(R.axis.I - truth) / truth;
  ok('固定格 ' + name + ' 档 O′ 与 0.22770 相差 < 1%', rel < 0.01 && R.samp.padActual >= 1, { Ifft: R.axis.I, Idir: R.axis.direct.I, rel, pad: R.samp.padActual, d_um: um(R.samp.dSrc) });
}
const relDir = Math.abs(cellStd.axis.direct.I - truth) / truth;
ok('固定格直接积分 O′ 与 0.22770 相差 < 0.1%（切边格子已细分）', relDir < 0.001, { Idir: cellStd.axis.direct.I, relDir });
const sp40 = cellStd.axis.direct.speckle;
ok('40 μm 固定格：图面平均 / (π a² δ²/(λL)²) 与 sinc² 包络平均同量级（约 0.67）', sp40 && sp40.ratio > 0.55 && sp40.ratio < 0.85 && Math.abs(sp40.ratio - sp40.envMean) < 0.12, sp40);
const cellAlt = D.computeQ2(params, 'preview', Object.assign({}, cellOpt, { seed: 1 }));
const dRefine = Math.abs(cellStd.axis.direct.I - cellPv.axis.direct.I);
const dSeed = Math.abs(cellAlt.axis.direct.I - cellPv.axis.direct.I);
ok('固定格加密不重抽：同种子直接积分差远小于换种子', dRefine < 0.25 * dSeed && dSeed > 0.01, { Ipreview: cellPv.axis.direct.I, Istandard: cellStd.axis.direct.I, dRefine, Iseed1: cellAlt.axis.direct.I, dSeed });
const tiny = D.computeQ2(params, 'preview', Object.assign({}, cellOpt, { cellSize: 5e-6 }));
const sp5 = tiny.axis.direct.speckle;
ok('δ < d 时面积加权后平均光强不再按 (d/δ)² 偏高', sp5 && sp5.ratio < 1.6 && sp5.ratio > 0.4, sp5 && { ratio: sp5.ratio, d_um: um(tiny.samp.dSrc), cell_um: 5 });
// 相位在标准网格采样点上仍与预览公式相同
let phaseKeep = true;
for (let i = 0; i < 50; i++) {
  const X = (i - 25) * cellStd.samp.dSrc * 5, Y = (i - 10) * cellStd.samp.dSrc * 3;
  if (X * X + Y * Y > a * a) continue;
  if (D.randomPhaseAt(X, Y, D.Q2_DEFAULT_SEED, 40e-6) !== fnA(X, Y)) phaseKeep = false;
}
ok('加密后仍采样同一块状相位场', phaseKeep);

/* 采样记录 */
const s = hole.samp;
ok('源/观察采样均有记录且满足轴向相位步 ≤ 上限', s.phaseStepAxial <= s.phaseStepLimit * 1.001 && s.dObs > 0 && s.dSrc > 0, { dSrc_um: um(s.dSrc), dObs_um: um(s.dObs), phaseStep: s.phaseStepAxial, limit: s.phaseStepLimit, Nfft: s.Nfft, nObs: s.nObs, nDisc: s.nDisc });
ok('抽检误差有限（标准同相 max|ΔI| < 0.02）', hole.maxAbsDI < 0.02, hole.maxAbsDI);
ok('同相源间距不含 8π，约 5.146 μm', Math.abs(um(s.dSrc) - 5.146) < 0.02, um(s.dSrc));
ok('线性情形才把 8π 计入源间距，约 4.775 μm', Math.abs(um(lin.samp.dSrc) - 4.775) < 0.02, um(lin.samp.dSrc));
ok('填充因子 padActual ≥ 1', [hole, lin, disk].every((R) => R.samp.padActual >= 1), { hole: hole.samp.padActual, lin: lin.samp.padActual, disk: disk.samp.padActual });
const ax = (ph.k * lin.samp.gEdge + lin.samp.incGrad) * lin.samp.dSrc;
const dg = (Math.SQRT2 * ph.k * lin.samp.gCorner + lin.samp.incGrad) * lin.samp.dSrc;
ok('相位步标签：轴向 (k·gEdge+∇φ)·d，对角 (√2·k·gCorner+∇φ)·d', Math.abs(lin.samp.phaseStepAxial - ax) < 1e-9 && Math.abs(lin.samp.phaseStepDiag - dg) < 1e-9, { ax: lin.samp.phaseStepAxial, diag: lin.samp.phaseStepDiag });
const wide = D.q2Sampling(ph, 2.2e-3, W, 'standard', { linear: false });
ok('r = 2.2 mm：padActual ≥ 1，halfObs ≥ 2.5 mm，按 d计划/d 实际 λ/q 粗于目标且未好于 λ/10', wide.padActual >= 1 && wide.halfObs + 1e-12 >= W && wide.belowTarget && !wide.refused && wide.pathFracActual < wide.pathFrac && Math.abs(wide.pathFracActual - wide.pathFrac * wide.dSrcPlan / wide.dSrc) < 1e-9, { q: wide.pathFracActual, pad: wide.padActual, half_mm: mm(wide.halfObs) });
let refusedMsg = '';
try { D.computeQ2({ lambda_nm: 380, L_cm: 10, A: 1, rMax_mm: 6, r4Threshold: 0.05 }, 'standard', { a, halfWidth: W, caseKey: 'inphase' }); }
catch (e) { refusedMsg = e.message; }
ok('比 λ/4 还粗时拒绝计算并说明原因', /不计算/.test(refusedMsg) && /λ\/4/.test(refusedMsg), refusedMsg);
ok('观察间距 ≤ 23.62 μm（计划）', um(s.dObs) <= 23.63, um(s.dObs));
ok('观察点落在 FFT 节点上（间距 = stride × d）', s.onNodes && s.stride >= 1 && Math.abs(s.dObs - s.stride * s.dSrc) < 1e-12, { stride: s.stride, nObs: s.nObs, dObs_um: um(s.dObs) });
const halfReq = 2.5;
const tiers = ['preview', 'standard', 'high'];
const halfByTier = {};
for (const tier of tiers) {
  const sm = D.q2Sampling(ph, a, W, tier, { linear: false });
  const cutHalf = ((sm.nCut - 1) / 2) * sm.dSrc;
  halfByTier[tier] = { half_mm: mm(sm.halfObs), pad: sm.padActual, nObs: sm.nObs, cut_mm: mm(cutHalf) };
  ok(tier + ' 档 halfObs ≥ 2.5 mm 且 padActual ≥ 1', sm.halfObs + 1e-12 >= W && sm.padActual >= 1 && halfByTier[tier].cut_mm + 1e-9 >= halfReq, halfByTier[tier]);
}
const small = D.q2Sampling(ph, 0.05e-3, W, 'standard', { linear: false });
ok('小半径 r = 0.05 mm：halfObs ≥ 2.5 mm 且 padActual ≥ 1', small.halfObs + 1e-12 >= W && small.padActual >= 1, { half_mm: mm(small.halfObs), pad: small.padActual, N: small.Nfft });
ok('剖面覆盖请求半宽（不在 ±2.5 mm 内读到空端）', hole.cutX.x[hole.cutX.n - 1] + 1e-12 >= W && hole.cutY.x[hole.cutY.n - 1] + 1e-12 >= W, { x_mm: mm(hole.cutX.x[hole.cutX.n - 1]), y_mm: mm(hole.cutY.x[hole.cutY.n - 1]) });
function gridI(map, x, y) {
  const n = map.nObs, Wm = map.halfWidth, d = map.dObs;
  const i = Math.max(0, Math.min(n - 1, (x + Wm) / d)), j = Math.max(0, Math.min(n - 1, (y + Wm) / d));
  return D.bilinearSample(map.I, n, i, j);
}
const diskCorner = disk.checks.find((c) => Math.abs(c.x - W) < 1e-12 && Math.abs(c.y - W) < 1e-12);
const gridCorner = gridI(disk.map, W, W);
ok('圆屏 (2.5, 2.5) mm 网格值与直接积分之差在抽检容差内', !!(diskCorner) && Math.abs(gridCorner) > 0.5 && Math.abs(gridCorner - diskCorner.I_direct) < 0.02, { grid: gridCorner, direct: diskCorner && diskCorner.I_direct, dI: diskCorner ? gridCorner - diskCorner.I_direct : null });
const cc = hole.cornerCheck;
ok('角点是 FFT 节点，与直接 RS 的 |ΔI| < 1e-3（求积误差量级）', !!(cc && cc.onNode) && Math.abs(cc.dI) < 1e-3, cc && { dI: cc.dI, Ifft: cc.I_fft, Idir: cc.I_direct, x_mm: mm(cc.x) });
const reused = D.q2ComplementView(hole, 'disk');
ok('圆屏复用圆孔 FFT：轴上直接 I 与单独计算一致且不再卷积', !!(reused && reused.reusedFFT) && Math.abs(reused.axis.direct.I - disk.axis.direct.I) < 1e-9 && reused.timing.ms === 0, { I: reused && reused.axis.direct.I, peakMB: hole.timing.arrayBuffersPeak / 1048576 });
const z0 = D.computeQ2(params, 'standard', { a: 0, halfWidth: W, caseKey: 'inphase' });
const zd = D.computeQ2(params, 'standard', { a: 0, halfWidth: W, caseKey: 'disk' });
ok('r = 0 立即返回：孔场 0、圆屏 1，Nfft = 0', z0.degenerate && z0.axis.I === 0 && zd.axis.I === 1 && z0.samp.Nfft === 0 && z0.timing.ms === 0, { hole: z0.axis.I, disk: zd.axis.I });
let rejected = false;
try { D.validateParams({ lambda_nm: -5, L_cm: 0, A: 1, rMax_mm: 2.2, r4Threshold: 9 }); } catch (e) { rejected = /合法范围/.test(e.message); }
ok('validateParams 拒绝 λ=-5、L=0、阈值 900%', rejected);

/* 抽检与径向交叉 */
ok('同相轴上直接积分与一维径向交叉 |ΔI| < 1e-10', Math.abs(hole.axis.direct.I - hole.axis.direct.I_radial) < 1e-10, { dir: hole.axis.direct.I, rad: hole.axis.direct.I_radial });

const summary = {
  generated: new Date().toISOString(), kernel: D.VERSION, ms: Date.now() - t0,
  pass: checks.filter((c) => c.pass).length, total: checks.length,
  checks,
  numbers: {
    r4_mm: mm(a), I_hole_direct: hole.axis.direct.I, I_hole_fft: hole.axis.I,
    I_disk_direct: disk.axis.direct.I, I_disk_fft: disk.axis.I,
    shift_peak_mm: mm(peak), shift_pred_mm: mm(pred),
    seed: D.Q2_DEFAULT_SEED, cell_um: 40,
    sampling_standard: { dSrc_um: um(s.dSrc), dObs_um: um(s.dObs), Nfft: s.Nfft, nObs: s.nObs, nDisc: s.nDisc, phaseStepAxial: s.phaseStepAxial, maxAbsDI: hole.maxAbsDI, halfObs_mm: mm(s.halfObs) },
    halfObs_mm: halfByTier,
    times: Object.fromEntries(cases.map((c) => [c, results[c]._ms]))
  }
};
fs.writeFileSync(path.join(OUT, 'kernel_regression_phase2.json'), JSON.stringify(summary, null, 2));
console.log('\n' + summary.pass + '/' + summary.total + ' 通过，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
if (summary.pass !== summary.total) process.exit(1);
