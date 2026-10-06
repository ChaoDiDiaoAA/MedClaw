import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, parseSkillBlock, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { discoverTests, runStage } from '../run';

test('p11 runner discovers real cases and never passes an empty or broken test module', async () => {
  expect(discoverTests('unit', 'P11')).toContain(join(import.meta.dir, 'p11-sdk.test.ts'));
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-runner-'));
  try {
    expect(await runStage('unit', 'P11', { root })).toMatchObject({ discoveredFiles: 0, executed: 0, exitCode: 1 });
    mkdirSync(join(root, 'tests/unit'), { recursive: true });
    writeFileSync(join(root, 'tests/unit/p11-broken.test.ts'), "throw new Error('ENGINEERING module load failed');\n");
    expect(await runStage('unit', 'P11', { root })).toMatchObject({ discoveredFiles: 1, pass: 0, exitCode: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('p11 public SDK keeps custom constraints and selected indexes while excluding default resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p11-sdk-'));
  const file = (relative: string, content: string) => {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  const skill = file('managed/query/SKILL.md', '---\nname: query\ndescription: ENGINEERING fact checking\n---\nSKILL_BODY_MARKER\n');
  const hidden = file('managed/hidden/SKILL.md', '---\nname: hidden\ndescription: ENGINEERING explicit only\ndisable-model-invocation: true\n---\nHIDDEN_BODY_MARKER\n');
  const prompt = file('managed/prompts/query.md', '---\ndescription: ENGINEERING query\n---\nQUERY_TEMPLATE $ARGUMENTS\n');
  file('.pi/skills/unselected/SKILL.md', '---\nname: unselected\ndescription: MUST_NOT_LOAD\n---\nUNSELECTED_BODY\n');
  file('.pi/prompts/unselected.md', 'MUST_NOT_LOAD $ARGUMENTS');
  file('agent/skills/global/SKILL.md', '---\nname: global\ndescription: MUST_NOT_LOAD\n---\nGLOBAL_BODY\n');
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: [skill, hidden], additionalPromptTemplatePaths: [prompt], extensionFactories: [], systemPrompt: 'MEDCLAW_FIXED_CONSTRAINT' });
  const runtime = await ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key' as const, key: 'ENGINEERING-NONSECRET' }),
    list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsStore: { read: async () => undefined, write: async () => {}, delete: async () => {} },
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = { id: 'p11-sdk', name: 'ENGINEERING', provider: 'openai', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1',
    reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 128 };
  const manager = SessionManager.inMemory(root);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let calls = 0;
  const requests: string[][] = [];
  const done = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ENGINEERING_OK' }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: 'stop', message }); return stream;
  };
  const userTexts = () => manager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'user'
    ? [typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')] : []);
  try {
    await loader.reload();
    expect(loader.getSkills().skills.map(s => s.name).sort()).toEqual(['hidden', 'query']);
    expect(loader.getPrompts().prompts.map(p => p.name)).toEqual(['query']);
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: runtime, model,
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: ['read'], customTools: [], thinkingLevel: 'off' }));
    session.agent.streamFunction = (_model, context) => {
      calls++; requests.push(context.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n'))); return done();
    };
    expect(session.systemPrompt).toContain('MEDCLAW_FIXED_CONSTRAINT');
    expect(session.systemPrompt).toContain('<name>query</name>');
    expect(session.systemPrompt).not.toContain('<name>hidden</name>');
    expect(session.systemPrompt).not.toContain('SKILL_BODY_MARKER');
    expect(session.systemPrompt).not.toContain('MUST_NOT_LOAD');
    await session.prompt('/query "浙江 二类" hello', { expandPromptTemplates: true }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe('QUERY_TEMPLATE 浙江 二类 hello');
    const raw = '原文 "浙江 二类" C:\\case\n第二行 $1';
    const quoted = raw.split('"').map(part => '"' + part + '"').join("'\"'");
    await session.prompt('/query ' + quoted, { expandPromptTemplates: true }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe('QUERY_TEMPLATE ' + raw);
    await session.prompt('/skill:query check facts', { expandPromptTemplates: true }); await session.waitForIdle();
    expect(parseSkillBlock(userTexts().at(-1)!)).toMatchObject({ name: 'query', location: skill, content: expect.stringContaining('SKILL_BODY_MARKER') });
    await session.prompt('/skill:hidden force', { expandPromptTemplates: true }); await session.waitForIdle();
    expect(parseSkillBlock(userTexts().at(-1)!)).toMatchObject({ name: 'hidden', content: expect.stringContaining('HIDDEN_BODY_MARKER') });
    await session.prompt('/query literal', { expandPromptTemplates: false }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe('/query literal');
    // Native command arguments trim whitespace and do not implement shell backslash escaping.
    await session.prompt('/query "tail\n"', { expandPromptTemplates: true }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe('QUERY_TEMPLATE tail\n');
    await session.prompt('/query tail\n', { expandPromptTemplates: true }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe('QUERY_TEMPLATE tail');
    await session.prompt(String.raw`/query "a\"b"`, { expandPromptTemplates: true }); await session.waitForIdle();
    expect(userTexts().at(-1)).toBe(String.raw`QUERY_TEMPLATE a\b`);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); let first = true;
    session.agent.streamFunction = () => {
      calls++;
      if (!first) return done();
      first = false; const stream = createAssistantMessageEventStream(); entered();
      release = () => { void (async () => { for await (const event of done()) stream.push(event); })(); }; return stream;
    };
    const running = session.prompt('queue origin', { expandPromptTemplates: false }); await started;
    await session.steer('/skill:query steered'); await session.followUp('/query "later task" tail'); release();
    await running; await session.waitForIdle();
    expect(userTexts().some(t => t.includes('SKILL_BODY_MARKER') && t.includes('steered'))).toBe(true);
    expect(userTexts()).toContain('QUERY_TEMPLATE later task tail');
    expect(requests[1]?.at(-1)).toBe('QUERY_TEMPLATE ' + raw);
    expect(calls).toBe(11); expect(userTexts()).toHaveLength(11);
  } finally {
    if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    rmSync(root, { recursive: true, force: true });
  }
});
