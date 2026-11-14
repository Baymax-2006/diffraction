/* worker.js — 后台积分线程。只做转发：任务逻辑在 jobs.js，物理在 diffraction.js / diffraction-q2.js。 */
importScripts('diffraction.js', 'diffraction-q2.js', 'jobs.js');
self.onmessage = (ev) => self.Q1Jobs.run(ev.data, (m, transfer) => self.postMessage(m, transfer || []));
self.postMessage({ type: 'ready', version: self.Diffraction.VERSION });
