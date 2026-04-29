require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// -------------------
// PLAN LIMITS
// -------------------
const PLAN_LIMITS = {
  free: 1000,
  premium: 10000,
  pro: 100000,
  unlimited: Infinity
};

// -------------------
// NEON DATABASE CONFIG ✅
// -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// -------------------
// ROOT (PUBLIC)
// -------------------
app.get('/', (req, res) => {
  res.send('API is running 🚀');
});

// -------------------
// AUTOCOMPLETE (PUBLIC 🔥)
// -------------------
app.get('/autocomplete', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json([]);
  }

  try {
    const result = await pool.query(
      `SELECT v.name AS village,
              sd.name AS subdistrict,
              d.name AS district,
              s.name AS state
       FROM villages v
       JOIN subdistricts sd ON v.subdistrict_id = sd.id
       JOIN districts d ON sd.district_id = d.id
       JOIN states s ON d.state_id = s.id
       WHERE v.name ILIKE $1
       LIMIT 10`,
      [`${q}%`]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("Autocomplete error:", err);
    res.status(500).json({ error: "Autocomplete failed" });
  }
});

// -------------------
// 🔐 API KEY MIDDLEWARE
// -------------------
app.use(async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: "API key required" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM api_keys WHERE api_key = $1",
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: "Invalid API key" });
    }

    const user = result.rows[0];
    const limit = PLAN_LIMITS[user.plan] || 1000;

    // 🚫 RATE LIMIT CHECK
    if (user.requests_count >= limit) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        plan: user.plan,
        limit: limit
      });
    }

    // 🚀 INCREMENT USAGE
    await pool.query(
      "UPDATE api_keys SET requests_count = requests_count + 1 WHERE api_key = $1",
      [apiKey]
    );

    next();

  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Server error" });
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
  } catch (err) {
    console.error(err);
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

  } catch (err) {
    console.error(err);
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
      `SELECT id, district_id, name::text AS name 
       FROM subdistricts 
       WHERE district_id = $1 
       ORDER BY name`,
      [district_id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
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

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch villages" });
  }
});

// -------------------
// SEARCH
// -------------------
app.get('/search', async (req, res) => {
  const { q } = req.query;

  try {
    const result = await pool.query(
      `SELECT v.name AS village,
              sd.name AS subdistrict,
              d.name AS district,
              s.name AS state
       FROM villages v
       JOIN subdistricts sd ON v.subdistrict_id = sd.id
       JOIN districts d ON sd.district_id = d.id
       JOIN states s ON d.state_id = s.id
       WHERE v.name ILIKE $1
       LIMIT 20`,
      [`${q}%`]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

// -------------------
// START SERVER
// -------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});