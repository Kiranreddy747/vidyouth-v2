/**
 * Loaded via `node --import ./tests/setup.ts` BEFORE any app module.
 * Forces NODE_ENV=test so config/env.ts validates in test mode and
 * server.ts does NOT auto-listen (the suite drives the app via inject()).
 */
process.env.NODE_ENV = 'test';
