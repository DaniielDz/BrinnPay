import { HttpException } from '@nestjs/common';

import { ErrorCode } from './error-code';

/**
 * Application error mapped to the canonical error envelope (phase 1 §7.6).
 *
 * Domain and cross-cutting layers throw `ApiError` with a stable `code`; the
 * global exception filter renders it. Details must never contain secrets.
 */
export class ApiError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, statusCode: status, details }, status);
  }

  static validation(details: Record<string, unknown>): ApiError {
    return new ApiError(ErrorCode.VALIDATION_ERROR, 'Validation failed', 400, details);
  }
}
