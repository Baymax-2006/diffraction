/* submit-worker.js — 精简页的第一问线程。只加载轴上内核，第二问不走这里。 */
importScripts('diffraction.js', 'jobs.js');
self.onmessage = (ev) => self.Q1Jobs.run(ev.data, (m, transfer) => self.postMessage(m, transfer || []));
self.postMessage({ type: 'ready', version: self.Diffraction.VERSION });
