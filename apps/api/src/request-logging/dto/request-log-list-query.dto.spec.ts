import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RequestLogListQueryDto } from './request-log-list-query.dto';

const REQUEST_ID = `req_${'c'.repeat(32)}`;

/** Runs the query through the same boundary the global validation pipe uses. */
async function fieldErrors(query: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(RequestLogListQueryDto, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('request log list query (phase 11 §4.3, D1/D8)', () => {
  it('accepts an empty query — no filter is required (D1)', async () => {
    await expect(fieldErrors({})).resolves.toEqual([]);
  });

  it('accepts a valid environment and rejects anything outside the catalog', async () => {
    await expect(fieldErrors({ environment: 'test' })).resolves.toEqual([]);
    await expect(fieldErrors({ environment: 'live' })).resolves.toEqual([]);

    const errors = await fieldErrors({ environment: 'staging' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/environment/);
    await expect(fieldErrors({ environment: 'TEST' })).resolves.toHaveLength(1);
    await expect(fieldErrors({ environment: '' })).resolves.toHaveLength(1);
  });

  it('accepts an exact request id in the server-assigned scheme (D8)', async () => {
    await expect(fieldErrors({ request_id: REQUEST_ID })).resolves.toEqual([]);
    await expect(fieldErrors({ request_id: `req_${'0'.repeat(32)}` })).resolves.toEqual([]);
  });

  it('rejects a malformed request id with a field error naming the scheme', async () => {
    for (const request_id of [
      'req_',
      `req_${'c'.repeat(31)}`,
      `req_${'c'.repeat(33)}`,
      `req_${'z'.repeat(32)}`,
      'REQ_cccccccccccccccccccccccccccccccc',
      'req_cccccccccccccccccccccccccccccc-cc',
      'log_123',
    ]) {
      const errors = await fieldErrors({ request_id });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/request_id/);
    }
    expect(await fieldErrors({ request_id: 42 })).not.toEqual([]);
  });

  it('trims the term and treats a cleared value as absent', async () => {
    await expect(fieldErrors({ request_id: `  ${REQUEST_ID}  ` })).resolves.toEqual([]);
    await expect(fieldErrors({ request_id: '   ' })).resolves.toEqual([]);
    await expect(fieldErrors({ request_id: '' })).resolves.toEqual([]);
  });

  it('inherits the shared limit/cursor boundary rules', async () => {
    await expect(fieldErrors({ limit: '25' })).resolves.toEqual([]);
    await expect(fieldErrors({ limit: '0' })).resolves.toHaveLength(1);
    await expect(fieldErrors({ limit: '101' })).resolves.toHaveLength(1);
    await expect(fieldErrors({ cursor: `11111111-1111-4111-8111-111111111111` })).resolves.toEqual([]);
    await expect(fieldErrors({ cursor: 'not-a-cursor' })).resolves.toHaveLength(1);
    // A non-numeric limit fails every bound it participates in; the shape of the
    // rejection is the pipe's, not this module's.
    expect(await fieldErrors({ limit: 'many' })).not.toEqual([]);
  });

  it('rejects undeclared parameters (forbidNonWhitelisted)', async () => {
    expect(await fieldErrors({ method: 'GET' })).not.toEqual([]);
    expect(await fieldErrors({ status_code: 404 })).not.toEqual([]);
    expect(await fieldErrors({ sort: 'desc' })).not.toEqual([]);
  });
});
