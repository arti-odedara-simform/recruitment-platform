import { config } from 'dotenv';

/**
 * Runs in every worker before any application module is imported, so
 * src/config/env.ts sees the test database. `override: true` matters: dotenv will not
 * replace a variable that is already set, and the app's own `dotenv/config` import
 * would otherwise leave a stray shell value in place.
 */
config({ path: '.env.test', override: true });
