import { describe, expect, it } from 'vitest';
import { cleanConfig, patchField } from './config';

describe('configuration editor round trip', () => {
  it('preserves unknown and nested fields while removing gateway metadata', () => {
    const source = {
      id: 'original',
      create_time: 3,
      update_time: 4,
      uri: '/a',
      future_extension: { id: 'nested', values: [false, 0] },
      plugins: { custom: { secret: '${dashboard:keep-secret}' } },
    };
    const editable = cleanConfig(source);
    const updated = patchField(editable, 'uri', '/b');
    expect(updated).toEqual({
      uri: '/b',
      future_extension: source.future_extension,
      plugins: source.plugins,
    });
    editable.future_extension.values.push(true);
    expect(source.future_extension.values).toEqual([false, 0]);
  });
  it('retains explicit false and zero instead of replacing them with gateway defaults', () => {
    expect(patchField({ status: 1 }, 'status', 0)).toEqual({ status: 0 });
    expect(patchField({}, 'enabled', false)).toEqual({ enabled: false });
    expect(patchField({ host: 'old', future: [1] }, 'host', '')).toEqual({ future: [1] });
  });
});
