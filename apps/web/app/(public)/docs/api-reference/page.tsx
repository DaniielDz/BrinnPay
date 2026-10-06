import type { Metadata } from 'next';

import { ApiReference } from '../../../../components/docs/api-reference';
import {
  loadContract,
  resolveApiBaseUrl,
  resolveSwaggerUrl,
} from '../../../../lib/docs/openapi';

export const metadata: Metadata = {
  title: 'API reference — BrinnPay',
  description:
    'The complete API reference: every BrinnPay v1 operation, parameter, response and schema, generated at build time from the canonical docs/openapi.yaml contract.',
};

/**
 * API reference route (phase 15 §6, ADR-0030, D2 confirmed (a)).
 *
 * The page renders the canonical contract — loaded once, at build/render time
 * from `docs/openapi.yaml` — through the display-only reference component.
 * There is no hand-written operation anywhere in the app (no parallel
 * contract), no client-side fetching, and no request is ever sent from this
 * page (Q4: display-only), so the route stays static and public like the rest
 * of the documentation area.
 */
export default function ApiReferencePage() {
  return <ApiReference contract={loadContract()} baseUrl={resolveApiBaseUrl()} swagger={resolveSwaggerUrl()} />;
}
