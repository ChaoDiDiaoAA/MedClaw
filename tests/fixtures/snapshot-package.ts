import {mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalRequest} from '../../packages/contracts/src/run';
const csv=(values:string[])=>values.map(value=>'"'+value.replaceAll('"','""')+'"').join(',');
export function packageFixture(root: string, options: { observedCounts?:number[];expectedCount?:number;prices?: (number | null)[]; missing?: boolean; scopeKey?: string; referenceDate?: string } = {}) {
  mkdirSync(root, { recursive: true });
  const masters = Array.from({length:options.expectedCount??1},(_,index)=>({ record_type: 'master', device_id: String(index+1).padStart(5,'0'), device_name: 'Device,\nwith quote "', source_submission_id: '00009', source_applicant: 'Applicant', category: 'Category', manufacturer: 'Synthetic manufacturer' }));
  const sourceLock = { schema: 'medclaw.source-lock/v2', sources: [{ source: 'fda', path: 'missing-original.zip', url: 'https://example.invalid/source' }] };
  writeFileSync(join(root, 'source-lock.json'), JSON.stringify(sourceLock));
  writeFileSync(join(root, 'entity-lineage.csv'), `${csv(Object.keys(masters[0]!))}\n${masters.map(master=>csv(Object.values(master))).join('\n')}\n`);
  for (const name of ['adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md']) writeFileSync(join(root, name), name.endsWith('.json') ? '{}' : 'auxiliary');
  const refs = [{ sourceId: 'fda', file: 'missing-original.zip', row: 1, recordId: '00009' }];
  const headers = ['device_id', 'device_name', 'source_submission_id', 'source_applicant', 'category', 'region', 'snapshot_date', 'price_cents', 'currency', 'unit', 'status', 'manufacturer', 'distributor', 'source_refs_json', 'field_origins_json'];
  const origins = Object.fromEntries(headers.slice(0, 13).map(key => [key, { kind: 'synthetic', ruleId: 'fixture' }]));
  const prices = options.prices ?? [100, 80];
  for (const [index, price] of prices.entries()) {
    const date = `2026-01-0${index + 1}`;
    const missing = options.missing && index === 1;
    const observed=options.observedCounts?.[index]??(missing?0:masters.length);
    const text = `${csv(headers)}\r\n${observed===0 ? '' : masters.slice(0,observed).map(master=>`${csv([master.device_id, master.device_name, '00009', 'Applicant', 'Category', '浙江', date, price === null ? '' : String(price), 'CNY', '件', 'active', 'Synthetic manufacturer', 'Distributor', JSON.stringify(refs), JSON.stringify(origins)])}\r\n`).join('')}`;
    writeFileSync(join(root, `zhejiang_${date}.csv`), text);
    writeFileSync(join(root, `zhejiang_${date}.metadata.json`), JSON.stringify({ contract: 'medclaw.snapshot/v2', mappingVersion: 'medclaw.snapshot/v1', materialVersion: 'fixture/v1', generatorVersion: 'fixture/v1', seed: 1, sourceBundleId: 'fixture', scopeKey: options.scopeKey ?? 'scope', region: '浙江', snapshotDate: date, coverage: 'full', expectedEntityCount: masters.length, observedEntityCount: observed, declaredMissingEntityIds: masters.slice(observed).map(master=>master.device_id), ...(observed<masters.length ? { missingReason: 'Fixture unavailable' } : {}), referenceDate: options.referenceDate ?? `2026-01-0${prices.length}`, timezone: 'Asia/Shanghai' }));
  }
  refreshManifest(root, prices.length, options.observedCounts?.reduce((sum,n)=>sum+n,0)??(options.missing?prices.length-1:prices.length)*masters.length);
}
export function refreshManifest(root: string, count: number, rowCount: number) {
  const files = readdirSync(root).filter(name => name !== 'manifest.json').sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length }; });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: count, businessRows: rowCount, businessBytes: files.filter(file => /^zhejiang_.*\.csv$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}
