import http from 'node:http';

// Isolated echo upstream and Wolf protocol fixture. This is not a Wolf deployment.
http
  .createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/wolf/rbac/access_check') {
      const allowed = req.headers['x-rbac-token'] === process.env.WOLF_TEST_TOKEN;
      res.statusCode = allowed ? 200 : 403;
      return res.end(
        JSON.stringify(
          allowed
            ? {
                data: {
                  userInfo: { id: 'fixture-user', username: 'wolf-client', nickname: 'Fixture' },
                },
              }
            : { reason: 'permission denied' },
        ),
      );
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.end(JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body }));
  })
  .listen(8080, '0.0.0.0');
