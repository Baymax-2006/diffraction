#!/usr/bin/env node
/* 无头浏览器打开 submit.html：无控制台错误，四张直接叠加图完成，并导出报告用图。
 * 用法：node tools/submit_browser_check.js
 * 需要本机 Chrome 远程调试端口 9333，静态服务 8765。 */
'use strict';
const fs = require('fs'), path = require('path');
const { connect } = require('./cdp.js');
const ROOT = path.join(__dirname, '..');
const FIG = path.join(ROOT, 'docs', 'figures');
const ART = '/opt/cursor/artifacts';
fs.mkdirSync(FIG, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const checks = [];
const ok = (name, cond, detail) => {
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};

function decodeDataUrl(url) {
  const i = url.indexOf(',');
  return Buffer.from(url.slice(i + 1), 'base64');
}

(async () => {
  const p = await connect(9333, 'http://127.0.0.1:8765/submit.html', [1440, 900]);
  const t0 = Date.now();
  await p.waitFor('window.__submit && window.__submit.ready === true && window.__submit.summary', 420000);
  const loadS = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = await p.evaluate('window.__submit.summary');
  const pageErrors = await p.evaluate('window.__submit.errors');
  const painted = await p.evaluate('window.__submit.painted');
  const bad = p.logs.filter((l) => /^(error|EXCEPTION)/i.test(l) || l.indexOf('EXCEPTION') === 0);
  ok('无控制台错误', pageErrors.length === 0 && bad.length === 0, JSON.stringify(pageErrors.concat(bad)));
  ok('参考值比对通过', summary.allPass === true, JSON.stringify(summary));
  ok('四张图都已绘制', painted.axial && painted.r4 && painted.inphase && painted.random && painted.linear && painted.disk, JSON.stringify(painted));
  ok('屏网格 201×201 且源点数 > 2e5', summary.nObs === 201 && summary.N > 200000, 'N=' + summary.N + ' nObs=' + summary.nObs);
  ok('同相中心接近 4', Math.abs(summary.Icenter - 3.999986) < 5e-4, String(summary.Icenter));
  ok('泊松斑接近 1', Math.abs(summary.Idisk - 1) < 2e-3, String(summary.Idisk));
  ok('线性峰约 0.378 mm', summary.peak_mm > 0 && Math.abs(summary.peak_mm - summary.geom_mm) < 0.008, JSON.stringify({ peak: summary.peak_mm, geom: summary.geom_mm }));
  console.log('页面用时 ' + (summary.loadMs / 1000).toFixed(1) + ' s，直接叠加 ' + (summary.mapMs / 1000).toFixed(1) + ' s，本脚本等待 ' + loadS + ' s');
  console.log('分图毫秒', JSON.stringify(summary.times_ms));
  console.log('引擎', summary.engine, summary.directEngine);

  const files = {
    cAxial: path.join(FIG, 'axial.png'),
    cR4: path.join(FIG, 'r4.png'),
    cIn: path.join(FIG, 'map-inphase.png'),
    cRand: path.join(FIG, 'map-random.png'),
    cLin: path.join(FIG, 'map-linear.png'),
    cDisk: path.join(FIG, 'map-disk.png')
  };
  for (const id of Object.keys(files)) {
    const url = await p.evaluate('document.getElementById(' + JSON.stringify(id) + ').toDataURL("image/png")');
    const buf = decodeDataUrl(url);
    fs.writeFileSync(files[id], buf);
    ok(id + ' 有图像', buf.length > 2000, buf.length + ' B');
  }
  const metrics = await p.send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const shot = path.join(ART, 'submit-direct-desktop.png');
  await p.screenshot(shot, {
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
  });
  ok('全页截图', fs.existsSync(shot) && fs.statSync(shot).size > 10000, shot + ' ' + fs.statSync(shot).size + ' B，' + size.width + '×' + size.height);
  fs.writeFileSync(path.join(OUT_SAFE(), 'submit_browser_summary.json'), JSON.stringify({ summary, logs: p.logs, pageErrors, loadS }, null, 2));
  await p.close();
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

function OUT_SAFE() {
  const d = path.join(ROOT, 'validation');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
