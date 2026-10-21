import { IsIn } from 'class-validator';

import { ENVIRONMENTS, type Environment } from '../../projects/environment';

/**
 * `ApiKeyCreate` (phase 5 §4.2): the environment the key is scoped to. Values
 * are the lowercase `test`/`live` from the contract's `Environment` enum;
 * the environment is embedded in the key prefix (`sk_test_…`/`sk_live_…`).
 */
export class ApiKeyCreateDto {
  @IsIn(ENVIRONMENTS)
  environment!: Environment;
}