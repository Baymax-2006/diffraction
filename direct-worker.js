/* direct-worker.js — 第二问直接叠加的计算线程。按观察屏的行分工，公式在 direct-q2.js。 */
importScripts('direct-q2.js');
self.onmessage = self.DirectQ2.workerOnMessage;
