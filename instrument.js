// instrument.js — Sentry initialization.
//
// This is required as the very first line of server.js so Sentry loads before
// any other module (required for its auto-instrumentation). It stays completely
// inert unless SENTRY_DSN is set, so local development, the test suite, and CI
// are unaffected — Sentry only activates in production where the DSN is configured.

require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Sample 10% of requests for performance tracing — plenty of signal, low overhead.
    tracesSampleRate: 0.1,
  });
}
