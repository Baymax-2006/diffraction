/* jobs.js — 计算任务调度（Worker 与主线程回退共用同一份代码）。
 * run(msg, post)：执行一个任务，通过 post(m, transfer) 回传进度与结果。每个结果都带上请求的 id。 */
(function jobsModule(root) {
  'use strict';
  const D = root.Diffraction;

  /* 仅供回归测试：消息带 __simulateFailure 时抛出异常，用来验证“任务失败”分支的生命周期处理 */
  function maybeFail(msg) { if (msg.__simulateFailure) throw new Error('模拟计算失败（回归测试注入）'); }

  function q1(msg, post) {
    const { id, params, precision } = msg;
    maybeFail(msg);
    const res = D.computeQ1(params, precision, { onProgress: (f) => post({ type: 'progress', id, job: 'q1', frac: f }) });
    const c = res.curve;
    const curve = { r: c.r, re: c.re, im: c.im, I: c.I, eps: res.r4.eps, nr: c.nr, rMax: c.rMax, panels: c.panels, rsamp: res.rsamp, refineMode: res.refineMode, prefix: c.prefix };
    const extrema = res.extrema.map((e) => ({ kind: e.kind, index: e.index, r: e.r, rDiscrete: e.rDiscrete, I: e.I, IDiscrete: e.IDiscrete, NF: e.NF, zone: e.zone, re: e.U.re, im: e.U.im }));
    const r4 = { C: res.r4.C, rs: res.r4.rs, threshold: res.r4.threshold, rLimit: res.r4.rLimit, NFLimit: res.r4.NFLimit, refined: res.r4.refined };
    const transfer = [curve.r.buffer, curve.re.buffer, curve.im.buffer, curve.I.buffer, curve.eps.buffer];
    if (curve.prefix) transfer.push(curve.prefix.buffer);
    post({ type: 'q1', id, params, precision, quad: res.quad, curve, extrema, r4, timing: res.timing }, transfer);
  }

  function point(msg, post) {
    const { id, params, precision, r, M } = msg;
    maybeFail(msg);
    const ph = D.physics(params);
    const quad = D.makeQuad(ph, Math.max(D.toSI(params.rMax_mm, 'mm'), r), D.PRECISION[precision]);
    const U = D.onAxisField(r, ph, quad);
    const seg = r > 0 ? D.segmentPhasors(r, M || 24, ph, quad) : { segments: [], sum: { re: 0, im: 0 } };
    post({ type: 'point', id, resultId: msg.resultId, params, precision, r, U, I: D.intensity(U), seg, quad, nodes: Math.ceil(r / quad.h) * quad.gl });
  }

  function r4(msg, post) {
    const { id, params, precision, threshold } = msg;
    const ph = D.physics(params);
    const prec = D.PRECISION[precision];
    const rMax = D.toSI(params.rMax_mm, 'mm');
    maybeFail(msg);
    const quad = D.makeQuad(ph, rMax, prec);
    let curve;
    if (msg.prefix && msg.r && msg.I) {
      const prefix = msg.prefix instanceof Float64Array ? msg.prefix : Float64Array.from(msg.prefix);
      const r = msg.r instanceof Float64Array ? msg.r : Float64Array.from(msg.r);
      const I = msg.I instanceof Float64Array ? msg.I : Float64Array.from(msg.I);
      curve = { r, I, rMax, prefix, nr: r.length, fieldAt: (x) => D.fieldAtPrefix(x, ph, quad, prefix) };
    } else curve = D.onAxisCurve(ph, rMax, D.radiusSampling(ph, rMax, prec).nr, quad);
    const a = D.r4Analysis(curve, ph, quad, threshold);
    post({ type: 'r4', id, resultId: msg.resultId, params, precision, threshold, r4: { C: a.C, rs: a.rs, threshold, rLimit: a.rLimit, NFLimit: a.NFLimit, refined: a.refined } });
  }

  function conv(msg, post) {
    const { id, params } = msg;
    maybeFail(msg);
    const t0 = Date.now();
    const result = D.convergenceStudy(params, (f) => post({ type: 'progress', id, job: 'conv', frac: f }));
    post({ type: 'conv', id, resultId: msg.resultId, params, result, ms: Date.now() - t0 });
  }

  function takeArr(arr, transfer) {
    if (!arr) return null;
    // 同一张图可能被 map / mapHole / mapDisk 共享，不能把同一 ArrayBuffer 移交两次
    if (transfer.indexOf(arr.buffer) >= 0) {
      const copy = new Float64Array(arr);
      transfer.push(copy.buffer);
      return copy;
    }
    transfer.push(arr.buffer);
    return arr;
  }
  function packCut(c, transfer) {
    if (!c) return null;
    return { axis: c.axis, other: c.other, n: c.n, x: takeArr(c.x, transfer), I: takeArr(c.I, transfer), re: takeArr(c.re, transfer), im: takeArr(c.im, transfer) };
  }
  function packMap(m, transfer) {
    if (!m) return null;
    return { I: takeArr(m.I, transfer), re: takeArr(m.re, transfer), im: takeArr(m.im, transfer), nObs: m.nObs, dObs: m.dObs, halfWidth: m.halfWidth, Imax: m.Imax, Imin: m.Imin, onNodes: !!m.onNodes, stride: m.stride || 1 };
  }
  function q2(msg, post) {
    const { id } = msg;
    maybeFail(msg);
    const prec = msg.q2Precision || msg.precision;
    const res = D.computeQ2(msg.params, prec, {
      a: msg.a, halfWidth: msg.halfWidth, caseKey: msg.caseKey,
      seed: msg.seed, cellSize: msg.cellSize, randomMode: msg.randomMode,
      onProgress: (f) => post({ type: 'progress', id, job: 'q2', frac: f }),
      skipSpot: !!msg.skipSpot
    });
    const transfer = [];
    const packed = {
      type: 'q2', id, resultId: msg.resultId, params: msg.params,
      q2Precision: res.prec.key, caseKey: res.caseKey, a: res.a, halfWidth: res.halfWidth, ph: res.ph, prec: res.prec,
      seed: res.seed, cellSize: res.cellSize, randomMode: res.randomMode, quality: res.quality,
      samp: res.samp, tilt: res.tilt, shiftMeas: res.shiftMeas,
      axis: res.axis, checks: res.checks, babinetChecks: res.babinetChecks, cornerCheck: res.cornerCheck,
      maxAbsDI: res.maxAbsDI, maxAbsDU: res.maxAbsDU,
      apertureBuild: res.apertureBuild, timing: res.timing, conventions: res.conventions,
      map: packMap(res.map, transfer),
      mapHole: packMap(res.mapHole, transfer),
      mapDisk: packMap(res.mapDisk, transfer),
      cutX: packCut(res.cutX, transfer), cutY: packCut(res.cutY, transfer),
      cutXhole: packCut(res.cutXhole, transfer), cutYhole: packCut(res.cutYhole, transfer),
      ap: res.ap && { n: res.ap.n, half: res.ap.half, d: res.ap.d, caseKey: res.ap.caseKey, amp: takeArr(res.ap.amp, transfer), phase: takeArr(res.ap.phase, transfer) }
    };
    post(packed, transfer);
  }

  /* 第二问探针：在已完成图样的同一套参数（λ, L, r, 情形, 种子, 单元格, 源间距 d）下，
   * 用 fieldAtPoint2D 直接极坐标积分求探针处的 U、I —— 与 FFT 网格插值读数对照。 */
  function probe(msg, post) {
    const { id } = msg;
    maybeFail(msg);
    const ph = D.physics(msg.params);
    const t0 = Date.now();
    const r = D.pointQ2(msg.xp, msg.yp, msg.a, ph, {
      d: msg.d, n: msg.n, gl: msg.gl, caseKey: msg.caseKey, seed: msg.seed, cellSize: msg.cellSize,
      randomMode: msg.randomMode, edgeSub: msg.edgeSub, a: msg.a
    });
    post({ type: 'probe', id, resultId: msg.resultId, xp: msg.xp, yp: msg.yp, U: r.U, I: D.intensity(r.U), samples: r.samples, ms: Date.now() - t0 });
  }

  function validateJob(msg) {
    if (!msg || !msg.params) throw new Error('缺少参数');
    D.validateParams(msg.params);
    if (msg.type === 'q2' || msg.type === 'probe') {
      if (!Number.isFinite(msg.a) || msg.a < 0) throw new Error('半径 r 必须 ≥ 0');
    }
    if ((msg.type === 'q2' || msg.type === 'probe') && msg.cellSize != null && msg.randomMode === 'cell') {
      const um = msg.cellSize * 1e6;
      if (!D.inRange('cell_um', um)) throw new Error('单元格边长须在 ' + D.PARAM_RANGES.cell_um.min + '–' + D.PARAM_RANGES.cell_um.max + ' μm');
    }
  }
  const table = { q1, point, r4, conv, q2, probe };
  root.Q1Jobs = {
    run(msg, post) {
      try { validateJob(msg); table[msg.type](msg, post); }
      catch (err) { post({ type: 'error', id: msg.id, job: msg.type, message: String((err && err.stack) || err) }); }
    }
  };
  (root.__kernelSrc = root.__kernelSrc || {}).jobs = '(' + String(jobsModule) + ')(self);';   // 供 file:// Blob Worker
})(typeof self !== 'undefined' ? self : this);
