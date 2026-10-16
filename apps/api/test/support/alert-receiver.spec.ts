import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Phase 20 local alert receiver (D6(a), AC4): the zero-dependency sink that
 * Alertmanager webhooks into. Spawning the real script is the only way to
 * prove the documented runbook path (`docker compose logs -f
 * alert-receiver`) actually prints something useful.
 */
const RECEIVER = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'monitoring',
  'alert-receiver.mjs',
);

jest.setTimeout(20_000);

interface ListeningLine {
  event?: string;
  port?: number;
}

/**
 * One persistent stdout buffer for the child's whole lifetime. Attaching and
 * detaching separate `data` listeners across phases would risk losing lines
 * (removing a listener does not pause the stream), so every waiter below
 * scans this buffer and only subscribes for future chunks.
 */
describe('local alert receiver (Phase 20 D6(a))', () => {
  // `stdio: ['ignore', ...]` leaves stdin null — that is the correct shape:
  // the receiver is a sink, it takes no input.
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let port: number;
  let stdout = '';

  /** Resolves when the accumulated stdout contains `needle`. */
  function waitForOutput(needle: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (stdout.includes(needle)) {
        resolve(stdout);
        return;
      }
      const onData = (): void => {
        if (stdout.includes(needle)) {
          child.stdout.off('data', onData);
          resolve(stdout);
        }
      };
      child.stdout.on('data', onData);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`receiver exited early with code ${code}`)));
    });
  }

  beforeAll(async () => {
    child = spawn(process.execPath, [RECEIVER], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    await waitForOutput('"event":"alert-receiver.listening"');
    const line = stdout
      .split('\n')
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .map((candidate) => {
        try {
          return JSON.parse(candidate) as ListeningLine;
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.event === 'alert-receiver.listening');
    port = line?.port ?? 0;
    expect(port).toBeGreaterThan(0);
  });

  afterAll(() => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
    }
  });

  it('prints one NDJSON line per firing alert batch', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'BrinnPayApiErrorRateHigh', severity: 'warning' },
            annotations: { summary: 'API 5xx error rate above the 2% operational guardrail' },
            startsAt: '2026-10-15T12:00:00Z',
            endsAt: '0001-01-01T00:00:00Z',
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: 1 });

    const output = await waitForOutput('BrinnPayApiErrorRateHigh');
    const line = output
      .split('\n')
      .filter((candidate) => candidate.includes('BrinnPayApiErrorRateHigh'))
      .pop();
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as {
      status?: string;
      alerts?: { name?: string; severity?: string; summary?: string }[];
    };
    expect(parsed.status).toBe('firing');
    expect(parsed.alerts?.[0]).toMatchObject({
      name: 'BrinnPayApiErrorRateHigh',
      severity: 'warning',
      summary: expect.stringContaining('5xx'),
    });
  });

  it('answers 404 for anything that is not POST /alerts', async () => {
    await fetch(`http://127.0.0.1:${port}/alerts`, { method: 'GET' }).then((response) =>
      expect(response.status).toBe(404),
    );
    await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST' }).then((response) =>
      expect(response.status).toBe(404),
    );
  });

  it('rejects a malformed body with 400 instead of crashing', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/alerts`, {
      method: 'POST',
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid json' });

    // The receiver is still alive after a bad payload.
    await fetch(`http://127.0.0.1:${port}/alerts`, {
      method: 'POST',
      body: JSON.stringify({ status: 'resolved', alerts: [] }),
    }).then((response) => expect(response.status).toBe(200));
  });
});
