import { safeError, type AppError } from '../../contracts/src/error';

const phases = ['hello', 'sdk_version', 'writer_lock', 'settings_read', 'database_open', 'pi_runtime', 'custom_registration', 'ready'] as const;
export type HostStartupFailure = { phase: typeof phases[number]; error: AppError };

export function parseHostStartupFailure(line: string): HostStartupFailure | null {
  const match = /^MedClaw Host terminated: ([a-z_]+)\/([a-z_]+)\.$/.exec(line);
  if (!match || match[0].length !== line.length || !phases.includes(match[1] as typeof phases[number])) return null;
  const error = safeError(match[2]!);
  return error.code === match[2] ? { phase: match[1] as typeof phases[number], error } : null;
}

// Keep at most one short line while decoding the private child stream. Only the
// validated fixed phase/code reaches diagnostics; discarded bytes are never logged.
export class HostStartupFailureReader {
  private line = '';
  private discarded = false;
  push(chunk: Buffer, receive: (failure: HostStartupFailure) => void) {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!this.discarded) {
          const failure = parseHostStartupFailure(this.line.replace(/\r$/, ''));
          if (failure) receive(failure);
        }
        this.line = ''; this.discarded = false;
      } else if (!this.discarded) {
        if (byte > 127 || this.line.length >= 256) { this.line = ''; this.discarded = true; }
        else this.line += String.fromCharCode(byte);
      }
    }
  }
}
