import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';
import {
  consumerAuthFixtures,
  jwtToken,
  jweToken,
  hmacHeaders,
  basicHeader,
  pause,
} from './consumer-auth-fixtures.mjs';

const client = await sandboxClient();
const { request, gateway, waitChange } = client;
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
assert.ok(cluster && !cluster.read_only, 'A writable local sandbox is required');
const runId = `auth-${Date.now()}`;
const fixture = await consumerAuthFixtures(runId);
const root = `/clusters/${cluster.id}`;
const records = [],
  resourceIDs = new Set();
const report = {
  started: new Date().toISOString(),
  cluster: cluster.name,
  environment: 'Local APISIX + real OpenLDAP; Wolf protocol fixture',
  checks: records,
};
const KEEP = '${dashboard:keep-secret}';
const secretValues = [
  fixture.adminPassword,
  fixture.directoryPassword,
  ...Object.values(fixture.credentials).flatMap((c) =>
    [c.key, c.password, c.secret, c.secret_key].filter(Boolean),
  ),
];
function redacted(data) {
  const text = JSON.stringify(data);
  for (const value of secretValues)
    assert.ok(!text.includes(value), 'Response exposed a credential');
}
function record(plugin, check, details = {}) {
  records.push({ plugin, check, ...details, passed: true });
  console.log(`PASS ${plugin}: ${check}`);
}
async function draft(kind, id, value, action) {
  resourceIDs.add(id);
  const old = await request(`${root}/resources/${kind}/${id}`).catch((error) => {
    if (error.status === 404) return undefined;
    throw error;
  });
  const d = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: kind,
    resource_id: id,
    action: action || (old ? 'update' : 'create'),
    base_hash: old?.hash,
    value,
    title: `${runId} ${kind}`,
  });
  redacted(d);
  return d;
}
async function publishDrafts(drafts) {
  const change = await request('/changesets', 'POST', {
    draft_ids: drafts.map((d) => d.id),
    title: runId,
    reason: '消费者关联插件逐项真实认证验收',
  });
  const validation = await request(`/changesets/${change.id}/validate`, 'POST', {});
  assert.equal(validation.ok, true, JSON.stringify(validation));
  await request(`/changesets/${change.id}/publish`, 'POST', {});
  const done = await waitChange(change.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  redacted(done);
  return done;
}
async function release(kind, id, value, action) {
  return publishDrafts([await draft(kind, id, value, action)]);
}
async function rollback(change) {
  const back = await request(`/changesets/${change.id}/rollback`, 'POST', {});
  assert.equal((await request(`/changesets/${back.id}/validate`, 'POST', {})).ok, true);
  await request(`/changesets/${back.id}/publish`, 'POST', {});
  assert.equal((await waitChange(back.id)).status, 'succeeded');
}
async function traffic(id, expected, headers = {}, options = {}) {
  let status, body;
  for (let i = 0; i < 45; i++) {
    const response = await sandboxProxy(`/${id}`, { headers, ...options });
    status = response.status;
    body = await response.json().catch(() => ({}));
    if ((Array.isArray(expected) ? expected : [expected]).includes(status)) return { status, body };
    await pause(100);
  }
  // Do not dump echoed credentials into reports or console logs.
  assert.fail(`${id} expected HTTP ${expected}, received ${status}; ${body?.message || ''}`);
}
const route = (id, plugins) => ({ name: id, uri: `/${id}`, plugins, upstream: fixture.upstream });
try {
  const catalog = await request(`${root}/plugins/catalog`);
  const names = catalog
    .filter((d) => d.consumer_source !== 'none')
    .map((d) => d.name)
    .sort();
  assert.deepEqual(
    names,
    Object.keys(fixture.credentials).sort(),
    'Every discovered consumer authentication plugin requires a real traffic fixture',
  );
  report.plugins = names;
  record('catalog', '实时发现全部消费者认证 Schema，包含 Wolf 共享 Schema', {
    count: names.length,
  });
  for (const name of names) {
    const id = `${runId}-${name}`,
      credential = fixture.credentials[name];
    const schema = await request(`${root}/plugins/${name}/schema?scope=consumer`);
    assert.ok(schema.properties);
    await request(`${root}/plugins/${name}/validate`, 'POST', {
      resource_type: 'consumers',
      value: credential,
    });
    const value = { username: id, labels: { team: 'platform' }, plugins: { [name]: credential } };
    const cd = await draft('consumers', id, value);
    const rd = await draft('routes', id, route(id, { [name]: fixture.routes[name] }));
    assert.equal((await gateway(`/consumers/${id}`)).status, 404);
    assert.equal((await gateway(`/routes/${id}`)).status, 404);
    redacted(await request(`/drafts/${cd.id}`));
    redacted(await request(`/drafts/${rd.id}`));
    await request(`${root}/plugins/${name}/validate`, 'POST', {
      resource_type: 'consumers',
      resource_id: id,
      draft_id: cd.id,
      value: cd.after.plugins[name],
    });
    await assert.rejects(
      request(`${root}/plugins/${name}/validate`, 'POST', {
        resource_type: 'routes',
        resource_id: id,
        draft_id: cd.id,
        value: cd.after.plugins[name],
      }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      request(`${root}/plugins/${name}/validate`, 'POST', {
        resource_type: 'consumers',
        resource_id: `${id}-other`,
        draft_id: cd.id,
        value: cd.after.plugins[name],
      }),
      (error) => error.status === 400,
    );
    record(name, '插件校验绑定草稿资源类型与 ID，拒绝跨资源使用凭据');
    await publishDrafts([cd, rd]);
    const missing = await traffic(id, name === 'jwe-decrypt' ? 403 : 401);
    const invalid = await traffic(
      id,
      name === 'jwe-decrypt' ? 400 : name === 'wolf-rbac' ? 403 : 401,
      fixture.headers(name, credential, true),
    );
    const valid = await traffic(id, 200, fixture.headers(name));
    if (name === 'jwe-decrypt')
      assert.equal(valid.body.headers['x-decrypted'], 'verified-plaintext');
    else assert.equal(valid.body.headers['x-consumer-username'], id);
    if (['key-auth', 'basic-auth', 'jwt-auth', 'hmac-auth', 'ldap-auth'].includes(name)) {
      assert.equal(valid.body.headers.apikey, undefined);
      assert.equal(valid.body.headers.authorization, undefined);
    }
    record(name, 'Schema 校验、草稿隔离、发布、缺失/错误/有效凭据', {
      missing: missing.status,
      invalid: invalid.status,
      valid: valid.status,
    });
    const live = await request(`${root}/resources/consumers/${id}`);
    redacted(live);
    redacted(await request(`${root}/resources/consumers`));
    await release('consumers', id, { ...live.value, desc: '保留全部已保存凭据' });
    await traffic(id, 200, fixture.headers(name));
    record(name, '脱敏读取、编辑保持凭据、再次发布');
    if (schema.required?.length) {
      const invalidConfig = { ...credential };
      delete invalidConfig[schema.required[0]];
      await assert.rejects(
        request(`${root}/plugins/${name}/validate`, 'POST', {
          resource_type: 'consumers',
          value: invalidConfig,
        }),
        (error) => error.status === 422,
      );
      record(name, '消费者必填字段拒绝缺失');
    }
    const removed = await release('consumers', id, { ...live.value, plugins: {} });
    await traffic(id, name === 'jwe-decrypt' ? 400 : 401, fixture.headers(name));
    await rollback(removed);
    await traffic(id, 200, fixture.headers(name));
    record(name, '撤销消费者凭据后拒绝，回退后恢复');
    if (['key-auth', 'basic-auth', 'jwt-auth', 'hmac-auth', 'jwe-decrypt'].includes(name)) {
      const field =
        name === 'key-auth'
          ? 'key'
          : name === 'basic-auth'
            ? 'password'
            : name === 'hmac-auth'
              ? 'secret_key'
              : 'secret';
      const replacement = {
        ...credential,
        [field]: randomBytes(name === 'jwe-decrypt' ? 16 : 24).toString('hex'),
      };
      secretValues.push(replacement[field]);
      const change = await release('consumers', id, { ...value, plugins: { [name]: replacement } });
      await traffic(id, name === 'jwe-decrypt' ? 400 : 401, fixture.headers(name));
      await traffic(id, 200, fixture.headers(name, replacement));
      await rollback(change);
      await traffic(id, 200, fixture.headers(name));
      record(name, '密钥或密码轮换后旧凭据失效，回退恢复');
    }
  }
  const jwtID = `${runId}-jwt-auth`;
  await traffic(jwtID, 401, {
    Authorization: `Bearer ${jwtToken(fixture.credentials['jwt-auth'], { exp: 1 })}`,
  });
  const rsaConfig = { key: `${runId}-rsa`, algorithm: 'RS256', public_key: fixture.rsa.publicKey };
  const rsaChange = await release('consumers', jwtID, {
    username: jwtID,
    plugins: { 'jwt-auth': rsaConfig },
  });
  await traffic(jwtID, 200, {
    Authorization: `Bearer ${jwtToken(rsaConfig, {}, fixture.rsa.privateKey)}`,
  });
  await rollback(rsaChange);
  record('jwt-auth', '过期 JWT 拒绝，RS256 公钥验签通过');
  const jwtBase64 = {
    ...fixture.credentials['jwt-auth'],
    secret: Buffer.from(fixture.credentials['jwt-auth'].secret).toString('base64'),
    base64_secret: true,
  };
  secretValues.push(jwtBase64.secret);
  const jwtEncodedChange = await release('consumers', jwtID, {
    username: jwtID,
    plugins: { 'jwt-auth': jwtBase64 },
  });
  await traffic(jwtID, 200, { Authorization: `Bearer ${jwtToken(jwtBase64)}` });
  await rollback(jwtEncodedChange);
  record('jwt-auth', 'Base64 签名密钥解码验签通过');
  const hmacID = `${runId}-hmac-auth`;
  await traffic(
    hmacID,
    401,
    hmacHeaders(fixture.credentials['hmac-auth'], new Date(0).toUTCString()),
  );
  record('hmac-auth', '过期签名请求拒绝');
  const jweID = `${runId}-jwe-decrypt`;
  const jweBase64 = {
    ...fixture.credentials['jwe-decrypt'],
    secret: Buffer.from(fixture.credentials['jwe-decrypt'].secret).toString('base64url'),
    is_base64_encoded: true,
  };
  secretValues.push(jweBase64.secret);
  const jweChange = await release('consumers', jweID, {
    username: jweID,
    plugins: { 'jwe-decrypt': jweBase64 },
  });
  await traffic(jweID, 200, { Authorization: jweToken(jweBase64) });
  await rollback(jweChange);
  record('jwe-decrypt', 'Base64URL 密钥解码与 AES-GCM 解密通过');
  const advancedID = `${runId}-ldap-auth-advanced`;
  await traffic(advancedID, 401, basicHeader('unmapped', fixture.directoryPassword));
  const optional = await release(
    'routes',
    advancedID,
    route(advancedID, {
      'ldap-auth-advanced': { ...fixture.routes['ldap-auth-advanced'], consumer_required: false },
    }),
  );
  await traffic(advancedID, 200, basicHeader('unmapped', fixture.directoryPassword));
  await rollback(optional);
  record('ldap-auth-advanced', '真实目录有效账户：必需消费者时拒绝未映射身份，关闭限制后允许');

  const comboID = `${runId}-combined`;
  const sharedKey = randomBytes(24).toString('hex'),
    basicPassword = randomBytes(24).toString('hex');
  secretValues.push(sharedKey, basicPassword);
  const combo = {
    username: comboID,
    labels: { team: 'platform' },
    plugins: {
      'key-auth': { key: sharedKey },
      'basic-auth': { username: comboID, password: basicPassword },
      'limit-count': {
        count: 100,
        time_window: 60,
        key: 'remote_addr',
        policy: 'local',
        rejected_code: 429,
      },
    },
  };
  await release('consumers', comboID, combo);
  await release(
    'routes',
    comboID,
    route(comboID, { 'multi-auth': { auth_plugins: [{ 'key-auth': {} }, { 'basic-auth': {} }] } }),
  );
  await traffic(comboID, 401);
  await traffic(comboID, 401, { apikey: 'invalid' });
  await traffic(comboID, 200, { apikey: sharedKey });
  await traffic(comboID, 200, basicHeader(comboID, basicPassword));
  const comboLive = (await request(`${root}/resources/consumers/${comboID}`)).value;
  assert.equal(comboLive.plugins['basic-auth'].password, KEEP);
  const removedKey = await release('consumers', comboID, {
    ...comboLive,
    plugins: {
      'basic-auth': comboLive.plugins['basic-auth'],
      'limit-count': comboLive.plugins['limit-count'],
    },
  });
  await traffic(comboID, 401, { apikey: sharedKey });
  await traffic(comboID, 200, basicHeader(comboID, basicPassword));
  await rollback(removedKey);
  record('multi-auth', '同一消费者两种凭据均可通过，移除其中一种不影响另一种与消费者策略');
  const deniedID = `${runId}-key-auth`;
  for (const policy of ['consumer-restriction', 'acl', 'attach-consumer-label']) {
    const id = `${runId}-${policy}`;
    const config =
      policy === 'consumer-restriction'
        ? { whitelist: [comboID] }
        : policy === 'acl'
          ? { allow_labels: { team: ['platform'] }, deny_labels: { team: ['blocked'] } }
          : { headers: { 'X-Team': '$team', 'X-Missing': '$not_present' } };
    await release(
      'routes',
      id,
      route(id, { 'key-auth': { hide_credentials: true }, [policy]: config }),
    );
    await traffic(id, 401);
    const accepted = await traffic(id, 200, {
      apikey: sharedKey,
      'X-Team': 'spoofed',
      'X-Missing': 'spoofed',
    });
    if (policy === 'consumer-restriction') await traffic(id, 403, fixture.headers('key-auth'));
    if (policy === 'acl') {
      const denied = (await request(`${root}/resources/consumers/${deniedID}`)).value;
      const labelChange = await release('consumers', deniedID, {
        ...denied,
        labels: { team: 'blocked' },
      });
      await traffic(id, 403, fixture.headers('key-auth'));
      await rollback(labelChange);
    }
    if (policy === 'attach-consumer-label') {
      assert.equal(accepted.body.headers['x-team'], 'platform');
      assert.equal(accepted.body.headers['x-missing'], undefined);
    }
    record(policy, '已认证消费者策略真实请求验证', {
      accepted: 200,
      unauthenticated: 401,
      denied: policy === 'attach-consumer-label' ? 'spoofed headers replaced/removed' : 403,
    });
  }
  for (const [name, value] of [
    ['jwt-auth', { key: 'x' }],
    ['jwe-decrypt', { key: 'x', secret: 'too-short' }],
    ['basic-auth', { username: 'x', password: '' }],
  ]) {
    await assert.rejects(
      request(`${root}/plugins/${name}/validate`, 'POST', { resource_type: 'consumers', value }),
      (error) => error.status === 422,
    );
  }
  record('validation', '拒绝缺失 JWT 密钥、错误 JWE 长度和空 Basic 密码');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  throw error;
} finally {
  const cleanup = [];
  for (const id of resourceIDs)
    for (const kind of ['routes', 'consumers']) {
      const response = await gateway(`/${kind}/${id}`, 'DELETE');
      if (![200, 204, 404].includes(response.status))
        cleanup.push(`${kind}/${id}: ${response.status}`);
    }
  for (const d of await request(`/drafts?cluster_id=${cluster.id}`))
    if (resourceIDs.has(d.resource_id) && d.status === 'draft')
      await request(`/drafts/${d.id}`, 'DELETE');
  await fixture.cleanup();
  report.cleanupErrors = cleanup;
  report.finished = new Date().toISOString();
  await writeFile('.local/consumer-plugins-integration.json', JSON.stringify(report, null, 2));
  assert.deepEqual(cleanup, []);
}
