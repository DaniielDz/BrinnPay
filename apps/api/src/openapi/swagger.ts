import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SwaggerModule } from '@nestjs/swagger';
import { parse } from 'yaml';

/**
 * Resolves the canonical OpenAPI contract (`docs/openapi.yaml`, ADR-0012)
 * relative to the process working directory or the compiled module location.
 */
function resolveOpenApiPath(configuredPath: string): string {
  const candidates = [
    resolve(process.cwd(), configuredPath),
    resolve(process.cwd(), '../../docs/openapi.yaml'),
    resolve(__dirname, '../../../../docs/openapi.yaml'),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `OpenAPI contract not found. Checked: ${candidates.join(', ')}. ` +
        'Set OPENAPI_PATH or run the API from its application directory.',
    );
  }

  return found;
}

/**
 * Serves Swagger UI from the canonical contract (D5, ADR-0012). No parallel
 * contract is generated from decorators.
 */
export function setupSwagger(app: INestApplication, config: ConfigService): void {
  const logger = new Logger('Swagger');
  const openApiPath = resolveOpenApiPath(config.get<string>('openapiPath') ?? '');
  const document = parse(readFileSync(openApiPath, 'utf8')) as OpenAPIObject;
  const mountPath = config.get<string>('swaggerPath') ?? 'docs';

  SwaggerModule.setup(mountPath, app, document);

  logger.log(`Swagger UI served at /${mountPath} from ${openApiPath}`);
}
