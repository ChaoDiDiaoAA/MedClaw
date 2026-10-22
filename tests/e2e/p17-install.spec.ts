import { expect, test } from '@playwright/test';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { launchPackagedDesktop } from '../fixtures/p17-installed';
import { bunExecutable, projectRoot, readStartupFacts } from '../fixtures/desktop-dev';

test('P17 unpacked Windows application restores through Main relaunch into an independent root', async ({}, info) => {
  test.setTimeout(150000);
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p17-打包 恢复-')), profile = join(root, '用户 数据'), destination = join(root, '备份 目录'), targetParent = join(root, '恢复 目录');
  for (const directory of [profile, destination, targetParent]) mkdirSync(directory);
  // This exercises the actual unpacked executable. NSIS installation and clean-machine acceptance remain separate.
  const desktop = await launchPackagedDesktop(root, profile, { kind: 'unpacked', executable: resolve(projectRoot, '.build/installers/win-unpacked/MedClaw.exe') });
  let failure: unknown, currentPage = desktop.page;
  try {
    const page = desktop.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const created = await page.evaluate(async () => {
      const workspace = await window.medclaw.request('workspace.read', {});
      if (!workspace.ok) throw new Error('ENGINEERING workspace unavailable');
      return window.medclaw.request('session.create', { expectedWorkspaceRevision: workspace.data.revision }, 'packaged-original-session');
    });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error('ENGINEERING Session creation failed');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();await page.getByRole('button',{name:'Backup and restore',exact:true}).click();
    desktop.choose([destination]);
    await page.getByRole('button', { name: 'Choose backup destination', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirm data backup' }).getByRole('button', { name: 'Confirm backup', exact: true }).click();
    await expect(page.getByText('Backup completed. Host remains stopped.', { exact: true })).toBeVisible({ timeout: 30000 });
    const backup = join(destination, readdirSync(destination).find(name => name.startsWith('MedClaw-backup-'))!);
    const original = readFileSync(join(profile, 'data/settings.json'), 'utf8');
    desktop.choose([backup, targetParent]);
    await page.getByRole('button', { name: 'Choose backup to restore', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Confirm data restore' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Confirm restore', exact: true }).click();
    const next = await desktop.relaunched(desktop.pid);
    currentPage = next.page;
    expect(next.pid).not.toBe(desktop.pid); expect(desktop.generations.size).toBeGreaterThanOrEqual(2);
    await expect(next.page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const selection = JSON.parse(readFileSync(join(profile, 'launch.json'), 'utf8')) as { activeDataRoot: string; restoreOperationRef: string };
    expect(realpathSync(selection.activeDataRoot)).not.toBe(realpathSync(profile));
    expect(relative(realpathSync(targetParent), realpathSync(selection.activeDataRoot))).not.toMatch(/^\.\./);
    const receipt = JSON.parse(readFileSync(join(selection.activeDataRoot, 'data/restore-receipt.json'), 'utf8')) as { receipt: { operationRef: string }; configVersion: string };
    expect(receipt.receipt.operationRef).toBe(selection.restoreOperationRef);
    const detail = await next.page.evaluate(sessionId => window.medclaw.request('session.read', { sessionId }), created.data.session.id);
    expect(detail).toMatchObject({ ok: true, data: { session: { id: created.data.session.id }, runtime: { availability: 'unloaded' } } });
    expect(readFileSync(join(profile, 'data/settings.json'), 'utf8')).toBe(original);
    const restored = JSON.parse(readFileSync(join(selection.activeDataRoot, 'data/settings.json'), 'utf8')) as { configVersion: string; credentialRefs: object; previous: unknown };
    expect(restored.configVersion).toBe('2'); expect(restored.credentialRefs).toEqual({}); expect(restored.previous).toBeNull();
    expect(readStartupFacts(profile)).toMatchObject({ runs: 0, calls: 0 }); expect(readStartupFacts(selection.activeDataRoot)).toMatchObject({ runs: 0, calls: 0 });
    const pages = ['Chat', 'Data Workspace', 'Query History', 'Models', 'Prompt', 'Skills', 'Extensions', 'Evaluation', 'Settings'];
    for (const [width, height, zoom] of [[1440, 900, 1], [1100, 720, 1], [1440, 900, 2], [1100, 720, 2]] as const) {
      const mode = `${width}-${height}-${zoom}`, measured = await desktop.display(width, height, zoom);
      await info.attach(`p17-${mode}-window.json`, { body: JSON.stringify({ requested: [width, height, zoom], ...measured,
        viewport: await next.page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })) }), contentType: 'application/json' });
      expect(measured.zoom).toBe(zoom); expect(measured.minimum).toEqual([1100, 720]);
      expect(measured).toMatchObject({ visible: true, minimized: false, maximized: false });
      expect(measured.content[0]).toBeGreaterThan(0); expect(measured.content[1]).toBeGreaterThan(0);
      // Windows rounds native DIP dimensions at this display scale; keep its actual measurements.
      expect(Math.abs(measured.size[0]! - width)).toBeLessThanOrEqual(2); expect(Math.abs(measured.size[1]! - height)).toBeLessThanOrEqual(2);
      await expect.poll(() => next.page.evaluate(() => innerWidth)).toBeLessThanOrEqual(Math.ceil(measured.content[0]! / zoom) + 1);
      await expect.poll(() => next.page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(Math.floor(measured.content[0]! / zoom) - 1);
      if (width === 1100) expect((await desktop.display(1, 1, zoom)).size).toEqual(measured.size);
      for (const name of pages) {
        await next.page.getByRole('button', { name, exact: true }).click();
        await expect(next.page.getByRole('heading', { name, level: 1, exact: true })).toBeInViewport({ ratio: 1 });
        await expect(next.page.getByRole('button', { name: 'View run details', exact: true })).toBeInViewport({ ratio: 1 });
        const geometry = await next.page.evaluate(() => {
          const main = document.querySelector('.workspace')!.getBoundingClientRect(), root = document.querySelector('.desktop')!;
          return { viewport: innerWidth, left: main.left, right: main.right, width: main.width, overflow: root.scrollWidth - root.clientWidth };
        });
        await info.attach(`p17-${mode}-${name.replaceAll(' ', '-')}-geometry.json`, { body: JSON.stringify(geometry), contentType: 'application/json' });
        expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
      }
      await next.page.getByRole('button', { name: 'Chat', exact: true }).click();
      const draft = next.page.getByRole('textbox', { name: 'Message text', exact: true }), text = 'ENGINEERING unsent navigation draft ' + mode;
      await draft.fill(text); await next.page.getByRole('button', { name: 'Data Workspace', exact: true }).click();
      await next.page.getByRole('button', { name: 'Chat', exact: true }).click(); await expect(draft).toHaveValue(text);
      await next.page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
      await expect(next.page.getByRole('button', { name: 'Expand navigation', exact: true })).toBeVisible();
      await expect(draft).toHaveValue(text); await next.page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
      await next.page.getByRole('button', { name: 'View run details', exact: true }).click();
      await expect(next.page.locator('.run-details')).toBeInViewport({ ratio: 1 });
      await next.page.getByRole('button', { name: 'Close run details', exact: true }).press('Escape');
      await expect(next.page.locator('.run-details')).toHaveCount(0);
      await expect(next.page.getByRole('button', { name: 'View run details', exact: true })).toBeFocused();
      await expect(draft).toHaveValue(text);
    }
    expect(readStartupFacts(selection.activeDataRoot)).toMatchObject({ runs: 0, calls: 0 });
  } catch (error) {
    failure = error; console.error('P17_PACKAGED_FAILURE ' + (error instanceof Error ? error.message : 'unknown'));
    try {
      const observed = await currentPage.evaluate(() => window.medclaw.request('diagnostics.read', { categories: ['runtime', 'errors'] }));
      await info.attach('p17-packaged-failure-control.json', { body: JSON.stringify(observed), contentType: 'application/json' });
      console.error('P17_PACKAGED_CONTROL ' + JSON.stringify(observed));
      const evaluation = await currentPage.evaluate(() => window.medclaw.request('eval.status', {}));
      console.error('P17_PACKAGED_EVALUATION ' + JSON.stringify(evaluation));
    } catch { console.error('P17_PACKAGED_CONTROL_UNAVAILABLE'); }
    throw error;
  } finally {
    try { await desktop.close(); } catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], 'ENGINEERING packaged verification and cleanup failed'); throw cleanup; }
    if (failure) console.error('P17_PACKAGED_ROOT_RETAINED ' + root);
    else {
      const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
      if (!part || part.startsWith('..') || !existsSync(join(root, 'packaged-tree-stopped'))) throw new Error('ENGINEERING packaged cleanup refused');
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test('P17 unpacked Main reads external evaluation configuration and original reports from a read-only application without inference', async ({}, info) => {
  test.setTimeout(240000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 评测只读-'))), application = join(root, '只读 应用'), profile = join(root, '用户 数据');
  console.log('P17_PACKAGED_EVALUATION_ROOT ' + root);
  const configs = join(profile, 'evaluation/configs'), runs = join(profile, 'evaluation/runs'), datasets = join(profile, 'evaluation/datasets');
  const requests: string[] = [], agentKey = 'ENGINEERING-PACKAGED-AGENT-KEY', judgeKey = 'ENGINEERING-PACKAGED-JUDGE-KEY';
  const listener = createServer((request, response) => { requests.push(request.url ?? 'unknown'); response.writeHead(403); response.end('ENGINEERING generation prohibited'); });
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath($request.root).TrimEnd('\')
    $target = (Resolve-Path -LiteralPath $request.path).ProviderPath
    if (!$target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Outside owned test root' }
    $acl = [IO.Directory]::GetAccessControl($target)
    if ($request.action -eq 'deny') {
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::Write,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
      [void]$acl.AddAccessRule($rule)
      [IO.Directory]::SetAccessControl($target, $acl)
    } elseif ($request.action -eq 'restore') {
      $acl.SetSecurityDescriptorSddlForm($request.sddl, [Security.AccessControl.AccessControlSections]::Access)
      [IO.Directory]::SetAccessControl($target, $acl)
    } elseif ($request.action -ne 'read') { throw 'Unknown test operation' }
    @{sddl=([IO.Directory]::GetAccessControl($target)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)} | ConvertTo-Json -Compress
  `;
  const acl = (action: 'read' | 'deny' | 'restore', sddl?: string): string => {
    const within = relative(root, realpathSync(application));
    if (realpathSync(root) !== root || !within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('ENGINEERING ACL root changed');
    const text = execFileSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: JSON.stringify({ root, path: application, action, sddl }), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 });
    return (JSON.parse(text) as { sddl: string }).sddl;
  };
  let desktop: Awaited<ReturnType<typeof launchPackagedDesktop>> | undefined, originalAcl: string | undefined, failure: unknown, stopped = false;
  try {
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + (listener.address() as { port: number }).port, endpoint = base + '/agent/v1';
    cpSync(resolve(projectRoot, '.build/installers/win-unpacked'), application, { recursive: true, dereference: true, errorOnExist: true, force: false });
    mkdirSync(profile);
    const runtime = join(application, 'resources/medclaw/runtime'), prepare = join(root, 'prepare-evaluation.ts'), packet = join(root, 'evaluation-fixture.json');
    writeFileSync(prepare, `import{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';
      import{loadDataset}from${JSON.stringify(resolve(projectRoot, 'agent-eval/src/datasets.ts'))};
      import{reportFixture,saveReportFixture,runConfigFixture}from${JSON.stringify(resolve(projectRoot, 'agent-eval/tests/report-fixture.ts'))};
      import{recordFeedback}from${JSON.stringify(resolve(projectRoot, 'agent-eval/src/review/store.ts'))};
      globalThis.fetch=async()=>{throw new Error('ENGINEERING preparation network prohibited');};
      const configs=${JSON.stringify(configs)},runs=${JSON.stringify(runs)},datasets=${JSON.stringify(datasets)};
      mkdirSync(configs,{recursive:true});mkdirSync(join(datasets,'medclaw-agent-v1'),{recursive:true});
      const dataset=await loadDataset('medclaw-agent-v1');if(dataset.manifest.readiness!=='reviewed')throw new Error('ENGINEERING original review unavailable');
      writeFileSync(join(datasets,'medclaw-agent-v1/snapshot.json'),JSON.stringify(dataset.snapshot));
      const config=runConfigFixture();config.model.url=${JSON.stringify(endpoint)};config.model.key=${JSON.stringify(agentKey)};
      writeFileSync(join(configs,'agent.json'),JSON.stringify(config));
      writeFileSync(join(configs,'environment'),${JSON.stringify('MEDCLAW_JUDGE_BASE_URL=' + base + '/judge/v1\nMEDCLAW_JUDGE_MODEL=openai/gpt-4o-mini\nMEDCLAW_JUDGE_API_KEY=' + judgeKey + '\n')});
      const report=reportFixture(),archive=join(runs,'business',report.executionId),trial=report.plan[0];await saveReportFixture(archive,report);
      const feedback={contract:'medclaw-human-feedback/v1',source:'local',sourceId:'packaged-original-feedback',reviewer:'ENGINEERING package reviewer',
        reviewedAt:'2026-10-17T00:00:00.000Z',executionId:report.executionId,caseId:trial.caseId,trialId:trial.trialId,status:'UNJUDGEABLE',
        comment:${JSON.stringify('ENGINEERING archived feedback ' + agentKey + ' ' + judgeKey)},evidenceRefs:[]};
      const receipt=await recordFeedback(archive,feedback);writeFileSync(${JSON.stringify(packet)},JSON.stringify({executionId:report.executionId,feedbackId:receipt.id}));
    `);
    execFileSync(bunExecutable, ['--no-env-file', prepare], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const prepared = JSON.parse(readFileSync(packet, 'utf8')) as { executionId: string; feedbackId: string };
    const archive = join(runs, 'business', prepared.executionId), originals = ['report.json', 'snapshot.json', 'review.json'].map(name => readFileSync(join(archive, name)));
    const configBytes = readFileSync(join(configs, 'agent.json')), datasetBytes = readFileSync(join(datasets, 'medclaw-agent-v1/snapshot.json'));
    const contents = readdirSync(application, { recursive: true }).sort();
    expect(existsSync(join(runtime, 'agent-eval/src/datasets'))).toBe(false);
    originalAcl = acl('read'); acl('deny');
    expect(() => writeFileSync(join(application, 'ENGINEERING-write-probe'), 'must be denied')).toThrow(/EACCES|EPERM/);
    expect(() => appendFileSync(join(runtime, 'agent-eval/src/doctor.ts'), 'ENGINEERING must be denied')).toThrow(/EACCES|EPERM/);
    const running = await launchPackagedDesktop(root, profile, { kind: 'unpacked', executable: join(application, 'MedClaw.exe') }); desktop = running;
    const page = running.page;
    await expect(page.getByText('Host ready', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    const processQuery = String.raw`
      $ErrorActionPreference = 'Stop'
      [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
      $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
      @{items=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + [int]$request.pid) |
        Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)} | ConvertTo-Json -Depth 3 -Compress
    `;
    const processes = (JSON.parse(execFileSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(processQuery, 'utf16le').toString('base64')],
      { input: JSON.stringify({ pid: running.pid }), encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15000 })) as
      { items: { ProcessId: number; ParentProcessId: number; ExecutablePath: string; CommandLine: string }[] }).items;
    for (const entry of ['agent-eval/src/desktop/controller.ts', 'apps/host/src/main.ts']) {
      const selected = processes.filter(row => row.CommandLine?.includes(join(runtime, entry)));
      expect(selected).toHaveLength(1); expect(selected[0]!.ParentProcessId).toBe(running.pid);
      expect(realpathSync(selected[0]!.ExecutablePath)).toBe(realpathSync(join(application, 'resources/medclaw/bin/bun.exe')));
    }
    const options = { datasetId: 'medclaw-agent-v1' as const, selection: 'smoke' as const, trials: 1 };
    const check = () => page.evaluate(input => window.medclaw.request('eval.preflight', input), options);
    const ready = await check();
    expect(ready).toMatchObject({ ok: true, data: { readiness: 'reviewed', cases: 10, plannedTrials: 10, trials: 1, blockers: [],
      config: { type: 'object', redacted: false, truncated: false } } });
    if (!ready.ok || !ready.data.config) throw new Error('ENGINEERING packaged configuration summary missing');
    expect(JSON.parse(ready.data.config.text!)).toMatchObject({ agent: 'gpt-4o-mini', endpoint, intent: 'qwen3.5:0.8b', judge: 'openai/gpt-4o-mini' });
    const reports = await page.evaluate(() => window.medclaw.request('eval.report.list', { page: 1, pageSize: 10 }));
    const feedback = await page.evaluate(id => window.medclaw.request('eval.report.read', { executionId: id, section: 'feedback', page: 1, pageSize: 10 }), prepared.executionId);
    expect(reports).toMatchObject({ ok: true, data: { total: 1, items: [{ executionId: prepared.executionId, archiveState: 'complete' }] } });
    expect(feedback).toMatchObject({ ok: true, data: { total: 1, items: [{ id: prepared.feedbackId, status: 'UNJUDGEABLE', reviewer: 'ENGINEERING package reviewer' }] } });
    expect(JSON.stringify({ ready, reports, feedback })).not.toContain(agentKey); expect(JSON.stringify(feedback)).not.toContain(judgeKey);
    writeFileSync(join(configs, 'agent.json'), '{');
    expect(await check()).toMatchObject({ ok: true, data: { cases: 10, plannedTrials: 10, config: null, blockers: [{ code: 'evaluation_config_unavailable' }] } });
    writeFileSync(join(configs, 'agent.json'), configBytes); expect(await check()).toMatchObject({ ok: true, data: { blockers: [] } });
    writeFileSync(join(datasets, 'medclaw-agent-v1/snapshot.json'), '{');
    expect(await check()).toMatchObject({ ok: true, data: { readiness: 'materials_unavailable', cases: 0, blockers: [{ code: 'evaluation_dataset_invalid' }] } });
    writeFileSync(join(datasets, 'medclaw-agent-v1/snapshot.json'), datasetBytes); expect(await check()).toMatchObject({ ok: true, data: { readiness: 'reviewed', blockers: [] } });
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evaluation', level: 1, exact: true })).toBeVisible();
    await page.getByRole('region', { name: 'Evaluation reports', exact: true }).locator('summary').filter({ hasText: /^Report identity$/ }).click();
    await expect(page.getByText(prepared.executionId, { exact: true }).first()).toBeVisible();
    await info.attach('p17-unpacked-evaluation-paths.json', { body: JSON.stringify({ origin: running.origin, executable: running.executable, profile, configs, runs, datasets, runtime, processes, ready, reports, feedback }), contentType: 'application/json' });
    expect(['report.json', 'snapshot.json', 'review.json'].map(name => readFileSync(join(archive, name)))).toEqual(originals);
    expect(readdirSync(join(runs, 'business'))).toEqual([prepared.executionId]);
    expect(existsSync(join(runs, 'business/.active-execution.json'))).toBe(false);
    expect(readStartupFacts(profile)).toMatchObject({ runs: 0, calls: 0 }); expect(requests).toEqual([]);
    await running.close(); desktop = undefined; stopped = true;
    expect(requests).toEqual([]); expect(readdirSync(application, { recursive: true }).sort()).toEqual(contents);
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    try { if (desktop) { await desktop.close(); stopped = true; } } catch (error) { errors.push(error); }
    try { if (originalAcl !== undefined) expect(acl('restore', originalAcl)).toBe(originalAcl); } catch (error) { errors.push(error); }
    await new Promise<void>(resolve => listener.close(() => resolve()));
    if (failure || errors.length || !stopped) console.error('P17_PACKAGED_EVALUATION_ROOT_RETAINED ' + root);
    else {
      const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
      if (target !== root || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part) || !existsSync(join(root, 'packaged-tree-stopped'))) throw new Error('ENGINEERING packaged evaluation cleanup refused');
      rmSync(target, { recursive: true, force: true });
    }
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'ENGINEERING packaged evaluation cleanup failed');
  }
});
