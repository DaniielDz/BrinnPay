import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ApiError } from '../errors/api-error';
import { createValidationPipe } from './validation';

class TestDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  age?: number;
}

class NestedDto {
  @IsString()
  @MinLength(1)
  value!: string;
}

class ParentDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NestedDto)
  child?: NestedDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NestedDto)
  children?: NestedDto[];
}

describe('createValidationPipe (phase 2 §4.2)', () => {
  const pipe = createValidationPipe();

  it('accepts valid input and transforms plain objects', async () => {
    const value = await pipe.transform(
      { email: 'dev@brinnpay.dev', name: 'Ada', age: 32 },
      { type: 'body', metatype: TestDto },
    );

    expect(value).toMatchObject({ email: 'dev@brinnpay.dev', name: 'Ada', age: 32 });
  });

  it('rejects unknown properties (whitelist + forbidNonWhitelisted)', async () => {
    const expectation = pipe.transform(
      { email: 'dev@brinnpay.dev', name: 'Ada', admin: true },
      { type: 'body', metatype: TestDto },
    );

    await expect(expectation).rejects.toBeInstanceOf(ApiError);
    await expect(expectation).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws the canonical VALIDATION_ERROR with field details', async () => {
    try {
      await pipe.transform(
        { email: 'not-an-email', name: 'x' },
        { type: 'body', metatype: TestDto },
      );
      fail('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe('VALIDATION_ERROR');
      expect(apiError.getStatus()).toBe(400);
      expect(apiError.details).toEqual({
        fields: expect.arrayContaining([
          { field: 'email', errors: expect.arrayContaining([expect.any(String)]) },
          { field: 'name', errors: expect.arrayContaining([expect.any(String)]) },
        ]),
      });
    }
  });

  it('exposes only field names and constraint messages, never values', async () => {
    try {
      await pipe.transform(
        { email: 'secret-value-not-valid', name: 'ok' },
        { type: 'body', metatype: TestDto },
      );
      fail('Expected validation to fail');
    } catch (error) {
      const details = (error as ApiError).details as { fields: { field: string }[] };
      const serialized = JSON.stringify(details);
      expect(serialized).not.toContain('secret-value-not-valid');
      expect(details.fields.some((entry) => entry.field === 'email')).toBe(true);
    }
  });

  it('flattens nested validation errors into dot paths', async () => {
    try {
      await pipe.transform(
        { email: 'dev@brinnpay.dev', child: { value: 42 }, children: [{ value: '' }] },
        { type: 'body', metatype: ParentDto },
      );
      fail('Expected validation to fail');
    } catch (error) {
      const details = (error as ApiError).details as { fields: { field: string }[] };
      expect(details.fields.map((entry) => entry.field)).toEqual(
        expect.arrayContaining(['child.value', 'children.0.value']),
      );
    }
  });
});