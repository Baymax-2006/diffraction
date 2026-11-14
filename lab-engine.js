/* lab-engine.js — 任务调度、Worker 与已应用参数。
 * lab-engine.js、lab-q1.js、lab-q2.js、lab-export.js、app.js 按这个顺序用普通 script 加载，
 * 共用页面全局作用域，因此 file:// 可以直接打开，不必打包。 */
'use strict';

  var D = window.Diffraction;
  var $ = (id) => document.getElementById(id);
  var MM = (m) => D.fromSI(m, 'mm');
  var SI_MM = (v) => D.toSI(v, 'mm');

  /* ======================= 状态 ======================= */
  var DEFAULTS = { lambda_nm: D.PRESET.lambda_nm, L_cm: D.PRESET.L_cm, rMax_mm: D.PRESET.rMax_mm, thr: D.PRESET.r4Threshold, precision: 'standard' };
  var state = Object.assign({ r_mm: 1.0, xAxis: 'r', locked: true }, DEFAULTS);
  var result = null;     // 当前被接受（已完成）的第一问结果 —— 所有显示的唯一来源
  var point = null;      // 当前半径处的结果（预览 / 精确），总是属于 result
  var r4override = null; // 阈值改变后的精化结果（带 resultId）
  var latest = { q1: 0, point: 0, r4: 0, conv: 0, q2: 0 };
  var jobs = {};       // id -> {type, params, precision, quality, t0, engine}
  var seq = 0, staleDropped = 0, lastError = null, cancelledNote = '', importNote = '';
  var pendingRadius = null; // 载入配置时要在对应结果完成后恢复的半径 {r, jobId}
  /* 半径参数扫描状态：on = 处于扫描模式（含暂停），playing = 正在随时间增大 r */
  var scan = { on: false, playing: false, raf: 0, lastT: 0, note: '' };

  var isPresetParams = (P) => !!P && P.lambda_nm === DEFAULTS.lambda_nm && P.L_cm === DEFAULTS.L_cm;
  var isPreset = () => isPresetParams(result ? result.params : curParams());   // 以已应用参数为准
  var curParams = () => ({ lambda_nm: state.lambda_nm, L_cm: state.L_cm, A: 1, rMax_mm: state.rMax_mm, r4Threshold: state.thr });
  var appliedParams = () => (result ? result.params : curParams());
  var AP = () => D.physics(appliedParams());                 // 已应用参数的物理量
  var rMaxApplied = () => (result ? result.params.rMax_mm : state.rMax_mm);
  var sameParams = (a, b) => a && b && a.lambda_nm === b.lambda_nm && a.L_cm === b.L_cm && a.rMax_mm === b.rMax_mm;
  /* 未应用的编辑：编辑值 ≠ 已应用值的项 */
  function pendingEdits() {
    if (!result) return [];
    const P = result.params, out = [];
    if (state.lambda_nm !== P.lambda_nm) out.push({ key: 'lambda_nm', label: 'λ', edit: state.lambda_nm + ' nm', applied: P.lambda_nm + ' nm', ids: ['lamInput', 'lamSlider'] });
    if (state.L_cm !== P.L_cm) out.push({ key: 'L_cm', label: 'L', edit: state.L_cm + ' cm', applied: P.L_cm + ' cm', ids: ['LInput', 'LSlider'] });
    if (state.rMax_mm !== P.rMax_mm) out.push({ key: 'rMax_mm', label: 'r_max', edit: state.rMax_mm + ' mm', applied: P.rMax_mm + ' mm', ids: ['rMaxInput'] });
    if (state.precision !== result.precision && result.quality !== 'preview') out.push({ key: 'precision', label: '精度', edit: D.PRECISION[state.precision].label, applied: D.PRECISION[result.precision].label, ids: ['precSeg'] });
    return out;
  }

  /* ======================= 计算引擎（Worker，失败时回退主线程） =======================
   * 启动顺序：① new Worker('worker.js')（http://）；② file:// 下浏览器禁止按路径创建 Worker，改用 Blob Worker：
   * 把已加载的 diffraction.js / diffraction-q2.js / jobs.js 的模块源码（window.__kernelSrc，与磁盘文件同一份代码）
   * 拼成 Blob 脚本，因此 file:// 也在后台线程积分，可随时取消（terminate）；③ 两者都失败才回退主线程。 */
  function blobWorkerURL() {
    const K = window.__kernelSrc || {};
    if (!K.diffraction || !K.q2 || !K.jobs) return null;
    if (!blobWorkerURL.url) {
      const src = [K.diffraction, K.q2, K.jobs,
        "self.onmessage = (ev) => self.Q1Jobs.run(ev.data, (m, transfer) => self.postMessage(m, transfer || []));",
        "self.postMessage({ type: 'ready', version: self.Diffraction.VERSION, blob: true });"].join('\n;\n');
      blobWorkerURL.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return blobWorkerURL.url;
  }
  class Engine {
    constructor(name, onMsg) { this.name = name; this.onMsg = onMsg; this.queue = []; this.inflight = new Map(); this.mainQueue = []; this.kinds = /[?&]engine=main\b/.test(location.search) ? [] : location.protocol === 'file:' ? ['blob'] : ['url', 'blob']; this.kindIdx = 0; this._start(); }
    _deliver(m) { if (m.type !== 'progress') this.inflight.delete(m.id); this.onMsg(m); }
    _start() {
      this.ready = false; this.mode = 'worker';
      if (!this.kinds.length) { this.mode = 'main'; this.ready = true; this.why = '?engine=main 强制主线程（测试用）'; return; }
      const kind = this.kinds[this.kindIdx];
      try {
        const url = kind === 'blob' ? blobWorkerURL() : 'worker.js';
        if (!url) throw new Error('内核源码不可用，无法创建 Blob Worker');
        this.workerKind = kind;
        this.w = new Worker(url);
        this.w.onmessage = (e) => {
          if (e.data.type === 'ready') { this.ready = true; clearTimeout(this.tm); this.queue.splice(0).forEach((m) => this.w.postMessage(m)); setTimeout(renderMode, 0); return; }
          this._deliver(e.data);
        };
        this.w.onerror = (e) => { e.preventDefault && e.preventDefault(); this._next('Worker 出错：' + (e.message || '')); };
        this.tm = setTimeout(() => { if (!this.ready) this._next('Worker 3 秒内未就绪'); }, 3000);
      } catch (err) { this._next(String(err.message || err)); }
    }
    /* 当前方式失败：试下一种 Worker，全部失败才回退主线程 */
    _next(why) {
      if (this.mode === 'main') return;
      clearTimeout(this.tm);
      try { this.w && this.w.terminate(); } catch (e) { /* ignore */ }
      this.w = null; this.why = why;
      const pend = [], seen = new Set();
      const take = (m) => { if (!m || seen.has(m.id)) return; seen.add(m.id); pend.push(m); };
      this.inflight.forEach(take); this.queue.forEach(take);
      this.queue = []; this.inflight.clear();
      if (this.kindIdx + 1 < this.kinds.length) { this.kindIdx++; this._start(); pend.forEach((m) => this.post(m)); setTimeout(renderMode, 0); return; }
      this.mode = 'main'; this.ready = true;
      // Worker 崩溃时，已发出但未返回的任务（inflight）也要在主线程重跑，否则它们永远不会结束
      pend.forEach((m) => this.post(m)); setTimeout(renderMode, 0);
    }
    post(msg) {
      this.inflight.set(msg.id, msg);
      if (this.mode === 'worker') { if (this.ready) this.w.postMessage(msg); else this.queue.push(msg); return; }
      // 主线程回退：放到下一帧执行，先让界面刷新（只有 Worker 与 Blob Worker 都不可用时才会走到这里）
      this.mainQueue.push(msg);
      setTimeout(() => {
        const i = this.mainQueue.indexOf(msg); if (i >= 0) this.mainQueue.splice(i, 1);
        if (msg.__cancelled) return;
        window.Q1Jobs.run(msg, (m) => this._deliver(m));
      }, 16);
    }
    busyIds() { return [...this.inflight.keys()]; }
    /* 取消本引擎上全部未完成任务；返回被取消的任务 id 列表 */
    cancel() {
      const ids = [...this.inflight.keys()]; this.inflight.clear();
      if (this.mode === 'worker') { clearTimeout(this.tm); try { this.w.terminate(); } catch (e) { /* ignore */ } this.queue = []; this._start(); }
      else { this.mainQueue.forEach((m) => { m.__cancelled = true; }); this.mainQueue = []; }
      return ids;
    }
    get label() {
      if (this.mode === 'main') return '主线程回退（' + (this.why || 'Worker 不可用') + '）';
      if (!this.ready) return 'Worker 启动中…';
      return this.workerKind === 'blob' ? 'Web Worker 后台线程（file:// 内联 Blob）' : 'Web Worker 后台线程';
    }
  }
  /* 各类任务各用一个后台线程：新的同类任务可以直接终止旧线程（“取代”），而不会误杀别的任务 */
  var eng = new Engine('q1', onMessage);          // 第一问 I(r) 曲线（预览 / 最终）
  var engPt = new Engine('point', onMessage);     // 当前点精算、r⁴ 阈值精化
  var engConv = new Engine('conv', onMessage);    // 收敛检查
  var engQ2 = new Engine('q2', onMessage);        // 第二问二维图样
  var engProbe = new Engine('probe', onMessage);  // 第二问探针直接积分

  /* opt: {params, precision}（默认 = 编辑参数，仅 q1 用；point/r4/conv 必须传入已应用参数） */
  var debug = { failNext: null, log: [] };   // 回归测试钩子：failNext = 'q1' | 'q1-preview' | 'point' | 'conv' | 'q2' | 'q2-preview'
  function submit(type, extra, quality, engine, opt) {
    opt = opt || {};
    const id = ++seq;
    latest[type] = id;
    const params = opt.params || curParams();
    const precision = opt.precision || state.precision;
    const msg = Object.assign({ type, id, params, precision }, extra || {});
    const tag = (type === 'q1' && quality === 'preview') ? 'q1-preview' : (type === 'q2' && quality === 'preview') ? 'q2-preview' : type;
    if (debug.failNext && debug.failNext === tag) { msg.__simulateFailure = true; debug.failNext = null; }
    jobs[id] = { type, params, precision, quality: quality || 'final', t0: performance.now(), engine: engine || eng, group: opt.group };
    (engine || eng).post(msg);
    renderStatus();
    return id;
  }
  /* 任务终结（完成 / 过期 / 失败 / 取消）的唯一出口 */
  function endJob(id, outcome) {
    const j = jobs[id]; delete jobs[id];
    debug.log.push({ id, outcome, type: j && j.type, quality: j && j.quality });
    if (debug.log.length > 200) debug.log.shift();
    if (previewJob === id) {
      previewJob = null;
      // 拖动仍在继续（有更新的编辑值）且没有被最终任务取代：立刻提交下一次预览
      if (previewDirty && outcome !== 'cancelled' && outcome !== 'superseded') { previewDirty = false; requestQ1('preview'); }
    }
    if (typeof q2PreviewJob !== 'undefined' && q2PreviewJob === id) {
      q2PreviewJob = null;
      if (q2PreviewDirty && outcome !== 'cancelled' && outcome !== 'superseded') { q2PreviewDirty = false; requestQ2('preview'); }
    }
    return j;
  }

  function onMessage(m) {
    if (m.type === 'progress') {
      if (m.job === 'q2') {   // 第二问：同一请求组（预览 + 精确）的进度都显示
        const jq = jobs[m.id]; if (!jq || jq.group !== q2Group) return;
        setQ2Progress(m.frac); q2s.progressQuality = jq.quality; renderQ2Status();
        return;
      }
      if (m.id !== latest[m.job]) return;
      if (m.job === 'conv') $('convStatus').textContent = '收敛检查进行中… ' + Math.round(m.frac * 100) + '%';
      else if (m.job === 'q1') setProgress(m.frac);
      else if (m.job === 'q2') { setQ2Progress(m.frac); renderQ2Status(); }
      return;
    }
    const kind = m.type === 'error' ? m.job : m.type;
    // 先判断是否最新，再结束任务（endJob 可能提交新预览）。第二问按“请求组”判断：同组的预览与精确都属于当前请求
    const isLatest = kind === 'q2' ? !!(jobs[m.id] && jobs[m.id].group === q2Group) : m.id === latest[kind];
    const isQ1Kind = kind === 'q1' || kind === 'point' || kind === 'r4';
    if (!jobs[m.id]) { staleDropped++; renderStatus(); return; }   // 已取消的任务迟到的消息
    const j = endJob(m.id, m.type === 'error' ? 'failed' : (isLatest ? 'done' : 'stale'));
    if (m.type === 'error') {
      console.warn('[任务失败] ' + m.message.split('\n')[0]);
      if (isLatest) {
        if (isQ1Kind) lastError = (j && j.quality === 'preview' ? '预览' : '') + '计算失败：' + m.message.split('\n')[0];   // 第二问 / 探针 / 收敛的失败不污染第一问状态栏
        if (kind === 'q1') pendingQ2AfterQ1 = false;
        if (kind === 'conv') $('convStatus').textContent = '收敛检查失败：' + m.message.split('\n')[0];
        if (kind === 'q2') { q2s.lastError = (j && j.quality === 'preview' ? '预览' : '') + '计算失败：' + m.message.split('\n')[0]; renderQ2Status(); }
      }
      renderStatus(); renderPending(); renderQ2Status(); return;
    }
    if (!isLatest) { staleDropped++; renderStatus(); return; } // 过期结果不允许覆盖新结果
    if (isQ1Kind) lastError = null;
    if (m.type === 'q1') acceptQ1(m, j);
    else if (m.type === 'point') acceptPoint(m);
    else if (m.type === 'r4') { if (result && m.resultId === result.id && m.threshold === state.thr) { r4override = Object.assign({ resultId: result.id }, m.r4); renderR4(); renderMain(); renderConcept(); } }
    else if (m.type === 'conv') renderConvergence(m);
    else if (m.type === 'q2') acceptQ2(m, j);
    else if (m.type === 'probe') acceptProbe(m);
    renderStatus();
  }

  /* ======================= 请求 ======================= */
  var previewJob = null, previewDirty = false;
  function requestQ1(quality) {
    cancelledNote = '';
    if (quality === 'preview') {
      if (previewJob !== null) { previewDirty = true; renderPending(); return; }
      supersede(eng, 'q1');   // 正在跑的最终任务也要让位，否则预览排在它后面
      previewJob = submit('q1', null, 'preview', eng, { precision: 'preview' });
      renderPending();
      return;
    }
    previewDirty = false;      // 最终任务取代所有未发出的预览
    supersede(eng, 'q1');      // 旧的 I(r) 任务（预览或最终）直接终止，不再排队占用后台线程
    const id = submit('q1', null, 'final');
    renderPending();
    return id;
  }
  /* “取代”：同一专用线程上尚未完成的旧任务立即终止（terminate 线程）并记为 superseded，busy 标志随之清除。
   * 以前新任务要排在旧任务后面（例：连点 3 个情形要等 8.6 s），旧结果算完后再被丢弃。 */
  function supersede(engine, type) {
    const ids = Object.keys(jobs).map(Number).filter((k) => jobs[k].engine === engine && (!type || jobs[k].type === type));
    if (!ids.length) return 0;
    engine.cancel();
    ids.forEach((k) => endJob(k, 'superseded'));
    if (engine === eng) previewJob = null;
    if (engine === engQ2) q2PreviewJob = null;
    supersededCount += ids.length;
    return ids.length;
  }
  var supersededCount = 0;
  /* 当前点 / r⁴ 精化：只针对已完成的结果（已应用参数），带 resultId */
  function requestPoint() {
    if (!result) return;
    submit('point', { r: SI_MM(state.r_mm), M: segCount(SI_MM(state.r_mm)), resultId: result.id }, 'final', engPt, { params: result.params, precision: result.precision });
  }
  function requestR4() {
    if (!result || !result.curve) return;
    const c = result.curve;
    submit('r4', { threshold: state.thr, resultId: result.id, prefix: c.prefix || null, r: c.r, I: c.I }, 'final', engPt, { params: Object.assign({}, result.params, { r4Threshold: state.thr }), precision: result.precision });
  }

  /* ======================= 接收 ======================= */
  var lockNote = '';
  function acceptQ1(m, j) {
    const prevFourth = result && result.fourth;
    result = { id: m.id, params: m.params, precision: m.precision, quality: j ? j.quality : 'final', quad: m.quad, curve: m.curve, extrema: m.extrema, r4: m.r4, timing: m.timing,
      ms: j ? Math.round(performance.now() - j.t0) : null };
    result.maxima = result.extrema.filter((e) => e.kind === 'max');
    result.minima = result.extrema.filter((e) => e.kind === 'min');
    result.fourth = result.maxima[3] || null;
    r4override = null;
    if (result.r4.threshold !== state.thr && result.quality !== 'preview') requestR4();
    lockNote = '';
    if (state.locked && result.fourth) setRadius(MM(result.fourth.r), { fromLock: true, silent: true });
    else if (state.locked && !result.fourth) {   // 极值不足：解除锁定，不保留旧的 r₄
      state.locked = false;
      lockNote = prevFourth ? '原先锁定的第 4 极大属于旧参数，已失效，锁定已解除。' : '';
    }
    if (pendingRadius && pendingRadius.jobId === m.id) { setRadius(pendingRadius.r, { silent: true, keepLock: state.locked }); pendingRadius = null; }
    if (state.r_mm > result.params.rMax_mm) setRadius(result.params.rMax_mm, { silent: true, keepLock: true });
    applyRadiusRange();
    setProgress(1);
    point = previewPoint(SI_MM(state.r_mm));
    homeMain(); renderAll(); renderPending();
    if (result.quality !== 'preview') requestPoint();
    if (pendingQ2AfterQ1 && result.quality !== 'preview') { pendingQ2AfterQ1 = false; requestQ2('final'); }
    else if (!$('q2-panel').hidden && q2Stale()) renderQ2Pending();
  }
  function acceptPoint(m) {
    if (!result || m.resultId !== result.id || Math.abs(MM(m.r) - state.r_mm) > 1e-12) { staleDropped++; return; }
    point = { r: m.r, U: m.U, I: m.I, quality: 'precise', seg: m.seg, nodes: m.nodes, precision: m.precision, quad: m.quad, resultId: m.resultId };
    renderPointViews();
  }

  /* 相量图分段数：每个半波带约 8 段（12–120 段），仅为示意 */
  function segCount(r) { const ph = AP(); return Math.max(12, Math.min(120, Math.ceil(8 * r * r / (ph.lambda * ph.z)))); }
  /* 预览：由已算好的 I(r) 曲线的复振幅线性插值（拖动时即时显示） */
  function interpU(r) {
    const c = result.curve, n = c.nr, f = r / c.rMax * (n - 1);
    const j = Math.max(0, Math.min(n - 2, Math.floor(f))), t = Math.max(0, Math.min(1, f - j));
    return { re: c.re[j] * (1 - t) + c.re[j + 1] * t, im: c.im[j] * (1 - t) + c.im[j + 1] * t };
  }
  function previewPoint(r) {
    if (!result) return null;
    const U = interpU(Math.min(r, result.curve.rMax));
    const M = segCount(r), segs = []; let prev = { re: 0, im: 0 };
    for (let s = 1; s <= M; s++) { const u = interpU(r * s / M); segs.push({ r0: r * (s - 1) / M, r1: r * s / M, re: u.re - prev.re, im: u.im - prev.im, startRe: prev.re, startIm: prev.im }); prev = u; }
    return { r, U, I: U.re * U.re + U.im * U.im, quality: 'preview', seg: { segments: segs, sum: U }, resultId: result.id };
  }

  /* ======================= 半径设置 ======================= */
  var rafPending = false, idleTimer = null;
  function setRadius(r_mm, opt) {
    opt = opt || {};
    r_mm = Math.max(0, Math.min(rMaxApplied(), r_mm));
    state.r_mm = r_mm;
    if (!opt.fromLock && !opt.keepLock) state.locked = false;
    if (!opt.fromScan && !opt.silent) scanStop(false);
    $('rSlider').value = r_mm;
    if (document.activeElement !== $('rInput') || opt.forceInput) $('rInput').value = r_mm.toFixed(7);
    if (opt.silent) { if (typeof renderQ2Lock === 'function') renderQ2Lock(); return; }
    point = previewPoint(SI_MM(r_mm));
    if (opt.renderNow) renderPointViews();     // 扫描帧：同一帧内同步刷新三图，游标不滞后
    else if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderPointViews(); }); }
    clearTimeout(idleTimer);
    if (opt.precise) requestPoint();
    else if (!opt.noIdle) idleTimer = setTimeout(requestPoint, 220); // 停顿 220 ms 也会自动补算精确值
    if (typeof renderQ2Lock === 'function') { renderQ2Lock(); renderQ2Pending(); }
  }
  function applyRadiusRange() {
    const rm = rMaxApplied();
    slider.max = rm; $('rEnd').textContent = rm + ' mm'; $('rInput').max = rm;
    if ($('q2rInput')) $('q2rInput').max = rm;
    slider.value = state.r_mm;
  }

  /* ======================= 渲染：状态 ======================= */
  function setProgress(f) { $('progBar').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; }
  function precText(key) { const p = D.PRECISION[key]; return `${p.label}（面板光程差 ≤ λ/${p.pathFrac}，GL ${p.gl} 点，N_r = ${p.nr}）`; }
