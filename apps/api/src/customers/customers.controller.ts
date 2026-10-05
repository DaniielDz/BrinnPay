import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { RequireCapability } from '../organizations/org-rbac.guard';
import type { CursorPage } from '../organizations/cursor';
import { resolveRequestId } from '../request-id/request-id';
import { ApiKeyRateLimitGuard } from '../rate-limiting/api-key-rate-limit.guard';
import { RateLimit } from '../rate-limiting/rate-limit.decorator';
import { CustomersAccessGuard } from './customers-access.guard';
import { CustomersScope, type CustomersScope as CustomersScopeValue } from './customers-scope';
import { CustomersService, type CustomerResponse } from './customers.service';
import { CustomerCreateDto } from './dto/customer-create.dto';
import { CustomerListQueryDto } from './dto/customer-list-query.dto';
import { CustomerUpdateDto } from './dto/customer-update.dto';

/**
 * Customers surface (phase 6 §4.2). Every route sits under a `project_id` path
 * parameter and is protected by the dual-mode `CustomersAccessGuard` (D8):
 *
 * - **session mode** (dashboard JWT): project-RBAC on the route's capability
 *   (404 non-member / 403 insufficient capability);
 * - **API-key mode** (`sk_…` token): the key's (project, environment) scope
 *   applies and the path project must be the key's project.
 *
 * All `api-key`-scoped data access is further pinned to the key's environment
 * inside `CustomersService` (404 cross-environment, 422 explicit mismatches).
 */
@Controller('projects/:project_id/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RateLimit('read')
  @UseGuards(CustomersAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'customers.read' })
  list(
    @CustomersScope() scope: CustomersScopeValue,
    @Query() query: CustomerListQueryDto,
  ): Promise<CursorPage<CustomerResponse>> {
    return this.customers.list(scope, query);
  }

  @Post()
  @RateLimit('write')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CustomersAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'customers.create' })
  create(
    @CustomersScope() scope: CustomersScopeValue,
    @Body() dto: CustomerCreateDto,
    @Req() request: { id?: unknown },
  ): Promise<CustomerResponse> {
    return this.customers.create(scope, dto, resolveRequestId(request));
  }

  @Get(':customer_id')
  @RateLimit('read')
  @UseGuards(CustomersAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'customers.read' })
  retrieve(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
  ): Promise<CustomerResponse> {
    return this.customers.retrieve(scope, customerId);
  }

  @Patch(':customer_id')
  @RateLimit('write')
  @UseGuards(CustomersAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'customers.update' })
  update(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
    @Body() dto: CustomerUpdateDto,
    @Req() request: { id?: unknown },
  ): Promise<CustomerResponse> {
    return this.customers.update(scope, customerId, dto, resolveRequestId(request));
  }

  @Delete(':customer_id')
  @RateLimit('write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CustomersAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'customers.delete' })
  async remove(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
    @Req() request: { id?: unknown },
  ): Promise<void> {
    await this.customers.delete(scope, customerId, resolveRequestId(request));
  }
}