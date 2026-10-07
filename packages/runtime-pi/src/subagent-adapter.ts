// The precise-version patch owns this entry; the normal ambient extension is never loaded by the product.
export { createManagedAgentExtension } from '@tintinweb/pi-subagents/managed';
export type { ManagedAgentSessionBridge, ManagedAgentExtension } from '@tintinweb/pi-subagents/managed';
export const SUBAGENT_BUILD = Object.freeze({
  pluginVersion: '0.19.0' as const, pluginGitHead: '4f572eaa04c09d3dbc16e4a5f13a16b295e84e14' as const,
  pluginIntegrity: 'sha512-DZsU33Urfb9dhEsJmsmpx0dayIHMYUbxng6AA7B6+bIgspNcTckcSnQRsbrv+QCS7jVKYJTzHIT/j1SU2B/nVQ==',
  patchHash: '486f001d155a6ecb21bbd35b74a605d2114f292177942311ef970af056ad8f3f',
});
