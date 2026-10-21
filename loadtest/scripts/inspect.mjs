#!/usr/bin/env node
/**
 * k6 validation entry point (AC9): runs `k6 inspect` against every committed
 * scenario inside the pinned container, so each script's options/thresholds
 * are machine-validated without executing load.
 *
 * Usage: `pnpm loadtest:inspect` (from the repository root) or
 * `node loadtest/scripts/inspect.mjs [scenario-file …]`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADTEST_DIR = path.resolve(HERE, '..');
const K6_IMAGE = 'grafana/k6:2.3.0';

const requested = process.argv.slice(2);
const scenariosDir = path.join(LOADTEST_DIR, 'scenarios');
const files =
  requested.length > 0
    ? requested
    : fs
        .readdirSync(scenariosDir)
        .filter((name) => name.endsWith('.ts'))
        .sort()
        .map((name) => `scenarios/${name}`);

if (files.length === 0) {
  process.stderr.write('inspect: no scenario files found\n');
  process.exit(1);
}

// Ensure the pinned image exists (offline-friendly: only pulls when missing).
const inspectImage = spawnSync('docker', ['image', 'inspect', K6_IMAGE], { stdio: 'ignore' });
if (inspectImage.status !== 0) {
  const pull = spawnSync('docker', ['pull', K6_IMAGE], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (pull.status !== 0) {
    process.stderr.write(`inspect: cannot pull ${K6_IMAGE}\n`);
    process.exit(1);
  }
}

let failures = 0;
for (const file of files) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${typeof process.getuid === 'function' ? process.getuid() : 0}:${typeof process.getgid === 'function' ? process.getgid() : 0}`,
      '-v',
      `${LOADTEST_DIR}:/loadtest`,
      '-w',
      '/loadtest',
      K6_IMAGE,
      'inspect',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status === 0) {
    process.stdout.write(`ok   ${file}\n`);
  } else {
    failures += 1;
    process.stderr.write(`FAIL ${file}\n${(result.stderr ?? '').trim()}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`inspect: ${failures}/${files.length} scenario(s) failed validation\n`);
  process.exit(1);
}
process.stdout.write(`inspect: ${files.length} scenario(s) validated with ${K6_IMAGE}\n`);
