// server.test.js — API contract tests for the India Geo API.
// Run with: npm test  (uses Node's built-in test runner)
//
// These are fast, deterministic contract tests: they verify routing, input
// validation, and response shapes without depending on the database or the
// Gemini API, so they pass anywhere (including CI with no secrets). The data
// "happy paths" are covered by the live /api-docs "Try it out" and manual checks.

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('./server');

test('GET /health returns ok status and uptime', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
  assert.strictEqual(typeof res.body.uptime, 'number');
});

test('GET / returns a running message', async () => {
  const res = await request(app).get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /running/i);
});

test('GET /autocomplete with fewer than 2 chars returns an empty array', async () => {
  const res = await request(app).get('/autocomplete').query({ q: 'a' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('GET /reverse-geocode with no params returns 400', async () => {
  const res = await request(app).get('/reverse-geocode');
  assert.strictEqual(res.statusCode, 400);
});

test('GET /reverse-geocode with out-of-range lat returns 400', async () => {
  const res = await request(app).get('/reverse-geocode?lat=200&lng=80');
  assert.strictEqual(res.statusCode, 400);
});

test('GET /autocomplete with an overlong query returns 400', async () => {
  const res = await request(app).get('/autocomplete').query({ q: 'a'.repeat(61) });
  assert.strictEqual(res.status, 400);
});

test('GET /ask without a question returns 400', async () => {
  const res = await request(app).get('/ask');
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test('GET /ask with an overlong question returns 400', async () => {
  const res = await request(app).get('/ask').query({ q: 'a'.repeat(201) });
  assert.strictEqual(res.status, 400);
});

test('GET /api-docs serves the Swagger UI', async () => {
  const res = await request(app).get('/api-docs/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
});
