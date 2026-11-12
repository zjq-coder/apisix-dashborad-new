import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import http2 from 'node:http2';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// A private protocol peer for this run. Only synthetic test payloads are sent here.
const events = [];
let ocspResponse;
const record = (event) => {
  events.push(event);
  if (events.length > 256) events.shift();
};
net
  .createServer((socket) =>
    socket.on('data', (chunk) => record({ protocol: 'tcp', body: chunk.toString() })),
  )
  .listen(15140);
const udp = dgram.createSocket('udp4');
udp.on('message', (chunk) => record({ protocol: 'udp', body: chunk.toString() }));
udp.bind(15141);
// Deterministic T1K policy for ordinary orders, selected by a synthetic QA header.
net
  .createServer((socket) => {
    let pending = Buffer.alloc(0),
      deny = false;
    const frame = (tag, value) => {
      const body = Buffer.from(value),
        header = Buffer.alloc(5);
      header[0] = tag;
      header.writeUInt32LE(body.length, 1);
      return Buffer.concat([header, body]);
    };
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const tag = pending[0],
          size = pending.readUInt32LE(1);
        if (pending.length < size + 5) return;
        if ((tag & 63) === 1)
          deny = /x-test-decision:\s*deny/i.test(pending.subarray(5, 5 + size).toString());
        pending = pending.subarray(5 + size);
        if (tag & 128) {
          record({ protocol: 't1k', body: deny ? 'deny' : 'pass' });
          socket.write(
            deny
              ? Buffer.concat([
                  frame(65, '?'),
                  frame(2, '403'),
                  frame(164, '<!-- event_id: OrderQA -->'),
                ])
              : frame(193, '.'),
          );
          deny = false;
        }
      }
    });
  })
  .listen(19800);
net
  .createServer((socket) =>
    socket.once('data', (data) => {
      record({ protocol: 'mqtt', body: data.toString() });
      socket.end(Buffer.from([32, 2, 0, 0]));
    }),
  )
  .listen(1883);
// NameServer topic lookup and broker acknowledgement using RocketMQ remoting frames.
net
  .createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const end = 4 + pending.readUInt32BE(0),
          length = pending.readUIntBE(5, 3);
        const head = pending.subarray(8, 8 + length),
          body = pending.subarray(8 + length, end);
        const request =
          pending[4] === 0
            ? JSON.parse(head)
            : { code: head.readUInt16BE(), opaque: head.readInt32BE(5) };
        pending = pending.subarray(end);
        const broker = socket.localAddress.replace('::ffff:', '') + ':19876';
        const route = {
          queueDatas: [
            {
              brokerName: 'fixture',
              readQueueNums: 1,
              writeQueueNums: 1,
              perm: 6,
              topicSysFlag: 0,
            },
          ],
          brokerDatas: [{ brokerName: 'fixture', cluster: 'test', brokerAddrs: { 0: broker } }],
          filterServerTable: {},
        };
        const content = request.code === 105 ? Buffer.from(JSON.stringify(route)) : Buffer.alloc(0);
        if (request.code === 310 || request.code === 10)
          record({ protocol: 'rocketmq', body: body.toString() });
        const reply = Buffer.from(
          JSON.stringify({
            code: 0,
            opaque: request.opaque,
            flag: 1,
            version: 399,
            language: 'JAVA',
            extFields: {
              msgId: '01020304000000000000000100000001',
              queueId: '0',
              queueOffset: '0',
            },
          }),
        );
        const prefix = Buffer.alloc(8);
        prefix.writeUInt32BE(4 + reply.length + content.length);
        prefix.writeUInt32BE(reply.length, 4);
        socket.write(Buffer.concat([prefix, reply, content]));
      }
    });
  })
  .listen(19876);
if (existsSync('/tls/cert'))
  tls
    .createServer({ cert: readFileSync('/tls/cert'), key: readFileSync('/tls/key') }, (socket) =>
      socket.on('data', (chunk) => record({ protocol: 'tcp-tls', body: chunk.toString() })),
    )
    .listen(16514);
// One unary protobuf string field. Return an actual gRPC data frame and OK trailers.
http2
  .createServer()
  .on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      record({
        protocol: 'grpc',
        url: headers[':path'],
        body: Buffer.concat(chunks).toString('hex'),
      });
      const message = Buffer.from('grpc-order'),
        data = Buffer.concat([Buffer.from([10, message.length]), message]);
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(data.length, 1);
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(Buffer.concat([frame, data]));
    });
  })
  .listen(8081);
net
  .createServer((socket) =>
    socket.once('data', (data) => {
      if (data.readUInt16BE(0) !== 0xdabb) return socket.end();
      // Hessian2 RPC response with an untyped Map<String, String>, or Dubbo JSON for http-dubbo.
      const shortString = (s) =>
        Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
      const body =
        (data[2] & 31) === 2
          ? Buffer.concat([
              Buffer.from([0x91, 0x48]),
              ...['status', '200', 'body', 'local-dubbo-order', 'x-order-peer', 'fixture'].map(
                shortString,
              ),
              Buffer.from([0x5a]),
            ])
          : Buffer.from('1\n"local-dubbo-order"\n');
      const header = Buffer.from(data.subarray(0, 16));
      header[2] &= 31;
      header[3] = 20;
      header.writeUInt32BE(body.length, 12);
      record({ protocol: 'dubbo', body: data.toString() });
      socket.end(Buffer.concat([header, body]));
    }),
  )
  .listen(20880);

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, 'http://peer.test').pathname;
    const respond = (status, body, headers) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === '/__events') return respond(200, events);
    if (path === '/__ready') return respond(200, {});
    if (path === '/orders-spec')
      return respond(200, {
        openapi: '3.0.3',
        info: { title: 'Order lookup', version: '1' },
        paths: {
          '/fixture-orders': {
            get: {
              operationId: 'lookupOrder',
              description: 'Read an order',
              responses: { 200: { description: 'Order' } },
            },
          },
        },
      });
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (path === '/streaming-order')
        record({ protocol: 'request-chunk', url: path, body: chunk.toString() });
    }
    const body = Buffer.concat(chunks).toString();
    if (path === '/__ocsp' && req.method === 'PUT') {
      ocspResponse = Buffer.from(body, 'base64');
      return respond(200, {});
    }
    if (path === '/ocsp' && ocspResponse) {
      res.writeHead(200, { 'content-type': 'application/ocsp-response' });
      return res.end(ocspResponse);
    }
    record({ protocol: 'http', url: req.url, method: req.method, body: body.slice(0, 32768) });
    if (path === '/auth')
      return req.headers['x-order-auth'] === 'allow'
        ? respond(200, {})
        : respond(403, { message: 'fixture-denied' });
    if (path === '/uma')
      return req.headers.authorization === 'Bearer order-allowed'
        ? respond(200, { result: true })
        : respond(403, { error: 'access_denied' });
    if (path === '/introspect')
      return respond(200, {
        active: new URLSearchParams(body).get('token') === 'order-allowed',
        sub: 'order-user',
        scope: 'read',
      });
    if (path.startsWith('/v1/data/'))
      return respond(200, { result: { allow: false, status_code: 418, reason: 'fixture-policy' } });
    if (path.includes('/chat/completions'))
      return respond(200, {
        id: 'local-completion',
        object: 'chat.completion',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'local-answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });
    if (path === '/oauth/token')
      return respond(200, {
        access_token: 'fixture-access',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    if (path.includes('/actions/orders'))
      return respond(200, { statusCode: 200, body: 'plugin-test-peer' });
    if (path === '/broken') return respond(500, { service: 'peer-outage' });
    if (req.headers['x-amz-target']?.includes('DetectToxicContent'))
      return respond(200, { ResultList: [{ Toxicity: 0.99, Labels: [] }] });
    if (path.includes('/lakera')) return respond(200, { flagged: true, breakdown: [] });
    if (
      path.includes('/aliyun') ||
      body.includes('ServiceParameters=') ||
      req.headers['x-acs-action']
    )
      return respond(200, { Code: 200, Message: 'OK', Data: { RiskLevel: 'high', Result: [] } });
    if (path.includes('/embeddings')) return respond(200, { data: [{ embedding: [0.1, 0.2] }] });
    if (path.includes('/docs/search'))
      return respond(200, { value: [{ content: 'local-rag-context' }] });
    if (path.includes('_bulk')) return respond(200, { errors: false, items: [] });
    if (path.includes('collector')) return respond(200, { text: 'Success', code: 0 });
    if (path.includes('/slow')) await new Promise((resolve) => setTimeout(resolve, 850));
    return respond(200, {
      service: 'plugin-test-peer',
      method: req.method,
      path,
      body,
      query: req.url,
      headers: { marker: req.headers['x-probe'] },
    });
  })
  .on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const len = pending[1] & 127,
          opcode = pending[0] & 15;
        if (len >= 126 || !(pending[1] & 128)) return socket.end();
        if (pending.length < 6 + len) return;
        const body = Buffer.from(pending.subarray(6, 6 + len));
        for (let i = 0; i < len; i++) body[i] ^= pending[2 + (i % 4)];
        pending = pending.subarray(6 + len);
        const reply = Buffer.concat([Buffer.from([128 | opcode, len]), body]);
        if (opcode === 8) return socket.end(reply);
        socket.write(reply);
        record({ protocol: 'ws', body: body.toString() });
      }
    });
    socket.on('error', () => {});
  })
  .listen(8080);
