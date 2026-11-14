#!/usr/bin/env node
/* validate.js — 命令行验证：直接 require 同一个内核 diffraction.js，输出到 validation/。
 * 用法：node validate.js            （约 10–30 s）
 */
'use strict';
const fs = require('fs'), path = require('path');
const D = require('./diffraction.js');
require('./diffraction-q2.js');
const OUT = path.join(__dirname, 'validation');
fs.mkdirSync(OUT, { recursive: true });
const params = { lambda_nm: D.PRESET.lambda_nm, L_cm: D.PRESET.L_cm, A: 1, rMax_mm: D.PRESET.rMax_mm, r4Threshold: 0.05 };
const ph = D.physics(params);
const mm = (m) => D.fromSI(m, 'mm'), nm = (m) => D.fromSI(m, 'nm'), um = (m) => D.fromSI(m, 'um');
const log = []; const P = (s) => { console.log(s); log.push(s); };
const t00 = Date.now();

P('# 圆孔衍射 第一问 数值验证报告（validate.js 自动生成）');
P(`生成时间：${new Date().toString()}；内核 ${D.VERSION}；Node ${process.version}`);
P(`参数：λ = ${params.lambda_nm} nm，L = ${params.L_cm} cm，A = 1，r_max = ${params.rMax_mm} mm；λL = ${mm(mm(ph.lambda * ph.z))} mm²`);

/* 1. 三档精度主结果 */
const res = {};
for (const k of Object.keys(D.PRECISION)) {
  const t0 = Date.now(); res[k] = D.computeQ1(params, k); res[k].ms = Date.now() - t0;
}
const S = res.standard;
P('\n## 1. 主结果（标准精度：面板光程差 ≤ λ/20，GL 8 点，N_r = 4000）');
P(`面板宽 h = ${um(S.quad.h).toFixed(4)} μm，面板数 ${S.curve.panels}，相邻节点最大光程差 ${nm(S.quad.pathPerNode).toFixed(3)} nm（λ/${(ph.lambda / S.quad.pathPerNode).toFixed(1)}），用时 ${S.ms} ms`);
P(`第 4 个极大：r = ${mm(S.fourthMax.r).toFixed(9)} mm，I/I_inc = ${S.fourthMax.I.toFixed(9)}，N_F = ${S.fourthMax.NF.toFixed(6)}`);
P('\n| 序号 | 类型 | r (mm) | r² (mm²) | N_F | n | I/I_inc | 离散峰 r (mm) | 验算 r_n（光程条件）(mm) | 差 (nm) |');
P('|---|---|---|---|---|---|---|---|---|---|');
const extRows = [];
for (const e of S.extrema) {
  const rn = D.pathConditionRadius(e.zone, ph);
  extRows.push({ kind: e.kind, index: e.index, r_mm: mm(e.r), r2_mm2: mm(e.r) ** 2, NF: e.NF, n: e.zone, I: e.I, rDiscrete_mm: mm(e.rDiscrete), rPath_mm: mm(rn), diff_nm: nm(e.r - rn) });
  P(`| ${e.kind === 'max' ? '极大' : '极小'} ${e.index} | ${e.kind} | ${mm(e.r).toFixed(9)} | ${(mm(e.r) ** 2).toFixed(7)} | ${e.NF.toFixed(6)} | ${e.zone} | ${e.I >= 1e-4 ? e.I.toFixed(9) : e.I.toExponential(3)} | ${mm(e.rDiscrete).toFixed(6)} | ${mm(rn).toFixed(9)} | ${nm(e.r - rn).toFixed(3)} |`);
}
fs.writeFileSync(path.join(OUT, 'extrema_standard.csv'), '\ufeff# 标准精度；r_path_mm 为独立验算（光程条件），非结果来源\nkind,index,r_mm,r2_mm2,NF,n,I_over_Iinc,r_discrete_mm,r_path_check_mm,diff_nm\n' +
  extRows.map((r) => [r.kind, r.index, r.r_mm.toPrecision(12), r.r2_mm2.toPrecision(12), r.NF.toPrecision(10), r.n, r.I.toPrecision(12), r.rDiscrete_mm.toPrecision(10), r.rPath_mm.toPrecision(12), r.diff_nm.toPrecision(6)].join(',')).join('\n'));
const maxima = S.extrema.filter((e) => e.kind === 'max'), minima = S.extrema.filter((e) => e.kind === 'min');
const dr2 = maxima.slice(1).map((e, i) => mm(e.r) ** 2 - mm(maxima[i].r) ** 2);
const drs = maxima.slice(1).map((e, i) => um(e.r - maxima[i].r));
P(`\n极大 ${maxima.length} 个、极小 ${minima.length} 个（不计 r=0），相邻极大之间完整周期数 ${maxima.length - 1}（要求 ≥ 5）。`);
P(`相邻极大 Δ(r²)：min ${Math.min(...dr2).toFixed(7)}，max ${Math.max(...dr2).toFixed(7)} mm²（2λL = ${(2 * mm(mm(ph.lambda * ph.z))).toFixed(7)}）；Δr：${drs[0].toFixed(2)} → ${drs[drs.length - 1].toFixed(2)} μm（r 上不等间隔）。`);

/* 2. r⁴ 适用区 */
P('\n## 2. r⁴ 适用区（ε(r) = |I/(C r⁴) − 1|，C 由 r_s = 10⁻³√(λL) 处数值积分得到）');
const ph0 = ph;
const r4rows = [];
for (const thr of [0.01, 0.02, 0.05, 0.10]) {
  const a = D.r4Analysis(S.curve, ph0, S.quad, thr);
  r4rows.push({ threshold: thr, rLimit_mm: mm(a.rLimit), NF: a.NFLimit });
  P(`阈值 ${(thr * 100).toFixed(0)} %：r ≤ ${mm(a.rLimit).toFixed(7)} mm（N_F ≤ ${a.NFLimit.toFixed(5)}）`);
}
const Cth = D.analyticCheckR4(1, ph);
P(`C（数值）= ${(S.r4.C * 1e-12).toPrecision(12)} mm⁻⁴；验算 π²/(λL)² = ${(Cth * 1e-12).toPrecision(12)} mm⁻⁴；相对差 ${(S.r4.C / Cth - 1).toExponential(2)}`);

/* 3. 独立验算 */
P('\n## 3. 独立验算（解析式只用于比较）');
let maxDiff = 0, maxRel4 = 0;
for (let i = 0; i < S.curve.nr; i++) maxDiff = Math.max(maxDiff, Math.abs(S.curve.I[i] - D.analyticCheckIntensity(S.curve.r[i], ph)));
P(`数值 I(r) 与近轴式 4sin²[k(√(L²+r²)−L)/2] 在 0…2.2 mm 全程最大 |ΔI| = ${maxDiff.toExponential(3)}（差异来自 RS1 的倾斜因子 L/R 与 1/R，量级 (r/L)² ≈ ${((2.2e-3 / 0.5) ** 2).toExponential(1)}×4）`);
// 黄金分割（不用导数）交叉检查第 4 极大
const m4 = S.fourthMax;
const rg = D.goldenExtremum((x) => D.intensity(D.onAxisField(x, ph, S.quad)), m4.rDiscrete - S.curve.rMax / (S.curve.nr - 1), m4.rDiscrete + S.curve.rMax / (S.curve.nr - 1), -1, 1e-13);
P(`第 4 极大：dI/dr=0 Brent 求根 r = ${mm(m4.r).toFixed(10)} mm；无导数黄金分割 r = ${mm(rg).toFixed(10)} mm；差 ${nm(rg - m4.r).toExponential(2)} nm`);
// 前缀和曲线 vs 直接积分
let maxCD = 0;
for (let i = 1; i < S.curve.nr; i += 37) maxCD = Math.max(maxCD, Math.abs(S.curve.I[i] - D.intensity(D.onAxisField(S.curve.r[i], ph, S.quad))));
P(`曲线（面板前缀和）与逐点直接积分（面板边界随 r 自适应）最大 |ΔI| = ${maxCD.toExponential(3)}`);
// 严格 RS1 因子 (1 − 1/(ikR)) 的影响
function fieldExactRS1(a) {
  const g = D.glNodes(8), N = Math.ceil(a / S.quad.h), w = a / N; let sr = 0, si = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < g.n; i++) {
    const rho = (j + 0.5) * w + 0.5 * w * g.x[i], R = Math.hypot(ph.z, rho), phi = ph.k * rho * rho / (R + ph.z);
    const amp = g.w[i] * 0.5 * w * 2 * Math.PI * rho * ph.z / (R * R);
    // (1 − 1/(ikR)) = 1 + i/(kR)
    const cr = Math.cos(phi), ci = Math.sin(phi), fr = 1, fi = 1 / (ph.k * R);
    sr += amp * (cr * fr - ci * fi); si += amp * (cr * fi + ci * fr);
  }
  return { re: si / ph.lambda, im: -sr / ph.lambda };
}
const Iex = D.intensity(fieldExactRS1(m4.r));
P(`在 r₄ 处加入严格 RS1 因子 (1 − 1/(ikR))：I 变化 ${(Iex - m4.I).toExponential(2)}（相对 ${((Iex - m4.I) / m4.I).toExponential(2)}），可忽略。`);

/* 4. 归一化 I_0 */
P('\n## 4. 归一化：不加遮挡平面波（高斯渐变孔径 e^{−ρ²/w²}）同一积分约定下的 I_0');
const normRows = [];
for (const w of [2e-3, 5e-3, 10e-3]) {
  const f = D.freeFieldTapered(ph, w, { pathFrac: 20, gl: 8 });
  const I0 = D.intensity(f.U);
  const corr = 1 / (1 + (ph.lambda * ph.z / (Math.PI * w * w)) ** 2); // 高斯光束轴上（菲涅耳）作为验算
  normRows.push({ w_mm: mm(w), I0, gaussCheck: corr });
  P(`w = ${mm(w)} mm：I_0 = ${I0.toFixed(9)}（高斯光束近似验算 ${corr.toFixed(9)}），w → ∞ 时 → 1 = I_inc`);
}

/* 5. 采样：实际光程差 */
P('\n## 5. 采样与光程差（λ/10 判据）');
const sampRows = {};
for (const k of Object.keys(D.PRECISION)) {
  const q = res[k].quad, g = D.glNodes(q.gl), N = res[k].curve.panels;
  let prevR = null, maxDR = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < g.n; i++) {
    const rho = (j + 0.5) * q.h + 0.5 * q.h * g.x[i]; if (rho > S.curve.rMax) break;
    const R = Math.hypot(ph.z, rho); if (prevR !== null) maxDR = Math.max(maxDR, Math.abs(R - prevR)); prevR = R;
  }
  sampRows[k] = { h_um: um(q.h), gl: q.gl, panels: N, pathPerPanelBound_nm: nm(q.pathPerPanel), pathPerNodeBound_nm: nm(q.pathPerNode), actualMaxAdjacentPath_nm: nm(maxDR) };
  P(`${D.PRECISION[k].label}：h = ${um(q.h).toFixed(4)} μm，GL ${q.gl}，面板光程差上界 ${nm(q.pathPerPanel).toFixed(3)} nm，相邻节点上界 ${nm(q.pathPerNode).toFixed(3)} nm，实际相邻节点最大光程差 ${nm(maxDR).toFixed(3)} nm（λ/10 = 50 nm）`);
}
// 第二问规划：用实际笛卡尔网格枚举边缘和角点的相邻光程差
const planIn = D.phase2Plan(ph, m4.r, D.toSI(2.5, 'mm'), { pathFrac: 10, incPhaseSpan: 0 });
const plan = D.phase2Plan(ph, m4.r, D.toSI(2.5, 'mm'), { pathFrac: 10, incPhaseSpan: 8 * Math.PI });
function gridAdjMax(d, xp, yp, a, phaseFn) {
  const n = Math.ceil(a / d); let maxDR = 0, maxDphi = 0, maxDphiDiag = 0;
  const Rf = (X, Y) => Math.hypot(ph.z, Math.hypot(xp - X, yp - Y));
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const X = i * d, Y = j * d; if (X * X + Y * Y > a * a) continue;
    const R0 = Rf(X, Y);
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const X2 = (i + di) * d, Y2 = (j + dj) * d; if (X2 * X2 + Y2 * Y2 > a * a) continue;
      const dR = Math.abs(Rf(X2, Y2) - R0); if (di === 0 || dj === 0) maxDR = Math.max(maxDR, dR);
      const dphi = Math.abs(ph.k * (Rf(X2, Y2) - R0) + (phaseFn ? phaseFn(X2, Y2) - phaseFn(X, Y) : 0));
      if (di === 0 || dj === 0) maxDphi = Math.max(maxDphi, dphi); else maxDphiDiag = Math.max(maxDphiDiag, dphi);
    }
  }
  return { maxDR, maxDphi, maxDphiDiag };
}
const a4 = m4.r, linPhase = (X) => 8 * Math.PI * (X + a4) / (2 * a4);
const edge = gridAdjMax(plan.dSrc, D.toSI(2.5, 'mm'), 0, a4, null);
const corner = gridAdjMax(plan.dSrc, D.toSI(2.5, 'mm'), D.toSI(2.5, 'mm'), a4, linPhase);
const cornerNeg = gridAdjMax(plan.dSrc, D.toSI(-2.5, 'mm'), D.toSI(2.5, 'mm'), a4, linPhase);
P(`第二问（a = r₄ = ${mm(a4).toFixed(7)} mm，观察区 ±2.5 mm）：边缘 |∇R| 上界 ${plan.gEdge.toExponential(4)}，角点 ${plan.gCorner.toExponential(4)}；λ/10 ⇒ d ≤ ${um(plan.dEdge).toFixed(3)} μm（边缘）/ ${um(plan.dCorner).toFixed(3)} μm（角点）；同相（不含 8π）计划 d = ${um(planIn.dSrc).toFixed(3)} μm。`);
P(`  情形 3 入射相位梯度 8π/(2a) = ${plan.incGrad.toFixed(2)} rad/m，合并相位判据 ⇒ d ≤ ${um(plan.dCombined).toFixed(3)} μm；计划 d = ${um(plan.dSrc).toFixed(3)} μm，孔内约 ${plan.nDisc} 点。`);
P(`  以 d = ${um(plan.dSrc).toFixed(3)} μm 笛卡尔网格实际枚举：边缘点 (2.5,0) mm 相邻（x/y 方向）最大光程差 ${nm(edge.maxDR).toFixed(3)} nm；角点 (2.5,2.5) mm ${nm(corner.maxDR).toFixed(3)} nm；`);
P(`  含 8π 线性相位（传播相位 + 入射相位）时，沿网格轴相邻样本最大相位步：角点 (2.5,2.5) mm ${corner.maxDphi.toFixed(4)} rad，角点 (−2.5,2.5) mm ${cornerNeg.maxDphi.toFixed(4)} rad（λ/10 对应 ${(2 * Math.PI / 10).toFixed(4)} rad）；`);
P(`  对角相邻样本距离为 √2·d，其相位步为 ${corner.maxDphiDiag.toFixed(4)} / ${cornerNeg.maxDphiDiag.toFixed(4)} rad（判据按轴向相邻定义；若要求对角也 ≤ λ/10，需 d ≤ ${um(plan.dSrc / Math.SQRT2).toFixed(3)} μm）。`);
P(`  观察面：强度最高空间频率 ≈ 2a/(λL) = ${(plan.fMax / 1000).toFixed(3)} mm⁻¹，Nyquist 间距 ${um(plan.dObsNyq).toFixed(2)} μm，计划 ≤ ${um(plan.dObsPlan).toFixed(2)} μm（${plan.nObs}×${plan.nObs}）。`);

/* 5b. 半径扫描采样（与源平面积分采样分开；修复轮新增） */
P('\n## 5b. 半径扫描采样（I(r) 曲线的 r 点，与源平面积分采样分开）');
P('判据：相邻半径采样之间边缘相位 k(R−L) 的增量 ≤ rPhaseStep（预览 π/4、标准 π/20、高精 π/80），N_r = max(基础点数, ⌈r_max/Δr⌉+1)。');
const rsRows = {};
for (const k of Object.keys(D.PRECISION)) {
  const rs = res[k].rsamp; rsRows[k] = rs;
  P(`${D.PRECISION[k].label}：N_r = ${rs.nr}（基础 ${rs.nrBase}，相位约束需要 ${rs.nrNeed}），Δr = ${um(rs.dr).toFixed(4)} μm，边缘相位步 ${rs.phaseStep.toFixed(5)} rad（上限 ${rs.phaseStepBound.toFixed(5)}），ΔN_F = ${rs.dNF.toExponential(3)}，每周期 ${rs.samplesPerPeriod.toFixed(1)} 点；极值定位 ${res[k].refineMode}`);
}
{
  const al = { lambda_nm: 380, L_cm: 10, A: 1, rMax_mm: 6, r4Threshold: 0.05 };
  const pv = D.computeQ1(al, 'preview');
  P(`混叠工况 λ = 380 nm、L = 10 cm、r_max = 6 mm（N_F,max = ${(36e-6 / (380e-9 * 0.1)).toFixed(2)}）：预览档 N_r = ${pv.curve.nr}，检出 ${pv.extrema.filter((e) => e.kind === 'max').length} 个极大（修复前固定 800 点只有 181 个；标准档 473 个，见 tools/kernel_regression_fix1.js）。`);
}

/* 6. 二维极坐标直接积分 vs 一维径向（为第二问做准备） */
P('\n## 6. 二维直接积分（fieldAtPoint2D，极坐标网格）与一维径向积分在 O′ 的交叉检查');
const t2 = Date.now();
const f2 = D.fieldAtPoint2D(0, 0, a4, ph, { d: plan.dSrc, gl: 6 });
const I2 = D.intensity(f2.U);
P(`O′：二维 I = ${I2.toFixed(10)}（${f2.samples} 个样本，${Date.now() - t2} ms），一维 I = ${m4.I.toFixed(10)}，差 ${(I2 - m4.I).toExponential(2)}`);
const fx = D.fieldAtPoint2D(D.toSI(1, 'mm'), 0, a4, ph, { d: plan.dSrc, gl: 6 });
const fy = D.fieldAtPoint2D(0, D.toSI(1, 'mm'), a4, ph, { d: plan.dSrc, gl: 6 });
P(`对称性：(X′,Y′) = (1,0) mm 处 I = ${D.intensity(fx.U).toExponential(6)}，(0,1) mm 处 I = ${D.intensity(fy.U).toExponential(6)}，相对差 ${(D.intensity(fx.U) / D.intensity(fy.U) - 1).toExponential(2)}`);

/* 7. 收敛检查 */
P('\n## 7. 收敛检查');
const tc = Date.now();
const conv = D.convergenceStudy(params);
P(`参考解：q = ${conv.reference.pathFrac}，GL ${conv.reference.gl}，h = ${conv.reference.h_um.toFixed(4)} μm；r₄ = ${conv.reference.r4max_mm.toFixed(10)} mm，I₄ = ${conv.reference.I4.toFixed(10)}（${Date.now() - tc} ms）`);
P('\n### 7A 源平面网格加密（400 个测试半径上 max|I − I_ref|；第 4 极大位置）');
P('| 规则 | q (λ/q) | h (μm) | max abs ΔI | r₄ (mm) | Δr₄ (nm) | ΔI₄ |'); P('|---|---|---|---|---|---|---|');
for (const g of conv.grid) P(`| ${g.method === 'GL' ? 'GL' + g.gl : '环带中点和'} | ${g.pathFrac} | ${g.h_um.toFixed(3)} | ${g.maxAbsErrI.toExponential(2)} | ${g.r4max_mm.toFixed(10)} | ${g.dr4_nm.toExponential(2)} | ${g.dI4.toExponential(2)} |`);
P('\n### 7B 半径采样加密（标准精度求积）');
P('| N_r | Δr (μm) | 极值数 | 离散峰 r₄ (mm) | 离散误差 (nm) | 精化 r₄ (mm) | 精化误差 (nm) | 全部极值较上一行最大移动 (nm) |'); P('|---|---|---|---|---|---|---|---|');
for (const s of conv.rsamp) P(`| ${s.nr} | ${s.dr_um.toFixed(3)} | ${s.nExtrema} | ${s.r4raw_mm.toFixed(7)} | ${s.dRawVsRef_nm.toFixed(2)} | ${s.r4ref_mm.toFixed(10)} | ${s.dRefinedVsRef_nm.toExponential(2)} | ${s.maxShiftAllExtrema_nm === null ? '—' : s.maxShiftAllExtrema_nm.toExponential(2)} |`);
P('\n### 7C 三档精度预设 vs 参考解（全部极值）');
P('| 预设 | 极值数 | max abs Δr (nm) | max abs ΔI | r₄ (mm) | r⁴ 5% 边界 (mm) | 用时 (ms) |'); P('|---|---|---|---|---|---|---|');
for (const k of Object.keys(conv.presets)) { const p = conv.presets[k]; P(`| ${D.PRECISION[k].label} | ${p.nExtrema} | ${p.maxAbsDr_nm.toExponential(2)} | ${p.maxAbsDI.toExponential(2)} | ${p.r4max_mm.toFixed(10)} | ${p.r4lim_mm.toFixed(7)} | ${res[k].ms} |`); }

/* 8. 交叉对照（另一个独立 Python 工程给出的参考值，只做比较） */
P('\n## 8. 与题目给出的独立参考值对照（只比较，不作输入）');
P(`参考：5 % 区 r ≤ 0.250 mm、1 % 区 r ≤ 0.166 mm、第 4 极大 r ≈ 1.3228768 mm、I ≈ 4.0。本项目：5 % ${r4rows[2].rLimit_mm.toFixed(4)} mm，1 % ${r4rows[0].rLimit_mm.toFixed(4)} mm，r₄ ${mm(m4.r).toFixed(7)} mm，I₄ ${m4.I.toFixed(6)}。`);
/* 9. 第二问（完整套件见 tools/kernel_regression_phase2.js） */
P('\n## 9. 第二问二维图样（标准档同相/圆屏/线性；随机用预览档抽检）');
{
  const a = m4.r, W = D.toSI(2.5, 'mm');
  const tq = Date.now();
  const hole = D.computeQ2(params, 'standard', { a, halfWidth: W, caseKey: 'inphase' });
  const disk = D.computeQ2(params, 'standard', { a, halfWidth: W, caseKey: 'disk' });
  const lin = D.computeQ2(params, 'standard', { a, halfWidth: W, caseKey: 'linear' });
  const rnd = D.computeQ2(params, 'preview', { a, halfWidth: W, caseKey: 'random', seed: D.Q2_DEFAULT_SEED, cellSize: D.toSI(40, 'um') });
  P(`同相圆孔：轴上直接 I = ${hole.axis.direct.I.toFixed(9)}（径向交叉 ${hole.axis.direct.I_radial.toFixed(9)}），FFT I = ${hole.axis.I.toFixed(6)}，抽检 max|ΔI| = ${hole.maxAbsDI.toExponential(2)}；源 d = ${um(hole.samp.dSrc).toFixed(3)} μm，观察 ${hole.samp.nObs}×${hole.samp.nObs}、d = ${um(hole.samp.dObs).toFixed(2)} μm，FFT N = ${hole.samp.Nfft}。`);
  P(`不透明圆屏：轴上直接 I = ${disk.axis.direct.I.toFixed(9)} = |1−U′_hole|²；圆孔轴上 ${disk.axis.direct.I_hole.toFixed(9)}。巴比涅探针残差 max ${Math.max(...disk.babinetChecks.map((b) => b.residual)).toExponential(2)}。`);
  P(`线性 8π：预计 ΔX′ = ${mm(lin.tilt.shiftOnScreen).toFixed(6)} mm，数值峰值 ${mm(lin.shiftMeas.peakX).toFixed(6)} mm，方向 ${lin.shiftMeas.direction}；O′ 处 I = ${lin.axis.direct.I.toFixed(6)}，预计偏移点 I = ${lin.axis.directShift.I.toFixed(9)}。`);
  P(`随机相位（题目预设：逐点独立，种子 ${rnd.seed}，δ = 源间距 ${um(rnd.samp.dSrc).toFixed(3)} μm）：预览轴上 I = ${rnd.axis.direct.I.toFixed(6)}，Imax = ${rnd.map.Imax.toFixed(4)}（单次实现，非时间平均；换网格会换相位）。`);
  P(`第二问这四次计算合计 ${Date.now() - tq} ms。`);
  global.__phase2 = { hole, disk, lin, rnd };
}

P(`\n总用时 ${((Date.now() - t00) / 1000).toFixed(1)} s。`);

const results = {
  phase2: global.__phase2 && {
    I_hole_direct: global.__phase2.hole.axis.direct.I, I_disk_direct: global.__phase2.disk.axis.direct.I,
    shift_peak_mm: mm(global.__phase2.lin.shiftMeas.peakX), shift_pred_mm: mm(global.__phase2.lin.tilt.shiftOnScreen),
    seed: global.__phase2.rnd.seed, sampling: { dSrc_um: um(global.__phase2.hole.samp.dSrc), dObs_um: um(global.__phase2.hole.samp.dObs), Nfft: global.__phase2.hole.samp.Nfft, nObs: global.__phase2.hole.samp.nObs, maxAbsDI: global.__phase2.hole.maxAbsDI }
  },
  generated: new Date().toISOString(), kernel: D.VERSION, params,
  quadrature: { standard: S.quad, sampling: sampRows, radiusSampling: rsRows },
  fourthMax: { r_mm: mm(m4.r), I_over_Iinc: m4.I, NF: m4.NF, goldenCheck_r_mm: mm(rg) },
  r4: { C_per_mm4: S.r4.C * 1e-12, C_theory_per_mm4: Cth * 1e-12, rows: r4rows },
  extrema: extRows, counts: { maxima: maxima.length, minima: minima.length, completeCycles: maxima.length - 1 },
  checks: { maxAbsDiffVsParaxialCheck: maxDiff, maxCurveVsDirect: maxCD, exactRS1FactorDeltaI: Iex - m4.I, twoD_vs_1D_atO: I2 - m4.I, twoDSamples: f2.samples },
  normalization: normRows,
  phase2Plan: Object.assign({}, plan, { edgeActualMaxAdjPath_nm: nm(edge.maxDR), cornerActualMaxAdjPath_nm: nm(corner.maxDR), cornerMaxPhaseStepWith8pi_rad: corner.maxDphi, cornerNegMaxPhaseStepWith8pi_rad: cornerNeg.maxDphi, cornerDiagPhaseStep_rad: corner.maxDphiDiag, cornerNegDiagPhaseStep_rad: cornerNeg.maxDphiDiag }),
  convergence: conv,
  presets: Object.fromEntries(Object.keys(res).map((k) => [k, { ms: res[k].ms, r4max_mm: mm(res[k].fourthMax.r), I4: res[k].fourthMax.I, r4lim_mm: mm(res[k].r4.rLimit), nExtrema: res[k].extrema.length }]))
};
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(OUT, 'validation_report.md'), log.join('\n') + '\n');
console.log('\n已写入 validation/results.json、validation/validation_report.md、validation/extrema_standard.csv');
