# BrinnPay — AI Project Rules

## Project

BrinnPay is a payment infrastructure sandbox for developers.

The system simulates payment flows, webhooks, refunds and related infrastructure. It does not process real money.

## Core Principles

* The specification is the source of truth.
* Do not implement features outside the current specification.
* Prefer simple, maintainable solutions.
* Do not introduce microservices unless explicitly required.
* Security is a first-class requirement.
* Every important behavior must have tests.
* Never expose secrets or sensitive credentials.
* Never log passwords, API secrets or webhook secrets.
* Database changes must use migrations.
* Preserve backwards compatibility unless the specification says otherwise.

## Architecture

Initial architecture:

* Modular monolith
* Backend: Node.js + TypeScript + NestJS
* Frontend: Next.js + TypeScript
* Database: PostgreSQL + Prisma
* Cache/queues: Redis + BullMQ
* Local infrastructure: Docker Compose
* API style: REST
* API documentation: OpenAPI

## Development Workflow

1. Read the current phase specification.
2. Understand existing architecture before changing it.
3. Implement only the requested scope.
4. Add/update tests.
5. Run required checks.
6. Review security-sensitive changes.
7. Prepare the branch for a pull request.

## Required Checks

Before considering work complete:

* lint
* typecheck
* unit tests
* relevant integration/e2e tests
* build

## Git

Use:

* main
* develop
* feature/*
* fix/*
* refactor/*
* security/*
* chore/*

Use focused commits.

Do not force-push protected branches.

## AI Behavior

Before implementing:

* inspect existing code;
* inspect relevant specifications;
* identify dependencies and risks.

When requirements are ambiguous:

* do not invent business behavior;
* state the ambiguity;
* propose the smallest reasonable solution.

When suggesting improvements outside the current scope:

* report them as recommendations;
* do not implement them automatically.

## Security

Always consider:

* authentication
* authorization
* tenant isolation
* input validation
* secret handling
* injection
* IDOR
* rate limiting
* secure logging
* cryptographic correctness

Security-sensitive changes require an explicit security review.

## Definition of Done

A task is complete only when:

* implementation matches the specification;
* acceptance criteria are satisfied;
* tests pass;
* required checks pass;
* no known critical security issue remains.
