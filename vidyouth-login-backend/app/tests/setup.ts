/**
 * Loaded via `node --import ./tests/setup.ts` BEFORE any app module.
 *
 * Forces NODE_ENV=test so config/env.ts validates in test mode and
 * server.ts does NOT auto-listen (the suite drives the app via
 * app.inject()). Other env comes from app/.env (dotenv) exactly like
 * production would load it from Secrets Manager.
 */

process.env.NODE_ENV = 'test';
process.env.EMAIL_PROVIDER = 'mock';
process.env.SMS_PROVIDER = 'mock';
// The test helper passes `logger: false` to buildApp(), so logs stay quiet
// without touching LOG_LEVEL (whose Zod enum has no "silent" member).
