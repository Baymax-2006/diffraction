/* app.js — 启动。物理在 diffraction.js / diffraction-q2.js，任务在 jobs.js，绘图在 plot.js，
 * 界面拆在 lab-engine.js、lab-q1.js、lab-q2.js、lab-export.js。 */
'use strict';
/* app.js — 界面事件、任务调度与绘图组织。物理全部在 diffraction.js，任务在 jobs.js，曲线控件在 plot.js。
 *
 * 参数的两种身份（修复“旧曲线 + 新参数卡片混用”）：
 *   • 编辑参数 state.lambda_nm / L_cm / rMax_mm / precision —— 控件上的值，可能尚未计算；
 *   • 已应用参数 result.params / result.precision —— 最近一次**完成**的第一问计算所用参数。
 *   曲线、当前点、相量、r⁴ 系数、极值、说明文字、导出全部只读取已应用参数（AP()），
 *   当前点 / r⁴ / 收敛检查任务也用已应用参数提交并带上 resultId，回来时若不属于当前结果就丢弃。
 *   编辑参数与已应用参数不同时，显示“未应用的编辑”提示条，并给出“应用并计算 / 放弃编辑”。
 *
 * 任务生命周期（修复 previewBusy 卡死）：每个任务登记在 jobs[id]，无论“完成 / 过期 / 失败 / 取消”，
 *   都经过 endJob(id) 统一清理；预览忙标志 = previewJob !== null，只由 endJob 和取消清除。 */


  window.__app = { state, get result() { return result; }, get point() { return point; }, get staleDropped() { return staleDropped; }, setRadius, requestQ1, configObject, loadConfig, pendingEdits,
    eng, engConv, engQ2, plots: { mainPlot, r4Plot, errPlot, q2cutX, q2cutY }, exportPngCanvas, exportQ2PngCanvas,
    get previewBusy() { return previewJob !== null; }, get previewDirty() { return previewDirty; }, get jobs() { return Object.assign({}, jobs); },
    get scan() { return scan; }, scanApi: { start: scanFromZero, toggle: scanToggle, pause: () => scanStop(true), step: scanStep, prevExt: () => jumpExt(-1), nextExt: () => jumpExt(1) }, debug, get lastError() { return lastError; },
    get q2() { return q2result; }, q2State: q2s, requestQ2, cancelQ2,
    get q2PreviewBusy() { return q2PreviewJob !== null; }, get q2PreviewDirty() { return q2PreviewDirty; },
    engPt, engProbe, get q2View() { return q2View; }, q2Zoom, q2ResetView, setProbe, get probeDirect() { return probeDirect; },
    get supersededCount() { return supersededCount; }, q2Domain: (w) => q2Domain(q2result && q2result.map, w || 'main'), get q2ImaxCache() { return q2ImaxCache; },
    get q2Group() { return q2Group; } };
  applyInputs(); renderMode(); renderStatus(); mainPlot.draw();
  requestQ1('final');
  $('footVer').textContent = ' 内核版本 ' + D.VERSION + '。';
  var boot = $('boot');
  boot.className = 'boot ok'; boot.textContent = '初始化完成（' + Math.round(performance.now() - window.__BOOT.t0) + ' ms）';
  setTimeout(() => boot.classList.add('boothide'), 900);
  /* 扫描按钮的 id 与函数同名。监听器已经拿住函数引用，这里把全局名字还给元素，测试和页面脚本都能用 scanFromZero.click()。 */
  window.scanFromZero = document.getElementById('scanFromZero');
  window.scanToggle = document.getElementById('scanToggle');
