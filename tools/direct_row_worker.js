/* 回归用：在 worker_threads 里按行调用 direct-q2.js 的同一套求和。 */
'use strict';
const { parentPort } = require('worker_threads');
const Q = require('../direct-q2.js');
parentPort.on('message', (m) => {
  if (!m || m.type !== 'sum') return;
  const part = Q.sumRows(m.src, m.geom, m.row0, m.row1);
  parentPort.postMessage({ row0: m.row0, row1: m.row1, re: part.re, im: part.im });
});
