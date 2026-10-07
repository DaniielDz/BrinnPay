import { ApiError } from '../../common/errors/api-error';
import { createValidationPipe } from '../../common/validation/validation';
import { FAILURE_CODES, PAYMENT_SCENARIOS } from '../payment-scenario';
import { PaymentCreateDto } from './payment-create.dto';

const CUSTOMER_ID = '0192f2a0-0000-7000-8000-00000000000c';

const pipe = createValidationPipe();

/** The phase 7 base body — every scenario field is optional on top of it. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: 'test',
    customer_id: CUSTOMER_ID,
    amount: '10.00',
    currency: 'usd',
    ...overrides,
  };
}

async function transform(body: unknown): Promise<PaymentCreateDto> {
  return (await pipe.transform(body, {
    type: 'body',
    metatype: PaymentCreateDto,
  })) as PaymentCreateDto;
}

async function expectFieldError(body: unknown, field: string): Promise<void> {
  const error = await transform(body).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.code).toBe('VALIDATION_ERROR');
  expect(apiError.getStatus()).toBe(400);
  const details = apiError.details as { fields: { field: string; errors: string[] }[] };
  expect(details.fields.map((entry) => entry.field)).toContain(field);
  // Field names and constraint messages only — never the submitted value.
  expect(JSON.stringify(details)).not.toContain(CUSTOMER_ID);
}

describe('PaymentCreate scenario fields (phase 16 §4.2, D1/D4; AC4)', () => {
  it('accepts a create with no scenario fields — absent means default success', async () => {
    const dto = await transform(base());
    expect(dto.scenario).toBeUndefined();
    expect(dto.failure_code).toBeUndefined();
  });

  it.each(PAYMENT_SCENARIOS)('accepts scenario "%s"', async (scenario) => {
    const dto = await transform(base({ scenario }));
    expect(dto.scenario).toBe(scenario);
  });

  it.each(FAILURE_CODES)('accepts failure_code "%s" with scenario decline', async (code) => {
    const dto = await transform(base({ scenario: 'decline', failure_code: code }));
    expect(dto.failure_code).toBe(code);
  });

  it('rejects an unknown scenario value', async () => {
    await expectFieldError(base({ scenario: 'give-me-a-429' }), 'scenario');
    await expectFieldError(base({ scenario: 'Decline' }), 'scenario');
    await expectFieldError(base({ scenario: '' }), 'scenario');
    await expectFieldError(base({ scenario: 42 }), 'scenario');
  });

  it('rejects a scenario value that only differs by surrounding whitespace', async () => {
    // The enums are closed and never free strings: no trimming happens here
    // (§4.2 "closed enums — never free strings").
    await expectFieldError(base({ scenario: ' decline ' }), 'scenario');
  });

  it('rejects a failure_code outside the catalog', async () => {
    await expectFieldError(base({ scenario: 'decline', failure_code: 'declined' }), 'failure_code');
    await expectFieldError(base({ scenario: 'decline', failure_code: '' }), 'failure_code');
    await expectFieldError(base({ scenario: 'decline', failure_code: 42 }), 'failure_code');
    await expectFieldError(
      base({ scenario: 'decline', failure_code: 'CARD_DECLINED' }),
      'failure_code',
    );
  });

  it('rejects failure_code unless the scenario is decline', async () => {
    await expectFieldError(base({ scenario: 'succeed', failure_code: 'card_declined' }), 'failure_code');
    await expectFieldError(base({ scenario: 'timeout', failure_code: 'card_declined' }), 'failure_code');
    await expectFieldError(base({ failure_code: 'card_declined' }), 'failure_code');
  });

  it('rejects an explicit null for scenario and for failure_code', async () => {
    await expectFieldError(base({ scenario: null }), 'scenario');
    await expectFieldError(base({ scenario: 'decline', failure_code: null }), 'failure_code');
    await expectFieldError(base({ failure_code: null }), 'failure_code');
  });

  it('rejects unknown keys alongside the scenario fields (whitelist + forbid)', async () => {
    await expectFieldError(base({ scenario: 'decline', simulate: true }), 'simulate');
  });

  it('reports both scenario errors at once, in the house field envelope', async () => {
    try {
      await transform(base({ scenario: 'nope', failure_code: 'nope' }));
      throw new Error('Expected validation to fail');
    } catch (error) {
      const apiError = error as ApiError;
      const details = apiError.details as { fields: { field: string }[] };
      expect(details.fields.map((entry) => entry.field)).toEqual(
        expect.arrayContaining(['scenario', 'failure_code']),
      );
    }
  });

  it('never echoes a submitted scenario value back in the error', async () => {
    try {
      await transform(base({ scenario: 'leaked-value' }));
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(JSON.stringify((error as ApiError).details)).not.toContain('leaked-value');
    }
  });
});
