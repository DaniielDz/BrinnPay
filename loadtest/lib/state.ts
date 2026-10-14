/**
 * Shared run state (phase 19 D9).
 *
 * `scripts/seed.mjs` writes `loadtest/.state/state.json` after scaffolding
 * identity through the public API. The file is **local-only runtime state**:
 * it lives under `loadtest/.state/` (gitignored, mode 600), is never printed
 * by the runner, and is never committed. It holds the run id, the seeded
 * user's credentials (email + generated password — S7 logs in through the
 * public API exactly like the dashboard), both projects' ids, the plaintext
 * API keys issued for the load run, receiver endpoint paths, and sample
 * payment/customer ids.
 *
 * The file is read **eagerly at module scope** — the init context is the only
 * stage where k6 allows `open()` (verified against grafana/k6:2.3.0: calling
 * it from `setup()` throws "the open function is only available in the init
 * stage"). A pre-seed read miss is swallowed here (`readFailed`), so
 * `k6 inspect` stays usable without a seed and `requireState()` throws the
 * actionable message from `setup()` instead.
 */

export interface SeedUser {
  email: string;
  /** Local load-run password. Never logged, never committed. */
  password: string;
  orgId: string;
}

export interface SeedProject {
  id: string;
  name: string;
}

/** Plaintext API keys issued by the seed (test environment scope). */
export interface SeedKeys {
  primaryTest: string;
  secondaryTest: string;
}

export interface SeedEndpoints {
  /**
   * Primary-project endpoint URLs registered by the seed, in registration
   * order. Includes failing receiver paths (URLs containing `/fail/`) — the
   * fan-out/pileup drivers for S2/S5 (multi-endpoint cost, D5 evidence).
   */
  primary: string[];
  /** Secondary-project endpoint URLs registered by the seed. */
  secondary: string[];
}

export interface LoadtestState {
  runId: string;
  seededAt: string;
  baseUrl: string;
  user: SeedUser;
  keys: SeedKeys;
  primary: SeedProject;
  secondary: SeedProject;
  endpoints: SeedEndpoints;
  /** Sample terminal payment ids (primary), for retrieve paths. */
  samplePaymentIds: string[];
  /** Succeeded ids reserved for S8 refunds (never touched by other scenarios). */
  refundablePaymentIds: string[];
  /** Sample terminal payment ids for the secondary project. */
  secondarySamplePaymentIds: string[];
  /** Fresh customer ids per project for S2/S5/S7/S8 payment creation. */
  customerIds: {
    primary: string[];
    secondary: string[];
  };
  counts: {
    primaryCustomers: number;
    primaryPayments: number;
    secondaryCustomers: number;
    secondaryPayments: number;
  };
}

let cached: LoadtestState | null = null;
let readFailed = false;

function readState(): LoadtestState | null {
  if (cached !== null) return cached;
  if (readFailed) return null;
  try {
    const raw: string = open('../.state/state.json');
    const parsed = JSON.parse(raw) as LoadtestState;
    if (!parsed || typeof parsed !== 'object' || !parsed.primary?.id) {
      readFailed = true;
      return null;
    }
    cached = parsed;
    return cached;
  } catch {
    readFailed = true;
    return null;
  }
}

// Init-stage read: scenarios import this module at init, so the file is
// parsed before `setup()` runs and `requireState()` never calls `open()`.
readState();

/**
 * Returns the parsed seed state, or throws an actionable error when the seed
 * step has not run yet. Safe to call from `setup()` — it only reads the cache
 * populated at init above.
 */
export function requireState(): LoadtestState {
  const state = readState();
  if (state === null) {
    throw new Error(
      'loadtest/.state/state.json is missing or invalid — run `pnpm loadtest` (or `node loadtest/scripts/seed.mjs`) first.',
    );
  }
  return state;
}

/** Non-throwing access (init-time probes, inspect). */
export function tryState(): LoadtestState | null {
  return readState();
}
