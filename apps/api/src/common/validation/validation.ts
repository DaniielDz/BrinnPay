import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { ApiError } from '../errors/api-error';

interface FieldValidationError {
  field: string;
  errors: string[];
}

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldValidationError[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own: FieldValidationError[] = error.constraints
      ? [{ field: path, errors: Object.values(error.constraints) }]
      : [];

    return [...own, ...flattenValidationErrors(error.children ?? [], path)];
  });
}

/**
 * Maps class-validator failures to the canonical 400 `VALIDATION_ERROR`
 * envelope. Only field names and constraint messages are exposed (no values,
 * no internals).
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  return ApiError.validation({ fields: flattenValidationErrors(errors) });
}

export const VALIDATION_PIPE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: validationExceptionFactory,
} as const;

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe(VALIDATION_PIPE_OPTIONS);
}
