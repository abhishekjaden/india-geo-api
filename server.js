// Load Sentry before anything else (no-op unless SENTRY_DSN is set).
require('./instrument.js');
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const pino = require('pino');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const Sentry = require('@sentry/node');
const { answerQuestion } = require('./ask');
const { parseAddress } = require('./parse-address');
const openapiSpec = require('./openapi');
const logger = pino();
const app = express();
app.set('trust proxy', 1);

// -------------------
// API DOCS (Swagger UI)
// Mounted before the global helmet: Swagger UI needs a relaxed Content-Security-
// Policy, so we scope a CSP-free helmet to /api-docs only and keep the strict
// global helmet on every other route.
// -------------------
app.use(
  '/api-docs',
  helmet({ contentSecurityPolicy: false }),
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, { customSiteTitle: 'India Geo API — API Docs' })
);

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));
// -------------------
// RATE LIMITING
// -------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);
// -------------------
// CACHE (10 mins)
// -------------------
const cache = new NodeCache({ stdTTL: 600 });
// -------------------
// DATABASE
// -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// -------------------
// ROOT
// -------------------
app.get('/', (req, res) => {
  res.send('GeoSense AI API is running 🚀');
});
// -------------------
// HEALTH
// -------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});
// -------------------
// 🔥 AI QUERY PROCESSOR
// -------------------
function processQuery(input) {
  let q = input.toLowerCase().trim();
  // normalize spaces
  q = q.replace(/\s+/g, " ");
  let parts = q.split(" ");
  // 🔥 state shortcuts
  const stateMap = {
    "tn": "tamil nadu",
    "ka": "karnataka",
    "mh": "maharashtra",
    "dl": "delhi"
  };
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (stateMap[last]) {
      parts[parts.length - 1] = stateMap[last];
      q = parts.join(" ");
    }
  }
  // 🔥 spell correction (first word focus)
  const corrections = {
    "chnai": "chennai",
    "chennaii": "chennai",
    "banglore": "bangalore",
    "bangalor": "bangalore",
    "bangluru": "bangalore",
    "delh": "delhi",
    "delih": "delhi",
    "mumabi": "mumbai"
  };
  parts = q.split(" ");
  if (corrections[parts[0]]) {
    parts[0] = corrections[parts[0]];
    q = parts.join(" ");
  }
  return q;
}
// -------------------
// 🔥 LOG A SEARCH
// Only record substantive, result-bearing queries (>= 4 chars, > 0 results)
// so analytics reflects real intent instead of keystroke fragments / typos.
// -------------------
function logSearch(query, resultCount) {
  if (query.length < 4 || resultCount === 0) return;
  pool.query(
    'INSERT INTO search_logs (query) VALUES ($1)',
    [query]
  ).catch(err => console.error('Logging error:', err));
}
// -------------------
// 🔥 AUTOCOMPLETE (FINAL)
// -------------------
app.get('/autocomplete', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.json([]);
  }
  if (q.length > 60) {
    return res.status(400).json({ error: "Query too long" });
  }
  try {
    // 🔥 STEP 1 — AI PROCESSING
    const searchQuery = processQuery(q);

    // 🔥 STEP 2 — CACHE (after processing)
    if (cache.has(searchQuery)) {
      const cached = cache.get(searchQuery);
      logSearch(searchQuery, cached.length);
      return res.json(cached);
    }

    // -------------------
    // 🔥 DB QUERY
    // -------------------
    const result = await pool.query(
      `
      SELECT
        v.name AS village,
        sd.name AS subdistrict,
        d.name AS district,
        s.name AS state,
        similarity(v.name, $1) AS score
      FROM villages v
      JOIN subdistricts sd ON v.subdistrict_id = sd.id
      JOIN districts d ON sd.district_id = d.id
      JOIN states s ON d.state_id = s.id
      WHERE v.name % $1 OR v.name ILIKE $2
      ORDER BY (v.name ILIKE $1 || '%') DESC, score DESC
      LIMIT 10
      `,
      [searchQuery, `%${searchQuery}%`]
    );
    const rows = result.rows;
    const formatted = rows.map(r => ({
      label: `${r.village}, ${r.subdistrict}, ${r.district}, ${r.state}`,
      value: r.village
    }));
    // 🔥 CACHE SAVE
    cache.set(searchQuery, formatted);
    logSearch(searchQuery, formatted.length);
    res.json(formatted);
  } catch (err) {
    Sentry.captureException(err);
    console.error("Autocomplete error:", err);
    res.status(500).json({ error: "Autocomplete failed" });
  }
});
// -------------------
// 🔥 ASK — natural-language query endpoint
// -------------------
app.get('/ask', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Provide a question via ?q=" });
  }
  if (q.length > 200) {
    return res.status(400).json({ error: "Question too long" });
  }
  try {
    const { answer, intent, supported } = await answerQuestion(q.trim(), pool);
    res.json({ question: q.trim(), answer, intent, supported });
  } catch (err) {
    Sentry.captureException(err);
    req.log.error({ err: err.message }, 'ask failed');
    // Transient Gemini/network issue (e.g. a 503) — tell the caller to retry
    // rather than leaking an error or crashing.
    res.status(503).json({
      error: "The AI service is temporarily unavailable. Please try again."
    });
  }
});
// -------------------
// 🔥 PARSE-ADDRESS — AI address parser / normalizer
// -------------------
app.post('/parse-address', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !address.trim()) {
    return res.status(400).json({ error: "Provide an address in the JSON body as { address }" });
  }
  if (address.length > 500) {
    return res.status(400).json({ error: "Address too long" });
  }
  try {
    const result = await parseAddress(address.trim(), pool);
    res.json(result);
  } catch (err) {
    Sentry.captureException(err);
    req.log.error({ err: err.message }, 'parse-address failed');
    res.status(503).json({
      error: "The address parser is temporarily unavailable. Please try again."
    });
  }
});
// -------------------
// STATES
// -------------------
app.get('/states', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM states ORDER BY name'
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch states" });
  }
});
// -------------------
// DISTRICTS
// -------------------
app.get('/districts', async (req, res) => {
  const { state_id } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM districts WHERE state_id = $1 ORDER BY name',
      [state_id]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch districts" });
  }
});
// -------------------
// SUBDISTRICTS
// -------------------
app.get('/subdistricts', async (req, res) => {
  const { district_id } = req.query;
  try {
    const result = await pool.query(
      `
      SELECT id, district_id, name
      FROM subdistricts
      WHERE district_id = $1
      ORDER BY name
      `,
      [district_id]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch subdistricts" });
  }
});
// -------------------
// VILLAGES
// -------------------
app.get('/villages', async (req, res) => {
  const { subdistrict_id } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM villages WHERE subdistrict_id = $1 ORDER BY name',
      [subdistrict_id]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch villages" });
  }
});
// -------------------
// SEARCH STATS
// -------------------
app.get('/stats', async (req, res) => {
  try {
    const totalResult = await pool.query(
      'SELECT COUNT(*) FROM search_logs'
    );
    const topResult = await pool.query(`
      SELECT query, COUNT(*) AS count
      FROM search_logs
      GROUP BY query
      ORDER BY count DESC
      LIMIT 10
    `);
    res.json({
      total_searches: parseInt(totalResult.rows[0].count),
      top_searches: topResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to fetch stats'
    });
  }
});
// -------------------
// 🌍 REVERSE GEOCODE — point (lat,lng) -> district + state
// Exact point-in-polygon via PostGIS ST_Contains over the GiST index.
// Falls back to the nearest district (KNN <->) for points just outside
// any boundary (e.g. offshore / border gaps), flagged exact:false.
// -------------------
app.get('/reverse-geocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'Provide numeric ?lat= and ?lng=' });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat must be -90..90 and lng -180..180' });
  }

  try {
    // Exact: which district polygon contains this point?
    const exact = await pool.query(
      `SELECT district, state
       FROM district_boundaries
       WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
       LIMIT 1`,
      [lng, lat]
    );
    if (exact.rows.length) {
      return res.json({ lat, lng, ...exact.rows[0], exact: true });
    }

    // Fallback: nearest district boundary (offshore / border points).
    const nearest = await pool.query(
      `SELECT district, state
       FROM district_boundaries
       ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`,
      [lng, lat]
    );
    if (nearest.rows.length) {
      return res.json({ lat, lng, ...nearest.rows[0], exact: false });
    }

    return res.status(404).json({ error: 'No district found' });
  } catch (err) {
    Sentry.captureException(err);
    console.error('Reverse-geocode error:', err);
    res.status(500).json({ error: 'Reverse geocode failed' });
  }
});
// -------------------
// SENTRY ERROR HANDLER — must be after all routes, before starting the server.
// No-op unless SENTRY_DSN is configured.
// -------------------
Sentry.setupExpressErrorHandler(app);
// -------------------
// START SERVER
// -------------------
const PORT = process.env.PORT || 3000;

// Only start the HTTP server when run directly (e.g. `node server.js`).
// When imported by the test suite, we just export `app` so supertest can
// drive it without binding a port.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(() => {
      pool.end(() => {
        logger.info('Closed server and database pool');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
