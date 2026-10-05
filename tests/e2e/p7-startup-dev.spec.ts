import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createLegacyLfRoot, createStartupPackage, launchActualDev, readStartupFacts, setFixtureMigrationChecksum } from '../fixtures/desktop-dev';

test.describe.configure({ mode: 'serial' });

test('S01/S06/S07/S08 actual dev starts unconfigured, reads unauthenticated providers and creates a session without a model call', async ({}, testInfo) => {
  test.setTimeout(60000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-dev-'));
  const dataRoot = join(temporary, '首次启动 empty root');
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined;
  try {
    const importDirectory = join(temporary, 'snapshot package');
    createStartupPackage(importDirectory);
    desktop = await launchActualDev(temporary, dataRoot, importDirectory);
    const { page } = desktop;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
    const initial = readStartupFacts(dataRoot);
    expect(initial.sessions).toHaveLength(0); expect(initial.runs).toBe(0); expect(initial.calls).toBe(0);
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    const directory = await page.evaluate(() => window.medclaw.request('model.read', {}));
    expect(directory.ok).toBe(true);
    if (!directory.ok) throw new Error(directory.error.code);
    expect(directory.data.selection).toBeNull();
    expect(directory.data.providers.length).toBeGreaterThan(0); expect(directory.data.models.length).toBeGreaterThan(0);
    const openai = directory.data.providers.find(provider => provider.id === 'openai');
    expect(openai?.auth.state).toBe('unavailable');
    await expect(page.getByLabel('Provider', { exact: true }).locator('option')).toHaveCount(directory.data.providers.length + 1);
    await page.getByLabel('Provider', { exact: true }).selectOption('openai');
    await page.getByLabel('Search models').fill('no-such-startup-model');
    await expect(page.getByText('No models match your search', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose snapshot directory', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Choose snapshot directory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm import', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
    await expect.poll(async () => { const result = await page.evaluate(() => window.medclaw.request('data.read', {})); return result.ok ? result.data.batchCount : null; }).toBe(1);
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect.poll(() => readStartupFacts(dataRoot).sessions.length).toBe(1);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Submitting…', exact: true })).toHaveCount(0);
    const final = readStartupFacts(dataRoot);
    expect(final.runs).toBe(0); expect(final.calls).toBe(0);
    await testInfo.attach('startup-facts', { body: JSON.stringify({ initial, final, providers: directory.data.providers.length, models: directory.data.models.length }), contentType: 'application/json' });
  } finally {
    await desktop?.close();
    expect(existsSync(join(dataRoot, 'runtime/host.lock'))).toBe(false);
    const path = relative(resolve(tmpdir()), resolve(temporary));
    if (existsSync(join(temporary, 'dev-exit-confirmed')) && path && !path.startsWith('..') && !path.includes(':')) rmSync(temporary, { recursive: true, force: true });
  }
});

test('S02 actual dev migrates an LF legacy root on Windows and preserves its original facts', async ({}, testInfo) => {
  test.setTimeout(60000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-legacy-'));
  const dataRoot = join(temporary, '旧数据 LF root');
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined;
  try {
    createLegacyLfRoot(dataRoot);
    const before = readStartupFacts(dataRoot);
    desktop = await launchActualDev(temporary, dataRoot);
    await expect(desktop.page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(desktop.page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    const after = readStartupFacts(dataRoot);
    expect(after.migrations.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8,9]);
    expect(after.migrations.slice(0, 3)).toEqual(before.migrations);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.runs).toBe(0); expect(after.calls).toBe(0);
    await testInfo.attach('legacy-startup-facts', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  } finally {
    await desktop?.close();
    expect(existsSync(join(dataRoot, 'runtime/host.lock'))).toBe(false);
    const path = relative(resolve(tmpdir()), resolve(temporary));
    if (existsSync(join(temporary, 'dev-exit-confirmed')) && path && !path.startsWith('..') && !path.includes(':')) rmSync(temporary, { recursive: true, force: true });
  }
});

test('S03 actual dev reports a real migration failure and permits explicit recovery through Main controls', async ({}, testInfo) => {
  test.setTimeout(60000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-failure-'));
  const dataRoot = join(temporary, 'failed existing root');
  let desktop: Awaited<ReturnType<typeof launchActualDev>> | undefined;
  try {
    createLegacyLfRoot(dataRoot);
    const original = readStartupFacts(dataRoot).migrations[2]!.checksum;
    setFixtureMigrationChecksum(dataRoot, 'content-changed-checksum');
    desktop = await launchActualDev(temporary, dataRoot);
    const { page } = desktop;
    await expect(page.getByText('Host failed to start', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const failed = await page.evaluate(() => window.medclaw.request('host.read', {}));
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error(failed.error.code);
    expect(failed.data.error?.code).toBe('storage_migration_failed');
    expect(failed.data.canStart).toBe(true);
    const diagnostic = await page.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['errors', 'runtime', 'host'] }));
    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) throw new Error(diagnostic.error.code);
    expect(diagnostic.data.partial).toBe(true);
    expect(JSON.stringify(diagnostic.data.entries)).toContain('database_open');
    expect(readStartupFacts(dataRoot).migrations).toHaveLength(3);
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save display preferences', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start Host', exact: true })).toBeEnabled();
    // Repair only the deliberately tampered fixture after the writer is proven exited.
    setFixtureMigrationChecksum(dataRoot, original);
    await page.getByRole('button', { name: 'Start Host', exact: true }).click();
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeEnabled();
    const recovered = readStartupFacts(dataRoot);
    expect(recovered.runs).toBe(0); expect(recovered.calls).toBe(0);
    await testInfo.attach('failure-recovery-facts', { body: JSON.stringify({ failed: failed.data, diagnostic: diagnostic.data, recovered }), contentType: 'application/json' });
  } finally {
    await desktop?.close();
    expect(existsSync(join(dataRoot, 'runtime/host.lock'))).toBe(false);
    const path = relative(resolve(tmpdir()), resolve(temporary));
    if (existsSync(join(temporary, 'dev-exit-confirmed')) && path && !path.startsWith('..') && !path.includes(':')) rmSync(temporary, { recursive: true, force: true });
  }
});

test('S03 actual dev acquisition failure confirms Main exit before its isolated root can be removed', async ({}, testInfo) => {
  test.setTimeout(60000);
  const temporary = mkdtempSync(join(tmpdir(), 'medclaw-startup-acquisition-'));
  const dataRoot = join(temporary, 'early close root');
  // Inject only fixture acquisition failure after connecting to the ordinary
  // Main, then verify its normal app.quit/Host shutdown before deleting the root.
  try {
    await expect(launchActualDev(temporary, dataRoot, undefined, () => { throw new Error('Fixture page acquisition failed'); })).rejects.toThrow('Fixture page acquisition failed');
    const main = JSON.parse(readFileSync(join(temporary, 'observed-main.json'), 'utf8')) as { pid: number };
    expect(Number.isSafeInteger(main.pid)).toBe(true);
    expect(() => process.kill(main.pid, 0)).toThrow();
    expect(existsSync(join(temporary, 'dev-exit-confirmed'))).toBe(true);
    expect(existsSync(join(dataRoot, 'runtime/host.lock'))).toBe(false);
    await testInfo.attach('acquisition-cleanup-facts', { body: JSON.stringify({ mainPid: main.pid, mainExited: true, launcherExited: true, lockRemoved: true }), contentType: 'application/json' });
  } finally {
    const path = relative(resolve(tmpdir()), resolve(temporary));
    if (existsSync(join(temporary, 'dev-exit-confirmed')) && !existsSync(join(dataRoot, 'runtime/host.lock')) && path && !path.startsWith('..') && !path.includes(':')) rmSync(temporary, { recursive: true, force: true });
  }
});
