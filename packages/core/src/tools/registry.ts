import { ToolExecutionModeSchema, type AnyToolDefinition } from "@medclaw/contracts/tool";

/** Definitions are assembled once; execution and scheduling belong to Executor and Pi. */
export class ToolRegistry {
  readonly definitions: readonly AnyToolDefinition[];
  private readonly byName: Map<string, AnyToolDefinition>;
  constructor(definitions: readonly AnyToolDefinition[]) {
    this.byName = new Map();
    for (const definition of definitions) {
      const managedAgent=definition.name==='Agent'&&definition.version==='0.19.0'&&definition.effect==='READ';
      if ((!/^[a-z][a-z0-9_]*$/.test(definition.name)&&!managedAgent) || !/^\d+\.\d+\.\d+$/.test(definition.version)
        || !definition.label.trim() || !definition.description.trim() || !["PURE", "READ", "LOCAL_WRITE"].includes(definition.effect)
        || !ToolExecutionModeSchema.safeParse(definition.executionMode).success || this.byName.has(definition.name)) throw new Error("invalid_argument");
      this.byName.set(definition.name, Object.freeze({ ...definition }));
    }
    this.definitions = Object.freeze([...this.byName.values()]);
  }
  get(name: string): AnyToolDefinition | undefined { return this.byName.get(name); }
}
