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
  UseGuards,
} from '@nestjs/common';

import { RequireCapability } from '../organizations/org-rbac.guard';
import type { CursorPage } from '../organizations/cursor';
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
  @UseGuards(CustomersAccessGuard)
  @RequireCapability({ capability: 'customers.read' })
  list(
    @CustomersScope() scope: CustomersScopeValue,
    @Query() query: CustomerListQueryDto,
  ): Promise<CursorPage<CustomerResponse>> {
    return this.customers.list(scope, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CustomersAccessGuard)
  @RequireCapability({ capability: 'customers.create' })
  create(
    @CustomersScope() scope: CustomersScopeValue,
    @Body() dto: CustomerCreateDto,
  ): Promise<CustomerResponse> {
    return this.customers.create(scope, dto);
  }

  @Get(':customer_id')
  @UseGuards(CustomersAccessGuard)
  @RequireCapability({ capability: 'customers.read' })
  retrieve(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
  ): Promise<CustomerResponse> {
    return this.customers.retrieve(scope, customerId);
  }

  @Patch(':customer_id')
  @UseGuards(CustomersAccessGuard)
  @RequireCapability({ capability: 'customers.update' })
  update(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
    @Body() dto: CustomerUpdateDto,
  ): Promise<CustomerResponse> {
    return this.customers.update(scope, customerId, dto);
  }

  @Delete(':customer_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CustomersAccessGuard)
  @RequireCapability({ capability: 'customers.delete' })
  async remove(
    @CustomersScope() scope: CustomersScopeValue,
    @Param('customer_id') customerId: string,
  ): Promise<void> {
    await this.customers.delete(scope, customerId);
  }
}