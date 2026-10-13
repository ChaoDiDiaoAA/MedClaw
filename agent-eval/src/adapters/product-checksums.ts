import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
export const hashValue = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const hashBytes = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
