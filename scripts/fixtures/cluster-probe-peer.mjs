// A switchable, read-only link to the local APISIX Admin API. No published ports.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
let mode = 'up';
const requests = [];
http
  .createServer(async (req, res) => {
    if (req.socket.remoteAddress === '127.0.0.1' && req.url.startsWith('/control/')) {
      if (req.method === 'POST') mode = req.url.slice('/control/'.length);
      return res.end(JSON.stringify(requests));
    }
    requests.push({ method: req.method, path: req.url });
    if (mode === 'down') return req.socket.destroy();
    if (mode === 'slow') await sleep(1500);
    if (req.method !== 'GET' || !req.url.startsWith('/apisix/admin/')) {
      res.writeHead(405);
      return res.end();
    }
    try {
      const gateway = await fetch('http://apisix:9180' + req.url, {
        headers: { 'X-API-KEY': req.headers['x-api-key'] || '' },
      });
      res.writeHead(gateway.status, {
        'Content-Type': 'application/json',
        Server: gateway.headers.get('server') || '',
      });
      res.end(await gateway.text());
    } catch {
      res.writeHead(502);
      res.end();
    }
  })
  .listen(8080, '0.0.0.0');
