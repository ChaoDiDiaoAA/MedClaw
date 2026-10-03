import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = count.min(1);

export const RUNTIME_CONFIG = Object.freeze({
  runBudget: {
    maxToolCalls: 24,
    maxModelCalls: 12,
    timeoutMs: 120000,
    singleToolTimeoutMs: 30000,
    maxRecoveryAttempts: 2,
  },
  llm: {
    maxRetries: 0 as const,
    maxRetryDelayMs: 2000,
  },
});

export const RunBudgetSchema = z.strictObject({
  maxToolCalls: positive,
  maxModelCalls: positive,
  timeoutMs: positive.min(1000),
  singleToolTimeoutMs: positive,
  maxRecoveryAttempts: count,
});
export const LlmRequestPolicySchema = z.strictObject({
  maxRetries: z.union([z.literal(0), z.literal(1)]),
  maxRetryDelayMs: positive.max(5000),
});
export const RuntimeConfigurationSchema = z.strictObject({
  runBudget: RunBudgetSchema,
  llm: LlmRequestPolicySchema,
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;
export type LlmRequestPolicy = z.infer<typeof LlmRequestPolicySchema>;
export type RuntimeConfiguration = z.infer<typeof RuntimeConfigurationSchema>;

export const RequestPolicySchema = LlmRequestPolicySchema.extend({
  timeoutMs: RunBudgetSchema.shape.timeoutMs,
});
export const AgentPolicySchema = RunBudgetSchema.omit({ timeoutMs: true }).extend({
  version: z.literal('medclaw.agent-policy/v1'),
});
export type RequestPolicy = z.infer<typeof RequestPolicySchema>;
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;

type ConfigurationPolicies = {
  runtimeConfiguration?: RuntimeConfiguration;
  requestPolicy?: RequestPolicy;
  agentPolicy?: AgentPolicy;
  toolConfiguration?: unknown;
};
const legacyRuntimeSchema = z.object({
  maxCalls: positive,
  maxModelCalls: positive,
  maxTimeoutMs: positive.min(1000),
  singleToolTimeoutMs: positive,
  maxRecoveryAttempts: count,
});

function suppliedBudgets(input: ConfigurationPolicies): Partial<RunBudget>[] {
  const candidates: Partial<RunBudget>[] = [];
  if (input.requestPolicy) candidates.push({
    timeoutMs: RequestPolicySchema.parse(input.requestPolicy).timeoutMs,
  });
  if (input.agentPolicy) {
    const { version: _version, ...budget } = AgentPolicySchema.parse(input.agentPolicy);
    candidates.push(budget);
  }
  if (input.toolConfiguration && typeof input.toolConfiguration === 'object' && 'runtime' in input.toolConfiguration) {
    const previous = legacyRuntimeSchema.parse(input.toolConfiguration.runtime);
    candidates.push({
      maxToolCalls: previous.maxCalls,
      maxModelCalls: previous.maxModelCalls,
      timeoutMs: previous.maxTimeoutMs,
      singleToolTimeoutMs: previous.singleToolTimeoutMs,
      maxRecoveryAttempts: previous.maxRecoveryAttempts,
    });
  }
  return candidates;
}

// Compare explicit old aliases before applying defaults.
export function normalizeRuntimeConfiguration(input: ConfigurationPolicies = {}): RuntimeConfiguration {
  const aliases = suppliedBudgets(input);
  const configuration = RuntimeConfigurationSchema.parse(input.runtimeConfiguration ?? {
    runBudget: Object.assign({}, RUNTIME_CONFIG.runBudget, ...aliases),
    llm: input.requestPolicy ? LlmRequestPolicySchema.parse({
      maxRetries: input.requestPolicy.maxRetries,
      maxRetryDelayMs: input.requestPolicy.maxRetryDelayMs,
    }) : RUNTIME_CONFIG.llm,
  });
  for (const budget of aliases) {
    for (const [field, value] of Object.entries(budget)) {
      if (configuration.runBudget[field as keyof RunBudget] !== value) throw new Error('Conflicting runtime configuration and policy');
    }
  }
  if (input.requestPolicy && (configuration.llm.maxRetries !== input.requestPolicy.maxRetries || configuration.llm.maxRetryDelayMs !== input.requestPolicy.maxRetryDelayMs)) {
    throw new Error('Conflicting runtime configuration and policy');
  }
  return configuration;
}

export function projectRuntimePolicies(configuration: RuntimeConfiguration) {
  const { timeoutMs, ...budget } = RuntimeConfigurationSchema.parse(configuration).runBudget;
  return {
    requestPolicy: {
      timeoutMs,
      ...configuration.llm,
    },
    agentPolicy: {
      version: 'medclaw.agent-policy/v1' as const,
      ...budget,
    },
  };
}

export function mergeRuntimeConfigurationPolicies(current: { runtimeConfiguration: RuntimeConfiguration }, patch: ConfigurationPolicies) {
  const runtimeConfiguration = normalizeRuntimeConfiguration({
    ...patch,
    runtimeConfiguration: patch.runtimeConfiguration ?? {
      runBudget: Object.assign({}, current.runtimeConfiguration.runBudget, ...suppliedBudgets(patch)),
      llm: patch.requestPolicy ? {
        maxRetries: patch.requestPolicy.maxRetries,
        maxRetryDelayMs: patch.requestPolicy.maxRetryDelayMs,
      } : current.runtimeConfiguration.llm,
    },
  });
  return {
    runtimeConfiguration,
    ...projectRuntimePolicies(runtimeConfiguration),
  };
}

const defaults = projectRuntimePolicies(RUNTIME_CONFIG);
export const DEFAULT_REQUEST_POLICY = Object.freeze(defaults.requestPolicy);
export const DEFAULT_AGENT_POLICY = Object.freeze(defaults.agentPolicy);
