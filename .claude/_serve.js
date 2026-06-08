// 로컬 미리보기용 정적 서버 (배포와 무관)
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8123, () => console.log('serving on 8123'));
