import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as instance from '../../src/execution/instance.ts';
import * as observe from '../../src/execution/observe.ts';
import { runTrial } from '../../src/execution/trial.ts';
import { ProductAdapter } from '../../src/adapters/product.ts';
import { createDatasetFixture } from '../datasets/fixture.ts';
import { loadDataset } from '../../src/datasets.ts';
import { reportFixture } from '../report-fixture.ts';
import { hashValue } from '../../src/adapters/product-checksums.ts';

test('Trial retains an acknowledged shutdown with unconfirmed process exit as infrastructure failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-trial-stop-proof-'));
  const datasetRoot = join(root, 'dataset'), trialRoot = join(root, 'trial');
  await createDatasetFixture(datasetRoot);
  const task = (await loadDataset(datasetRoot)).cases[0]!; task.setup = []; task.steps = [];
  await writeFile(join(datasetRoot, '.controlled-fixture.json'), JSON.stringify({ contract: 'medclaw-controlled-fixture/v1', synthetic: true, containsSecrets: false }));
  const config = reportFixture().config;
  const product = new ProductAdapter({ dataRoot: join(trialRoot, 'product'), tracePath: join(trialRoot, 'trace.jsonl') });
  Object.assign(product, { instanceId: 'instance', paths: { dataRoot: product.options.dataRoot } });
  const proof = { stopped: true, closed: true, processExited: false, residuals: ['process_exit_unconfirmed'] };
  const body = { executionId: 'fixture', trialId: 'trial', instanceId: 'instance', observedFrom: '2026-10-12T00:00:00.000Z', observedUntil: '2026-10-12T00:00:00.000Z', identityChecks: [], facts: {}, missing: [] };
  const prepare = spyOn(instance, 'prepareInstance').mockResolvedValue(product);
  const collect = spyOn(observe, 'collectObservation').mockResolvedValue({ ...body });
  const stop = spyOn(product, 'stop').mockResolvedValue(proof);
  try {
    const result = await runTrial({ executionId: 'fixture', trialId: 'trial', caseId: task.id, repetition: 1, case: task, datasetRoot, config, trialRoot });
    expect(result.status).toBe('infra_error');
    expect(result.reason).toBe('host_stop_unconfirmed');
    expect(JSON.parse(await readFile(join(trialRoot, 'trial.json'), 'utf8')).lifecycle.shutdown).toEqual(proof);
    expect(JSON.parse(await readFile(join(trialRoot, 'trial.json'), 'utf8')).lifecycle.cleanup).toMatchObject({ status: 'preserved', reason: 'host_stop_unconfirmed' });
  } finally { prepare.mockRestore(); collect.mockRestore(); stop.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
