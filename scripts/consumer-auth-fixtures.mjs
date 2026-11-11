import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createHmac, randomBytes, generateKeyPairSync, sign } from 'node:crypto';

const execute = promisify(execFile);
async function docker(args, input) {
  if (input === undefined) {
    try {
      return (
        await execute('docker', args, { windowsHide: true, timeout: 90_000, maxBuffer: 1_000_000 })
      ).stdout;
    } catch {
      throw new Error(`Test container operation failed (${args[0]})`);
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve('')
        : reject(Object.assign(new Error(`LDAP fixture operation failed (${code})`), { code })),
    );
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end(input);
  });
}
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function jwtToken(config, overrides = {}, privateKey) {
  const head = Buffer.from(
    JSON.stringify({ alg: config.algorithm || 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ key: config.key, exp: Math.floor(Date.now() / 1000) + 600, ...overrides }),
  ).toString('base64url');
  const content = `${head}.${payload}`;
  const signature = privateKey
    ? sign('RSA-SHA256', Buffer.from(content), privateKey)
    : createHmac(
        'sha256',
        config.base64_secret ? Buffer.from(config.secret, 'base64') : config.secret,
      )
        .update(content)
        .digest();
  return `${content}.${signature.toString('base64url')}`;
}
export function jweToken(config, plaintext = 'verified-plaintext') {
  const protectedPart = Buffer.from(
    JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid: config.key }),
  ).toString('base64url');
  const iv = randomBytes(12);
  const key = config.is_base64_encoded
    ? Buffer.from(config.secret, 'base64url')
    : Buffer.from(config.secret);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(protectedPart));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    protectedPart,
    '',
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}
export function hmacHeaders(config, date = new Date().toUTCString()) {
  const signature = createHmac('sha256', config.secret_key)
    .update(`${config.key_id}\ndate: ${date}\n`)
    .digest('base64');
  return {
    date,
    Authorization: `Signature keyId="${config.key_id}",algorithm="hmac-sha256",headers="date",signature="${signature}"`,
  };
}
export const basicHeader = (username, password) => ({
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
});

export async function consumerAuthFixtures(runId) {
  if (!/^auth-[a-z0-9-]+$/.test(runId))
    throw new Error('Expected an isolated auth test identifier');
  const ldapName = `${runId}-ldap`,
    serverName = `${runId}-server`;
  const network = 'apisix-dashboard-next_default';
  const adminPassword = randomBytes(24).toString('hex');
  const directoryPassword = randomBytes(24).toString('hex');
  const wolfToken = randomBytes(24).toString('hex');
  const baseDN = 'dc=example,dc=test';
  const adminDN = `cn=admin,${baseDN}`;
  const created = [];
  async function cleanup() {
    for (const name of created.reverse()) await docker(['rm', '-f', '-v', name]);
  }
  try {
    await docker([
      'run',
      '-d',
      '--name',
      ldapName,
      '--network',
      network,
      '-e',
      'LDAP_DOMAIN=example.test',
      '-e',
      `LDAP_ADMIN_PASSWORD=${adminPassword}`,
      '-e',
      'LDAP_TLS=false',
      'osixia/openldap:1.5.0',
    ]);
    created.push(ldapName);
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try {
        await docker([
          'exec',
          ldapName,
          'ldapsearch',
          '-x',
          '-H',
          'ldap://localhost',
          '-D',
          adminDN,
          '-w',
          adminPassword,
          '-b',
          baseDN,
          '-s',
          'base',
        ]);
        ready = true;
        break;
      } catch {
        await pause(500);
      }
    }
    if (!ready) throw new Error('OpenLDAP test service did not become ready');
    const ldif = ['legacy', 'advanced', 'unmapped']
      .map(
        (user) =>
          `dn: cn=${user},${baseDN}\nobjectClass: inetOrgPerson\ncn: ${user}\nsn: ${user}\nuserPassword: ${directoryPassword}\n`,
      )
      .join('\n');
    // Bootstrap briefly restarts slapd; tolerate that restart and existing seed entries.
    let seeded = false;
    for (let i = 0; i < 25; i++) {
      try {
        await docker(
          [
            'exec',
            '-i',
            ldapName,
            'ldapadd',
            '-c',
            '-x',
            '-H',
            'ldap://localhost',
            '-D',
            adminDN,
            '-w',
            adminPassword,
          ],
          ldif,
        ).catch((error) => {
          if (error.code !== 68) throw error;
        });
        for (const user of ['legacy', 'advanced', 'unmapped'])
          await docker([
            'exec',
            ldapName,
            'ldapwhoami',
            '-x',
            '-H',
            'ldap://localhost',
            '-D',
            `cn=${user},${baseDN}`,
            '-w',
            directoryPassword,
          ]);
        seeded = true;
        break;
      } catch {
        await pause(500);
      }
    }
    if (!seeded) throw new Error('OpenLDAP test users could not be seeded and authenticated');
    await docker([
      'run',
      '-d',
      '--name',
      serverName,
      '--network',
      network,
      '-e',
      `WOLF_TEST_TOKEN=${wolfToken}`,
      '-v',
      `${fileURLToPath(new URL('./fixtures/auth-server.mjs', import.meta.url))}:/fixture.mjs:ro`,
      'node:24-bookworm-slim',
      'node',
      '/fixture.mjs',
    ]);
    created.push(serverName);
    await docker([
      'exec',
      serverName,
      'node',
      '-e',
      "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)})",
    ]);
    const secret = () => randomBytes(24).toString('hex');
    const credentials = {
      'key-auth': { key: secret() },
      'basic-auth': { username: `${runId}-login`, password: secret() },
      'jwt-auth': { key: secret(), secret: secret(), algorithm: 'HS256' },
      'hmac-auth': { key_id: `${runId}-hmac`, secret_key: secret() },
      'jwe-decrypt': { key: secret(), secret: randomBytes(16).toString('hex') },
      'ldap-auth': { user_dn: `cn=legacy,${baseDN}` },
      'ldap-auth-advanced': { user_dn: `cn=advanced,${baseDN}` },
      'wolf-rbac': {
        appid: `${runId}-wolf`,
        server: `http://${serverName}:8080`,
        header_prefix: 'X-',
      },
    };
    const routes = {
      'key-auth': { hide_credentials: true },
      'basic-auth': { hide_credentials: true },
      'jwt-auth': { hide_credentials: true },
      'hmac-auth': { signed_headers: ['date'], clock_skew: 300, hide_credentials: true },
      'jwe-decrypt': { header: 'Authorization', forward_header: 'X-Decrypted', strict: true },
      'ldap-auth': {
        ldap_uri: `${ldapName}:389`,
        base_dn: baseDN,
        uid: 'cn',
        use_tls: false,
        hide_credentials: true,
      },
      'ldap-auth-advanced': {
        ldap_uri: `${ldapName}:389`,
        base_dn: baseDN,
        bind_dn: adminDN,
        ldap_password: adminPassword,
        attribute: 'cn',
        header_type: 'basic',
        consumer_required: true,
      },
      'wolf-rbac': {},
    };
    const headers = (name, config = credentials[name], wrong = false) => {
      switch (name) {
        case 'key-auth':
          return { apikey: wrong ? 'invalid' : config.key };
        case 'basic-auth':
          return basicHeader(config.username, wrong ? 'invalid' : config.password);
        case 'jwt-auth':
          return {
            Authorization: `Bearer ${jwtToken(wrong ? { ...config, secret: 'invalid' } : config)}`,
          };
        case 'hmac-auth':
          return hmacHeaders(wrong ? { ...config, secret_key: 'invalid' } : config);
        case 'jwe-decrypt':
          return {
            Authorization: jweToken(wrong ? { ...config, secret: 'x'.repeat(32) } : config),
          };
        case 'ldap-auth':
          return basicHeader('legacy', wrong ? 'invalid' : directoryPassword);
        case 'ldap-auth-advanced':
          return basicHeader('advanced', wrong ? 'invalid' : directoryPassword);
        case 'wolf-rbac':
          return { 'x-rbac-token': `V1#${config.appid}#${wrong ? 'invalid' : wolfToken}` };
        default:
          throw new Error(`No traffic fixture for ${name}`);
      }
    };
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return {
      credentials,
      routes,
      headers,
      cleanup,
      upstream: { type: 'roundrobin', nodes: { [`${serverName}:8080`]: 1 } },
      directoryPassword,
      adminPassword,
      baseDN,
      rsa,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
