import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OpaqueIdSchema, errorMessage, safeError, type AppError, type Result } from '@medclaw/contracts/error';
import { HostViewSchema } from '@medclaw/contracts/model';
import { HOST_PROTOCOL_VERSION, DesktopMethodSchema, desktopMethodSchemas, type DesktopPayload } from '@medclaw/contracts/protocol';
import { composeDiagnostics } from '../../../../packages/logging/src/diagnostics';
import { ErrorLog } from '../../../../packages/logging/src/error-log';

/** No business root has been established, so this window cannot start or repair a writer. */
export function openBootstrapFailure(input: { shell: { preloadEntry: string; rendererEntry: string }; profileRoot: string; error: AppError }): void {
  if (!isAbsolute(input.profileRoot)) throw new Error('access_denied');
  if (!app.hasSingleInstanceLock()) {
    app.setPath('userData', realpathSync(input.profileRoot));
    if (!app.requestSingleInstanceLock()) { app.exit(1); return; }
  }
  const failure = safeError(input.error.code, undefined, { reason: 'desktop_bootstrap_failed' });
  const host = HostViewSchema.parse({ instanceId: null, state: 'failed', canStart: false, sdkVersion: null, schemaVersion: null, error: failure });
  const errors = new ErrorLog('main'); errors.add(failure);
  let window: BrowserWindow | null = null;
  const fail = () => { try { dialog.showErrorBox('MedClaw', errorMessage(failure)); } finally { app.exit(1); } };
  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    if (!window || window.isDestroyed() || event.sender.isDestroyed()) return false;
    const contents = window.webContents;
    return !contents.isDestroyed() && event.sender.id === contents.id && event.senderFrame === event.sender.mainFrame;
  };
  void app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1100, minHeight: 720, backgroundColor: '#F5F6F8', title: 'MedClaw',
      webPreferences: { preload: input.shell.preloadEntry, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('preload-error', fail);
    window.webContents.on('render-process-gone', fail);
    ipcMain.handle('medclaw:request', (event, raw: unknown): Result<unknown> => {
      let operationRef: string | undefined;
      try {
        if (!trusted(event)) throw new Error('access_denied');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['method', 'payload', 'operationRef'].includes(key))) throw new Error('invalid_argument');
        const envelope = raw as { method: unknown; payload: unknown; operationRef?: unknown };
        const method = DesktopMethodSchema.parse(envelope.method);
        operationRef = OpaqueIdSchema.parse(envelope.operationRef ?? crypto.randomUUID());
        const payload = desktopMethodSchemas[method].input.parse(envelope.payload);
        if (method === 'host.read') return { ok: true, data: structuredClone(host) };
        if (method === 'diagnostics.read') {
          const { categories } = payload as DesktopPayload<'diagnostics.read'>;
          return { ok: true, data: composeDiagnostics({ host, hostAvailable: false, mainEntries: errors.read(), categories,
            versions: { sdkVersion: '0.87.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: null, configVersion: null,
              bunVersion: null, electronVersion: process.versions.electron } }) };
        }
        return { ok: false, error: { ...failure, operationRef } };
      } catch (error) { return { ok: false, error: safeError(error instanceof Error && error.name === 'ZodError' ? 'invalid_argument'
        : error instanceof Error ? error.message : 'internal_error', error, { operationRef }) }; }
    });
    ipcMain.on('medclaw:subscribe', event => { if (trusted(event)) event.sender.send('medclaw:notice', { type: 'host.status', instanceId: null, host: structuredClone(host) }); });
    await window.loadFile(input.shell.rendererEntry);
  }).catch(fail);
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => app.exit(1));
}
