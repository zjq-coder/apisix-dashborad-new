import { readFile } from 'node:fs/promises';
import http from 'node:http';

// Native HTTP preserves explicit Host headers; Node fetch can replace them.
export function sandboxProxy(path, options = {}) {
  const url = new URL(path, 'http://127.0.0.1:19080');
  if (url.origin !== 'http://127.0.0.1:19080')
    throw new Error('Only the local sandbox proxy is allowed');
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method || 'GET', headers: options.headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value !== undefined) headers.set(name, value);
          }
          resolve(
            new Response(
              [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
              { status: response.statusCode, headers },
            ),
          );
        });
      },
    );
    request.setTimeout(8000, () => request.destroy(new Error('Local proxy request timed out')));
    request.on('error', reject);
    request.end(options.body);
  });
}

export async function localConfig() {
  const text = await readFile(new URL('../.env', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
let clientPromise;
export function sandboxClient() {
  if (!clientPromise)
    clientPromise = connectSandbox().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}
async function connectSandbox() {
  const config = await localConfig();
  const base = 'http://127.0.0.1:18080';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) })).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Container may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Local dashboard is not ready. Start Docker Compose first.');
  const loginOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.DASHBOARD_USERNAME,
      password: config.DASHBOARD_PASSWORD,
    }),
  };
  let login = await fetch(`${base}/api/v1/login`, loginOptions);
  // Repeated local test runs still honor the real login rate limiter.
  const loginDeadline = Date.now() + 65_000;
  while (login.status === 429 && Date.now() < loginDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    login = await fetch(`${base}/api/v1/login`, loginOptions);
  }
  if (!login.ok) throw new Error(`Local login failed (${login.status})`);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': session.csrf_token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(`${method} ${path}: ${data.error}`), {
        status: response.status,
        data,
      });
    return data;
  };
  const gateway = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:19180/apisix/admin${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': config.APISIX_ADMIN_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const waitChange = async (id) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const change = await request(`/changesets/${id}`);
      if (change.status !== 'publishing') return change;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Release did not finish within 20 seconds');
  };
  return { config, request, gateway, waitChange, cookie, session };
}
