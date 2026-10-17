import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunExecutable, confirmedDevHostStop, electronTestWindowArgs, projectRoot } from './desktop-dev';
import { selectedDataRoot } from '../../apps/desktop/src/main/runtime-paths';

type PackagedOrigin = { kind: 'installed' | 'unpacked'; executable: string };
async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

// The outer test Job contains every Main/relaunch generation; product Host Jobs remain unchanged.
export async function launchPackagedDesktop(root: string, userData: string, origin: PackagedOrigin) {
  const executable = realpathSync(origin.executable), inspectorPort = await freePort(), browserPort = await freePort();
  const choices = join(root, 'dialog-choices.json'), helperEntry = join(root, 'packaged-owner.ts'), jobRecord = join(root, 'packaged-job.json');
  const jobModule = pathToFileURL(resolve(projectRoot, 'apps/host/src/windows-job.ts')).href;
  writeFileSync(choices, '[]');
  const args = ['--user-data-dir=' + userData, '--inspect=127.0.0.1:' + inspectorPort, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + browserPort, ...electronTestWindowArgs];
  writeFileSync(helperEntry, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';
    import{createHostJob}from ${JSON.stringify(jobModule)};
    const owner={instanceId:randomUUID(),startupToken:randomUUID()},job=createHostJob(owner);
    writeFileSync(${JSON.stringify(jobRecord)},JSON.stringify({owner,domain:job.domain,pid:process.pid}));
    const child=spawn(${JSON.stringify(executable)},${JSON.stringify(args)},{env:process.env,windowsHide:true,stdio:['ignore','inherit','inherit']});
    child.on('error',()=>{console.error('PACKAGED_MAIN_SPAWN_FAILED');process.exit(1);});
    process.stdin.setEncoding('utf8');process.stdin.once('data',async()=>{
      const deadline=Date.now()+20000;while(job.readActiveProcesses()!==1&&Date.now()<deadline)await Bun.sleep(50);
      if(job.readActiveProcesses()!==1){console.error('PACKAGED_PROCESS_TREE_UNCONFIRMED');return;}
      writeFileSync(${JSON.stringify(join(root, 'packaged-tree-stopped'))},'confirmed');process.exit(0);
    });`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|CREDENTIAL|AWS_|AZURE_|GOOGLE_|^MEDCLAW_)/i.test(name)) delete env[name];
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  const helper = spawn(bunExecutable, ['--no-env-file', helperEntry], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let outputChars = 0;
  const collect = (data: Buffer) => { outputChars += data.length; };
  helper.stdout.on('data', collect); helper.stderr.on('data', data => {
    collect(data);
    const inspector = data.toString().match(/(?:Debugger listening on ws:\/\/127\.0\.0\.1:\d+\/[^\s]+|Starting inspector on 127\.0\.0\.1:\d+ failed:[^\r\n]+)/g);
    if (inspector) console.log('P17_PACKAGED_INSPECTOR ' + inspector.join(' '));
  });
  const exited = new Promise<void>((resolve, reject) => { helper.once('close', () => resolve()); helper.once('error', reject); });
  void exited.catch(() => {});
  const browsers: Browser[] = [], generations = new Set<number>(); let page: Page | undefined, closed = false;
  async function evaluateMain<T>(expression: string): Promise<T> {
    const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json() as { webSocketDebuggerUrl?: string }[];
    const url = targets[0]?.webSocketDebuggerUrl;
    if (!url) throw new Error('ENGINEERING Main inspector unavailable');
    return new Promise<T>((resolve, reject) => {
      const socket = new WebSocket(url);
      const done = (error?: Error, value?: T) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value!); };
      const timer = setTimeout(() => done(new Error('ENGINEERING Main observation timeout')), 10000);
      socket.addEventListener('error', () => done(new Error('ENGINEERING Main observer disconnected')), { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })), { once: true });
      socket.addEventListener('message', event => {
        const reply = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: { exceptionDetails?: unknown; result?: { value?: T } } };
        if (reply.id === 1) reply.error || reply.result?.exceptionDetails ? done(new Error('ENGINEERING Main observation rejected')) : done(undefined, reply.result?.result?.value);
      });
    });
  }
  const electron = `process.getBuiltinModule('module').createRequire(process.execPath)('electron')`;
  async function acquire(previousPid?: number) {
    const deadline = Date.now() + 45000; let lastFailure: unknown;
    while (Date.now() < deadline && helper.exitCode === null) {
      try {
        const current = await evaluateMain<{ pid: number; userData: string; executable: string; isPackaged: boolean; ready: boolean }>(`({pid:process.pid,userData:${electron}.app.getPath('userData'),executable:process.execPath,isPackaged:${electron}.app.isPackaged,ready:${electron}.app.isReady()})`);
        generations.add(current.pid);
        if (realpathSync(current.executable) !== executable || !current.isPackaged) throw new Error('ENGINEERING packaged identity or profile mismatch');
        if (current.pid === previousPid || !current.ready) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
        if (realpathSync(current.userData) !== realpathSync(selectedDataRoot(userData))) throw new Error('ENGINEERING packaged identity or profile mismatch');
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`, { timeout: 1000 }); browsers.push(browser);
        const context = browser.contexts()[0]!; page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10000 });
        await page.waitForLoadState('domcontentloaded');
        await evaluateMain(`(()=>{const fs=process.getBuiltinModule('fs');${electron}.dialog.showOpenDialog=async()=>{
          const paths=JSON.parse(fs.readFileSync(${JSON.stringify(choices)},'utf8')),path=paths.shift();fs.writeFileSync(${JSON.stringify(choices)},JSON.stringify(paths));return{canceled:!path,filePaths:path?[path]:[]};};return true;})()`);
        return { page, pid: current.pid };
      } catch (error) {
        if (error instanceof Error && error.message.includes('identity or profile mismatch')) throw error;
        lastFailure = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw new Error(`ENGINEERING packaged desktop acquisition failed (origin=${origin.kind}, outputChars=${outputChars}, observation=${lastFailure instanceof Error ? lastFailure.message : 'unknown'})`);
  }
  async function close() {
    if (closed) return;
    try {
      await evaluateMain(`(()=>{${electron}.app.quit();return true;})()`).catch(() => {});
      helper.stdin.write('confirm stopped\n');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ENGINEERING packaged tree stop timeout')), 25000); })]); }
      finally { clearTimeout(timer); }
      if (helper.exitCode !== 0 || !existsSync(join(root, 'packaged-tree-stopped')) || !confirmedDevHostStop(userData)) throw new Error('ENGINEERING packaged stop unconfirmed');
      closed = true;
      await Promise.all(browsers.map(browser => browser.close()));
    } catch (error) {
      // Kill only the captured test owner; its Job contains its own descendants. Retain all roots on failure.
      if (helper.exitCode === null) { helper.kill('SIGKILL'); await exited; }
      console.error('P17_PACKAGED_ROOT_RETAINED ' + JSON.stringify({ root, origin: origin.kind, generations: [...generations] }));
      throw error;
    }
  }
  try {
    const initial = await acquire();
    return { ...initial, origin, executable, generations, choose: (paths: string[]) => writeFileSync(choices, JSON.stringify(paths)), relaunched: (oldPid: number) => acquire(oldPid),
      // Native content dimensions are invalid while this test-owned window is minimized or hidden.
      display: (width: number, height: number, zoom: number) => evaluateMain<{ size: number[]; content: number[]; minimum: number[]; scale: number; zoom: number; bounds: {x:number;y:number;width:number;height:number}; workArea: {x:number;y:number;width:number;height:number}; visible:boolean; minimized:boolean; maximized:boolean }>(`(()=>{const electron=${electron},window=electron.BrowserWindow.getAllWindows()[0],display=electron.screen.getDisplayMatching(window.getBounds());if(window.isMinimized())window.restore();window.show();window.setSize(${width},${height});window.webContents.setZoomFactor(${zoom});const bounds=window.getBounds();return{size:window.getSize(),content:window.getContentSize(),minimum:window.getMinimumSize(),scale:display.scaleFactor,zoom:window.webContents.getZoomFactor(),bounds,workArea:display.workArea,visible:window.isVisible(),minimized:window.isMinimized(),maximized:window.isMaximized()};})()`), close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'ENGINEERING packaged acquisition and cleanup failed'); }
    throw error;
  }
}
