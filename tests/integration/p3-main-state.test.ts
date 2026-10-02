import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';

test('Main directory token binds the selected root, window, Host, operation and expiration', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-token-'));
  try {
    const directory = join(root, 'original'); mkdirSync(directory);
    let now = 100;
    const tokens = new FileTokens(() => now, 1000), issued = tokens.issue(7, 'host', 'import-1', directory);
    expect(tokens.resolve(issued.fileToken, 7, 'host', 'import-1')).toBe(directory);
    expect(() => tokens.resolve(issued.fileToken, 8, 'host', 'import-1')).toThrow('file_token_invalid');
    expect(() => tokens.resolve(issued.fileToken, 7, 'other-host', 'import-1')).toThrow('file_token_invalid');
    expect(() => tokens.resolve(issued.fileToken, 7, 'host', 'import-2')).toThrow('file_token_invalid');
    renameSync(directory, join(root, 'moved')); mkdirSync(directory);
    expect(() => tokens.resolve(issued.fileToken, 7, 'host', 'import-1')).toThrow('file_token_invalid');
    const next = tokens.issue(7, 'host', 'import-2', directory); now = 1100;
    expect(() => tokens.resolve(next.fileToken, 7, 'host', 'import-2')).toThrow('file_token_invalid');
    const last = tokens.issue(7, 'host', 'import-3', directory); tokens.closeWindow(7);
    expect(() => tokens.resolve(last.fileToken, 7, 'host', 'import-3')).toThrow('file_token_invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
