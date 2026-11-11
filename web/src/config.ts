import type { JsonObject } from './types';

// Preserve extensions and fields that the visual editor does not yet understand.
export function cleanConfig(value: JsonObject): JsonObject {
  const next = structuredClone(value);
  delete next.id;
  delete next.create_time;
  delete next.update_time;
  return next;
}

export function patchField(value: JsonObject, key: string, next: unknown): JsonObject {
  const copy = { ...value };
  if (next === undefined || next === '' || next === null) delete copy[key];
  else copy[key] = next;
  return copy;
}
