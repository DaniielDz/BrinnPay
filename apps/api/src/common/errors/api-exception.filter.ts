import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

import { resolveRequestId } from '../../request-id/request-id';
import { ApiError } from './api-error';
import { ErrorCode } from './error-code';

const STATUS_TO_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.BUSINESS_RULE_VIOLATION,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Global exception filter rendering the canonical error envelope (phase 1
 * §7.6). Never leaks stack traces, database details, connection strings, or
 * secrets; unexpected errors are logged server-side and returned as a generic
 * 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = resolveRequestId(request);

    const envelope = this.toEnvelope(exception, requestId);

    response.setHeader('X-Request-Id', requestId);
    response.status(this.statusFor(exception)).json(envelope);
  }

  private toEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
    if (exception instanceof ApiError) {
      return {
        error: {
          code: exception.code,
          message: exception.message,
          request_id: requestId,
          ...(exception.details ? { details: exception.details } : {}),
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        error: {
          code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
          message: this.safeHttpMessage(exception, status),
          request_id: requestId,
        },
      };
    }

    this.logger.error(
      { err: exception, request_id: requestId },
      'Unhandled exception while processing request',
    );

    return {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
        request_id: requestId,
      },
    };
  }

  private safeHttpMessage(exception: HttpException, status: number): string {
    if (status >= 500) {
      return 'Internal server error';
    }

    const response = exception.getResponse();
    if (typeof response === 'string') {
      return response;
    }

    if (typeof response === 'object' && response !== null) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
      if (Array.isArray(message)) {
        return message.map(String).join('; ');
      }
    }

    return exception.message;
  }

  private statusFor(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
