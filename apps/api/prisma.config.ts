import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma ORM 7 CLI configuration (privatized from the schema datasource block).
// The development fallback mirrors `src/config/configuration.ts` (D7): it is a
// non-secret localhost default so `prisma generate` works without a `.env`.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://brinnpay:brinnpay@localhost:5432/brinnpay?schema=public',
  },
});