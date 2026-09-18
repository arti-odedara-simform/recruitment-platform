import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectDatabase } from './db/client.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
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
