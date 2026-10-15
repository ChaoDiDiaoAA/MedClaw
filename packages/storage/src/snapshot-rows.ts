import {closeSync,openSync,readSync} from 'node:fs';
import {join} from 'node:path';
import {ImportRowSchema,type ImportIssue,type ImportRow,type SnapshotMetadata} from '../../contracts/src/data';
import {legacySourceRef,legacyFieldOrigins} from './legacy-business-fields';
const columns = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
export class PackageInvalid extends Error {
  constructor(readonly issue: ImportIssue) { super(issue.code); }
}
export function invalid(file: string | null, row: number | null, field: string | null, code = 'import_invalid'): never {
  throw new PackageInvalid({ file, row, field, code, message: code === 'import_conflict' ? 'This package conflicts with immutable imported history.' : 'The package does not meet the snapshot contract.' });
}

/** Parse bounded chunks and logical CSV records, preserving quoted newlines and original strings. */
export function* readCsvRecords(path: string, signal?: AbortSignal): Generator<string[]> {
  const fd = openSync(path, 'r'), bytes = Buffer.alloc(65536), decoder = new TextDecoder('utf-8', { fatal: true });
  let state: 'plain' | 'quoted' | 'closed' = 'plain', value = '', row: string[] = [], beginning = true, swallowLf = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const length = readSync(fd, bytes, 0, bytes.length, null);
      const text = decoder.decode(bytes.subarray(0, length), { stream: length !== 0 });
      for (let char of text) {
        if (beginning) { beginning = false; if (char === '\ufeff') continue; }
        if (swallowLf) { swallowLf = false; if (char === '\n') continue; }
        if (state === 'quoted') {
          if (char === '"') state = 'closed'; else value += char;
          continue;
        }
        if (state === 'closed' && char === '"') { value += '"'; state = 'quoted'; continue; }
        if (char === ',' || char === '\n' || char === '\r') {
          row.push(value); value = ''; state = 'plain';
          if (char !== ',') { yield row; row = []; swallowLf = char === '\r'; }
          continue;
        }
        if (state === 'closed') throw new Error('import_invalid');
        if (char === '"') { if (value !== '') throw new Error('import_invalid'); state = 'quoted'; }
        else value += char;
      }
      if (!length) break;
    }
    if (state === 'quoted') throw new Error('import_invalid');
    if (value.length || row.length || state === 'closed') { row.push(value); yield row; }
  } finally { closeSync(fd); }
}

export function* csvObjects(path: string, file: string, required?: string[], signal?: AbortSignal): Generator<{ row: number; value: Record<string, string> }> {
  let headers: string[] | undefined, logicalRow = 0;
  try {
    for (const record of readCsvRecords(path, signal)) {
      logicalRow++;
      if (!headers) {
        headers = record;
        if (headers.some(header => !header) || new Set(headers).size !== headers.length || required && (headers.length !== required.length || required.some(key => !headers!.includes(key)))) invalid(file, logicalRow, 'header');
        continue;
      }
      if (record.length !== headers.length) invalid(file, logicalRow, null);
      yield { row: logicalRow, value: Object.fromEntries(headers.map((key, index) => [key, record[index]!])) };
    }
    if (!headers) invalid(file, 1, 'header');
  } catch (error) {
    if (error instanceof PackageInvalid || signal?.aborted || error instanceof Error && error.message === 'import_preview_stale') throw error;
    if (error instanceof Error && (error.message === 'import_invalid' || 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')) invalid(file, logicalRow || 1, null);
    throw error;
  }
}
export function* readPackageRows(root: string, file: string, metadata: SnapshotMetadata, signal?: AbortSignal): Generator<ImportRow> {
  for (const { row, value } of csvObjects(join(root, file), file, columns, signal)) {
    if (value.price_cents !== '' && !/^\d+$/.test(value.price_cents!)) invalid(file, row, 'price_cents');
    let sourceRefs: unknown, fieldOrigins: unknown;
    try { sourceRefs = JSON.parse(value.source_refs_json!); } catch { invalid(file, row, 'source_refs_json'); }
    try { fieldOrigins = JSON.parse(value.field_origins_json!); } catch { invalid(file, row, 'field_origins_json'); }
    const parsed = ImportRowSchema.safeParse({ sourceDeviceId: value.device_id, sourceSubmissionId: value.source_submission_id, sourceApplicant: value.source_applicant, deviceName: value.device_name, category: value.category, region: value.region, snapshotDate: value.snapshot_date, priceCents: value.price_cents === '' ? null : Number(value.price_cents), currency: value.currency, unit: value.unit, status: value.status, manufacturer: value.manufacturer, distributor: value.distributor || null, sourceRefs: Array.isArray(sourceRefs) ? sourceRefs.map(legacySourceRef) : sourceRefs, fieldOrigins: legacyFieldOrigins(fieldOrigins), sourceRowRef: `${file}:${row}` });
    if (!parsed.success) invalid(file, row, String(parsed.error.issues[0]?.path[0] ?? 'row'));
    if (parsed.data.snapshotDate !== metadata.snapshotDate || parsed.data.region !== metadata.region) invalid(file, row, 'snapshot_date');
    if (Object.keys(parsed.data.fieldOrigins).length !== 13 || columns.slice(0, 13).some(key => !parsed.data.fieldOrigins[key]?.ruleId)) invalid(file, row, 'field_origins_json');
    yield parsed.data;
  }
}
