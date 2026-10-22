import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchActualDev, readStartupFacts } from '../fixtures/desktop-dev';
import { launchEvaluationDesktop } from '../fixtures/p16-evaluation';
import { createServer } from 'node:http';

test('p16 report filters apply to Cases, Trials and Feedback while aggregate sections keep their original scope', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ reports: true, feedbackHistory: 2 });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('button', { name: 'Open current-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' }), section = details.getByRole('combobox', { name: 'Report section', exact: true });
    await expect(details.getByLabel('Case filter', { exact: true })).toHaveCount(0);
    await expect(details.getByLabel('Trial filter', { exact: true })).toHaveCount(0);
    const original = JSON.parse(readFileSync(join(desktop.runsRoot, 'business/current-report/report.json'), 'utf8')).plan[0];
    await section.selectOption('cases'); await details.getByLabel('Case filter', { exact: true }).fill('missing-case');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('0'); await expect(details.getByLabel('Trial filter', { exact: true })).toHaveCount(0);
    await details.getByLabel('Case filter', { exact: true }).fill(original.caseId); await expect(details.getByTestId('evaluation-section-total')).toHaveText('1');
    await section.selectOption('trials'); await details.getByLabel('Trial filter', { exact: true }).fill('missing-trial'); await expect(details.getByTestId('evaluation-section-total')).toHaveText('0');
    await details.getByLabel('Trial filter', { exact: true }).fill(original.trialId); await expect(details.getByTestId('evaluation-section-total')).toHaveText('1');
    await section.selectOption('feedback'); await expect(details.getByTestId('evaluation-section-total')).toHaveText('2');
    await details.getByLabel('Trial filter', { exact: true }).fill('missing-trial'); await expect(details.getByTestId('evaluation-section-total')).toHaveText('0');
    await details.getByLabel('Trial filter', { exact: true }).fill(original.trialId); await expect(details.getByTestId('evaluation-section-total')).toHaveText('2');
    await section.selectOption('coverage'); await expect(details.getByLabel('Case filter', { exact: true })).toHaveCount(0); await expect(details.getByLabel('Trial filter', { exact: true })).toHaveCount(0);
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('50');
    for (const [path, originalBytes] of desktop.originals) expect(readFileSync(path).equals(originalBytes)).toBe(true);
    expect(desktop.requests).toEqual([]); await page.screenshot({ path: info.outputPath('p16-original-report-filters.png') });
  } finally { await desktop.close(); }
});

test('p16 real production chat, queued input and manual compaction block fresh evaluation while browsing preserves the draft', async ({}, info) => {
  test.setTimeout(120000);
  let releaseChat!: () => void, releaseSummary!: () => void, summaryEntered = false, mainCalls = 0;
  const chatGate = new Promise<void>(resolve => { releaseChat = resolve; }), summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const main = body.includes('MedClaw trusted runtime feedback');
    if (main) { mainCalls++; await chatGate; } else { summaryEntered = true; await summaryGate; }
    if (!response.destroyed) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: 'ENGINEERING', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: main ? 'ENGINEERING answer ' + 'a'.repeat(500) : 'ENGINEERING original summary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing engineering provider');
  const desktop = await launchEvaluationDesktop({ configured: true, productionCompaction: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const configured = await page.evaluate(async baseUrl => {
      const directory = await window.medclaw.request('model.read', {}); if (!directory.ok) throw new Error(directory.error.code);
      const token = await window.medclaw.secretInput({ providerId: 'p16-production', purpose: 'custom_api_key', value: 'ENGINEERING-LOCAL' }); if (!token.ok) throw new Error(token.error.code);
      const saved = await window.medclaw.request('model.custom.save', { expectedConfigVersion: directory.data.configVersion, credentialInput: token.data.token, definition: { providerId: 'p16-production', name: 'ENGINEERING', api: 'openai-completions', baseUrl, models: [{ id: 'fixture', name: 'ENGINEERING', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 128, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } }); if (!saved.ok) throw new Error(saved.error.code);
      return window.medclaw.request('model.configure', { provider: 'p16-production', modelId: 'fixture', expectedConfigVersion: saved.data.configVersion });
    }, `http://127.0.0.1:${address.port}/v1`);
    expect(configured.ok).toBe(true);
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    const preflight = await page.evaluate(() => window.medclaw.request('eval.preflight', { datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 }));
    if (!preflight.ok) throw new Error(preflight.error.code); expect(preflight.data.blockers).toEqual([]);
    const runOptions = { datasetId: 'medclaw-agent-v1', selection: 'smoke' as const, trials: 1, preflightId: preflight.data.preflightId };
    const blocked = async () => {
      const result = await page.evaluate(options => window.medclaw.request('eval.start', options, crypto.randomUUID()), runOptions);
      expect(result).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
      expect(desktop.requests.filter(request => request.kind === 'agent' || request.kind === 'judge')).toHaveLength(0);
    };
    await page.getByLabel('Message text', { exact: true }).fill('ENGINEERING first original ' + 'x'.repeat(500));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => mainCalls).toBe(1); await blocked();
    expect(await page.evaluate(() => window.medclaw.request('run.control.read', {}))).toMatchObject({ ok: true, data: { activeRootRun: { kind: 'agent', sessionId: 1 }, acceptingNewRuns: false } });
    await page.getByRole('button', { name: 'Message actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Follow Up', exact: true }).click();
    await page.getByLabel('Message text', { exact: true }).fill('ENGINEERING queued original ' + 'y'.repeat(500));
    await page.getByRole('button', { name: 'Follow Up', exact: true }).click();
    await expect.poll(async () => { const value = await page.evaluate(() => window.medclaw.request('session.listInputs', { sessionId: 1, afterClientSequence: null, limit: 50 })); return value.ok && value.data.items.some(item => item.status === 'queued'); }).toBe(true); await blocked();
    await page.getByLabel('Message text', { exact: true }).fill('ENGINEERING retained draft');
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await navigation.getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click(); await page.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled(); await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('ENGINEERING retained draft'); releaseChat();
    const idle = async () => { await expect.poll(async () => { const value = await page.evaluate(() => window.medclaw.request('run.control.read', {})); return value.ok && value.data.acceptingNewRuns; }, { timeout: 15000 }).toBe(true); };
    await idle();
    for (let i = 0; i < 3; i++) { const before = mainCalls; await page.getByLabel('Message text', { exact: true }).fill('ENGINEERING history ' + i + ' ' + 'z'.repeat(500)); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => mainCalls).toBeGreaterThan(before); await idle(); }
    await page.getByLabel('Message text', { exact: true }).fill('ENGINEERING retained draft');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Runtime', exact: true }).click();
    const compaction = page.getByTestId('session-compaction'); if (!await compaction.getByRole('button', { name: 'Compact context', exact: true }).isVisible()) await compaction.getByText('Context tools', { exact: true }).click(); await compaction.getByRole('button', { name: 'Compact context', exact: true }).click();
    await expect.poll(() => summaryEntered).toBe(true);
    expect(await page.evaluate(() => window.medclaw.request('run.control.read', {}))).toMatchObject({ ok: true, data: { activeRootRun: null, acceptingNewRuns: false } }); await blocked();
    await navigation.getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click(); await expect(page.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('p16-production-compaction-blocks-evaluation.png') });
    await navigation.getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('ENGINEERING retained draft');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings tasks' }).getByRole('button', { name: 'Runtime', exact: true }).click();
    await compaction.getByRole('button', { name: 'Cancel compaction', exact: true }).click(); releaseSummary();
    await expect(compaction).toContainText('Compaction · cancelled', { timeout: 15000 }); await compaction.getByRole('button', { name: 'Restore compaction session', exact: true }).click(); await idle();
    expect(desktop.requests.filter(request => request.kind === 'agent' || request.kind === 'judge')).toHaveLength(0);
  } finally { releaseChat(); releaseSummary(); desktop.releaseAgent(); try { await desktop.close(); } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } }
});

for (const phase of ['Judge', 'collection', 'save'] as const) test('p16 cancellation during actual ' + phase + ' retains the original plan and confirms final saving', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ configured: true, holdJudge: phase === 'Judge', holdCollect: phase === 'collection', holdSave: phase === 'save' });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    if (phase === 'Judge') await expect.poll(() => desktop.requests.filter(item => item.kind === 'judge').length, { timeout: 30000 }).toBe(1);
    else await expect.poll(() => existsSync(phase === 'save' ? desktop.saveEntered : desktop.collectEntered), { timeout: 30000 }).toBe(true);
    const agentRequests = desktop.requests.filter(item => item.kind === 'agent').length;
    const current = page.getByRole('region', { name: 'Current evaluation' });
    await expect(current.getByTestId('evaluation-saved-trials')).toHaveText('0');
    await current.getByRole('button', { name: 'Cancel evaluation', exact: true }).click();
    if (phase !== 'Judge') { await expect(current.getByTestId('evaluation-control-state')).toHaveText('Stopping'); await expect(current.getByTestId('evaluation-saved-trials')).toHaveText('0'); if (phase === 'save') desktop.releaseSave(); else desktop.releaseCollect(); }
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Finished', { timeout: 30000 });
    await expect(current.getByTestId('evaluation-saved-trials')).toHaveText('10');
    desktop.releaseJudge();
    await current.getByText('Current execution identity', { exact: true }).click();
    const executionId = (await current.locator('code').first().innerText()).trim(), root = join(desktop.runsRoot, 'business', executionId);
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.plan).toHaveLength(10); expect(report.trials).toHaveLength(10);
    expect(report.trials.slice(1).every((trial: { status: string }) => trial.status === 'not_run')).toBe(true);
    const original = JSON.parse(readFileSync(join(root, 'evidence', report.trials[0].trialId, 'trial.json'), 'utf8'));
    expect(original.lifecycle.shutdown).toMatchObject({ stopped: true, closed: true, processExited: true, residuals: [] });
    expect(desktop.requests.filter(item => item.kind === 'agent')).toHaveLength(agentRequests);
    if (phase === 'Judge') { expect(report.judgeCalls).toHaveLength(1); expect(report.judgeCalls[0].result.status).not.toBe('completed'); }
    expect(existsSync(join(desktop.runsRoot, 'business', '.active-execution.json'))).toBe(false);
    cpSync(root, info.outputPath('evaluation-runs', 'business', executionId), { recursive: true, errorOnExist: true, force: false });
    await page.screenshot({ path: info.outputPath('p16-cancel-' + phase + '.png') });
  } finally { await desktop.close(); }
});

test('p16 an actual independent configuration edit rejects the stale Check without executing a model', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ configured: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    const configPath = join(desktop.temporary, 'evaluation-configs/agent.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.policy.maxRetries = 1; writeFileSync(configPath, JSON.stringify(config));
    await setup.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(desktop.requests).toEqual([]); expect(existsSync(desktop.runsRoot)).toBe(false);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('medclaw.evaluation.pending.v1'))).toBeNull();
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    expect(desktop.requests).toEqual([]); await page.screenshot({ path: info.outputPath('p16-config-edit-requires-check.png') });
  } finally { await desktop.close(); }
});

test('p16 a changed runtime descriptor stays blocked after Check while original reports and local feedback remain usable', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ configured: true, reports: true, sourceChange: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    writeFileSync(desktop.sourceChange, 'changed descriptor at the existing sourceInventory port');
    await setup.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    await expect(setup.getByText('Restart the app after confirming the original evaluation has stopped and saved.', { exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    rmSync(desktop.sourceChange);
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open current-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' });
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('trials');
    await details.getByRole('button', { name: /Review Trial / }).click();
    const feedback = page.getByRole('region', { name: 'Local feedback' });
    await feedback.getByRole('textbox', { name: 'Reviewer', exact: true }).fill('Engineering reviewer');
    await feedback.getByRole('textbox', { name: 'Comment', exact: true }).fill('Original report review after runtime descriptor change');
    await feedback.getByRole('button', { name: 'Submit feedback', exact: true }).click();
    await expect(feedback.getByText('Feedback saved.', { exact: true })).toBeVisible();
    for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    expect(desktop.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('p16-runtime-change-keeps-original-report.png') });
  } finally { await desktop.close(); }
});

for (const fault of ['after_trial_save', 'scoring_save', 'worker_exit'] as const) test('p16 actual ' + fault + ' retains uncertainty and reopens only original partial results after application failure', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ configured: true, fault });
  try {
    let page = desktop.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    await expect.poll(() => existsSync(desktop.faultWindow), { timeout: 30000 }).toBe(true);
    const window = JSON.parse(readFileSync(desktop.faultWindow, 'utf8')), root = join(desktop.runsRoot, 'business', window.executionId);
    const first = JSON.parse(readFileSync(join(root, 'evidence', window.trialId, 'trial.json'), 'utf8'));
    expect(first.lifecycle.shutdown).toMatchObject({ stopped: true, closed: true, processExited: true, residuals: [] });
    expect(readdirSync(join(root, 'evidence'), { withFileTypes: true }).filter(item => item.isDirectory())).toHaveLength(1);
    expect(existsSync(join(root, 'report.json'))).toBe(false);
    const lockPath = join(desktop.runsRoot, 'business', '.active-execution.json'), lock = readFileSync(lockPath);
    const snapshot = readFileSync(join(root, 'snapshot.json'));
    expect(JSON.parse(snapshot.toString()).plan).toHaveLength(10);
    const current = page.getByRole('region', { name: 'Current evaluation' });
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Unconfirmed');
    await expect(page.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    const spawned = () => readFileSync(join(desktop.temporary, 'spawned-processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; kind: string });
    expect(spawned().filter(item => item.kind === 'production')).toHaveLength(1);
    expect(spawned().filter(item => item.kind === 'evaluation')).toHaveLength(1);
    await page.getByRole('button', { name: 'Refresh evaluation status', exact: true }).click();
    expect(spawned().filter(item => item.kind === 'evaluation')).toHaveLength(1);
    desktop.requestQuit(); await expect.poll(() => existsSync(desktop.quitObserved)).toBe(true);
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Unconfirmed');
    expect(page.isClosed()).toBe(false); expect(existsSync(join(desktop.temporary, 'dev-exit-confirmed'))).toBe(false);
    if (fault === 'scoring_save') {
      const backup = readFileSync(join(root, 'evidence', window.trialId, 'events.before-save.jsonl'));
      desktop.restoreScoringFile(); expect(readFileSync(join(root, 'evidence', window.trialId, 'events.jsonl')).equals(backup)).toBe(true);
    }
    const requests = desktop.requests.length, originalChildren = spawned();
    await desktop.crashMain();
    await expect.poll(() => originalChildren.filter(item => { try { process.kill(item.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).length, { timeout: 15000 }).toBe(0);
    expect(existsSync(join(desktop.temporary, 'dev-exit-confirmed'))).toBe(false);
    page = await desktop.relaunch();
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Unconfirmed');
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open ' + window.executionId, exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' });
    await expect(details.getByText('Partial results', { exact: true })).toBeVisible();
    await expect(details.getByText('Recorded Trials: 1 of 10', { exact: true })).toBeVisible();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    if (fault === 'scoring_save') await expect(details.getByTestId('evaluation-section-total')).toHaveText('0');
    else await expect(details.getByTestId('evaluation-score').first()).toBeVisible();
    expect(readFileSync(lockPath).equals(lock)).toBe(true); expect(readFileSync(join(root, 'snapshot.json')).equals(snapshot)).toBe(true);
    expect(existsSync(join(root, 'report.json'))).toBe(false); expect(desktop.requests).toHaveLength(requests);
    expect(readdirSync(join(root, 'evidence'), { withFileTypes: true }).filter(item => item.isDirectory())).toHaveLength(1);
    cpSync(root, info.outputPath('evaluation-runs', 'business', window.executionId), { recursive: true, errorOnExist: true, force: false });
    await test.step('Capture the original partial report after ' + fault, async () => {
      await page.screenshot({ path: info.outputPath('p16-original-partial-' + fault + '.png'), timeout: 15000 });
    });
    await desktop.crashMain();
    console.log('ENGINEERING abnormal-application root retained: ' + desktop.temporary);
  } finally { await desktop.close(); }
});

test('p16 complete desktop Smoke uses the actual SDK response and saves the original ten-Trial archive', async ({}, info) => {
  test.setTimeout(120000);
  const desktop = await launchEvaluationDesktop({ configured: true });
  const failures: unknown[] = [];
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const before = readStartupFacts(desktop.dataRoot);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' });
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    expect(desktop.requests).toEqual([]);
    await setup.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    const current = page.getByRole('region', { name: 'Current evaluation' });
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Finished', { timeout: 90000 });
    await expect(current.getByTestId('evaluation-saved-trials')).toHaveText('10');
    await current.getByText('Current execution identity', { exact: true }).click();
    const executionId = (await current.locator('code').first().innerText()).trim(), root = join(desktop.runsRoot, 'business', executionId);
    const reportBytes = readFileSync(join(root, 'report.json')), snapshotBytes = readFileSync(join(root, 'snapshot.json'));
    const report = JSON.parse(reportBytes.toString()), snapshot = JSON.parse(snapshotBytes.toString());
    expect(report.plan).toHaveLength(10); expect(report.trials).toHaveLength(10);
    expect(report.trials.some((trial: { status: string }) => trial.status === 'completed')).toBe(true);
    const observation = JSON.parse(readFileSync(join(root, report.trials[0].observationRef), 'utf8'));
    expect(observation.facts.modelCalls.some((call: { state: string }) => call.state === 'completed')).toBe(true);
    expect(observation.facts.toolCalls.some((call: { name: string }) => call.name === 'read_data_scope')).toBe(true);
    expect(snapshot.desktopRequest).toMatchObject({ datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 });
    expect(new Set(report.judgeCalls.map((call: { trialId: string }) => call.trialId)).size).toBe(report.judgeCalls.length);
    expect(desktop.requests.filter(item => item.kind === 'judge')).toHaveLength(report.judgeCalls.length);
    expect(desktop.requests.some(item => item.kind === 'platform')).toBe(false);
    const reports = page.getByRole('region', { name: 'Evaluation reports' });
    await reports.getByRole('button', { name: 'Open ' + executionId, exact: true }).click();
    const detail = page.getByRole('region', { name: 'Report details' });
    await expect(detail.getByText('Recorded Trials: 10 of 10', { exact: true })).toBeVisible();
    const scoreReadStarted = Date.now();
    await detail.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    await expect(detail.getByTestId('evaluation-score').first()).toBeVisible({ timeout: 30000 });
    console.log('ENGINEERING original ten-Trial Score read milliseconds: ' + (Date.now() - scoreReadStarted));
    expect(readFileSync(join(root, 'report.json')).equals(reportBytes)).toBe(true);
    expect(readFileSync(join(root, 'snapshot.json')).equals(snapshotBytes)).toBe(true);
    expect(existsSync(join(desktop.runsRoot, 'business', '.active-execution.json'))).toBe(false);
    const after = readStartupFacts(desktop.dataRoot); expect(after.runs).toBe(before.runs); expect(after.calls).toBe(before.calls);
    cpSync(root, info.outputPath('evaluation-runs', 'business', executionId), { recursive: true, errorOnExist: true, force: false });
    await test.step('Capture the original ten-Trial Scores', async () => {
      const before = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
      await page.bringToFront();
      const after = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
      await info.attach('score-capture-focus', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('p16-complete-smoke-original-scores.png'), timeout: 15000 });
    });
  } catch (error) { failures.push(error); }
  finally {
    try { await desktop.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'P16 ten-Trial Smoke body and shutdown failed: ' + desktop.temporary);
});

test('p16 original source conflicts remain two visible human reviews and do not change automatic Scores', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ reports: true, feedbackHistory: 1, feedbackConflict: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open current-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' });
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('feedback');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('2');
    await expect(details.getByText('Original engineering review 0', { exact: true })).toBeVisible();
    await expect(details.getByText('Preserved conflicting engineering review', { exact: true })).toBeVisible();
    await expect(details.getByText('Both versions were preserved.', { exact: true })).toBeVisible();
    for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    expect(desktop.requests).toEqual([]);
    await test.step('Capture both original conflicting human reviews', async () => {
      await page.screenshot({ path: info.outputPath('p16-feedback-conflict-preserved.png'), timeout: 15000 });
    });
  } finally { await desktop.close(); }
});

test('p16 real local feedback preserves the Score and explicitly delivers existing results without model calls', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ reports: true, platform: true, holdPlatform: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open current-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' });
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('trials');
    await details.getByRole('button', { name: /Review Trial / }).click();
    const feedback = page.getByRole('region', { name: 'Local feedback' });
    await expect(feedback.getByRole('button', { name: 'Submit feedback', exact: true })).toBeDisabled();
    const archive = join(desktop.runsRoot, 'business', 'current-report'); expect(existsSync(join(archive, 'review.json'))).toBe(false);
    await feedback.getByLabel('Reviewer', { exact: true }).fill('本地审核人');
    await feedback.getByRole('textbox', { name: 'Comment', exact: true }).fill('保留原始评分，只记录人工复核。');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(feedback.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('保留原始评分，只记录人工复核。');
    await page.setViewportSize({ width: 800, height: 700 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
    await feedback.getByRole('button', { name: 'Submit feedback', exact: true }).focus();
    await expect(feedback.getByRole('button', { name: 'Submit feedback', exact: true })).toBeFocused();
    expect(await feedback.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('p16-feedback-200pct-focus.png') });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await feedback.getByRole('button', { name: 'Submit feedback', exact: true }).dblclick();
    await expect(feedback.getByText('Feedback saved.', { exact: true })).toBeVisible();
    const review = JSON.parse(readFileSync(join(archive, 'review.json'), 'utf8')); expect(review.feedback).toHaveLength(1);
    expect(review.feedback[0].value).toMatchObject({ source: 'local', reviewer: '本地审核人', comment: '保留原始评分，只记录人工复核。' });
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('feedback');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('1');
    await feedback.getByRole('textbox', { name: 'Comment', exact: true }).fill('第二次独立人工复核。');
    await feedback.getByRole('button', { name: 'Submit feedback', exact: true }).click();
    await expect(feedback.getByText('Feedback saved.', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Refresh section', exact: true }).click();
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('2');
    await expect(details.getByText('Saved item count changed. This page reflects the latest read; refresh other pages.', { exact: true })).toBeVisible();
    expect(desktop.requests).toEqual([]); expect(existsSync(join(archive, 'export.json'))).toBe(false);
    await page.getByRole('button', { name: 'Report delivery', exact: true }).click();
    const delivery = page.getByRole('region', { name: 'Report delivery' });
    await expect(delivery.getByRole('button', { name: 'Upload / Resend', exact: true })).toBeEnabled();
    await delivery.getByRole('button', { name: 'Upload / Resend', exact: true }).dblclick();
    await expect.poll(() => desktop.requests.filter(item => item.kind === 'platform').length).toBe(1);
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Running');
    await expect(page.getByRole('button', { name: 'Cancel evaluation', exact: true })).toHaveCount(0);
    await delivery.getByRole('button', { name: 'Read upload status', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Running');
    await expect(delivery.getByRole('button', { name: 'Sync feedback', exact: true })).toBeDisabled();
    desktop.releasePlatform();
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Finished');
    await delivery.getByRole('button', { name: 'Read upload status', exact: true }).click();
    await expect(delivery.getByTestId('evaluation-delivery-state')).toHaveText('complete');
    const sent = desktop.requests.length;
    await delivery.getByRole('button', { name: 'Upload / Resend', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Finished');
    expect(desktop.requests).toHaveLength(sent);
    await delivery.getByRole('button', { name: 'Sync feedback', exact: true }).click();
    await expect.poll(() => desktop.requests.length).toBe(sent + 2);
    await expect(page.getByRole('region', { name: 'Current evaluation' }).getByTestId('evaluation-control-state')).toHaveText('Finished');
    const count = desktop.requests.length; await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open current-report', exact: true }).click();
    await page.getByRole('button', { name: 'Report delivery', exact: true }).click();
    await delivery.getByRole('button', { name: 'Read feedback sync status', exact: true }).click();
    await expect(delivery.getByTestId('evaluation-delivery-state')).toHaveText('complete'); expect(desktop.requests).toHaveLength(count);
    expect(desktop.requests.every(item => item.kind === 'platform')).toBe(true);
    for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    await page.setViewportSize({ width: 800, height: 700 }); await page.screenshot({ path: info.outputPath('p16-feedback-explicit-delivery.png') });
  } catch (error) {
    await info.attach('evaluation-delivery-failure-state', { body: JSON.stringify(await desktop.page.evaluate(() => window.medclaw.request('eval.status', {}))), contentType: 'application/json' });
    throw error;
  } finally { await desktop.close(); }
});

test('p16 feedback reload finds the original source on a later page and never resubmits lost text', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ reports: true, holdFeedback: true, feedbackHistory: 55 });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('region', { name: 'Evaluation reports' }).getByRole('button', { name: 'Open current-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' }); await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('trials');
    await details.getByRole('button', { name: /Review Trial / }).click();
    const feedback = page.getByRole('region', { name: 'Local feedback' });
    await feedback.getByLabel('Reviewer', { exact: true }).fill('Original reviewer'); await feedback.getByRole('textbox', { name: 'Comment', exact: true }).fill('Original submitted comment');
    await feedback.getByRole('button', { name: 'Submit feedback', exact: true }).click();
    await expect.poll(() => existsSync(desktop.feedbackEntered)).toBe(true);
    const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('medclaw.evaluation.pending.v1')!));
    expect(pending.feedback).toMatchObject({ operationKind: 'review_record', executionId: 'current-report' });
    expect(JSON.stringify(pending)).not.toContain('Original submitted comment');
    await page.reload(); desktop.releaseFeedback();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(page.getByText('Original feedback confirmed.', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('medclaw.evaluation.pending.v1'))).toBeNull();
    const review = JSON.parse(readFileSync(join(desktop.runsRoot, 'business/current-report/review.json'), 'utf8'));
    expect(review.feedback).toHaveLength(56); expect(review.feedback[55].value.sourceId).toBe('desktop-' + pending.feedback.operationRef);
    expect(desktop.requests).toEqual([]);
    for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    await page.screenshot({ path: info.outputPath('p16-feedback-reload-original.png') });
  } finally { await desktop.close(); }
});

test('p16 report pages shrink without losing reachable Scores and an oversized single item stays explicit', async ({}, info) => {
  test.setTimeout(120000);
  const desktop = await launchEvaluationDesktop({ reports: true, largeReports: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Evaluation reports' }), details = page.getByRole('region', { name: 'Report details' });
    await reports.getByRole('button', { name: 'Open paged-report', exact: true }).click();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    await expect(details.getByRole('button', { name: 'Load smaller page', exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Load smaller page', exact: true }).click();
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('69');
    const reachable: string[] = [];
    for (let number = 1; number <= 3; number++) {
      await expect(details.getByText('Page ' + number + ' · 25 per page', { exact: true })).toBeVisible();
      const scores = details.getByTestId('evaluation-score'); reachable.push(...await scores.evaluateAll(elements => elements.map(element => element.querySelector('code')!.textContent + ':' + element.querySelectorAll('p')[1]!.textContent)));
      if (number < 3) await details.getByRole('button', { name: 'Next section page', exact: true }).click();
    }
    expect(reachable).toHaveLength(69); expect(new Set(reachable).size).toBe(69);
    await page.getByRole('button', { name: 'Back to report list', exact: true }).click();
    await reports.getByRole('button', { name: 'Open oversized-item-report', exact: true }).click();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    for (let count = 0; count < 5; count++) { const smaller = details.getByRole('button', { name: 'Load smaller page', exact: true }); await expect(smaller).toBeVisible(); await smaller.click(); }
    await expect(details.getByText('This item cannot be displayed. Read Summary or Diagnostics; its original Score and denominator are preserved.', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Load smaller page', exact: true })).toHaveCount(0);
    await details.getByRole('button', { name: 'Read next page', exact: true }).click();
    await expect(details.getByTestId('evaluation-score')).toHaveCount(1);
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('23');
    expect(desktop.requests).toEqual([]);
    for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    await test.step('Capture the explicit single-item report size gap', async () => {
      await page.screenshot({ path: info.outputPath('p16-single-item-size-gap.png'), timeout: 15000 });
    });
  } finally { await desktop.close(); }
});

for (const delayed of ['legacy-report', 'corrupt-report']) test('p16 a late ' + delayed + ' response cannot replace the selected report', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ reports: true, holdReport: delayed });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Evaluation reports' }), details = page.getByRole('region', { name: 'Report details' });
    await reports.getByRole('button', { name: 'Open ' + delayed, exact: true }).click(); await expect.poll(() => existsSync(desktop.reportEntered)).toBe(true);
    await page.getByRole('button', { name: 'Back to report list', exact: true }).click();
    await reports.getByRole('button', { name: 'Open current-report', exact: true }).click();
    await details.getByText('Report identity and metric catalog', { exact: true }).click();
    await expect(details.getByText('Catalog v2', { exact: true })).toBeVisible(); desktop.releaseReport();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('23');
    await expect(details.getByRole('alert')).toHaveCount(0);
    await details.getByRole('button', { name: 'Read evidence query:42:page:1', exact: true }).click();
    const evidence = details.getByRole('region', { name: 'Selected evidence' });
    await evidence.getByText('Evidence data', { exact: true }).click();
    await expect(evidence.getByText(/selected-original-evidence/)).toBeVisible();
    expect(await evidence.innerText()).not.toContain('never-show-provider-key');
    expect(desktop.requests).toEqual([]);
    await test.step('Capture the selected report after the late ' + delayed + ' reply', async () => {
      await page.screenshot({ path: info.outputPath('p16-report-identity-' + delayed + '.png'), timeout: 15000 });
    });
  } finally { await desktop.close(); }
});

for (const method of ['eval.compare', 'eval.evidence.read'] as const) test('p16 late ' + method + ' replies stay with their original selection', async ({}, info) => {
  const desktop = await launchEvaluationDesktop({ reports: true, holdReply: method });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Evaluation reports' }), details = page.getByRole('region', { name: 'Report details' }), comparison = page.getByRole('region', { name: 'Compare reports' });
    if (method === 'eval.compare') {
      await page.getByRole('button', { name: 'Compare reports', exact: true }).click();
      await comparison.getByRole('combobox', { name: 'Baseline report', exact: true }).selectOption('current-report');
      await comparison.getByRole('combobox', { name: 'Candidate report', exact: true }).selectOption('compatible-report');
      await comparison.getByRole('button', { name: 'Compare saved reports', exact: true }).click();
      await expect.poll(() => existsSync(desktop.reportEntered)).toBe(true);
      await comparison.getByRole('combobox', { name: 'Candidate report', exact: true }).selectOption('legacy-report');
      await comparison.getByRole('button', { name: 'Compare saved reports', exact: true }).click();
      await expect(comparison.getByRole('alert')).toBeVisible(); desktop.releaseReport();
      await expect(comparison.getByText(/matchedTrials/)).toHaveCount(0);
    } else {
      await reports.getByRole('button', { name: 'Open current-report', exact: true }).click();
      await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
      await details.getByRole('button', { name: 'Read evidence query:42:page:1', exact: true }).click();
      await expect.poll(() => existsSync(desktop.reportEntered)).toBe(true);
      await page.getByRole('button', { name: 'Back to report list', exact: true }).click();
      await reports.getByRole('button', { name: 'Open legacy-report', exact: true }).click();
      await details.getByText('Report identity and metric catalog', { exact: true }).click();
      await expect(details.getByText('Catalog v1', { exact: true })).toBeVisible(); desktop.releaseReport();
      await test.step('Confirm the late evidence stays with its original report', async () => {
        await expect(details.getByRole('region', { name: 'Selected evidence' })).toHaveCount(0);
      });
    }
    await test.step('Verify the original report archive bytes', async () => {
      for (const [path, original] of desktop.originals) expect(readFileSync(path).equals(original)).toBe(true);
    });
    await test.step('Capture the final report state without model requests', async () => {
      expect(desktop.requests).toEqual([]); await page.screenshot({ path: info.outputPath('p16-late-' + method + '.png') });
    });
  } finally { await test.step('Close the isolated evaluation desktop', async () => { await desktop.close(); }); }
});

test('p16 saved reports preserve catalogs, partial facts and original comparison rules without configuration', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ reports: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Evaluation reports' }); await expect(reports).toBeVisible();
    await reports.getByRole('button', { name: 'Open legacy-report', exact: true }).click();
    const details = page.getByRole('region', { name: 'Report details' });
    await details.getByText('Report identity and metric catalog', { exact: true }).click();
    await expect(details.getByText('Catalog v1', { exact: true })).toBeVisible();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('coverage');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('39');
    await page.getByRole('button', { name: 'Back to report list', exact: true }).click();
    await reports.getByRole('button', { name: 'Open current-report', exact: true }).click();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('coverage');
    await expect(details.getByTestId('evaluation-section-total')).toHaveText('50');
    const compare = page.getByRole('region', { name: 'Compare reports' });
    await page.getByRole('button', { name: 'Compare reports', exact: true }).click();
    await compare.getByRole('combobox', { name: 'Baseline report', exact: true }).selectOption('current-report');
    await compare.getByRole('combobox', { name: 'Candidate report', exact: true }).selectOption('compatible-report');
    await compare.getByRole('button', { name: 'Compare saved reports', exact: true }).click();
    await expect(compare.getByText(/matchedTrials/)).toBeVisible();
    await compare.getByRole('combobox', { name: 'Candidate report', exact: true }).selectOption('legacy-report');
    await compare.getByRole('button', { name: 'Compare saved reports', exact: true }).click();
    await expect(compare.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Back to report list', exact: true }).click();
    await reports.getByRole('button', { name: 'Open partial-report', exact: true }).click();
    await expect(details.getByText('Partial results', { exact: true })).toBeVisible();
    await expect(details.getByText('Recorded Trials: 1 of 2', { exact: true })).toBeVisible();
    await expect(details.getByText('Missing Trials remain unconfirmed. No final quality is available.', { exact: true })).toBeVisible();
    await details.getByRole('combobox', { name: 'Report section', exact: true }).selectOption('scores');
    await expect(details.getByTestId('evaluation-score').first()).toBeVisible();
    await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await reports.getByRole('button', { name: 'Open corrupt-report', exact: true }).click();
    await expect(details.getByText('Report unavailable', { exact: true })).toBeVisible();
    expect(desktop.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('p16-reports-partial-and-catalogs.png') });
  } finally { await desktop.close(); }
});

test('p16 offline preflight invalidates changed options and preserves independent configuration boundaries', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ configured: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup).toBeVisible();
    await expect(setup.getByTestId('evaluation-planned-trials')).toHaveText('10');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    await setup.getByLabel('Trials per Case', { exact: true }).fill('5');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByTestId('evaluation-planned-trials')).toHaveText('50');
    await setup.getByRole('combobox', { name: 'Selection', exact: true }).selectOption('full');
    await expect(setup.getByLabel('Trials per Case', { exact: true })).toHaveValue('3');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByTestId('evaluation-planned-trials')).toHaveText('150');
    await setup.getByRole('combobox', { name: 'Dataset', exact: true }).selectOption('medclaw-badcase-v1');
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByTestId('evaluation-planned-trials')).toHaveText('9');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await setup.getByText('Independent configuration', { exact: true }).click();
    expect(await page.locator('body').innerText()).not.toContain('controlled-agent-key');
    expect(await page.locator('body').innerText()).not.toContain('controlled-judge-key');
    expect(desktop.requests).toEqual([]); expect(existsSync(desktop.runsRoot)).toBe(false);
    const facts = readStartupFacts(desktop.dataRoot); expect(facts.runs).toBe(0); expect(facts.calls).toBe(0);
    await page.screenshot({ path: info.outputPath('p16-preflight-independent-config.png') });
  } finally { await desktop.close(); }
});

test('p16 a delayed preflight reply cannot reenable Run after the selection has changed', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ configured: true, holdPreflight: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup).toBeVisible();
    await expect.poll(() => existsSync(desktop.preflightEntered)).toBe(true);
    await setup.getByLabel('Trials per Case', { exact: true }).fill('2'); desktop.releasePreflight();
    await expect(setup.getByText('Check required', { exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await setup.getByRole('button', { name: 'Check evaluation', exact: true }).click();
    await expect(setup.getByTestId('evaluation-planned-trials')).toHaveText('20');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    expect(desktop.requests).toEqual([]); expect(existsSync(desktop.runsRoot)).toBe(false);
    await page.screenshot({ path: info.outputPath('p16-preflight-stale-reply.png') });
  } finally { await desktop.close(); }
});

test('p16 unavailable recovery storage blocks Run before a Trial or model request is created', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop({ configured: true });
  try {
    const { page } = desktop;
    await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key === 'medclaw.evaluation.pending.v1') throw new DOMException('Controlled storage failure', 'QuotaExceededError');
      return original.call(this, key, value);
    }; });
    await page.reload(); await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    await setup.getByRole('button', { name: 'Run evaluation', exact: true }).click();
    await expect(page.getByText('Evaluation recovery is unavailable. Existing results remain readable.', { exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    expect(desktop.requests).toEqual([]); expect(existsSync(desktop.runsRoot)).toBe(false);
    const facts = readStartupFacts(desktop.dataRoot); expect(facts.runs).toBe(0); expect(facts.calls).toBe(0);
    await page.screenshot({ path: info.outputPath('p16-recovery-storage-blocks-run.png') });
  } finally { await desktop.close(); }
});

test('p16 Run reaches an isolated actual Trial, preserves a chat draft and cancels without a second execution', async ({}, info) => {
  test.setTimeout(120000);
  const desktop = await launchEvaluationDesktop({ configured: true, holdAgent: true });
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect(page.getByLabel('Message text', { exact: true })).toBeEnabled();
    await page.getByLabel('Message text', { exact: true }).fill('Retained draft during independent evaluation');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click(); await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Evaluation setup' }); await expect(setup).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeEnabled();
    await setup.getByRole('button', { name: 'Run evaluation', exact: true }).dblclick();
    await expect.poll(() => desktop.requests.filter(item => item.kind === 'agent').length, { timeout: 30000 }).toBe(1);
    const current = page.getByRole('region', { name: 'Current evaluation' });
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Running');
    await expect(setup.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
    await current.getByText('Current execution identity', { exact: true }).click();
    const identity = (await current.locator('code').first().innerText()).trim();
    expect(identity).toMatch(/^desktop-[0-9a-f-]{36}$/);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel('Message text', { exact: true })).toHaveValue('Retained draft during independent evaluation');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByText(/Evaluation stop or save is unconfirmed|An evaluation action is running/).first()).toBeVisible();
    const blocked = await page.evaluate(() => window.medclaw.request('model.diagnose', { model: { provider: 'fixture', modelId: 'fixture', expectedConfigVersion: '0' }, referenceDate: '2026-01-01', timezone: 'UTC' }));
    expect(blocked).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Runtime', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restart Host', exact: true })).toBeDisabled();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await current.getByRole('button', { name: 'Cancel evaluation', exact: true }).click(); desktop.releaseAgent();
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Finished', { timeout: 30000 });
    await expect(current.getByTestId('evaluation-saved-trials')).toHaveText('10');
    const directory = join(desktop.runsRoot, 'business', identity);
    expect(existsSync(join(directory, 'snapshot.json'))).toBe(true); expect(existsSync(join(directory, 'report.json'))).toBe(true);
    expect(readdirSync(join(desktop.runsRoot, 'business'), { withFileTypes: true }).filter(item => item.isDirectory())).toHaveLength(1);
    const snapshot = JSON.parse(readFileSync(join(directory, 'snapshot.json'), 'utf8'));
    expect(snapshot.executionId).toBe(identity); expect(snapshot.desktopRequest.operationRef).toBe(identity.slice(8)); expect(snapshot.plan).toHaveLength(10);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')), started = report.trials.find((trial: { startedAt: string | null }) => trial.startedAt !== null);
    expect(started.stopped).toBe(true); expect(started.closed).toBe(true);
    const originalTrial = JSON.parse(readFileSync(join(directory, 'evidence', started.trialId, 'trial.json'), 'utf8'));
    expect(originalTrial.lifecycle.shutdown).toMatchObject({ stopped: true, closed: true, processExited: true, residuals: [] });
    expect(existsSync(join(desktop.runsRoot, 'business', '.active-execution.json'))).toBe(false);
    const facts = readStartupFacts(desktop.dataRoot); expect(facts.runs).toBe(0); expect(facts.calls).toBe(0);
    const pending = await page.evaluate(() => sessionStorage.getItem('medclaw.evaluation.pending.v1'));
    if (pending) expect(JSON.parse(pending).run?.operationRef).toBe(identity.slice(8));
    cpSync(directory, info.outputPath('evaluation-runs', 'business', identity), { recursive: true, force: false, errorOnExist: true });
    await page.screenshot({ path: info.outputPath('p16-run-cancel-original-archive.png') });
  } finally { await desktop.close(); }
});

test('p16 navigation and status use the actual Evaluation page with keyboard access', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop();
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const before = readStartupFacts(desktop.dataRoot), navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation.getByRole('button')).toHaveCount(8);
    await expect(navigation.getByText('Quality', { exact: true })).toBeVisible();
    const entry = navigation.getByRole('button', { name: 'Evaluation', exact: true });
    await entry.focus(); await page.keyboard.press('Enter');
    await expect(entry).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible();
    const current = page.getByRole('region', { name: 'Current evaluation', includeHidden: true });
    await expect(current).toBeHidden();
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Idle');
    await page.getByRole('button', { name: 'Refresh evaluation status' }).click();
    await expect(current.getByTestId('evaluation-control-state')).toHaveText('Idle');
    const after = readStartupFacts(desktop.dataRoot);
    expect(after.runs).toBe(0); expect(after.calls).toBe(0);
    expect(after.migrations.map(item => ({ version: item.version, appliedAt: item.applied_at }))).toEqual(before.migrations.map(item => ({ version: item.version, appliedAt: item.applied_at })));
    expect(existsSync(desktop.runsRoot)).toBe(false);
    await page.screenshot({ path: info.outputPath('p16-evaluation-navigation.png') });
  } finally { await desktop.close(); }
});

test('p16 reload only looks up a pending original and cannot let its unknown history replace current idle', async ({}, info) => {
  test.setTimeout(90000);
  const desktop = await launchEvaluationDesktop(), operationRef = '435cbd9c-f42b-4e59-a24c-79e3f9738df3';
  try {
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const pending = { schemaVersion: 1, run: { operationKind: 'run', operationRef, datasetId: 'medclaw-agent-v1', selection: 'smoke', trials: 1 }, feedback: null, platform: null };
    await page.evaluate(value => sessionStorage.setItem('medclaw.evaluation.pending.v1', JSON.stringify(value)), pending);
    await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('button', { name: 'Check original evaluation' }).click();
    await expect(page.getByText('Original action unconfirmed', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Current evaluation', includeHidden: true }).getByTestId('evaluation-control-state')).toHaveText('Idle');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('medclaw.evaluation.pending.v1')!))).toEqual(pending);
    const facts = readStartupFacts(desktop.dataRoot); expect(facts.runs).toBe(0); expect(facts.calls).toBe(0);
    expect(existsSync(desktop.runsRoot)).toBe(false);
    await page.screenshot({ path: info.outputPath('p16-evaluation-reload-unknown.png') });
  } finally { await desktop.close(); }
});

test('p16 actual Electron Main Preload and Bun provide readonly evaluation and confirm orderly exit', async ({}, info) => {
  test.setTimeout(90000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-p16-desktop-')), dataRoot = join(temporary, 'production');
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined;
  try {
    desktop = await launchActualDev(temporary, dataRoot);
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const before = readStartupFacts(dataRoot);
    const summary = await page.evaluate(async () => ({
      status: await window.medclaw.request('eval.status', {}),
      check: await window.medclaw.request('eval.preflight', { datasetId: 'medclaw-agent-v1', selection: 'smoke' }),
      reports: await window.medclaw.request('eval.report.list', {}),
      workspace: await window.medclaw.request('workspace.read', {}),
    }));
    expect(summary.status).toMatchObject({ ok: true, data: { state: 'idle', stopConfirmed: true, saveConfirmed: true, controllerExited: false } });
    expect(summary.check).toMatchObject({ ok: true, data: { cases: 10, plannedTrials: 10, config: null, blockers: [{ code: 'evaluation_config_unavailable' }] } });
    expect(summary.reports).toMatchObject({ ok: true, data: { total: 0, items: [] } });
    expect(summary.workspace.ok).toBe(true);
    const after = readStartupFacts(dataRoot);
    expect(after.runs).toBe(0); expect(after.calls).toBe(0);
    expect(after.migrations.map(item => ({ version: item.version, appliedAt: item.applied_at }))).toEqual(before.migrations.map(item => ({ version: item.version, appliedAt: item.applied_at })));
    await page.screenshot({ path: info.outputPath('p16-main-preload-readonly.png') });
    await desktop.close(); desktop = undefined;
    expect(readFileSync(join(temporary, 'dev-exit-confirmed'), 'utf8')).toBe('exited');
  } finally {
    if (desktop) await desktop.close();
    // Only a proved ordinary Main exit permits removal of this test's own root.
    const confirmed = existsSync(join(temporary, 'dev-exit-confirmed'));
    if (confirmed && resolve(temporary).startsWith(resolve(tmpdir()) + '\\')) rmSync(temporary, { recursive: true, force: true });
  }
});

test('p16 actual Main refuses quit while an owned previous execution has no stop or save proof', async ({}, info) => {
  test.setTimeout(90000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-p16-quit-')), dataRoot = join(temporary, 'production');
  const executionId = 'desktop-63faf6f3-1dc9-4768-a23d-52cb734619ef';
  const business = join(temporary, 'evaluation-runs/business'), lock = join(business, '.active-execution.json');
  const original = JSON.stringify({ executionId, pid: 12345, state: 'stop_or_save_unconfirmed' });
  mkdirSync(business, { recursive: true }); writeFileSync(lock, original);
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined;
  try {
    desktop = await launchActualDev(temporary, dataRoot);
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const status = await page.evaluate(() => window.medclaw.request('eval.status', {}));
    expect(status).toMatchObject({ ok: true, data: { state: 'unknown', executionId, stopConfirmed: null, saveConfirmed: null, controllerExited: false } });
    if (!status.ok) throw status.error;
    await page.evaluate(sequence => {
      (window as typeof window & { p16QuitProof?: unknown }).p16QuitProof = null;
      const release = window.medclaw.subscribe(notice => {
        if (notice.type === 'eval.status' && notice.sequence > sequence) {
          release(); (window as typeof window & { p16QuitProof?: unknown }).p16QuitProof = notice.control;
        }
      });
    }, status.data.sequence);
    writeFileSync(join(temporary, 'request-dev-quit'), 'quit');
    await expect.poll(() => page.evaluate(() => (window as typeof window & { p16QuitProof?: unknown }).p16QuitProof), { timeout: 10000 })
      .toMatchObject({ state: 'unknown', stopConfirmed: null, saveConfirmed: null, controllerExited: false });
    expect(await page.evaluate(() => window.medclaw.request('workspace.read', {}))).toMatchObject({ ok: true });
    expect(readFileSync(lock, 'utf8')).toBe(original);
    await page.screenshot({ path: info.outputPath('p16-quit-refused.png') });
    let closeError: unknown;
    try { await desktop.close(); } catch (error) { closeError = error; }
    expect(closeError).toBeInstanceOf(Error);
    expect(existsSync(join(temporary, 'dev-exit-confirmed'))).toBe(false);
    expect(await page.evaluate(() => window.medclaw.request('workspace.read', {}))).toMatchObject({ ok: true });
    expect(readFileSync(lock, 'utf8')).toBe(original);
  } finally {
    // This test's lock never owned a Trial; preserve it if another writer changed its contents.
    if (existsSync(lock) && readFileSync(lock, 'utf8') === original) rmSync(lock);
    if (desktop) await desktop.close();
    if (existsSync(join(temporary, 'dev-exit-confirmed')) && resolve(temporary).startsWith(resolve(tmpdir()) + '\\')) rmSync(temporary, { recursive: true, force: true });
  }
});
