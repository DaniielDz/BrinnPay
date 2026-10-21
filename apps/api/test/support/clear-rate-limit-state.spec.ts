import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Phase 17 security review F4: the rate-limit flush script may only ever touch
 * a loopback Redis. The guard is the whole point of the script's contract with
 * `playwright.config.ts`, so it is asserted here (unit layer, no database):
 * a non-loopback `REDIS_URL` — or an unusable one — must be refused with a
 * non-zero exit **before** any connection or deletion happens.
 */
const SCRIPT = path.resolve(__dirname, '../../scripts/clear-rate-limit-state.mjs');

function runScript(redisUrl: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, REDIS_URL: redisUrl },
    timeout: 20_000,
  });
}

describe('clear-rate-limit-state guard (phase 17 F4)', () => {
  it('refuses a non-loopback host and exits non-zero', () => {
    const result = runScript('redis://cache.internal.example:6379/15');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to clear rate-limit state');
    expect(result.stderr).toContain('cache.internal.example');
    // Refused before the target line is printed: nothing was connected to.
    expect(result.stdout).not.toContain('rate-limit flush target');
    expect(result.stdout).not.toContain('rate-limit state cleared');
  });

  it('refuses an invalid REDIS_URL and exits non-zero', () => {
    const result = runScript('not-a-url');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to clear rate-limit state');
    expect(result.stdout).not.toContain('rate-limit state cleared');
  });

  it('reports the loopback target instead of refusing it', () => {
    // Loopback host on a closed port: the guard must let it through (the
    // connection itself then fails, which is also a non-zero exit — and no
    // limiter state is ever touched by this test).
    const result = runScript('redis://127.0.0.1:1/15');

    expect(result.stdout).toContain('rate-limit flush target 127.0.0.1 db 15');
    expect(result.stderr).not.toContain('refusing to clear rate-limit state');
    expect(result.stdout).not.toContain('rate-limit state cleared');
    expect(result.status).not.toBe(0);
  });
});
