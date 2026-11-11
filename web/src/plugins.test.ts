import { describe, expect, it } from 'vitest';
import {
  activeSchema,
  credentialIssues,
  maskPluginSecrets,
  KEEP_SECRET,
  type PluginDefinition,
} from './plugins';

describe('dynamic consumer plugin support', () => {
  it('shows the matching JWT dependency fields and preserves the original schema', () => {
    const schema = {
      properties: {
        algorithm: { default: 'HS256', enum: ['HS256', 'RS256'] },
        secret: { type: 'string' },
      },
      required: ['key'],
      dependencies: {
        algorithm: {
          oneOf: [
            { properties: { algorithm: { enum: ['HS256'] } } },
            {
              properties: { algorithm: { enum: ['RS256'] }, public_key: { type: 'string' } },
              required: ['public_key'],
            },
          ],
        },
      },
    };
    expect(activeSchema(schema, {}).properties.public_key).toBeUndefined();
    expect(activeSchema(schema, { algorithm: 'RS256' }).properties.algorithm.enum).toEqual([
      'HS256',
      'RS256',
    ]);
    expect(activeSchema(schema, { algorithm: 'RS256' }).properties.public_key).toBeDefined();
    expect(activeSchema(schema, { algorithm: 'RS256' }).required).toEqual(['key', 'public_key']);
    expect(schema.required).toEqual(['key']);
  });
  it('masks every supported credential and a schema-declared custom field in previews', () => {
    const value = {
      plugins: {
        'key-auth': { key: 'private-api' },
        'basic-auth': { username: 'visible', password: 'private-basic' },
        'hmac-auth': { key_id: 'visible', secret_key: 'private-hmac' },
        'jwt-auth': { key: 'private-jwt-id', secret: 'private-jwt' },
        'jwe-decrypt': { key: 'private-jwe-id', secret: 'private-jwe' },
        custom: { opaque: 'private-custom' },
        'limit-count': { key: 'remote_addr' },
      },
    };
    const definitions = [
      { name: 'custom', consumer_secret_fields: ['opaque'], route_secret_fields: [] },
    ] as unknown as PluginDefinition[];
    const preview = maskPluginSecrets(value, definitions);
    expect(JSON.stringify(preview)).not.toContain('private-');
    expect(preview.plugins['basic-auth'].username).toBe('visible');
    expect(preview.plugins['limit-count'].key).toBe('remote_addr');
    expect(value.plugins.custom.opaque).toBe('private-custom');
  });
  it('checks JWT algorithm-specific fields and JWE decoded byte lengths', () => {
    expect(credentialIssues('jwt-auth', { key: 'id' })).toHaveLength(1);
    expect(credentialIssues('jwt-auth', { key: 'id', secret: KEEP_SECRET })).toEqual([]);
    expect(
      credentialIssues('jwt-auth', { key: 'id', algorithm: 'RS256', secret: 'not-a-public-key' }),
    ).toHaveLength(1);
    expect(credentialIssues('jwt-auth', { algorithm: 'RS256', public_key: 'public-key' })).toEqual(
      [],
    );
    expect(
      credentialIssues('jwt-auth', { secret: 'invalid base64 !!', base64_secret: true }),
    ).toHaveLength(1);
    expect(credentialIssues('jwe-decrypt', { secret: '字'.repeat(32) })).toHaveLength(1);
    expect(credentialIssues('jwe-decrypt', { secret: 'x'.repeat(32) })).toEqual([]);
    expect(
      credentialIssues('jwe-decrypt', { secret: btoa('x'.repeat(32)), is_base64_encoded: true }),
    ).toEqual([]);
    expect(credentialIssues('jwe-decrypt', { secret: KEEP_SECRET })).toEqual([]);
    expect(credentialIssues('jwe-decrypt', { secret: '$secret://vault/key' })).toEqual([]);
  });
});
