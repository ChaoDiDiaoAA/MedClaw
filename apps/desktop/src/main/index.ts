import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { HostController } from "./host-controller.ts";
import { EvaluationController } from './evaluation-controller';
import { MainCredentials, SecretInputs } from "./credentials.ts";
import { MainSettings } from "./settings.ts";
import { FileTokens } from "./file-tokens.ts";
import { DestinationTokens } from './destination-tokens';
import { privateCredentialRequest, registerIpc } from "./ipc-handlers.ts";
import { errorMessage, safeError, type Result } from "../../../../packages/contracts/src/error.ts";
import { HOST_PROTOCOL_VERSION, type DesktopNotice, type DiagnosticsView } from "../../../../packages/contracts/src/protocol.ts";
import { ErrorLog } from "../../../../packages/logging/src/error-log.ts";
import { RuntimeLog } from "../../../../packages/logging/src/runtime-log.ts";
import { composeDiagnostics } from "../../../../packages/logging/src/diagnostics.ts";
import { resolveDesktopShellPaths, resolveRuntimePaths } from './runtime-paths';
import { openBootstrapFailure } from './bootstrap-failure';
import { MaintenanceController } from './maintenance-controller';
import { LaunchSelectionSchema } from '@medclaw/contracts/maintenance';

app.setName("MedClaw");
// Electron resolves the application directory even when launchers prepend Node flags.
const desktopEntryDir = app.getAppPath();
const overrideIndex = process.argv.indexOf("--medclaw-data-root");
const explicitRoot = app.isPackaged || overrideIndex < 0 ? null : process.argv[overrideIndex + 1];
const selectionRoot = explicitRoot ?? app.getPath('userData');
function startDesktop(): void {
  if (!app.isPackaged && overrideIndex >= 0 && (!explicitRoot || !isAbsolute(explicitRoot))) throw new Error("Engineering data root must be absolute");
  const launchPaths = resolveRuntimePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
    appPath: desktopEntryDir, defaultUserData: app.getPath('userData'), engineeringOverrides: {
      ...(explicitRoot ? { dataRoot: explicitRoot } : {}), hostEntry: process.env.MEDCLAW_HOST_ENTRY, bunExecutable: process.env.MEDCLAW_BUN_EXECUTABLE,
      sourceRoot: process.env.MEDCLAW_EVALUATION_SOURCE_ROOT, configsRoot: process.env.MEDCLAW_EVALUATION_CONFIGS_ROOT, runsRoot: process.env.MEDCLAW_EVALUATION_RUNS_ROOT } });
  app.setPath('userData', launchPaths.dataRoot);
  if (!app.requestSingleInstanceLock()) app.exit(0);
  let window: BrowserWindow | null = null, shuttingDown = false;
  let lastPreview: (DesktopNotice & { instanceId: string | null }) | null = null;
  const errors = new ErrorLog("main"), runtimeLog = new RuntimeLog("main");
  let ipc: ReturnType<typeof registerIpc> | null = null;
  const dataRoot = launchPaths.dataRoot;
  mkdirSync(join(dataRoot, "data"), { recursive: true }); mkdirSync(join(dataRoot, "runtime"), { recursive: true });
  const credentials = new MainCredentials(join(dataRoot, "data", "credentials.enc.json"), safeStorage);
  const fileTokens = new FileTokens();
  const destinations = new DestinationTokens(dataRoot, Date.now, async (instanceId, input) => {
    unwrap(await host.request('export.copy.verify', input, input.operationRef, undefined, instanceId));
  });
  const notify = (notice: DesktopNotice) => {
    if ((notice.type === 'event.available' || notice.type === 'event.stream') && !ipc?.acceptEventNotice(notice, host.read().instanceId)) return;
    const frame = { ...notice, instanceId: notice.type.startsWith('eval.') ? null : host.read().instanceId };
    if (notice.type === "provider.preview") lastPreview = frame;
    if (notice.type === "provider.settled" || notice.type === "provider.persistence_failed") lastPreview = null;
    if (notice.type === "host.status" && notice.host.state !== "ready") lastPreview = null;
    if (window && !window.isDestroyed()) window.webContents.send("medclaw:notice", frame);
  };
  const host = new HostController({ dataRoot, hostEntry: launchPaths.hostEntry, bunExecutable: launchPaths.bunExecutable,
    resourceRoot: launchPaths.resourceRoot, installManifestPath: launchPaths.installManifestPath,
    maintenanceEntry: launchPaths.maintenanceEntry,
    onStarting: instanceId => { credentials.attachInstance(instanceId); destinations.retainInstance(instanceId); },
    onExit: instanceId => { ipc?.closeInstance(instanceId); credentials.confirmHostExit(instanceId); destinations.retainInstance(null); },
    onCredentialRequest: frame => privateCredentialRequest(credentials, frame, fileTokens, window && !window.isDestroyed() ? window.id : undefined, destinations, maintenance),
    onError: error => errors.add(error),
    onStartupFailure: failure => runtimeLog.addHostStartupFailure(failure),
    onNotice: notice => {
      if (notice.type === 'host.status') {
        if (notice.host.state === 'handshaking') runtimeLog.add('host_handshake');
        else if (notice.host.state === 'ready') runtimeLog.add('host_ready');
        else if (notice.host.state === 'stopped') runtimeLog.add('host_stopped');
        else if (notice.host.state === 'failed') runtimeLog.add('host_failure');
      }
      notify(notice);
      if (notice.type === "auth.finished" && (notice.attempt.state === "completed" || notice.attempt.state === "sync_unknown")) void ipc?.publishCredentials().catch(error => errors.add(safeError(error instanceof Error ? error.message : "model_auth_sync_failed")));
    },
  });
  const evaluation = new EvaluationController({
    paths: launchPaths.evaluationPaths,
    workerEntry: join(launchPaths.runtimeRoot, 'agent-eval/src/desktop/controller.ts'), bunExecutable: launchPaths.bunExecutable,
    production: host, notify, report: error => errors.add(error),
    maintenanceBusy: () => maintenance.busy,
  });
  const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.code); return result.data; };
  const settings = new MainSettings(host.paths.settingsPath, {
    prepare: async (token, candidate) => unwrap(await host.request("settings.prepare", { token, candidate })),
    commit: async (token, publishedVersion) => unwrap(await host.request("settings.commit", { token, publishedVersion })),
    abort: async token => unwrap(await host.request("settings.abort", { token })),
    readVersion: async () => (unwrap(await host.request("model.read", {})) as { configVersion: string }).configVersion,
  });
  try { settings.read(); } catch (error) { errors.add(safeError(error instanceof Error ? error.message : 'config_read_failed', error)); }
  const maintenance = new MaintenanceController({ dataRoot, selectionRoot: realpathSync(selectionRoot), host, files: fileTokens,
    installManifestPath: launchPaths.installManifestPath, bunExecutable: launchPaths.bunExecutable, maintenanceEntry: launchPaths.maintenanceEntry,
    writesBusy: () => credentials.busy || destinations.busy || evaluation.admissionPending, appClosing: () => shuttingDown });
  async function diagnostics(categories: string[]): Promise<DiagnosticsView> {
    let source: DiagnosticsView | null = null;
    let configVersion: string | null = null;
    try { configVersion = settings.read().configVersion; } catch (error) { errors.add(safeError(error instanceof Error ? error.message : 'config_read_failed', error)); }
    if (host.read().state === "ready") {
      const response = await host.request("diagnostics.read", { categories });
      if (response.ok) source = response.data as DiagnosticsView;
    }
    return composeDiagnostics({ host: host.read(), versions: { sdkVersion: "0.87.1", protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: source?.versions.schemaVersion ?? null, configVersion, bunVersion: source?.versions.bunVersion ?? null, electronVersion: process.versions.electron }, dependencies: source?.dependencies, hostAvailable: source !== null, mainEntries: [...errors.read(), ...runtimeLog.read()], hostEntries: source?.entries, categories: categories as Parameters<typeof composeDiagnostics>[0]["categories"] });
  }
  const startupFailure = (stage: string) => { runtimeLog.add(stage); errors.add(safeError('host_start_failed')); };
  void app.whenReady().then(async () => {
    runtimeLog.add('desktop_startup');
    window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1100, minHeight: 720, backgroundColor: "#faf9f6", title: "MedClaw", webPreferences: { preload: launchPaths.preloadEntry, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on('preload-error', () => startupFailure('preload_failed'));
    window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) startupFailure('renderer_load_failed'); });
    window.webContents.on('render-process-gone', () => startupFailure('renderer_process_gone'));
    ipc = registerIpc({ window, host, evaluation, maintenance, settings, credentials, inputs: new SecretInputs(), fileTokens, destinations, diagnostics, report: error => errors.add(error), notify,
      onRestored: receipt => {
        try {
          const selection = LaunchSelectionSchema.parse(JSON.parse(readFileSync(join(selectionRoot, 'launch.json'), 'utf8')));
          if (selection.restoreOperationRef !== receipt.operationRef || selection.activeDataRoot === dataRoot) return;
          app.relaunch(); app.quit();
        } catch { errors.add(safeError('restore_failed', undefined, { operationRef: receipt.operationRef })); }
      } });
    void evaluation.initialize().then(() => {
      const control = evaluation.read(); notify({ type: 'eval.status', controllerInstanceId: control.controllerInstanceId, executionId: control.executionId, sequence: control.sequence, control });
    }).catch(() => errors.add(safeError('host_start_failed')));
    ipcMain.on("medclaw:subscribe", event => { if (window && event.sender.id === window.webContents.id && event.senderFrame === event.sender.mainFrame) {
      event.sender.send("medclaw:notice", { type: "host.status", host: host.read(), instanceId: host.read().instanceId });
      const control = evaluation.read();
      if (control.sequence > 0) event.sender.send('medclaw:notice', { type: 'eval.status', controllerInstanceId: control.controllerInstanceId, executionId: control.executionId, sequence: control.sequence, control, instanceId: null });
      if (lastPreview) event.sender.send("medclaw:notice", lastPreview);
    } });
    runtimeLog.add('renderer_load_start');
    try { await window.loadFile(launchPaths.rendererEntry); }
    catch { startupFailure('renderer_load_failed'); return; }
    runtimeLog.add('renderer_load_finished');
    runtimeLog.add("host_start");
    await host.start();
  }).catch(() => startupFailure('desktop_startup_failed'));
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      if (!(await maintenance.shutdown()).stopped) { errors.add(safeError('host_stop_unconfirmed')); shuttingDown = false; return; }
      const proof = await evaluation.shutdown();
      if (proof.stopConfirmed !== true || proof.saveConfirmed !== true || !proof.controllerExited) {
        errors.add(safeError('host_stop_unconfirmed')); shuttingDown = false; return;
      }
      const instanceId = host.read().instanceId;
      if (instanceId && !host.read().canStart) await host.stop(instanceId);
      await destinations.settlePrevious();
      if (!(await maintenance.shutdown()).stopped) { errors.add(safeError('host_stop_unconfirmed')); shuttingDown = false; return; }
      await host.refreshStopProof();
      const view = host.read(), saved = view.shutdown;
      if (view.canStart) {
        const clean = view.instanceId === null || view.state === 'stopped' && saved?.executionStopped === true && saved.requiredPersistenceComplete === true && saved.databaseClosed === true && saved.processExited && saved.processTreeStopped === true;
        if (!clean) errors.add(safeError('host_interrupted'));
        app.exit(clean ? 0 : 1);
      } else { errors.add(safeError('host_stop_unconfirmed')); shuttingDown = false; }
    })().catch(() => { errors.add(safeError('host_stop_unconfirmed')); shuttingDown = false; });
  });
}
try { startDesktop(); }
catch (error) {
  const failure = safeError(error instanceof Error ? error.message : "host_start_failed", error, { reason: "desktop_bootstrap_failed" });
  try { openBootstrapFailure({ shell: resolveDesktopShellPaths({ isPackaged: app.isPackaged, appPath: desktopEntryDir }),
    profileRoot: app.hasSingleInstanceLock() ? app.getPath("userData") : selectionRoot, error: failure }); }
  catch { try { dialog.showErrorBox("MedClaw", errorMessage(failure)); } finally { app.exit(1); } }
}
if (explicitRoot && process.env.MEDCLAW_DEV_CONTROL_TOKEN) {
  process.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && Object.keys(message).length === 2 && "token" in message && "command" in message && message.token === process.env.MEDCLAW_DEV_CONTROL_TOKEN && message.command === "quit") app.quit();
  });
  process.on("disconnect", () => app.quit());
}
