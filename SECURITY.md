# Política de seguridad

## Proyectos soportados

Solo se soporta la última versión del proyecto. Las versiones anteriores no reciben correcciones de seguridad.

| Versión | Soportado |
| --- | --- |
| `develop` (último commit) / `main` | ✅ |
| Cualquier tag o rama anterior | ❌ |

## Qué es BrinnPay (y qué no)

BrinnPay es un **sandbox de infraestructura de pagos**: no procesa dinero real, no está afiliado a ninguna pasarela y **no debe usarse en producción como sistema de pagos**. Aun así, tratamos la seguridad del código en serio: autenticación, aislamiento de tenant, gestión de secretos y manejo de entrada están revisados y con pruebas (ver [docs/security-review.md](docs/security-review.md)).

## Reportar una vulnerabilidad

**No abras un issue público para vulnerabilidades.**

Usa [GitHub Security Advisories](https://github.com/DaniielDz/BrinnPay/security/advisories/new) (vulnerability reporting privado) para describir el hallazgo. Incluye:

- Descripción del problema y su impacto
- Pasos de reproducción (poc, requests, etc.)
- Versión o commit afectado
- Cualquier mitigación conocida

Recibirás acuse de recibo en un plazo razonable y te mantendremos informado sobre el estado del reporte. Una vez corregido y publicado el fix, daremos crédito en el changelog salvo que prefieras permanecer anónimo.

## Alcance

**En alcance:**

- Autenticación y autorización (incluido IDOR y aislamiento de tenant)
- Inyección (SQL, NoSQL, command injection, template injection)
- XSS y CSRF
- Gestión de secretos y exposición de datos sensibles
- Rate limiting y abuso de la API
- Webhooks: firma, validación de destinos y manejo de secretos de destino

**Fuera de alcance:**

- Dependencias de terceros con vectores meramente teóricos sin impacto en BrinnPay (se gestionan igualmente vía Dependabot y el gate de CI, pero por el canal de dependencias)
- Issues en entornos de desarrollo locales con configuración modificada por el usuario
- Reportes sin impacto de seguridad demostrable (por ejemplo, banners de versión)
- Denial of service a escala que requiera capacidades de atacante fuera del alcance de un sandbox
