import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ExtensionOwner, ExtensionRef, ExtensionStatus } from '../../../../packages/contracts/src/extensions';

/** First-party trusted host code. Each root Run owns this closure and its subscriptions. */
export function createToolAudit(owner: ExtensionOwner & { ref: ExtensionRef }) {
  let closed = false, seenToolCalls = 0, inputObservations = 0, contextObservations = 0, closing: Promise<void> | undefined;
  const subscriptions: Array<() => void> = [];
  const readStatus = (): ExtensionStatus => {
    if (closed) throw new Error('Extension is closed');
    return { ...owner, seenToolCalls, inputObservations, contextObservations };
  };
  const factory: ExtensionFactory = pi => {
    subscriptions.push(pi.on('session_start', () => { readStatus(); }));
    subscriptions.push(pi.on('input', () => { inputObservations++; }));
    subscriptions.push(pi.on('context', () => { contextObservations++; }));
    subscriptions.push(pi.on('tool_call', event => {
      seenToolCalls++;
      if (event.toolName === 'read_query_page' && typeof event.input.pageSize === 'number' && event.input.pageSize > 0) event.input.pageSize = Math.min(event.input.pageSize, 20);
    }));
    subscriptions.push(pi.on('tool_result', () => {}));
    subscriptions.push(pi.on('agent_start', () => {}));
    subscriptions.push(pi.on('agent_end', () => {}));
    pi.registerTool({ name: 'extension_runtime_status', label: 'Extension runtime status', description: 'Read the current Run extension identity and observed hook counters.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { const status = readStatus(); return { content: [{type:'text',text:JSON.stringify(status)}], details:status }; } });
    pi.registerCommand('extension_status', { description: 'Read the current Run extension status without sending a model request.', handler: async () => { readStatus(); } });
  };
  const close = () => closing ??= Promise.resolve().then(() => { closed = true; for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); });
  return { factory, readStatus, close };
}
