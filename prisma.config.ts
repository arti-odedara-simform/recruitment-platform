import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of schema.prisma: the CLI (migrate, db, studio)
 * reads it from here, and the runtime client gets it through the pg driver adapter in
 * src/db/client.ts. Both ultimately read DATABASE_URL — see .env.example.
 *
 * This deliberately reads process.env rather than prisma/config's `env()` helper, which
 * throws on a missing variable at *config load* time. `prisma generate` needs no
 * database, and the Docker build runs it in an image that has no .env — with `env()`
 * the image build fails. A URL that is genuinely missing still fails, with Prisma's own
 * message, on the commands that actually need one.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
