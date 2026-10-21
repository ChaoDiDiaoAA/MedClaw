import { beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { businessToolSchemas } from '../../packages/contracts/src/business-tools';
import { createResourceSource } from '../../packages/runtime-pi/src/resource-loader';

const dependencies = {
  'data-scope-review': ['list_batches', 'read_batch'],
  'data-coverage-check': ['check_data_coverage', 'read_batch'],
  'device-identity-resolve': ['resolve_device', 'read_device'],
  'device-detail-review': ['resolve_device', 'read_device', 'query_current_devices', 'read_query', 'read_query_page', 'list_query_evidence', 'read_source_metadata'],
  'current-device-search': ['list_filter_values', 'check_data_coverage', 'query_current_devices', 'read_query_page'],
  'manufacturer-device-list': ['list_filter_values', 'check_data_coverage', 'query_current_devices', 'read_query', 'read_query_page'],
  'device-status-screen': ['list_filter_values', 'check_data_coverage', 'query_current_devices', 'read_query_page', 'list_query_evidence', 'read_source_metadata'],
  'new-device-records': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_query_evidence'],
  'missing-device-records': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_query_evidence'],
  'price-change-review': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_evidence_rows'],
  'device-status-change': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_query_evidence'],
  'distributor-change-review': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_source_metadata'],
  'price-threshold-review': ['check_data_coverage', 'query_device_changes', 'read_query_page', 'list_query_evidence', 'read_query_evidence'],
  'query-evidence-audit': ['read_query', 'read_query_page', 'list_query_evidence', 'read_query_evidence', 'read_evidence_rows', 'read_source_metadata'],
  'data-freshness-review': ['list_batches', 'read_batch'],
};
const source = createResourceSource(join(import.meta.dir, '../../resources'));
let discovered: Awaited<ReturnType<typeof source.discover>>;
beforeAll(async () => { discovered = await source.discover(); });

test('p11 catalog discovers 16 SDK-parsed Skills without enabling new resources', () => {
  const skills = discovered.items.filter(item => item.ref.kind === 'skill');
  expect(skills.map(item => item.ref.id).sort()).toEqual(['query', ...Object.keys(dependencies)].sort());
  expect(skills.every(item => item.availability === 'ready' && !item.enabled)).toBe(true);
  expect(discovered.items.filter(item => item.ref.kind === 'prompt').map(item => item.ref.id)).toEqual(['query']);
  expect(discovered.diagnostics).toEqual([]);
});

for (const [id, tools] of Object.entries(dependencies)) {
  test(`p11 ${id} has SDK metadata, actual tool dependencies and an on-demand reference`, async () => {
    const item = discovered.items.find(item => item.ref.kind === 'skill' && item.ref.id === id);
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.ref.version).toBe('v1');
    expect(item.name).toBe(id);
    expect(item.description).toBeString();
    expect(item.description!.length).toBeGreaterThan(20);
    expect(item.disableModelInvocation).toBe(false);
    expect(item.requiredTools?.toSorted()).toEqual(['read', 'read_data_scope', ...tools].sort());
    expect(item.requiredTools?.every(name => name === 'read' || Object.hasOwn(businessToolSchemas, name))).toBe(true);
    expect(item.requiredExtensions).toEqual([]);
    const [snapshot] = await source.capture([item.ref]);
    expect(snapshot?.entry).toBe(`skills/${id}/v1/SKILL.md`);
    expect(snapshot?.files).toHaveLength(2);
    const guide = snapshot!.files.find(file => file.file === 'SKILL.md')!;
    const reference = snapshot!.files.find(file => file.file.startsWith('references/'))!;
    expect(reference).toBeDefined();
    expect(guide.content).toContain(reference.file);
    expect(reference.content.length).toBeGreaterThan(200);
    expect(guide.content).toContain('read_data_scope');
  });
}
