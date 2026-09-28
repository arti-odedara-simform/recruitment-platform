import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectDatabase } from './db/client.js';
import { assertRlsReady } from './repositories/rls.repository.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/**
 * PLAN.md §1 layer 3, probed once at boot so the answer is in the log rather than
 * discovered per request. With `DB_RLS=require` a missing role stops the process; with
 * the default `auto` it is a warning, because layers 1 and 2 are unconditional and a
 * laptop that cannot create a Postgres role should still be able to run the API.
 */
assertRlsReady()
  .then((status) => {
    console.log(
      status === 'enforced'
        ? '[api] db: interviewer reads run as app_interviewer (PLAN.md §1 layer 3)'
        : `[api] db: layer 3 ${status} — run \`npm run db:rls\` to install it`,
    );
  })
  .catch((error: unknown) => {
    console.error('[api]', error instanceof Error ? error.message : error);
    process.exit(1);
  });

/**
 * Graceful shutdown: stop accepting connections, drain in-flight requests, then close
 * the pool. Without this, `docker compose down` can kill the process mid-transaction.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);

  const forced = setTimeout(() => {
    console.error('[api] did not close in 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await disconnectDatabase();
  clearTimeout(forced);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
