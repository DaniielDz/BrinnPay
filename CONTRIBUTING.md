# Contribuir a BrinnPay

Gracias por tu interés en BrinnPay. Este documento explica cómo trabajar en el proyecto para que tus cambios lleguen a `develop` con la menor fricción posible.

BrinnPay es un sandbox de infraestructura de pagos en desarrollo activo: todavía no hay releases versionadas y la mayor parte del trabajo sigue el [ROADMAP.md](ROADMAP.md).

## Antes de empezar

1. Lee [AGENTS.md](AGENTS.md): contiene las reglas del proyecto (son las mismas que siguen los agentes de IA).
2. Revisa la especificación relevante: [.ai/SPEC.md](.ai/SPEC.md) para el alcance general y [.ai/phases/](.ai/phases/) para la fase concreta.
3. Entiende la arquitectura existente antes de cambiarla: preferimos soluciones simples y mantenibles frente a abstracciones prematuras.

## Principios

- **La especificación es la fuente de verdad.** No implementes funcionalidades fuera de la especificación actual. Si un requisito es ambiguo, no inventes comportamiento de negocio: plantea la ambigüedad y propón la solución razonable más pequeña.
- **La seguridad es un requisito de primer nivel**: autenticación, autorización, aislamiento de tenant, validación de entrada, manejo de secretos, rate limiting y logging seguro siempre se consideran.
- **Todo comportamiento importante tiene pruebas.**
- **Nada de microservicios** salvo que la especificación lo pida explícitamente.
- **Compatibilidad hacia atrás** salvo que la especificación diga lo contrario.

## Flujo de trabajo

### 1. Ramas

Usa [Git Flow](https://www.atlassian.com/git/tutorials/comparing-branches#feature-branches) con nombres explícitos:

| Tipo | Ejemplo | Destino |
| --- | --- | --- |
| `feature/*` | `feature/phase-21-production-docker` | `develop` |
| `fix/*` | `fix/webhook-retry-clamp` | `develop` |
| `refactor/*` | `refactor/rate-limit-discriminator` | `develop` |
| `security/*` | `security/api-key-rotation` | `develop` |
| `chore/*` | `chore/roadmap-sync` | `develop` |
| `release/*`, `hotfix/*` | `release/v0.1.0` | `main` |

No hagas force-push en ramas protegidas (`main`, `develop`).

### 2. Commits

- Convención [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `security:`.
- Commits enfocados: un commit = un cambio comprensible por sí solo.
- Nunca subas secretos, claves, tokens ni credenciales. Los archivos `.env` están ignorados por Git y deben permanecer así.

### 3. Checks obligatorios

Antes de considerar un cambio terminado (y antes de abrir el PR), ejecuta desde la raíz:

```sh
pnpm lint          # ESLint + lint del contrato OpenAPI
pnpm typecheck     # verificación de tipos
pnpm test          # pruebas unitarias
pnpm test:e2e      # integración/e2e (requiere Postgres + Redis y migraciones)
pnpm build         # build de todos los paquetes
```

El CI ejecuta exactamente esta cadena (más cobertura, tests de navegador y gate de vulnerabilidades), así que un PR verde localmente casi siempre es verde en CI.

Si el cambio afecta al contrato de la API, actualiza `docs/openapi.yaml` en el mismo PR: el contrato es la fuente única de verdad y el build falla si implementation y contrato divergen.

### 4. Especificaciones, ADRs y roadmap

- Un cambio de comportamiento o de alcance debe reflejarse en la especificación de fase correspondiente (o en una fase nueva).
- Una decisión técnica relevante (arquitectura, formato de contrato, política de seguridad, estrategia de datos) se registra como ADR en [`.ai/decisions/`](.ai/decisions/) con el formato de los existentes.
- Al completar trabajo de una fase, marca los checkboxes en [ROADMAP.md](ROADMAP.md): es nuestro registro de estado.

### 5. Pull requests

- Destino: `develop` (excepto releases/hotfixes, que van a `main`).
- Describe: **qué** cambia, **por qué**, cómo se validó y qué implicaciones de seguridad tiene.
- Incluye la actualización de tests y docs necesaria para el cambio.
- Si toca código sensible a seguridad (auth, autorización, aislamiento de tenant, secretos, inyección, IDOR, rate limiting), menciónalo explícitamente para que pueda revisarse con foco.

## Probar los cambios

```sh
# infraestructura local
docker compose -f docker/compose.yml up -d postgres redis

# migraciones
DATABASE_URL="postgresql://brinnpay:brinnpay@localhost:5432/brinnpay?schema=public" \
  pnpm --filter @brinnpay/api prisma:migrate:deploy

# stack completo (o apps por separado, ver README)
docker compose -f docker/compose.yml up -d --build
```

Detalles de puertos, profiles (`worker`, `monitoring`) y troubleshooting en [docker/README.md](docker/README.md) y [monitoring/README.md](monitoring/README.md).

## Seguridad

- No abras issues públicos para vulnerabilidades explícitas: contacta al mantenedor por privado a través de su perfil de GitHub.
- Nunca incluyas secretos reales en commits, issues, PRs ni capturas.
- Las revisiones de seguridad formales quedan registradas en [docs/security-review.md](docs/security-review.md).

## Estilo de código

- Sigue las convenciones del archivo que estás editando (formato, nombres, patrones existentes).
- Prefiere soluciones simples y directas; evita abstracciones que solo una llamada justifica.
- Sin comentarios de código salvo que expliquen el *porqué* no obvio.
- Idioma: README y CONTRIBUTING en español; specs, ADRs y documentación de diseño en inglés. Escribe en el idioma del artefacto que estés tocando.

## Licencia

Al contribuir, tus cambios se distribuyen bajo la [licencia MIT](LICENSE) del proyecto.
