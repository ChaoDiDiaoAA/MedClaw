import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadP13Managed, p13AgentInput, withP13Plugin } from '../fixtures/p13-subagent';

test('p13 exact plugin exposes an awaited managed factory without running its ambient default', async () => {
  expect(typeof await loadP13Managed()).toBe('function');
  await withP13Plugin(async (parent, trace) => {
    expect(parent.getActiveToolNames()).toEqual(['Agent']);
    expect(parent.getAllTools().map(tool => tool.name)).toEqual(['Agent']);
    await parent.prompt('ENGINEERING no delegation');
    expect(trace.parentRequests).toBe(1);
    expect(trace.ids).toEqual([]);
    expect(trace.children).toEqual([]);
    expect(trace.childRequests).toBe(0);
    expect(existsSync(join(trace.root, 'agent'))).toBe(false);
  }, { delegate: false });
});

test('p13 real parent Agent call awaits binding before child SDK request and returns original reply', async () => {
  const entered = Promise.withResolvers<void>(), bound = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    const execution = parent.prompt('ENGINEERING delegate');
    try {
      await entered.promise;
      expect(trace.children).toHaveLength(1);
      expect(trace.childRequests).toBe(0);
      expect(trace.children[0]!.sessionManager.getSessionId()).not.toBe(parent.sessionManager.getSessionId());
    } finally { bound.resolve(); }
    await execution;
    const record = await trace.extension.control.waitForSettled(trace.ids[0]!);
    expect(record.status).toBe('completed');
    expect(record.session).toBe(trace.children[0]);
    expect(record.result).toBe('ENGINEERING_CHILD_RESULT');
    expect(trace.childRequests).toBe(1);
    expect(trace.parentRequests).toBe(2);
    const reply = parent.messages.find(message => message.role === 'toolResult');
    expect(reply).toMatchObject({ role: 'toolResult', toolCallId: 'parent_1', toolName: 'Agent', isError: false });
    expect(JSON.stringify(reply)).toContain('ENGINEERING_CHILD_RESULT');
    expect(record.session!.sessionManager.getSessionFile()).toBeUndefined();
    await trace.extension.control.release(record.id);
  }, { beforeReturn: async () => { entered.resolve(); await bound.promise; } });
});

test('p13 next real delegation is refused until child release and then creates fresh plugin and SDK identities', async () => {
  await withP13Plugin(async (parent, trace) => {
    await parent.prompt('ENGINEERING first delegation');
    const firstId = trace.ids[0]!, first = await trace.extension.control.waitForSettled(firstId);
    await parent.prompt('ENGINEERING cannot reuse an unreleased child');
    expect(trace.children).toHaveLength(1);
    const rejected = parent.messages.filter(message => message.role === 'toolResult').at(-1);
    expect(rejected).toMatchObject({ isError: true });
    await trace.extension.control.release(firstId);
    await parent.prompt('ENGINEERING fresh delegation');
    expect(trace.children).toHaveLength(2);
    const second = await trace.extension.control.waitForSettled(trace.ids[1]!);
    expect(second.id).not.toBe(first.id);
    expect(second.session!.sessionManager.getSessionId()).not.toBe(first.session!.sessionManager.getSessionId());
    expect(trace.childRequests).toBe(2);
    await trace.extension.control.release(second.id);
  });
});

test('p13 cancellation does not treat plugin stopped as settled while the real factory is still pending', async () => {
  const entered = Promise.withResolvers<void>(), bound = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    const execution = parent.prompt('ENGINEERING cancellation');
    let settled = false;
    try {
      await entered.promise;
      trace.extension.control.cancel(trace.ids[0]!);
      const proof = trace.extension.control.waitForSettled(trace.ids[0]!).then(record => { settled = true; return record; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(trace.childRequests).toBe(0);
      bound.resolve();
      expect((await proof).status).toBe('stopped');
      await execution;
      expect(trace.childRequests).toBe(0);
      await trace.extension.control.release(trace.ids[0]!);
    } finally { bound.resolve(); await execution; }
  }, { beforeReturn: async () => { entered.resolve(); await bound.promise; } });
});

test('p13 child shutdown must finish before release allows a second real Agent call', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  await withP13Plugin(async (parent, trace) => {
    await parent.prompt('ENGINEERING first');
    const release = trace.extension.control.release(trace.ids[0]!);
    try {
      await entered.promise;
      await parent.prompt('ENGINEERING release still pending');
      expect(trace.children).toHaveLength(1);
      expect(parent.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({ isError: true });
    } finally { released.resolve(); await release; }
    await parent.prompt('ENGINEERING release confirmed');
    expect(trace.children).toHaveLength(2);
    await trace.extension.control.release(trace.ids[1]!);
  }, { childFactory: pi => { pi.on('session_shutdown', async () => { entered.resolve(); await released.promise; }); } });
});

test('p13 raw Agent input cannot enable background, model, cwd, recursion or user tool configuration', async () => {
  const overrides: Record<string, string | boolean | string[]>[] = [{ run_in_background: true }, { model: 'untrusted' }, { cwd: 'untrusted' }, { schedule: 'later' }, { subagent_type: 'Explore' }, { sub_tools: ['write'] }];
  for (const override of overrides) {
    await withP13Plugin(async (parent, trace) => {
      await parent.prompt('ENGINEERING reject override');
      expect(trace.children).toEqual([]);
      expect(trace.childRequests).toBe(0);
      expect(parent.messages.find(message => message.role === 'toolResult')).toMatchObject({ isError: true });
    }, { arguments: { ...p13AgentInput, ...override } });
  }
});

test('p13 a terminal child awaiting product save is not evicted by the upstream timed cleanup', async () => {
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = set(callback, delay, ...args);
    if (delay === 60000) timers.set(timer, () => callback(...args));
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); clear(timer); }) as typeof clearInterval;
  try {
    await withP13Plugin(async (parent, trace) => {
      await parent.prompt('ENGINEERING retained pending save');
      const first = await trace.extension.control.waitForSettled(trace.ids[0]!);
      first.completedAt = Date.now() - 11 * 60 * 1000;
      for (const callback of [...timers.values()]) callback();
      expect((await trace.extension.control.waitForSettled(first.id)).session).toBe(first.session);
      await trace.extension.control.release(first.id);
    });
  } finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
});
