#!/usr/bin/env node
/* server.js — 零依赖本地静态服务器（Node）。用法：node server.js [端口] */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const port = parseInt(process.argv[2] || process.env.PORT || '8765', 10);
const root = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('bad request'); }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(root, p));
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (f !== root && !f.startsWith(rootPrefix)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`圆孔衍射实验已启动：http://127.0.0.1:${port}/index.html  （Ctrl+C 停止）`));
