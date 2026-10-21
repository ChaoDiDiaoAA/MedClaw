import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { launchPackagedDesktop } from '../fixtures/p17-installed';
import { projectRoot, readStartupFacts } from '../fixtures/desktop-dev';

test('p11 unpacked Windows resources expose 16 Skills and preserve Prompt drafts without inference', async ({}, info) => {
  test.setTimeout(150000);
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-installed-')), profile = join(root, 'profile'); mkdirSync(profile);
  const desktop = await launchPackagedDesktop(root, profile, { kind: 'unpacked', executable: resolve(projectRoot, '.build/installers/win-unpacked/MedClaw.exe') });
  let failure: unknown;
  try {
    const page = desktop.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.medclaw.request('workspace.read', {}));
      return result.ok ? result.data.sessionId : null;
    }).not.toBeNull();
    const workspace = await page.evaluate(() => window.medclaw.request('workspace.read', {}));
    if (!workspace.ok || !workspace.data.sessionId) throw new Error('ENGINEERING installed Session unavailable');
    const sessionId = workspace.data.sessionId;
    const catalog = await page.evaluate(sessionId => window.medclaw.request('resources.list', { source: 'selection', sessionId }), sessionId);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error('ENGINEERING installed resource catalog unavailable');
    const skills = catalog.data.items.filter(item => item.ref.kind === 'skill');
    expect(skills.map(item => item.ref.id).sort()).toEqual(['query', 'data-scope-review', 'data-coverage-check', 'device-identity-resolve', 'device-detail-review',
      'current-device-search', 'manufacturer-device-list', 'device-status-screen', 'new-device-records', 'missing-device-records', 'price-change-review',
      'device-status-change', 'distributor-change-review', 'price-threshold-review', 'query-evidence-audit', 'data-freshness-review'].sort());
    expect(catalog.data.items).toHaveLength(17);
    expect(catalog.data.items.filter(item => item.ref.kind === 'prompt').map(item => item.ref.id)).toEqual(['query']);
    expect(skills.filter(item => item.ref.id !== 'query').every(item => !item.enabled && item.availability === 'ready')).toBe(true);
    expect(catalog.data.selection.skills).toEqual([]);
    const originalDraft = 'ENGINEERING existing unsent chat draft';
    await page.getByLabel('Message text', { exact: true }).fill(originalDraft);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    const hub = page.getByRole('region', { name: 'Skill Hub', exact: true });
    await expect(hub.getByTestId('resource-row')).toHaveCount(16);
    await hub.getByRole('button', { name: 'Disabled', exact: true }).click();
    await expect(hub.getByTestId('resource-row')).toHaveCount(16);
    await hub.getByRole('button', { name: 'All', exact: true }).click();
    await hub.getByRole('button', { name: 'data-scope-review', exact: true }).click();
    const bodyButton = hub.getByRole('button', { name: 'Read data-scope-review SKILL.md', exact: true });
    await expect(bodyButton).toBeDisabled();
    await hub.getByRole('button', { name: 'Enable data-scope-review', exact: true }).click();
    await expect(hub.getByRole('button', { name: 'Disable data-scope-review', exact: true })).toBeVisible();
    await expect(bodyButton).toBeEnabled(); await bodyButton.click();
    await expect(hub.getByTestId('resource-body')).toContainText('Review the available data scope');
    await expect(hub.getByTestId('resource-body')).toContainText('read_data_scope');
    const selected = await page.evaluate(sessionId => window.medclaw.request('resources.list', { source: 'selection', sessionId }), sessionId);
    expect(selected).toMatchObject({ ok: true, data: { selection: { skills: [{ kind: 'skill', id: 'data-scope-review', version: 'v1' }] } } });
    for (const zoom of [1, 2]) {
      const display = await desktop.display(1100, 720, zoom);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(Math.ceil(display.content[0]! / zoom) + 1);
      const geometry = await hub.evaluate(element => {
        const content = element.closest('.page-content')!, root = document.querySelector('.desktop')!;
        return { viewport: innerWidth, hubOverflow: element.scrollWidth - element.clientWidth,
          contentOverflow: content.scrollWidth - content.clientWidth, rootOverflow: root.scrollWidth - root.clientWidth };
      });
      await info.attach(`p11-installed-skill-geometry-${zoom}.json`, { body: JSON.stringify({ display, geometry }), contentType: 'application/json' });
      expect(geometry.hubOverflow).toBeLessThanOrEqual(1);
      expect(geometry.contentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.rootOverflow).toBeLessThanOrEqual(1);
    }
    await desktop.display(1100, 720, 1);
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    const original = '请优化问数提示，保留日期、字段和证据要求。', requirements = 'Keep the original language and all identifiers.', optimized = 'ENGINEERING edited prompt; not generated by a model.';
    await page.getByLabel('Original prompt', { exact: true }).fill(original);
    await page.getByLabel('Requirements (optional)', { exact: true }).fill(requirements);
    await page.getByLabel('Optimized prompt', { exact: true }).fill(optimized);
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const business = page.getByRole('region', { name: 'Business prompt', exact: true });
    await expect(business.getByTestId('resource-row')).toHaveCount(1);
    await expect(business.getByRole('button', { name: 'Enable query', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    await expect(page.getByLabel('Original prompt', { exact: true })).toHaveValue(original);
    await expect(page.getByLabel('Requirements (optional)', { exact: true })).toHaveValue(requirements);
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue(optimized);
    await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
    await expect(page.getByLabel('Message text', { exact: true })).toHaveValue(originalDraft + '\n\n' + optimized);
    expect(readStartupFacts(profile)).toMatchObject({ runs: 0, calls: 0 });
    await info.attach('p11-installed-engineering-evidence.json', { body: JSON.stringify({ executable: desktop.executable, origin: desktop.origin.kind,
      resources: catalog.data.items.map(item => ({ ref: item.ref, enabled: item.enabled, availability: item.availability })),
      selected: selected.ok ? selected.data.selection : null, modelCalls: 0, quality: 'NOT_RUN', installation: 'unpacked executable; NSIS not exercised' }), contentType: 'application/json' });
  } catch (error) {
    failure = error;
    await info.attach('p11-installed-failure.png', { body: await desktop.page.screenshot(), contentType: 'image/png' }).catch(() => {});
    throw error;
  } finally {
    try { await desktop.close(); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], 'ENGINEERING installed resource check and cleanup failed'); throw cleanup; }
    if (!failure) {
      const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
      if (!part || part.startsWith('..') || !existsSync(join(root, 'packaged-tree-stopped'))) throw new Error('ENGINEERING installed resource cleanup refused');
      rmSync(target, { recursive: true, force: true });
    }
  }
});
