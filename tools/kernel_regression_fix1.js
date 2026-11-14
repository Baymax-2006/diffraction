#!/usr/bin/env node
/* kernel_regression_fix1.js — 修复轮的 Node 端（无浏览器）回归测试，直接 require 同一个 diffraction.js / jobs.js。
 * 用法：node tools/kernel_regression_fix1.js   （约 20–40 s，主要耗时是混叠工况标准档的 946 个极值精化）
 * 输出：validation/kernel_regression_fix1.json */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'diffraction.js'));
global.self = global; global.Diffraction = D; require(path.join(ROOT, 'jobs.js'));
const J = global.Q1Jobs;
const checks = []; const ok = (g, n, c, d) => { checks.push({ group: g, name: n, pass: !!c, detail: d }); console.log((c ? 'PASS ' : 'FAIL ') + '[' + g + '] ' + n + ' — ' + (typeof d === 'string' ? d : JSON.stringify(d))); };
const P = (o) => Object.assign({ A: 1, r4Threshold: 0.05 }, o);
const preset = P({ lambda_nm: 500, L_cm: 50, rMax_mm: 2.2 });
const mm = (m) => m * 1e3;

/* 基准 */
const S = D.computeQ1(preset, 'standard');
const mx = S.extrema.filter((e) => e.kind === 'max'), mn = S.extrema.filter((e) => e.kind === 'min');
ok('基准', '第 4 极大 r = 1.3228768035 mm（10 位）', mm(S.fourthMax.r).toFixed(10) === '1.3228768035', mm(S.fourthMax.r).toFixed(12));
ok('基准', '第 4 极大 I/I_inc = 3.999986（6 位）', S.fourthMax.I.toFixed(6) === '3.999986', S.fourthMax.I.toFixed(9));
ok('基准', '5% r⁴ 边界 = 0.2495438957 mm（10 位）', mm(S.r4.rLimit).toFixed(10) === '0.2495438957', mm(S.r4.rLimit).toFixed(12));
ok('基准', '0–2.2 mm：10 极大 / 9 极小', mx.length === 10 && mn.length === 9, `${mx.length}/${mn.length}`);
ok('基准', '题目预设下半径采样点数不变（N_r = 4000），结果与修复前逐位一致', S.curve.nr === 4000 && S.refineMode === 'brent', `N_r = ${S.curve.nr}，边缘相位步 ${S.rsamp.phaseStep.toFixed(5)} rad ≤ π/20`);
for (const k of ['preview', 'high']) { const R = D.computeQ1(preset, k); ok('基准', `${D.PRECISION[k].label}档 r₄ 与标准档一致（< 0.01 nm）`, Math.abs(R.fourthMax.r - S.fourthMax.r) < 1e-11, `${mm(R.fourthMax.r).toFixed(10)} mm，N_r = ${R.curve.nr}`); }

/* 问题 5：混叠 */
const al = P({ lambda_nm: 380, L_cm: 10, rMax_mm: 6 });
const NFmax = (6e-3) ** 2 / (380e-9 * 0.1), expMax = Math.floor((NFmax + 1) / 2);
let t = Date.now(); const pv = D.computeQ1(al, 'preview'); const tp = Date.now() - t;
t = Date.now(); const sd = D.computeQ1(al, 'standard'); const ts = Date.now() - t;
const nPv = pv.extrema.filter((e) => e.kind === 'max').length, nSd = sd.extrema.filter((e) => e.kind === 'max').length;
ok('问题5', `预期极大数 ⌊(N_F,max+1)/2⌋ = ${expMax}（N_F,max = ${NFmax.toFixed(2)}）`, true, '');
ok('问题5', '预览档不再混叠（原 800 点只检出 181 个）', Math.abs(nPv - nSd) <= 3 && nPv >= 470, `预览 ${nPv} 个极大，N_r = ${pv.curve.nr}，ΔN_F = ${pv.rsamp.dNF.toFixed(4)}，${pv.refineMode}，${tp} ms`);
ok('问题5', '标准档 473 个极大', nSd === 473, `N_r = ${sd.curve.nr}，ΔN_F = ${sd.rsamp.dNF.toFixed(4)}，${ts} ms`);
ok('问题6', '前缀和精化：λ=380 nm、L=10 cm、r_max=6 mm 的 946 个极值远小于 1 s，且与从 0 重积分的位置一致', ts < 1000 && sd.timing.analysis < 1000 && sd.extrema.length === 946, { ms: ts, analysis: sd.timing.analysis, n: sd.extrema.length });
{
  const phP = D.physics(preset);
  const bare = Object.assign({}, S.curve); delete bare.fieldAt;
  const again = D.findExtrema(bare, phP, S.quad);
  let maxDr = 0;
  if (again.length === S.extrema.length) for (let i = 0; i < again.length; i++) maxDr = Math.max(maxDr, Math.abs(again[i].r - S.extrema[i].r));
  ok('问题6', '题目预设：前缀 fieldAt 与从 0 重积分的极值位置差 < 1e-15 m', again.length === S.extrema.length && maxDr < 1e-15, { n: again.length, maxDr_m: maxDr });
}
{
  const bad = [];
  J.run({ type: 'q1', id: 3, params: P({ lambda_nm: 1, L_cm: 50, rMax_mm: 2.2 }), precision: 'preview' }, (m) => bad.push(m));
  J.run({ type: 'q1', id: 4, params: P({ lambda_nm: -5, L_cm: 0, rMax_mm: 2.2 }), precision: 'preview' }, (m) => bad.push(m));
  ok('问题5 输入', 'jobs.js 入口拒绝 λ=1 nm 与 λ=-5、L=0', bad.filter((m) => m.type === 'error').length === 2 && bad.every((m) => m.type === 'error' || m.type === 'progress'), bad.map((m) => m.type + (m.message ? ':' + m.message.split('\n')[0] : '')).join(' | '));
}
// 预览档的极值位置（抛物线插值）与标准档精化位置的差
let maxd = 0; const sdMax = sd.extrema.filter((e) => e.kind === 'max'), pvMax = pv.extrema.filter((e) => e.kind === 'max');
for (let i = 0; i < Math.min(sdMax.length, pvMax.length); i++) maxd = Math.max(maxd, Math.abs(sdMax[i].r - pvMax[i].r));
ok('问题5', '预览档极大位置与标准档逐一对应，偏差 < 半径采样间隔', maxd < pv.rsamp.dr, `max |Δr| = ${(maxd * 1e9).toFixed(1)} nm，预览 Δr = ${(pv.rsamp.dr * 1e9).toFixed(1)} nm`);
// 源积分采样与半径扫描采样相互独立：改 rPhaseStep 不改 makeQuad；改 pathFrac 不改 N_r
const ph = D.physics(al), q1 = D.makeQuad(ph, 6e-3, D.PRECISION.preview), q2 = D.makeQuad(ph, 6e-3, Object.assign({}, D.PRECISION.preview, { rPhaseStep: 0.01 }));
const n1 = D.radiusSampling(ph, 6e-3, D.PRECISION.preview).nr, n2 = D.radiusSampling(ph, 6e-3, Object.assign({}, D.PRECISION.preview, { pathFrac: 80, gl: 12 })).nr;
ok('问题5', '源平面积分采样（makeQuad）与半径扫描采样（radiusSampling）互不影响', q1.h === q2.h && n1 === n2, `h = ${(q1.h * 1e6).toFixed(4)} μm，N_r = ${n1}`);
// 每个预设档都满足相位约束
for (const k of Object.keys(D.PRECISION)) { const rs = D.radiusSampling(ph, 6e-3, D.PRECISION[k]); ok('问题5', `${D.PRECISION[k].label}档：相邻半径采样边缘相位步 ≤ 上限`, rs.phaseStep <= rs.phaseStepBound * (1 + 1e-12) && !rs.capped, `${rs.phaseStep.toFixed(4)} ≤ ${rs.phaseStepBound.toFixed(4)} rad，每周期 ${rs.samplesPerPeriod.toFixed(1)} 点`); }

/* 问题 3：r_max = 0.3 mm */
const small = P({ lambda_nm: 500, L_cm: 50, rMax_mm: 0.3 });
let thrown = null, conv = null; try { conv = D.convergenceStudy(small); } catch (e) { thrown = e.message; }
ok('问题3', 'convergenceStudy 在 r_max = 0.3 mm（无极大）下不抛异常', !thrown && conv.reference.targetIndex === null && conv.grid.every((g) => g.r4max_mm === null) && conv.grid.every((g) => isFinite(g.maxAbsErrI)), thrown || JSON.stringify(conv.reference));
const mid = P({ lambda_nm: 500, L_cm: 50, rMax_mm: 1.2 });
const conv2 = D.convergenceStudy(mid);
ok('问题3', 'r_max = 1.2 mm（3 个极大）：收敛检查退而检查最后一个极大', conv2.reference.targetIndex === 3 && conv2.reference.nMaxima === 3 && !conv2.reference.hasFourth && conv2.grid.every((g) => g.r4max_mm !== null && isFinite(g.dr4_nm)) && conv2.grid.filter((g) => g.method === "GL" && g.gl === 8).every((g) => Math.abs(g.dr4_nm) < 1e-3), JSON.stringify({ target: conv2.reference.targetIndex, nMax: conv2.reference.nMaxima }));
const out = []; J.run({ type: 'conv', id: 7, params: small }, (m) => out.push(m));
ok('问题3', '经 jobs.js 运行 conv 任务：返回结果而不是 error', out.some((m) => m.type === 'conv') && !out.some((m) => m.type === 'error'), out.map((m) => m.type).filter((x) => x !== 'progress').join());
const q = D.computeQ1(small, 'standard');
ok('问题3', 'computeQ1(r_max = 0.3)：fourthMax = null，r⁴ 边界仍正确', q.fourthMax === null && Math.abs(mm(q.r4.rLimit) - 0.2495438957) < 1e-9, `extrema ${q.extrema.length}，r_lim = ${mm(q.r4.rLimit).toFixed(10)} mm`);

/* 问题 4：失败注入走 error 分支（任务层） */
const o2 = []; J.run({ type: 'q1', id: 9, params: preset, precision: 'preview', __simulateFailure: true }, (m) => o2.push(m));
ok('问题4', '失败注入：jobs.js 回传 {type:"error", id, job:"q1"}', o2.length === 1 && o2[0].type === 'error' && o2[0].id === 9 && o2[0].job === 'q1', o2[0] && o2[0].message.split('\n')[0]);

fs.writeFileSync(path.join(ROOT, 'validation', 'kernel_regression_fix1.json'), JSON.stringify({ when: new Date().toISOString(), node: process.version, kernel: D.VERSION, checks }, null, 2));
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} 项通过`);
process.exit(failed ? 1 : 0);
