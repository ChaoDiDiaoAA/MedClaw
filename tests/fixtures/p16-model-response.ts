import { record } from '../../agent-eval/src/scoring/rules';

// Both terminal and Electron tests use the actual SDK Responses route.
export function evaluationReply(path: string, body: unknown): { json: unknown } | { stream: string } {
  if (path === '/api/version') return { json: { version: 'ENGINEERING' } };
  if (path === '/api/tags') return { json: { models: [{ name: 'qwen3.5:0.8b' }] } };
  if (path === '/api/show') return { json: { details: { family: 'ENGINEERING', parameter_size: 'fixture', quantization_level: 'fixture' } } };
  if (path === '/api/chat') return { json: { model: 'qwen3.5:0.8b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify({ contract: 'medclaw.intent/v2', status: 'OUT_OF_SCOPE', intents: [], candidateIntents: [], clarification: null }) },
    prompt_eval_count: 12, eval_count: 4, total_duration: 1000000 } };
  if (!path.endsWith('/responses') || !record(body) || !Array.isArray(body.input)) throw new Error('Unexpected engineering model route');
  let text = 'Controlled engineering response; no business quality claim.';
  if (path.startsWith('/judge/')) {
    const content = body.input.filter(record).flatMap(item => typeof item.content === 'string' ? [item.content] : Array.isArray(item.content) ? item.content.filter(record).flatMap(part => typeof part.text === 'string' ? [part.text] : []) : []);
    const payload = content.map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => record(value) && Array.isArray(value.checks));
    if (!payload || !payload.checks.length) throw new Error('Missing engineering Judge checks');
    text = JSON.stringify({ results: payload.checks.map((check: Record<string, any>) => ({ checkId: check.checkId, value: null,
      reason: 'ENGINEERING: unknown business quality; no calibration claim.', evidenceRefs: check.evidenceRefs.slice(0, 1),
      ...(check.counted ? { numerator: null, denominator: check.counted.denominator ?? null } : {}) })) });
  }
  const readScope = !path.startsWith('/judge/') && Array.isArray(body.tools) && body.tools.some(tool => record(tool) && tool.name === 'read_data_scope')
    && !body.input.some(item => record(item) && item.type === 'function_call_output');
  const output = readScope ? [{ type: 'function_call', id: 'controlled-function', call_id: 'controlled-scope-read', name: 'read_data_scope', arguments: '{}' }]
    : [{ type: 'message', id: 'controlled-message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  const events: unknown[] = output.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]);
  events.push({ type: 'response.completed', response: { id: 'controlled-response', status: 'completed', output,
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return { stream: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') };
}
