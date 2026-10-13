import type { AnyToolDefinition } from '@medclaw/contracts/tool';
import { safeError } from '@medclaw/contracts/error';

export function createControlledToolFault(fault?: 'query-timeout-once') {
  let consumed = false;
  return (definitions: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] => fault === undefined ? definitions : definitions.map(tool => {
    if (tool.name !== 'query_current_devices' && tool.name !== 'query_intent_step') return tool;
    return { ...tool, execute: async (input, context) => {
      if (!consumed) { consumed = true; throw safeError('tool_timeout'); }
      return tool.execute(input, context);
    } };
  });
}
