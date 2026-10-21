import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Flat string-map constraints (phase 6 D6): string keys ≤ 40 chars, string
 *  values ≤ 500 chars, ≤ 50 entries. The contract describes `metadata` as
 *  "developer-defined key/value metadata" (`additionalProperties: true`);
 *  these bounds give that "key/value" meaning without narrowing the schema. */
export const MAX_METADATA_ENTRIES = 50;
export const MAX_METADATA_KEY_LENGTH = 40;
export const MAX_METADATA_VALUE_LENGTH = 500;

/**
 * Bounds a value to the flat string-map shape. Validation happens at the
 * boundary (DTO level); the service persists the validated map as JSONB.
 */
@ValidatorConstraint({ name: 'isFlatStringMap', async: false })
export class IsFlatStringMapConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_METADATA_ENTRIES) {
      return false;
    }

    return entries.every(
      ([key, entry]) =>
        key.length <= MAX_METADATA_KEY_LENGTH &&
        typeof entry === 'string' &&
        entry.length <= MAX_METADATA_VALUE_LENGTH,
    );
  }
}

export function IsFlatStringMap(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsFlatStringMapConstraint,
    });
  };
}