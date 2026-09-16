# BrinnPay — Master Specification

## Product

BrinnPay is a developer-focused payment infrastructure sandbox.

It simulates payment infrastructure without processing real money.

## Goal

Provide developers with a realistic environment to integrate and test:

- payments
- refunds
- idempotency
- webhooks
- retries
- API authentication
- errors
- logs
- sandbox scenarios

The product also provides a developer-facing web application where users can:

- learn about BrinnPay
- read the API and integration documentation
- authenticate
- manage organizations and projects
- manage API keys
- inspect payments and refunds
- configure and inspect webhooks
- inspect request and audit logs
- interact with the simulated payment infrastructure

## Core Users

- Developers integrating BrinnPay
- Development teams working with payment integrations
- Organization administrators managing projects and team access

## Core Concepts

- User
- Organization
- Organization Member
- Project
- API Key
- Customer
- Payment
- Refund
- Webhook Endpoint
- Webhook Event
- Webhook Delivery
- Idempotency Key
- Audit Log

## Environments

Projects support:

- TEST
- LIVE

Both are simulated environments.

No real money is processed.

## Architecture

Initial architecture:

- Modular monolith
- NestJS backend
- Next.js web application
- PostgreSQL
- Prisma
- Redis
- BullMQ
- Docker

### Application structure

The repository uses a monorepo structure:

```text
apps/
├── api/
└── web/
```

### API application

`apps/api` is the backend application responsible for:

- authentication
- authorization
- organizations
- projects
- API keys
- customers
- payments
- refunds
- webhooks
- idempotency
- rate limiting
- request logs
- audit logs
- background processing
- API documentation

### Web application

`apps/web` is the single Next.js application responsible for the complete BrinnPay web experience.

It contains both public and authenticated areas.

Conceptually:

```text
apps/web/

Public:
- home
- product information
- pricing or plans when applicable
- documentation
- integration guides

Authentication:
- login
- registration
- session-related flows

Authenticated:
- dashboard
- organizations
- projects
- API keys
- customers
- payments
- refunds
- webhooks
- request logs
- audit logs
- settings
```

The public site, documentation, authentication UI, and developer dashboard are part of the same web application.

They are not required to be separate applications during the MVP.

### Packages

`packages/` contains shared libraries or configuration only when a concrete reuse need exists.

Possible future packages include:

- shared types
- shared configuration
- UI primitives
- API client
- validation schemas

No package should be created solely for theoretical future reuse.

## Core API Principles

- REST
- versioned API
- consistent errors
- request IDs
- pagination
- validation
- authorization
- idempotency for critical mutations

## Web Application Principles

The web application should:

- clearly separate public and authenticated areas
- protect authenticated routes
- reuse a consistent application shell
- provide responsive interfaces
- consume the backend through documented API contracts
- avoid duplicating domain/business logic that belongs to the backend
- provide an accessible developer experience
- expose documentation and integration guidance publicly where appropriate

The dashboard should be treated as a client of the API rather than as a second backend.

## Security Principles

- strong authentication
- role-based authorization
- tenant isolation
- secure API key handling
- HMAC-SHA256 webhook signatures
- rate limiting
- secure logging
- secrets never exposed
- authenticated web routes must enforce authorization
- sensitive data must not be exposed through public web routes

## MVP

The MVP must provide:

1. Authentication
2. Organizations and RBAC
3. Projects
4. API keys
5. Customers
6. Payments
7. Idempotency
8. Refunds
9. Webhooks
10. Webhook retries/replay
11. Request and audit logs
12. Rate limiting
13. Public BrinnPay web application
14. Developer dashboard
15. Public API and integration documentation
16. Sandbox simulation
17. Automated testing
18. Dockerized development
19. CI
20. Staging/production deployment

The public web application and developer dashboard are provided through the same Next.js application.

## Out of Scope for MVP

- real payment processing
- real card data
- microservices
- Kubernetes
- multi-region infrastructure
- AI features
- billing
- enterprise SSO
- dedicated CLI application
- separate standalone documentation application
- separate frontend applications for each product area

## Source of Truth

This document defines the global product context.

Detailed behavior belongs to the specification of each phase.

Phase specifications may refine these requirements but must not contradict the master specification without an explicit architectural decision.
