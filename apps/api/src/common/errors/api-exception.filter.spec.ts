import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'nestjs-pino';

import { ApiError } from './api-error';
import { ApiExceptionFilter } from './api-exception.filter';
import { ErrorCode } from './error-code';

interface MockResponse {
  setHeader: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
}

function createHost(requestId: string): { host: ArgumentsHost; response: MockResponse } {
  const response: MockResponse = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: requestId }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('ApiExceptionFilter (phase 2 §4.2, phase 1 §7.6)', () => {
  const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders ApiError with its code, message, request_id and details', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(
      new ApiError(ErrorCode.CONFLICT, 'Already exists', HttpStatus.CONFLICT, { field: 'x' }),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req_abc');
    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'CONFLICT',
        message: 'Already exists',
        request_id: 'req_abc',
        details: { field: 'x' },
      },
    });
  });

  it('maps common HttpExceptions to canonical codes', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new NotFoundException('Missing something'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Missing something',
        request_id: 'req_abc',
      },
    });
  });

  it('maps BadRequestException to VALIDATION_ERROR', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new BadRequestException('Bad input'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
      }),
    );
  });

  it('maps ForbiddenException to FORBIDDEN and includes the request ID', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new ForbiddenException('Not allowed'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCode.FORBIDDEN,
        message: 'Not allowed',
        request_id: 'req_abc',
      },
    });
  });

  it('never leaks internals for 5xx HttpExceptions', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new HttpException('database pool exhausted at postgres://internal', 500), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
        request_id: 'req_abc',
      },
    });
  });

  it('logs unexpected errors server-side and returns a generic envelope', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new Error('boom: postgresql://user:password@db:5432/brinnpay'), host);

    expect(logger.error).toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const payload = response.json.mock.calls[0][0] as {
      error: { code: string; message: string; request_id: string };
    };
    expect(payload.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(payload.error.message).toBe('Internal server error');
    expect(payload.error.request_id).toBe('req_abc');
    expect(JSON.stringify(payload)).not.toContain('postgresql://');
    expect(JSON.stringify(payload)).not.toContain('password');
    expect(JSON.stringify(payload)).not.toContain('stack');
    expect(JSON.stringify(payload)).not.toContain('boom');
  });

  it('extracts array validation messages from HttpException responses', () => {
    const { host, response } = createHost('req_abc');
    const filter = new ApiExceptionFilter(logger);

    filter.catch(new BadRequestException(['first problem', 'second problem']), host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'first problem; second problem' }),
      }),
    );
  });
});