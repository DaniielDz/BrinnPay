# BrinnPay Roadmap

> Payment infrastructure sandbox for developers. This document defines the complete development roadmap from project setup to MVP release.

---

## Overview

| Phase | Name                    | Focus                                     |
| ----- | ----------------------- | ----------------------------------------- |
| 0     | Project & AI Foundation | Tooling, workflow, and AI agent setup     |
| 1     | Architecture & MVP Spec | Design decisions, domain model, contracts |
| 2     | Foundation              | Core stack, Docker, health checks         |
| 3     | Authentication          | Registration, login, tokens, security     |
| 4     | Organizations & RBAC    | Multi-tenancy, roles, permissions         |
| 5     | Projects & API Keys     | Key management, environments, rotation    |
| 6     | Customers               | CRUD, pagination, filtering               |
| 7     | Payments                | Model, state machine, simulation          |
| 8     | Idempotency             | Keys, constraints, concurrency            |
| 9     | Refunds                 | Full/partial refunds, validation          |
| 10    | Webhooks                | Events, delivery, HMAC, retries           |
| 11    | Request Logging         | Request IDs, structured logs              |
| 12    | Audit Logs              | Security and business events              |
| 13    | Rate Limiting           | IP, API key, and endpoint limits          |
| 14    | Web Application         | Public site, authentication UI, dashboard |
| 15    | Developer Experience    | Docs, examples, integration guides        |
| 16    | Sandbox                 | Simulation scenarios                      |
| 17    | Testing                 | Unit, integration, e2e                    |
| 18    | Security Hardening      | Authorization, OWASP, secrets             |
| 19    | Performance             | Load testing, optimization                |
| 20    | Observability           | Metrics, monitoring, health               |
| 21    | Production Docker       | Images, config, secrets                   |
| 22    | Staging                 | Environment, automated deployment         |
| 23    | CI/CD                   | Pipeline, releases                        |
| 24    | AWS                     | Compute, RDS, Redis, IAM                  |
| 25    | Open Source             | Community, templates, licensing           |
| 26    | MVP Release             | QA, security review, v0.1.0               |

---

## Phase 0 — Project & AI Foundation

**Goal:** Establish development tooling, Git workflow, and AI-assisted development environment.

- [x] GitHub repository + branches + rulesets
- [x] Git workflow (conventional commits, PR flow)
- [x] OpenCode configuration
- [x] `AGENTS.md` — project rules for AI agents
- [x] `master SPEC.md` — source of truth specification
- [x] AI agents setup
- [x] Custom commands
- [x] Monorepo/tooling (workspace setup)
- [x] Docker base images
- [x] Basic CI pipeline
- [x] Definition of Done

---

## Phase 1 — Architecture & MVP Spec

**Goal:** Define the system architecture, domain model, and API contracts before writing code.

- [x] Actors identification (platform admin, org admin, developer, end user)
- [x] Environment definitions (local, staging, production)
- [x] Domain model (entities, relationships, boundaries)
- [x] API conventions (naming, versioning, pagination, errors)
- [x] OpenAPI contract
- [x] ID strategy (UUIDs, CUIDs, or ULIDs)
- [x] Event system design
- [x] Security baseline
- [x] Web application structure and route boundaries
- [x] Public vs authenticated application areas
- [x] MVP boundaries and scope

---

## Phase 2 — Foundation

**Goal:** Scaffold the core application stack with health checks and basic infrastructure.

- [x] NestJS backend setup (`apps/api`)
- [x] Next.js web application setup (`apps/web`)
- [x] Public web application structure
- [x] Initial routing structure for public and authenticated areas
- [x] PostgreSQL database
- [x] Prisma ORM + schema
- [x] Redis (cache/queues)
- [x] Docker Compose (local dev)
- [x] Request validation (pipes/DTOs)
- [x] Structured logging base
- [x] Health check endpoints
- [x] OpenAPI/Swagger integration

---

## Phase 3 — Authentication

**Goal:** Implement user registration, login, and secure session management.

- [x] User registration
- [x] User login
- [x] Token/session management (JWT + refresh)
- [x] Password hashing (bcrypt/argon2)
- [x] Rate limiting (auth endpoints)
- [x] Authentication UI in `apps/web`
- [x] Login UI
- [x] Registration UI
- [x] Session handling in the web application
- [x] Auth tests

---

## Phase 4 — Organizations & RBAC

**Goal:** Enable multi-tenancy with organization management and role-based access control.

- [x] Organizations CRUD
- [x] Member management (invite, remove)
- [x] Role definitions (owner, admin, member, viewer)
- [x] Permission system
- [x] Tenant isolation (data scoping)
- [x] Organization management UI in `apps/web`
- [x] Member and role management UI

---

## Phase 5 — Projects & API Keys

**Goal:** Allow organizations to create projects and manage API keys per environment.

- [x] Projects CRUD
- [x] TEST vs LIVE environment separation
- [x] API key generation
- [x] Key rotation
- [x] Key revocation
- [x] Project management UI
- [x] API key management UI
- [x] Environment selection UI

---

## Phase 6 — Customers

**Goal:** CRUD operations for customer records with pagination and filtering.

- [x] Customer CRUD
- [x] Pagination (cursor-based)
- [x] Filtering and search
- [x] Customers UI in the dashboard

---

## Phase 7 — Payments

**Goal:** Core payment model with state machine and simulation capabilities.

- [x] Payment data model
- [x] Payment API (create, retrieve, list)
- [x] Payment state machine (pending, processing, succeeded, failed)
- [x] Payment simulation (no real money)
- [x] Payments UI in the dashboard

---

## Phase 8 — Idempotency

**Goal:** Ensure safe retries and prevent duplicate operations.

- [x] Idempotency key support
- [x] Database constraints for uniqueness
- [x] Transaction-safe operations
- [x] Concurrency tests
- [x] Idempotency behavior reflected in API documentation

---

## Phase 9 — Refunds

**Goal:** Support full and partial refunds with proper validation.

- [x] Full refund flow
- [x] Partial refund flow
- [x] Refund validation rules
- [x] Refund API endpoints
- [x] Refunds UI in the dashboard

---

## Phase 10 — Webhooks

**Goal:** Reliable event delivery with HMAC signing, retries, and replay.

- [x] Event system
- [x] Webhook registration
- [x] HMAC-SHA256 signature verification
- [x] Redis/BullMQ queue for delivery
- [x] Retry policy (exponential backoff)
- [x] Webhook replay
- [x] Webhook management UI
- [x] Webhook event and delivery visibility in the dashboard

---

## Phase 11 — Request Logging

**Goal:** Traceable, structured logs for every API request.

- [x] Request ID propagation
- [x] Structured JSON logging
- [x] API request/response logs
- [x] Request log viewer in the dashboard

---

## Phase 12 — Audit Logs

**Goal:** Immutable audit trail for security and business events.

- [x] Security event logging (auth, access)
- [x] Business event logging (payments, refunds)
- [x] Audit log API
- [x] Audit log viewer in the dashboard

---

## Phase 13 — Rate Limiting

**Goal:** Protect the API with configurable rate limits.

- [x] IP-based rate limiting
- [x] API key-based rate limiting
- [x] Endpoint-specific limits
- [x] Rate limit headers
- [x] Rate limit behavior documented in developer documentation

---

## Phase 14 — Web Application

**Goal:** Deliver the complete BrinnPay web experience, combining the public website, developer-facing information, authentication flows, and authenticated dashboard in a single Next.js application.

- [x] Public home page
- [x] Product overview pages
- [x] Public navigation and footer
- [x] Login flow
- [x] Registration flow
- [x] Authenticated dashboard shell
- [x] Dashboard overview
- [x] Payments view
- [x] Customers view
- [x] Refunds view
- [x] Webhooks management
- [x] API keys management
- [x] Projects management
- [x] Organizations and settings
- [x] Request logs viewer
- [x] Audit logs viewer
- [x] Responsive layout
- [x] Authentication-aware route protection
- [x] Consistent application layout and navigation

> Note: Public documentation is implemented as part of the `apps/web` application and is covered in detail in Phase 15.

---

## Phase 15 — Developer Experience

**Goal:** Make BrinnPay understandable and easy to integrate for developers.

- [x] Public documentation section in `apps/web`
- [x] OpenAPI documentation
- [x] API reference docs
- [x] Authentication guide
- [x] API key usage guide
- [x] TEST/LIVE environment guide
- [x] Payments guide
- [x] Refunds guide
- [x] Idempotency guide
- [x] Webhooks guide
- [x] Error handling guide
- [x] cURL examples
- [x] Code examples
- [x] Integration guides
- [x] Sandbox usage guide
- [x] Local development guide
- [x] Developer onboarding flow

---

## Phase 16 — Sandbox

**Goal:** Realistic simulation of payment scenarios without real money.

- [x] Success simulation
- [x] Decline simulation
- [x] Timeout simulation
- [x] Webhook failure simulation

---

## Phase 17 — Testing

**Goal:** Comprehensive test coverage across all layers.

- [x] Unit tests
- [x] Integration tests
- [x] End-to-end tests
- [x] Critical flow coverage
- [x] Web application critical flow coverage
- [x] Authentication flow coverage
- [x] Payment and refund flow coverage
- [x] Webhook flow coverage

---

## Phase 18 — Security Hardening

**Goal:** Systematic security review and hardening.

- [ ] Authorization review (IDOR prevention)
- [ ] Tenant isolation verification
- [ ] API security (injection, XSS)
- [ ] Web application security review
- [ ] Session and authentication review
- [ ] Secrets management review
- [ ] OWASP Top 10 checklist

---

## Phase 19 — Performance

**Goal:** Validate performance under load and optimize bottlenecks.

- [ ] k6 load testing scripts
- [ ] Load test scenarios
- [ ] Bottleneck identification
- [ ] Performance optimization
- [ ] Review API performance under dashboard usage

---

## Phase 20 — Observability

**Goal:** Production-ready monitoring and alerting.

- [ ] Metrics collection (Prometheus/custom)
- [ ] Health/readiness endpoints
- [ ] Monitoring dashboards
- [ ] API error monitoring
- [ ] Background job monitoring

---

## Phase 21 — Production Docker

**Goal:** Optimized Docker images for production deployment.

- [ ] Production Dockerfile for API
- [ ] Production Dockerfile/build strategy for web
- [ ] Configuration management
- [ ] Secrets injection
- [ ] Production runtime validation

---

## Phase 22 — Staging

**Goal:** Automated staging environment mirroring production.

- [ ] Staging environment setup
- [ ] API deployment
- [ ] Web application deployment
- [ ] Database and Redis configuration
- [ ] Automated deployment pipeline

---

## Phase 23 — CI/CD

**Goal:** Automated build, test, and deployment pipeline.

- [ ] Advanced CI (tests, lint, security)
- [ ] API build and validation
- [ ] Web build and validation
- [ ] Staging auto-deploy
- [ ] Production deploy pipeline
- [ ] Release automation

---

## Phase 24 — AWS

**Goal:** Production infrastructure on AWS.

- [ ] Compute (ECS/EKS or EC2)
- [ ] RDS PostgreSQL
- [ ] ElastiCache Redis
- [ ] CloudWatch logging
- [ ] IAM policies
- [ ] Secrets Manager
- [ ] API deployment
- [ ] Web application deployment

---

## Phase 25 — Open Source

**Goal:** Prepare the repository for public consumption.

- [ ] README
- [ ] CONTRIBUTING guide
- [ ] SECURITY policy
- [ ] LICENSE
- [ ] Issue templates
- [ ] PR template
- [ ] Architecture documentation
- [ ] Local development documentation
- [ ] Public project documentation

---

## Phase 26 — MVP Release

**Goal:** Ship v0.1.0 with confidence.

- [ ] Final QA pass
- [ ] Security review sign-off
- [ ] Final documentation
- [ ] Verify public web experience
- [ ] Verify authentication flows
- [ ] Verify dashboard critical flows
- [ ] Verify API documentation
- [ ] Verify staging/production deployment
- [ ] **Release v0.1.0**

---

## Future

Ideas beyond the MVP scope:

- Official SDKs (Node.js, Python, Go)
- CLI tool
- Local webhook tooling
- Advanced simulation scenarios
- Analytics dashboard
- API versioning strategy
- Billing integration
- Team collaboration features
- Self-hosting guide
- Cloud edition
- AI-assisted debugging
- Advanced testing scenarios
- Enterprise features
