/**
 * Project environment model (phase 1 §5.2, phase 5 §4.2/D6).
 *
 * A project always supports both simulated environments (`test` and `live`);
 * the `environments` array exposed by the API is derived by the service, never
 * stored. Environment values are lowercase in the API (`test`/`live`),
 * uppercase in UI copy (`TEST`/`LIVE`), and embedded in the API-key prefixes
 * (`sk_test_…`/`sk_live_…`) — api-conventions §8.
 */
export const ENVIRONMENTS = ['test', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}