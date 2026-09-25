import { vi } from 'vitest';

import type { AuthSession, CreatePaymentInput, Payment } from '../../lib/brinnpay/client';
import {
  customerFixtures,
} from './customers-test-utils';
import {
  memberFixtures,
  projectFixture,
  sessionFixture,
} from './projects-test-utils';

export const paymentFixtures: Payment[] = [
  {
    id: 'pay-1',
    project_id: projectFixture.id,
    environment: 'test',
    customer_id: customerFixtures[0].id,
    amount: '10.00',
    currency: 'usd',
    status: 'pending',
    failure_code: null,
    description: null,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
  },
  {
    id: 'pay-2',
    project_id: projectFixture.id,
    environment: 'test',
    customer_id: customerFixtures[1].id,
    amount: '40.00',
    currency: 'usd',
    status: 'succeeded',
    failure_code: null,
    description: 'Monthly plan',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:01:00.000Z',
  },
];

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const respond = (status: number, body?: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body ?? null,
});

const fail = (code: string, message: string, status: number): FakeResponse =>
  respond(status, { error: { code, message } });

export interface PaymentsApiBehaviour {
  /** When set, every payments route returns this code (e.g. NOT_FOUND). */
  failPayments?: string;
  session?: AuthSession;
  payments?: Payment[];
}

/**
 * Installs a scriptable `fetch` for the phase 7 payments UI: `/auth/*`
 * (session restore), the owning org's members (caller role), the project
 * (access), the customers of the environment (create select, D1/D3), and the
 * payments list/retrieve/create routes of the API contract. The in-memory
 * payment store is exposed so a test can settle a non-terminal payment (the
 * default-success simulation, D2) and watch the poll pick it up.
 */
export function stubPaymentsApi(behaviour: PaymentsApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const store: { payments: Payment[] } = {
    payments: behaviour.payments ?? [...paymentFixtures],
  };

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
      const fullUrl = String(input);
      const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');

      if (url.endsWith('/auth/refresh')) {
        return respond(200, activeSession);
      }
      if (url.endsWith('/auth/me')) {
        return respond(200, activeSession.user);
      }

      const membersPath = url.match(/^\/organizations\/([^/]+)\/members(?:\?|$)/);
      if (membersPath) return respond(200, { data: memberFixtures, next_cursor: null, has_more: false });

      const customerListPath = url.match(/^\/projects\/([^/]+)\/customers(?:\?|$)/);
      if (customerListPath) {
        const query = new URLSearchParams(fullUrl.split('?')[1] ?? '');
        const environment = query.get('environment') ?? 'test';
        return respond(200, {
          data: customerFixtures.filter((customer) => customer.environment === environment),
          next_cursor: null,
          has_more: false,
        });
      }

      const paymentPath = url.match(/^\/projects\/([^/]+)\/payments\/([^/?]+)(?:\?|$)/);
      if (paymentPath) {
        const paymentId = paymentPath[2];
        if (behaviour.failPayments) return fail(behaviour.failPayments, 'Payment not found', 404);
        const payment = store.payments.find((entry) => entry.id === paymentId);
        if (!payment) return fail('NOT_FOUND', 'Payment not found', 404);
        return respond(200, { ...payment });
      }

      const paymentsListPath = url.match(/^\/projects\/([^/]+)\/payments(?:\?|$)/);
      if (paymentsListPath) {
        if (behaviour.failPayments) return fail(behaviour.failPayments, 'Project not found', 404);
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as CreatePaymentInput;
          const created: Payment = {
            id: 'pay-new',
            project_id: paymentsListPath[1],
            environment: body.environment,
            customer_id: body.customer_id,
            amount: body.amount,
            currency: 'usd',
            status: 'pending',
            failure_code: null,
            description: body.description ?? null,
            created_at: '2026-09-25T01:00:00.000Z',
            updated_at: '2026-09-25T01:00:00.000Z',
          };
          store.payments.push(created);
          return respond(201, { ...created });
        }
        const query = new URLSearchParams(fullUrl.split('?')[1] ?? '');
        const environment = query.get('environment') ?? 'test';
        return respond(200, {
          // Copies, never references: React state may only change through an
          // actual list re-fetch (the poll), never through store mutation.
          data: store.payments
            .filter(
              (payment) => payment.environment === environment && payment.project_id === paymentsListPath[1],
            )
            .map((payment) => ({ ...payment })),
          next_cursor: null,
          has_more: false,
        });
      }

      const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
      if (projectPath) {
        if (behaviour.failPayments) return fail(behaviour.failPayments, 'Project not found', 404);
        return respond(200, projectFixture);
      }

      return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    store: {
      /** Settle a payment to `succeeded` (the default-success simulation, D2).
       *  Replaces the store entry so only future fetches observe the change. */
      settle(paymentId: string): void {
        const index = store.payments.findIndex((entry) => entry.id === paymentId);
        if (index >= 0) {
          store.payments[index] = {
            ...store.payments[index],
            status: 'succeeded',
            updated_at: '2026-09-25T01:00:05.000Z',
          };
        }
      },
    },
  };
}

export function unstubPaymentsApi(): void {
  vi.unstubAllGlobals();
}