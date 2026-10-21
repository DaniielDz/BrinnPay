import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

import { routeTemplateOf } from '../../metrics/http-metrics';
import { MetricsService } from '../../metrics/metrics.service';
import { resolveRequestId } from '../../request-id/request-id';
import {
  isUnderApiPrefix,
  requestPathOf,
} from '../../request-logging/request-log-record';
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
 *
 * Phase 20 §6 M4/§10: also the boundary that *knows* an exception was not an
 * `HttpException` — the definition of unhandled — so the
 * `http_unhandled_exceptions_total` counter is raised here rather than
 * anywhere that would have to re-classify the error later. Only `/api/v1`
 * traffic counts, by the same predicate as the rest of the request surface.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly metrics: MetricsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = resolveRequestId(request);

    const envelope = this.toEnvelope(exception, requestId);

    if (!(exception instanceof HttpException)) {
      this.countUnhandled(request);
    }

    response.setHeader('X-Request-Id', requestId);
    response.status(this.statusFor(exception)).json(envelope);
  }

  /** §4 rule 5: a metric defect must never replace the error envelope. */
  private countUnhandled(request: Request): void {
    try {
      if (!isUnderApiPrefix(requestPathOf(request.originalUrl ?? request.url ?? ''))) {
        return;
      }
      this.metrics.incUnhandledException(routeTemplateOf(request));
    } catch {
      // Instrumentation degrades observability, never the error contract.
    }
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
