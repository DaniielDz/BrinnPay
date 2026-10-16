[![CI](https://github.com/DaniielDz/BrinnPay/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/DaniielDz/BrinnPay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

# BrinnPay

**Sandbox de infraestructura de pagos para desarrolladores.**

BrinnPay es una plataforma de pagos simulados: una API REST y un dashboard desde los que se pueden construir, probar e integrar flujos de pago completos — pagos, reembolsos, webhooks, idempotencia, rate limiting, auditoría y observabilidad — **sin procesar dinero real**.

> **Estado del proyecto:** en desarrollo activo. Las fases 0–20 del roadmap están completadas (specs, implementación, pruebas, revisión de seguridad, rendimiento y observabilidad). **Todavía no hay una release oficial**: todo el desarrollo ocurre en la rama [`develop`](https://github.com/DaniielDz/BrinnPay/tree/develop) y las fases 21–26 (despliegue productivo, open source y release v0.1.0) están pendientes. Consulta [ROADMAP.md](ROADMAP.md).

---

## Contenido

- [¿Qué es BrinnPay?](#qué-es-brinnpay)
- [Características](#características)
- [Stack tecnológico](#stack-tecnológico)
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Comandos de desarrollo](#comandos-de-desarrollo)
- [Pruebas](#pruebas)
- [Documentación de la API](#documentación-de-la-api)
- [Observabilidad](#observabilidad)
- [Testing de carga](#testing-de-carga)
- [Desarrollo asistido por IA (Spec-Driven Development)](#desarrollo-asistido-por-ia-spec-driven-development)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Roadmap](#roadmap)
- [Contribuir](#contribuir)
- [Aviso importante](#aviso-importante)
- [Licencia](#licencia)

---

## ¿Qué es BrinnPay?

BrinnPay reproduce la superficie de una plataforma de pagos real para que puedas desarrollar e integrar contra ella sin depender de ningún proveedor ni mover dinero:

- **API REST** (`/api/v1`) con autenticación por sesión (dashboard) y por API key (integraciones), contratos OpenAPI y límites de tasa.
- **Dashboard web** con el ciclo completo: proyectos, API keys, clientes, pagos, reembolsos, webhooks, logs de peticiones y auditoría.
- **Sandbox determinista**: los pagos avanzan solos (`pending → processing → succeeded`) y puedes forzar escenarios de éxito, rechazo o timeout para probar tu integración.
- **Webhooks firmados** con reintentos automáticos, replay y visibilidad de cada intento de entrega.
- **Herramientas de operación**: métricas, dashboards de Grafana, alertas, logs estructurados con `request_id` y un registro de auditoría inmutable.

Está pensado para dos audiencias: desarrolladores que quieren **aprender a construir la infraestructura de un sistema de pagos** (idempotencia, consistencia, entrega de eventos, rate limiting) y equipos que quieren **probar integraciones** contra un sandbox autoalojado.

## Características

### API y dominio

- **Autenticación**: registro, login, refresh con rotación, cookies HttpOnly y hashing de contraseñas con Argon2.
- **Multi-tenancy con RBAC**: organizaciones, invitaciones y roles (`owner`, `admin`, `member`, `viewer`) con aislamiento de tenant verificado.
- **Proyectos y API keys**: entornos **TEST** y **LIVE** separados, claves con hash almacenado (la clave en claro solo se muestra una vez), rotación y revocación.
- **Clientes**: CRUD con paginación por cursor y filtros.
- **Pagos**: máquina de estados (`pending`, `processing`, `succeeded`, `failed`), simulación sin dinero real y escenarios (`success`, `decline`, `timeout`).
- **Reembolsos**: totales y parciales, con serialización de escrituras concurrentes (`SELECT ... FOR UPDATE`) y validación del saldo reembolsable.
- **Idempotencia**: header `Idempotency-Key` con reclamo atómico en base de datos (`INSERT ... ON CONFLICT DO NOTHING`), replay de la respuesta original durante 24 h y pruebas de concurrencia.
- **Webhooks**: eventos duraderos en DB, entrega por worker BullMQ en proceso separado, firma `BrinnPay-Signature: t=<unix>,v1=<HMAC-SHA256>` con comparación en tiempo constante, reintentos con exponential backoff + full jitter, replay manual, listas blancas/negras de destinos y retención de 30 días.

### Plataforma

- **Rate limiting** multi-ámbito (IP, API key y clase de endpoint) sobre Redis, con headers HTTP y modo degradado configurable cuando Redis no está disponible.
- **Request logging** estructurado (JSON) con propagación de `request_id` y retención de 30 días, consultable desde el dashboard.
- **Audit log inmutable** (append-only, respaldado por un trigger de base de datos) para eventos de seguridad y de negocio.
- **Contrato OpenAPI** como fuente única de verdad (`docs/openapi.yaml`), con Swagger UI y conformance testing que hace fallar el build si el código y el contrato divergen.
- **Documentación para desarrolladores** dentro de la web: quickstart, autenticación, API keys, entornos, pagos, reembolsos, idempotencia, webhooks, errores, rate limits, logs, sandbox y desarrollo local.
- **Dashboard web** (Next.js): resumen, proyectos, API keys, clientes, pagos, reembolsos, webhooks con detalle de entregas, logs de peticiones, auditoría, organizaciones e invitaciones.

### Calidad y operación

- **Suite de pruebas** de más de 130 archivos y 1.200 casos: unitarias, de integración/e2e (API y web) y flujos críticos en navegador con Playwright.
- **Coverage ratchet**: los umbrales de cobertura no pueden bajar (ADR-0034) y se verifican en CI.
- **CI completo** (GitHub Actions): lint → typecheck → unit tests → cobertura → migraciones → e2e (con Postgres y Redis reales) → build → tests de navegador → lint del contrato OpenAPI → gate de vulnerabilidades de dependencias.
- **Revisión de seguridad** explícita ([docs/security-review.md](docs/security-review.md)): checklist OWASP Top 10, IDOR, aislamiento de tenant y gestión de secretos — aceptada el 2026-10-13 sin hallazgos críticos ni altos.
- **Rendimiento**: baseline de rendimiento comprometido ([docs/performance-baseline.md](docs/performance-baseline.md)) y escenarios de carga k6 (S1–S8).
- **Observabilidad**: métricas Prometheus propias en API y worker, tres dashboards de Grafana (API, worker, infraestructura) y cuatro reglas de alerta con Alertmanager.

## Stack tecnológico

| Capa | Tecnología |
| --- | --- |
| Backend | Node.js 22, TypeScript, [NestJS 11](https://nestjs.com/) |
| Frontend | Next.js 15, React 19, TypeScript |
| Base de datos | PostgreSQL 17 + Prisma ORM (migraciones versionadas) |
| Cache y colas | Redis 7 + BullMQ (worker de webhooks) |
| Autenticación | JWT + refresh con rotación, Argon2, cookies HttpOnly, API keys hasheadas |
| API | REST, OpenAPI 3 (`docs/openapi.yaml`), Swagger UI |
| Pruebas | Jest, Vitest, Playwright, k6 |
| Monitoreo | Prometheus, Grafana, Alertmanager, exporters |
| Empaquetado | Docker Compose, monorepo pnpm |
| IA / workflow | OpenCode (agentes y comandos), especificaciones y ADRs en `.ai/` |

## Arquitectura

Monolito modular con un worker en proceso aparte:

```text
                       ┌──────────────────────────────┐
   Dashboard (web) ───▶│  API NestJS  (/api/v1)       │
                       │  - auth / orgs / RBAC        │
   Integraciones ─────▶│  - pagos / reembolsos        │────▶ PostgreSQL
   (API keys)          │  - webhooks / logs / audit   │        │
                       │  - rate limiting (Redis)     │        │
                       │  - /metrics (Prometheus)     │        │
                       └──────────────┬───────────────┘        │
                                      │ encola eventos          │
                                      ▼                          │
                       ┌──────────────────────────────┐        │
                       │  Worker (proceso aparte)     │◀───────┘
                       │  - entrega de webhooks       │
                       │    (firmas, reintentos)      │
                       │  - sweeps y limpieza         │
                       │  - /metrics (puerto propio)  │
                       └──────────────────────────────┘
                                      │
                                      ▼
                              Redis (BullMQ)
```

Decisiones clave documentadas como ADRs en [`.ai/decisions/`](.ai/decisions/) (42 hasta la fecha): estrategia de IDs (UUIDv7), hashing de API keys, modelo de entrega de webhooks, retención de idempotencia, arquitectura de métricas, política de alertas, cobertura mínima, entre otras.

## Requisitos

- **Node.js 22+**
- **pnpm 12.4.1** (el repo lo fija; con Corepack/`devEngines` se usa automáticamente)
- **Docker + Docker Compose** (para la base de datos, Redis y el stack completo)
- **Git**

## Inicio rápido

### 1. Clonar e instalar

```sh
git clone https://github.com/DaniielDz/BrinnPay.git
cd BrinnPay
pnpm install
```

### 2. Generar los secretos locales de desarrollo

La API valida en arranque que existan dos secretos; no están commiteados y viven en archivos `.env` ignorados por Git:

```sh
cp docker/.env.example docker/.env
```

Edita `docker/.env` y genera los valores:

```sh
JWT_SECRET=$(openssl rand -base64 48)          # firma de tokens
WEBHOOK_ENCRYPTION_KEY=$(openssl rand -base64 32)  # cifra los secretos de firma de webhooks en DB
```

### 3. Levantar la infraestructura y aplicar migraciones

```sh
docker compose -f docker/compose.yml up -d postgres redis

DATABASE_URL="postgresql://brinnpay:brinnpay@localhost:5432/brinnpay?schema=public" \
  pnpm --filter @brinnpay/api prisma:migrate:deploy
```

### 4. Arrancar el stack completo

```sh
docker compose -f docker/compose.yml up -d --build
```

| Servicio | URL | Notas |
| --- | --- | --- |
| Dashboard web | http://localhost:3001 | Registra una cuenta y obtienes una organización personal |
| API | http://localhost:3000/api/v1 | Base de la API versionada |
| Swagger UI | http://localhost:3000/docs | Servido desde `docs/openapi.yaml` |
| Salud | http://localhost:3000/health/live · `/health/ready` | Liveness y readiness |
| Métricas | http://localhost:3000/metrics | Formato Prometheus |

### 5. (Opcional) Worker de webhooks

Las entregas de webhooks, los sweeps de conciliación y la limpieza corren en un proceso separado que no arranca por defecto (los tests e2e gestionan sus propios workers):

```sh
docker compose -f docker/compose.yml --profile worker up -d
```

### 6. (Opcional) Stack de monitoreo

Prometheus, Grafana, Alertmanager y los exporters:

```sh
docker compose -f docker/compose.yml --profile monitoring --profile worker up -d
```

| Servicio | URL |
| --- | --- |
| Grafana | http://localhost:3002 (`admin` / `admin` en local) |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

Los puertos publicados quedan ligados a `127.0.0.1`. Detalle completo en [docker/README.md](docker/README.md) y [monitoring/README.md](monitoring/README.md).

### Alternativa: apps en el host

Si prefieres correr la API y la web en local (con hot reload nativo) y solo Docker para Postgres/Redis:

```sh
cp apps/api/.env.example apps/api/.env   # revisa DATABASE_URL, REDIS_URL y secretos
docker compose -f docker/compose.yml up -d postgres redis

pnpm --filter @brinnpay/api dev    # http://localhost:3000
pnpm --filter @brinnpay/web dev    # http://localhost:3001
```

## Comandos de desarrollo

Desde la raíz del monorepo:

| Comando | Qué hace |
| --- | --- |
| `pnpm lint` | ESLint en todos los paquetes + lint del contrato OpenAPI (Redocly) |
| `pnpm typecheck` | Verificación de tipos en todos los paquetes |
| `pnpm test` | Pruebas unitarias (API con Jest, web con Vitest) |
| `pnpm test:e2e` | Pruebas de integración/e2e (requiere Postgres + Redis y migraciones aplicadas) |
| `pnpm test:coverage` | Cobertura con los umbrales del coverage ratchet |
| `pnpm test:browser` | Flujos críticos en navegador con Playwright |
| `pnpm build` | Build de todos los paquetes |
| `pnpm loadtest` | Batería de carga k6 (requiere Docker) |
| `pnpm audit:deps` | Gate de vulnerabilidades de dependencias (`--audit-level=high`) |

## Pruebas

La estrategia está descrita en [`.ai/phases/phase-17-testing.md`](.ai/phases/phase-17-testing.md) y opera con varios niveles:

- **Unitarias**: lógica de dominio y servicios, sin infraestructura externa.
- **Integración/e2e**: API completa contra Postgres y Redis reales (autenticación, pagos, reembolsos, idempotencia, webhooks, rate limiting, logs, auditoría, métricas…) y humos de la web con Vitest.
- **Navegador**: flujos críticos del dashboard con Playwright.
- **Conformance de contrato**: verifica que la implementación cumple `docs/openapi.yaml`; la divergencia falla el build (ADR-0035).
- **Umbrales de cobertura**: la cobertura no puede bajar respecto a la línea base (API: 72% statements / 64% branches; web: 95% / 80%).

Para ejecutar los e2e en local:

```sh
docker compose -f docker/compose.yml up -d postgres redis
# aplica migraciones (paso 3 del inicio rápido) y después:
pnpm test:e2e
```

## Documentación de la API

- **Contrato OpenAPI**: [`docs/openapi.yaml`](docs/openapi.yaml) — fuente única de verdad (ADR-0012), confeccionado a mano y verificado en CI con Redocly.
- **Swagger UI**: http://localhost:3000/docs, servido directamente desde el contrato (no se genera desde decoradores).
- **Guías en la web**: sección `/docs` de la aplicación con quickstart, autenticación, API keys, entornos, pagos, reembolsos, idempotencia, webhooks, errores, rate limits, logs, sandbox y desarrollo local.
- **Convenciones y modelo de dominio**: [docs/api-conventions.md](docs/api-conventions.md) y [docs/domain-model.md](docs/domain-model.md).
- **Referencia en la web**: la página de referencia de API carga el propio contrato en tiempo de render.

## Observabilidad

El stack de monitoreo es opt-in y arranca con un comando (ver [monitoring/README.md](monitoring/README.md)):

- **Métricas** de Prometheus servidas por la API (`/metrics`) y por el worker en su propio puerto (`9464`), con opción de token de scrape.
- **Dashboards de Grafana** provisionados desde el repositorio:
  - **BrinnPay — API**: tasa de peticiones, latencia p95/p50, errores 5xx, throttles y agotamiento de rate limit, logs de peticiones en curso.
  - **BrinnPay — Webhook Worker**: trabajos de la cola por estado, entrega pendiente más antigua, resultados por intento, fair-use por proyecto, sweeps.
  - **Infraestructura**: targets de scrape, conexiones de Postgres, operaciones de Redis, RSS y event-loop.
- **4 reglas de alerta** (`monitoring/prometheus/alerts.yml`): tasa de errores alta, rate limit degradado, lag de la cola de entregas y anomalía de escritura de logs de peticiones, ruteadas por Alertmanager.

## Testing de carga

```sh
pnpm loadtest
```

Batería k6 con escenarios S1–S8 (lecturas, escrituras, picos, idempotencia, webhooks…) sobre un stack aislado, con resultados versionados en `loadtest/results/` y línea base comprometida en [docs/performance-baseline.md](docs/performance-baseline.md). No corre en CI: es una herramienta local deliberada.

## Desarrollo asistido por IA (Spec-Driven Development)

BrinnPay se construye con un flujo spec-first en el que las decisiones se toman antes que el código:

1. **Especificación maestra**: [`.ai/SPEC.md`](.ai/SPEC.md) define producto, alcance MVP y arquitectura.
2. **Specs por fase**: [`.ai/phases/`](.ai/phases/) (20 fases) con decisiones numeradas (`D1…Dn`) y preguntas abiertas (`Q1…Qn`) que deben resolverse antes de implementar.
3. **ADRs**: [`.ai/decisions/`](.ai/decisions/) (42) registran cada decisión técnica ratificada.
4. **Implementación por fase**: una fase = una rama = un PR, con los checks obligatorios (`AGENTS.md`: lint, typecheck, pruebas y build).
5. **Revisión por separado**: revisión de código, revisión de seguridad y preparación de PR/commits con reglas explícitas.

El workflow está automatizado con [OpenCode](https://opencode.ai): [.opencode/agents/](.opencode/agents/) define seis agentes con roles separados (`architect`, `builder`, `reviewer`, `security`, `tester`, `release`) y [.opencode/commands/](.opencode/commands/) ocho comandos (`spec`, `implement`, `test`, `review`, `security-review`, `commit`, `pr`, `release`). El agente que escribe specs no modifica código; el que revisa no edita; las reglas de proyecto viven en [AGENTS.md](AGENTS.md).

## Estructura del repositorio

```text
BrinnPay/
├── apps/
│   ├── api/                 # NestJS: API REST, worker BullMQ, prisma/, test/
│   └── web/                 # Next.js: sitio público, docs y dashboard
├── docs/                    # Contrato OpenAPI y documentación de diseño
├── docker/                  # Compose local (postgres, redis, api, web)
├── monitoring/              # Prometheus, Grafana, Alertmanager, alertas
├── loadtest/                # Harness de carga k6 (S1–S8)
├── .ai/                     # SPEC.md, specs de fase y ADRs
├── .opencode/               # Agentes y comandos de OpenCode
├── .github/workflows/       # CI (lint, tests, e2e, build, navegador)
├── AGENTS.md                # Reglas del proyecto para agentes de IA
└── ROADMAP.md               # Roadmap completo por fases
```

## Roadmap

27 fases (0–26). Estado resumido — el detalle vive en [ROADMAP.md](ROADMAP.md):

| Bloque | Fases | Estado |
| --- | --- | --- |
| Fundación y arquitectura | 0–2 | Completadas |
| Identidad y tenancy | 3–5 | Completadas |
| Dominio de pagos | 6–10 | Completadas |
| Plataforma (logs, auditoría, rate limit) | 11–13 | Completadas |
| Web, docs y sandbox | 14–16 | Completadas |
| Calidad: pruebas, seguridad, rendimiento | 17–19 | Completadas |
| Observabilidad | 20 | Completada |
| Producción: Docker productivo, staging, CI/CD, AWS | 21–24 | Pendientes |
| Open source y release | 25–26 | En curso / pendientes |

Ideas posteriores al MVP (SDKs, CLI, billing, self-hosting…) están en la sección `## Future` del roadmap.

## Contribuir

Aún no hay una release ni un CONTRIBUTING maduro: el proyecto está en fase de desarrollo. Si quieres probarlo, reportar un problema o colaborar, revisa [CONTRIBUTING.md](CONTRIBUTING.md) y abre un issue o un PR contra `develop`. Las contribuciones se aceptan bajo los términos de la licencia.

## Aviso importante

- BrinnPay es un **sandbox de desarrollo**: no procesa dinero real, no está afiliado a ninguna pasarela o procesadora de pagos y no debe usarse en producción como sistema de pagos.
- **No introduzcas datos reales de tarjetas ni datos personales sensibles**: el sistema no espera ni almacena datos de tarjetas, pero cualquier dato que introduzcas queda en tu base de datos local.
- Los valores por defecto de credenciales (`brinnpay`/`brinnpay`, `admin`/`admin` en Grafana) son **exclusivamente para desarrollo local**.

## Licencia

Distribuido bajo la licencia [MIT](LICENSE) — © 2026 Daniel Diaz.
