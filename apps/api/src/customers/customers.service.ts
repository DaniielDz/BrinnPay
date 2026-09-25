import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import { isUuidLike } from '../projects/projects.service';
import type { Environment } from '../projects/environment';
import { PrismaService } from '../prisma/prisma.service';
import type { CustomerListQueryDto } from './dto/customer-list-query.dto';
import type { CustomerCreateDto } from './dto/customer-create.dto';
import type { CustomerUpdateDto } from './dto/customer-update.dto';
import type { CustomersScope } from './customers-scope';

/** `Customer` as contracted (phase 6 §4.2): `metadata` is always a flat string
 *  map (`{}` when absent, D6); `name` is `null` when not provided. */
export interface CustomerResponse {
  id: string;
  project_id: string;
  environment: Environment;
  email: string;
  name: string | null;
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

const CUSTOMER_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Customer not found', 404);

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/**
 * Customers domain service (phase 6 §4.2). Owns customer persistence and rules.
 *
 * The dual-mode boundary (`CustomersAccessGuard`) has already resolved the
 * request to exactly one scope (D8) and enforced the project-level
 * authorization (session: membership + capability; API key: path project =
 * key project). This service enforces what remains:
 *
 * - the environment-match rule (D2): session requests must provide the
 *   environment (400 when missing); API-key requests derive it from the key
 *   and reject conflicting explicit values (422);
 * - project/environment scoping of every query (404 non-disclosure for
 *   cross-project and cross-environment customer ids, phase 4 D1 / phase 5
 *   D2 applied to customers);
 * - the field rules: email normalization (trimmed + lowercased, ≤ 320), name
 *   (trimmed, non-empty, ≤ 200, not clearable to null — D7), metadata (flat
 *   string map, replaced wholesale — D6);
 * - search (D3): case-insensitive substring on `email` and `name`, composed
 *   with the environment filter and cursor pagination.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** List (§4.2): cursor-paginated customers of one project environment. */
  async list(
    scope: CustomersScope,
    query: CustomerListQueryDto,
  ): Promise<CursorPage<CustomerResponse>> {
    const environment = this.resolveListEnvironment(scope, query.environment);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.prisma.customer.findMany({
      where: {
        projectId: scope.project_id,
        environment,
        ...(searchWhere(query.search) ?? {}),
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toCustomerResponse), limit);
  }

  /**
   * Create (§4.2): a customer belongs to exactly one (project, environment) —
   * immutable after creation. Session mode: `environment` is required in the
   * body (DTO-enforced); API-key mode: it must equal the key's environment
   * (else 422, D2). Emails are normalized and deliberately **not unique** (D1).
   */
  async create(scope: CustomersScope, dto: CustomerCreateDto): Promise<CustomerResponse> {
    const environment = this.resolveCreateEnvironment(scope, dto.environment);
    const email = this.normalizeEmail(dto.email);
    const name = dto.name === undefined ? null : this.validateName(dto.name);
    const metadata = dto.metadata ?? {};

    const now = new Date();
    const customer = await this.prisma.customer.create({
      data: {
        id: uuidv7(),
        projectId: scope.project_id,
        environment,
        email,
        name,
        metadata: metadata as Prisma.InputJsonValue,
        createdAt: now,
        updatedAt: now,
      },
    });
    return toCustomerResponse(customer);
  }

  /** Retrieve (§4.2): scoped to the addressed project; an API key can only
   *  see customers of its own environment (else 404, non-disclosure). */
  async retrieve(scope: CustomersScope, customerId: string): Promise<CustomerResponse> {
    const customer = await this.findScopedCustomer(scope, customerId);
    return toCustomerResponse(customer);
  }

  /**
   * Update (§4.2): partial — only provided fields change; a PATCH providing no
   * fields (or only equal values) is a no-op returning the current state;
   * `updated_at` advances only when a field actually changes. Clearing `name`
   * to `null` is not supported (D7).
   */
  async update(
    scope: CustomersScope,
    customerId: string,
    dto: CustomerUpdateDto,
  ): Promise<CustomerResponse> {
    const customer = await this.findScopedCustomer(scope, customerId);

    const nextEmail = dto.email === undefined ? undefined : this.normalizeEmail(dto.email);
    const nextName = dto.name === undefined ? undefined : this.validateName(dto.name);
    const nextMetadata = dto.metadata;

    const emailChanged = nextEmail !== undefined && nextEmail !== customer.email;
    const nameChanged = nextName !== undefined && nextName !== customer.name;
    const metadataChanged =
      nextMetadata !== undefined &&
      JSON.stringify(nextMetadata) !== JSON.stringify(customer.metadata ?? {});

    if (!emailChanged && !nameChanged && !metadataChanged) {
      // No-op patch returns the current state (no `updated_at` advance).
      return toCustomerResponse(customer);
    }

    try {
      const updated = await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          ...(emailChanged ? { email: nextEmail } : {}),
          ...(nameChanged ? { name: nextName } : {}),
          ...(metadataChanged ? { metadata: nextMetadata as Prisma.InputJsonValue } : {}),
          updatedAt: new Date(),
        },
      });
      return toCustomerResponse(updated);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        // Deleted between the read and the update; the customer no longer exists.
        throw CUSTOMER_NOT_FOUND();
      }
      throw error;
    }
  }

  /** Delete (§4.2): hard delete (no child rows exist until Phase 7); returns
   *  void (204) and subsequent access yields 404 for everyone. */
  async delete(scope: CustomersScope, customerId: string): Promise<void> {
    const customer = await this.findScopedCustomer(scope, customerId);
    try {
      await this.prisma.customer.delete({ where: { id: customer.id } });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw CUSTOMER_NOT_FOUND();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Scope and environment resolution (D2)
  // -------------------------------------------------------------------------

  /**
   * Session mode: the `environment` query parameter is required — TEST/LIVE
   * data is never mixed, so a session request without an explicit environment
   * cannot be served (400, field error). API-key mode: the environment is
   * derived from the key; an explicit conflicting value → 422 (the contract's
   * `required: false` covers this API-key path).
   */
  private resolveListEnvironment(
    scope: CustomersScope,
    explicit: Environment | undefined,
  ): Environment {
    if (scope.mode === 'api_key') {
      if (explicit && explicit !== scope.environment) {
        this.environmentMismatch();
      }
      return scope.environment;
    }
    if (!explicit) {
      throw ApiError.validation({
        fields: [
          {
            field: 'environment',
            errors: ['environment is required for session-authenticated requests'],
          },
        ],
      });
    }
    return explicit;
  }

  /** Create environment check: session → DTO-required body value; API key →
   *  the body value must equal the key's environment (422 on mismatch). */
  private resolveCreateEnvironment(scope: CustomersScope, body: Environment): Environment {
    if (scope.mode === 'api_key') {
      if (body !== scope.environment) {
        this.environmentMismatch();
      }
      return scope.environment;
    }
    return body;
  }

  /** 422 `BUSINESS_RULE_VIOLATION` for the environment-mismatch rule (D2). */
  private environmentMismatch(): never {
    throw new ApiError(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'Environment does not match the API key scope',
      422,
      { field: 'environment' },
    );
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  /**
   * Loads a customer within the addressed project (and, in API-key mode,
   * within the key's environment). A cross-project or cross-environment
   * `customer_id`, or any malformed id, is indistinguishable from an unknown
   * customer (404 non-disclosure). In session mode the environment filter does
   * not apply here: retrieve/update/delete act on the row addressed by id, and
   * env isolation for session mode is enforced by the UI/list flow passing the
   * explicit environment.
   */
  private async findScopedCustomer(
    scope: CustomersScope,
    customerId: string,
  ): Promise<{
    id: string;
    projectId: string;
    environment: string;
    email: string;
    name: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  }> {
    if (!isUuidLike(customerId)) {
      throw CUSTOMER_NOT_FOUND();
    }

    const customer = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        projectId: scope.project_id,
        ...(scope.mode === 'api_key' ? { environment: scope.environment } : {}),
      },
    });
    if (!customer) {
      throw CUSTOMER_NOT_FOUND();
    }
    return customer;
  }

  // -------------------------------------------------------------------------
  // Field rules
  // -------------------------------------------------------------------------

  /** Emails are persisted trimmed + lowercased (phase 3/4 convention). */
  private normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  /** `name` must be a non-empty string after trimming, ≤ 200 chars (D7: not
   *  clearable to null in the MVP). */
  private validateName(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Customer name must not be empty'] }],
      });
    }
    if (trimmed.length > 200) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Customer name must be at most 200 characters'] }],
      });
    }
    return trimmed;
  }
}

/** Search (D3): case-insensitive substring on `email` and `name`, ANDed with
 *  the (project, environment) filter by the caller; empty/whitespace-only
 *  terms are treated as absent. No relevance ranking in the MVP. */
function searchWhere(term: string | undefined): Prisma.CustomerWhereInput | undefined {
  const trimmed = term?.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    OR: [
      { email: { contains: trimmed, mode: 'insensitive' } },
      { name: { contains: trimmed, mode: 'insensitive' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mappers (snake_case contract projection; UTC timestamps pass through as-is)
// ---------------------------------------------------------------------------

function toCustomerResponse(customer: {
  id: string;
  projectId: string;
  environment: string;
  email: string;
  name: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): CustomerResponse {
  return {
    id: customer.id,
    project_id: customer.projectId,
    environment: customer.environment as Environment,
    email: customer.email,
    name: customer.name,
    metadata: (customer.metadata ?? {}) as Record<string, string>,
    created_at: customer.createdAt,
    updated_at: customer.updatedAt,
  };
}