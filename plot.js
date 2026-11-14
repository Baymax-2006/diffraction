/* plot.js — 轻量 Canvas 曲线图（无依赖）。支持：线性/对数轴、滚轮缩放、拖动平移、双击复位、
 * 悬停十字读数、可点击标记点、竖线/横线/阴影带、游标点。只负责绘图与交互，不含任何物理。
 *
 * 标记标签布局（修复“极值标签被绘图区裁剪/截断”）：
 *   带 lane: 'top' | 'bottom' 的标记，其标签不再画在绘图区内（会被 clip 裁掉），而是画在绘图框
 *   上方 / 下方专门留出的“标签带”（opts.labelBand 像素高）里，竖排文字；同一条带内按 x 排序后做
 *   一维防重叠排布（最小间距 = 字高 + 2 px），并整体限制在绘图框左右边界之内，所以最右侧标签也不会截断。
 *   标签与标记之间画细引线。标签可点击（与点击标记等效）。 */
(function (root) {
  'use strict';
  const COLORS = { bg: '#060c16', grid: '#1b2a3e', axis: '#3a526d', text: '#93aac2', strong: '#eaf4ff' };

  function niceStep(span, target) {
    const raw = span / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function fmt(v, step) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e', 'e');
    const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step || a)) ));
    return v.toFixed(d);
  }
  function supExp(e) {
    const m = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    return '10' + String(e).split('').map((c) => m[c]).join('');
  }

  class LinePlot {
    constructor(canvas, opts) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.o = Object.assign({ xlog: false, ylog: false, xlabel: '', ylabel: '', pad: { l: 62, r: 16, t: 14, b: 42 },
        yZoom: false, title: '' }, opts || {});
      this.series = []; this.markers = []; this.vlines = []; this.hlines = []; this.bands = []; this.texts = []; this.cursor = null;
      this.labelBoxes = [];
      this.home = null; this.view = null; this.hover = null; this.drag = null;
      this.onHover = null; this.onMarkerClick = null; this.onClickX = null; this.onView = null;
      this._bind(); this._resize();
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this._resize(); this.draw(); }).observe(canvas);
    }
    _resize() {
      const dpr = window.devicePixelRatio || 1, r = this.c.getBoundingClientRect();
      this.W = Math.max(50, r.width); this.H = Math.max(50, r.height);
      this.c.width = Math.round(this.W * dpr); this.c.height = Math.round(this.H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    /* 以给定 CSS 尺寸离屏渲染（用于 PNG 导出，与窗口宽度无关，标签按导出尺寸重新排布） */
    renderOffscreen(W, H, scale) {
      scale = scale || 1;
      const cv = document.createElement('canvas'); cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
      const save = { ctx: this.ctx, W: this.W, H: this.H, hover: this.hover, boxes: this.labelBoxes };
      this.ctx = cv.getContext('2d'); this.ctx.setTransform(scale, 0, 0, scale, 0, 0); this.W = W; this.H = H; this.hover = null;
      try { this.draw(); this.lastOffscreen = { W, H, boxes: this.labelBoxes, band: Object.assign({}, this._band), pad: this.pad }; }
      finally { this.ctx = save.ctx; this.W = save.W; this.H = save.H; this.hover = save.hover; this.labelBoxes = save.boxes; this._computeBand(); }
      return cv;
    }
    tx(v, ax) { return this.o[ax + 'log'] ? Math.log10(Math.max(v, 1e-300)) : v; }
    itx(v, ax) { return this.o[ax + 'log'] ? Math.pow(10, v) : v; }
    setHome(h, keepView) { this.home = h; if (!keepView || !this.view) this.view = Object.assign({}, h); }
    resetView() { if (this.home) this.view = Object.assign({}, this.home); this.draw(); if (this.onView) this.onView(this.view); }
    /* 标签带高度：labelBand.top/bottom 为数字（固定）或 'auto'（按该带最长标签宽度 + 引线留白自动确定） */
    _computeBand() {
      const lb = this.o.labelBand || {}, out = {};
      for (const lane of ['top', 'bottom']) {
        if (lb[lane] === 'auto') {
          const ms = this.markers.filter((m) => m.lane === lane && m.label);
          if (!ms.length) { out[lane] = 0; continue; }
          this.ctx.font = '600 10.5px "Microsoft YaHei",Consolas,sans-serif';
          out[lane] = Math.ceil(Math.max(...ms.map((m) => this.ctx.measureText(m.label).width)) + 16);
        } else out[lane] = lb[lane] || 0;
      }
      this._band = out; return out;
    }
    get pad() { const p = this.o.pad, b = this._band || {}; return { l: p.l, r: p.r, t: p.t + (b.top || 0), b: p.b + (b.bottom || 0) }; }
    px(x) { const p = this.pad, v = this.view; return p.l + (this.tx(x, 'x') - this.tx(v.x0, 'x')) / (this.tx(v.x1, 'x') - this.tx(v.x0, 'x')) * (this.W - p.l - p.r); }
    py(y) { const p = this.pad, v = this.view; return this.H - p.b - (this.tx(y, 'y') - this.tx(v.y0, 'y')) / (this.tx(v.y1, 'y') - this.tx(v.y0, 'y')) * (this.H - p.t - p.b); }
    xAt(px) { const p = this.pad, v = this.view; const t = (px - p.l) / (this.W - p.l - p.r); return this.itx(this.tx(v.x0, 'x') + t * (this.tx(v.x1, 'x') - this.tx(v.x0, 'x')), 'x'); }
    yAt(py) { const p = this.pad, v = this.view; const t = (this.H - p.b - py) / (this.H - p.t - p.b); return this.itx(this.tx(v.y0, 'y') + t * (this.tx(v.y1, 'y') - this.tx(v.y0, 'y')), 'y'); }

    _bind() {
      const c = this.c;
      c.addEventListener('wheel', (e) => {
        if (!this.view) return; e.preventDefault();
        const f = e.deltaY > 0 ? 1.25 : 0.8, r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        const zoomAx = (ax, m, a0, a1) => {
          const t0 = this.tx(this.view[a0], ax), t1 = this.tx(this.view[a1], ax), tm = this.tx(m, ax);
          this.view[a0] = this.itx(tm + (t0 - tm) * f, ax); this.view[a1] = this.itx(tm + (t1 - tm) * f, ax);
        };
        if (!e.shiftKey) zoomAx('x', this.xAt(mx), 'x0', 'x1');
        if (e.shiftKey || this.o.yZoom) zoomAx('y', this.yAt(my), 'y0', 'y1');
        this.draw(); if (this.onView) this.onView(this.view);
      }, { passive: false });
      c.addEventListener('pointerdown', (e) => {
        if (!this.view) return;
        const r = c.getBoundingClientRect();
        this.drag = { x: e.clientX - r.left, y: e.clientY - r.top, v: Object.assign({}, this.view), moved: false };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        if (this.drag) {
          const dx = mx - this.drag.x, dy = my - this.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
          if (this.drag.moved) {
            const p = this.pad, v = this.drag.v;
            const sx = (this.tx(v.x1, 'x') - this.tx(v.x0, 'x')) / (this.W - p.l - p.r);
            const sy = (this.tx(v.y1, 'y') - this.tx(v.y0, 'y')) / (this.H - p.t - p.b);
            this.view.x0 = this.itx(this.tx(v.x0, 'x') - dx * sx, 'x'); this.view.x1 = this.itx(this.tx(v.x1, 'x') - dx * sx, 'x');
            if (e.shiftKey || this.o.yZoom) { this.view.y0 = this.itx(this.tx(v.y0, 'y') + dy * sy, 'y'); this.view.y1 = this.itx(this.tx(v.y1, 'y') + dy * sy, 'y'); }
            if (this.onView) this.onView(this.view);
          }
        }
        this.hover = { px: mx, py: my, x: this.xAt(mx), y: this.yAt(my) };
        this.draw();
      });
      c.addEventListener('pointerup', (e) => {
        const d = this.drag; this.drag = null;
        if (d && !d.moved) {
          const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
          const m = this.hitMarker(mx, my) || this.hitLabel(mx, my);
          if (m && this.onMarkerClick) this.onMarkerClick(m);
          else if (this.onClickX) this.onClickX(this.xAt(mx), e);
        }
      });
      c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
      c.addEventListener('dblclick', () => this.resetView());
    }
    hitMarker(mx, my) {
      let best = null, bd = 10;
      for (const m of this.markers) {
        if (!this._inView(m.x, m.y)) continue;
        const d = Math.hypot(this.px(m.x) - mx, this.py(m.y) - my);
        if (d < bd) { bd = d; best = m; }
      }
      return best;
    }
    hitLabel(mx, my) {
      for (const b of this.labelBoxes) if (mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) return b.m;
      return null;
    }
    /* 一维防重叠：xs 已排序，返回不小于 gap 间距、落在 [lo, hi] 内、尽量接近原位置的坐标 */
    static spread(xs, gap, lo, hi) {
      const n = xs.length, out = xs.slice();
      if (!n) return out;
      if ((n - 1) * gap > hi - lo) { const g = (hi - lo) / Math.max(1, n - 1); return xs.map((_, i) => lo + i * g); }
      for (let i = 0; i < n; i++) out[i] = Math.max(lo, i ? Math.max(out[i], out[i - 1] + gap) : out[i]);
      if (out[n - 1] > hi) { out[n - 1] = hi; for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap); }
      return out;
    }
    _inView(x, y) { const v = this.view; return x >= Math.min(v.x0, v.x1) && x <= Math.max(v.x0, v.x1) && y >= Math.min(v.y0, v.y1) && y <= Math.max(v.y0, v.y1); }

    _ticks(ax) {
      const v = this.view, a0 = ax === 'x' ? v.x0 : v.y0, a1 = ax === 'x' ? v.x1 : v.y1;
      const out = [];
      if (this.o[ax + 'log']) {
        const e0 = Math.floor(Math.log10(Math.min(a0, a1))), e1 = Math.ceil(Math.log10(Math.max(a0, a1)));
        const stepE = Math.max(1, Math.ceil((e1 - e0) / 7));
        for (let e = e0; e <= e1; e += stepE) out.push({ v: Math.pow(10, e), label: supExp(e) });
      } else {
        const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
        const step = niceStep(hi - lo, ax === 'x' ? Math.max(4, this.W / 95) : Math.max(3, this.H / 55));
        for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push({ v: Math.abs(t) < step * 1e-9 ? 0 : t, label: fmt(Math.abs(t) < step * 1e-9 ? 0 : t, step) });
      }
      return out;
    }

    draw() {
      this._computeBand();
      const ctx = this.ctx, W = this.W, H = this.H, p = this.pad, band = this._band;
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);
      if (!this.view) { ctx.fillStyle = COLORS.text; ctx.font = '13px "Microsoft YaHei",sans-serif'; ctx.fillText(this.o.empty || '等待计算结果…', 20, 30); return; }
      const x0 = p.l, x1 = W - p.r, y0 = p.t, y1 = H - p.b;
      ctx.font = '11px Consolas,monospace'; ctx.lineWidth = 1;
      // 网格与刻度
      ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const tickY = y1 + (band.bottom || 0) + 5;
      for (const t of this._ticks('x')) { const X = this.px(t.v); if (X < x0 - .5 || X > x1 + .5) continue; ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y1); ctx.stroke(); ctx.fillText(t.label, X, tickY); }
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const t of this._ticks('y')) { const Y = this.py(t.v); if (Y < y0 - .5 || Y > y1 + .5) continue; ctx.beginPath(); ctx.moveTo(x0, Y); ctx.lineTo(x1, Y); ctx.stroke(); ctx.fillText(t.label, x0 - 6, Y); }
      ctx.strokeStyle = COLORS.axis; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = COLORS.text; ctx.font = '12px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(this.o.xlabel, (x0 + x1) / 2, H - 4);
      ctx.save(); ctx.translate(13, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(this.o.ylabel, 0, 0); ctx.restore();

      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      for (const b of this.bands) { const a = this.px(b.x0), c2 = this.px(b.x1); ctx.fillStyle = b.color; ctx.fillRect(Math.min(a, c2), y0, Math.abs(c2 - a), y1 - y0); if (b.label) { ctx.fillStyle = b.textColor || COLORS.text; ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(b.label, Math.min(a, c2) + 4, y0 + 4); } }
      for (const h of this.hlines) { const Y = this.py(h.y); ctx.strokeStyle = h.color; ctx.setLineDash(h.dash || [5, 4]); ctx.beginPath(); ctx.moveTo(x0, Y); ctx.lineTo(x1, Y); ctx.stroke(); ctx.setLineDash([]); if (h.label) { ctx.fillStyle = h.color; ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = h.labelLeft ? 'left' : 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(h.label, h.labelLeft ? x0 + 4 : x1 - 4, Y - 2); } }
      for (const s of this.series) {
        if (s.visible === false || !s.x) continue;
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6; ctx.setLineDash(s.dash || []);
        ctx.globalAlpha = s.alpha == null ? 1 : s.alpha;
        ctx.beginPath(); let pen = false;
        const n = s.x.length;
        // 像素级抽稀：每个像素列保留 min/max，保证细振荡不丢失
        let lastCol = null, cmin = 0, cmax = 0, cfirst = 0, clast = 0;
        const flush = () => { if (lastCol === null) return; const X = lastCol; if (!pen) { ctx.moveTo(X, cfirst); pen = true; } else ctx.lineTo(X, cfirst); ctx.lineTo(X, cmin); ctx.lineTo(X, cmax); ctx.lineTo(X, clast); };
        for (let i = 0; i < n; i++) {
          const xv = s.x[i], yv = s.y[i];
          if (!isFinite(yv) || (this.o.ylog && yv <= 0) || (this.o.xlog && xv <= 0)) { flush(); lastCol = null; pen = false; continue; }
          const X = Math.round(this.px(xv) * 2) / 2, Y = this.py(yv);
          if (X === lastCol) { cmin = Math.min(cmin, Y); cmax = Math.max(cmax, Y); clast = Y; }
          else { flush(); lastCol = X; cmin = cmax = cfirst = clast = Y; }
        }
        flush(); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;
      }
      for (const v of this.vlines) { const X = this.px(v.x); ctx.strokeStyle = v.color; ctx.lineWidth = v.width || 1.2; ctx.setLineDash(v.dash || []); ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y1); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; if (v.label) { ctx.fillStyle = v.color; ctx.font = '600 11px "Microsoft YaHei",sans-serif'; ctx.textAlign = X > (x0 + x1) / 2 ? 'right' : 'left'; ctx.textBaseline = 'top'; ctx.fillText(v.label, X + (X > (x0 + x1) / 2 ? -5 : 5), v.labelBottom ? y1 - 18 - (v.labelY || 0) : y0 + (v.labelY || 4)); } }
      for (const m of this.markers) {
        if (!this._inView(m.x, m.y)) continue;
        const X = this.px(m.x), Y = this.py(m.y);
        ctx.fillStyle = m.color; ctx.strokeStyle = '#07111c'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (m.shape === 'down') { ctx.moveTo(X - 5, Y + 4); ctx.lineTo(X + 5, Y + 4); ctx.lineTo(X, Y - 4); }
        else if (m.shape === 'up') { ctx.moveTo(X - 5, Y - 4); ctx.lineTo(X + 5, Y - 4); ctx.lineTo(X, Y + 4); }
        else ctx.arc(X, Y, m.size || 4.5, 0, Math.PI * 2);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (m.ring) { ctx.strokeStyle = m.ring; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 9, 0, Math.PI * 2); ctx.stroke(); }
        if (m.label && !m.lane) { ctx.fillStyle = m.labelColor || m.color; ctx.font = '600 10.5px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = m.shape === 'up' ? 'top' : 'bottom'; ctx.fillText(m.label, X, m.shape === 'up' ? Y + 7 : Y - 7); }
        ctx.lineWidth = 1;
      }
      for (const t of this.texts) { ctx.fillStyle = t.color || COLORS.text; ctx.font = t.font || '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = t.align || 'left'; ctx.textBaseline = 'top'; ctx.fillText(t.text, t.px != null ? t.px : t.plotX != null ? x0 + t.plotX : this.px(t.x), t.py != null ? t.py : t.plotY != null ? y0 + t.plotY : this.py(t.y)); }
      // 游标点（当前半径处的 I）
      if (this.cursor && isFinite(this.cursor.y) && this._inView(this.cursor.x, Math.min(Math.max(this.cursor.y, this.view.y0), this.view.y1))) {
        const X = this.px(this.cursor.x), Y = this.py(this.cursor.y);
        ctx.fillStyle = this.cursor.color || '#eaf4ff'; ctx.strokeStyle = '#07111c'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X, Y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = this.cursor.color || '#eaf4ff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X, Y, 10, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
      ctx.restore();
      this._drawLaneLabels(x0, x1, y0, y1, band);

      // 悬停读数
      if (this.hover && this.hover.px >= x0 && this.hover.px <= x1 && this.hover.py >= y0 && this.hover.py <= y1 && this.onHover) {
        const lines = this.onHover(this.hover.x, this.hover) || [];
        const hx = this.hover.px;
        ctx.strokeStyle = 'rgba(234,244,255,.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, y1); ctx.stroke(); ctx.setLineDash([]);
        if (lines.dots) for (const d of lines.dots) { if (!isFinite(d.y)) continue; ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(this.px(d.x), this.py(d.y), 3.5, 0, Math.PI * 2); ctx.fill(); }
        if (lines.length) {
          ctx.font = '11.5px Consolas,"Microsoft YaHei",monospace';
          const w = Math.max(...lines.map((l) => ctx.measureText(l.text || l).width)) + 16, h = lines.length * 16 + 10;
          let bx = hx + 12, by = y0 + 8; if (bx + w > x1) bx = hx - 12 - w;
          ctx.fillStyle = 'rgba(16,27,44,.94)'; ctx.strokeStyle = '#33586d'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, h, 7) : ctx.rect(bx, by, w, h); ctx.fill(); ctx.stroke();
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          lines.forEach((l, i) => { ctx.fillStyle = l.color || COLORS.strong; ctx.fillText(l.text || l, bx + 8, by + 6 + i * 16); });
        }
      }
    }
  }
  LinePlot.prototype._drawLaneLabels = function (x0, x1, y0, y1, band) {
    const ctx = this.ctx; this.labelBoxes = [];
    const font = '600 10.5px "Microsoft YaHei",Consolas,sans-serif', fh = 12, gap = fh + 2;
    for (const lane of ['top', 'bottom']) {
      const bh = band[lane]; if (!bh) continue;
      const ms = this.markers.filter((m) => m.lane === lane && m.label && this._inView(m.x, m.y)).sort((a, b) => a.x - b.x);
      // 标签带标题（单位说明）
      ctx.font = '10px "Microsoft YaHei",sans-serif'; ctx.fillStyle = COLORS.text; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      const title = (this.o.laneTitles || {})[lane];
      if (title) { ctx.save(); ctx.translate(x0 - 8, lane === 'top' ? y0 - bh / 2 - 2 : y1 + bh / 2 + 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(title, 0, 0); ctx.restore(); }
      if (!ms.length) continue;
      const Xs = ms.map((m) => this.px(m.x));
      const pos = LinePlot.spread(Xs, gap, x0 + fh / 2 + 1, x1 - fh / 2 - 1);
      ctx.font = font;
      ms.forEach((m, i) => {
        const X = Xs[i], P = pos[i], Y = this.py(m.y);
        const yEdge = lane === 'top' ? y0 : y1;           // 绘图框边
        const yKnee = lane === 'top' ? y0 - 6 : y1 + 6;   // 引线拐点
        const yText = lane === 'top' ? y0 - 9 : y1 + 9;   // 文字起点（靠近绘图框的一端）
        ctx.strokeStyle = m.labelColor || m.color; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X, lane === 'top' ? Math.max(yEdge, Y - 8) : Math.min(yEdge, Y + 8)); ctx.lineTo(X, yEdge); ctx.stroke();
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(X, yEdge); ctx.lineTo(P, yKnee); ctx.stroke(); ctx.globalAlpha = 1;
        // 竖排文字：从绘图框向外延伸
        const w = ctx.measureText(m.label).width;
        ctx.save(); ctx.translate(P, yText); ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = m.labelColor || m.color; ctx.textBaseline = 'middle'; ctx.textAlign = lane === 'top' ? 'left' : 'right';
        ctx.fillText(m.label, 0, 0); ctx.restore();
        const ya = lane === 'top' ? yText - w : yText, yb = lane === 'top' ? yText : yText + w;
        this.labelBoxes.push({ m, x0: P - fh / 2, x1: P + fh / 2, y0: ya, y1: yb, overflow: lane === 'top' ? (y0 - bh) - ya : yb - (y1 + bh) });
      });
    }
  };
  root.LinePlot = LinePlot;
  root.PlotColors = COLORS;
  root.niceStep = niceStep;
})(typeof self !== 'undefined' ? self : this);
