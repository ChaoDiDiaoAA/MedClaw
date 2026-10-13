// ENGINEERING protocol fault fixture only; no Application, Provider, business query or model execution.
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { HostHelloSchema, HostReadySchema, HostRequestSchema, encodeHostFrame, type HostHello } from '../../../../packages/contracts/src/protocol.ts';

let hello: HostHello | undefined, buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const raw = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    if (!hello) {
      hello = HostHelloSchema.parse(raw);
      writeSync(1, `${JSON.stringify(HostReadySchema.parse({ protocolVersion: hello.protocolVersion, instanceId: hello.instanceId,
        sdkVersion: hello.sdkVersion, schemaVersion: hello.expectedSchemaVersion, configVersion: '1', dataRoot: hello.paths.dataRoot }))}\n`);
      continue;
    }
    const frame = HostRequestSchema.parse(raw);
    if (frame.method !== 'host.shutdown' || frame.instanceId !== hello.instanceId) throw new Error('ENGINEERING unexpected protocol request');
    const delay = JSON.parse(readFileSync(join(hello.paths.dataRoot, 'engineering-transport.json'), 'utf8')) as { ackDelayMs: number; exitDelayMs: number };
    setTimeout(() => {
      writeSync(1, encodeHostFrame({ protocolVersion: frame.protocolVersion, kind: 'reply', instanceId: frame.instanceId, requestId: frame.requestId,
        result: { ok: true, data: { executionStopped: true, databaseClosed: true } } }));
      setTimeout(() => process.exit(0), delay.exitDelayMs);
    }, delay.ackDelayMs);
  }
});
