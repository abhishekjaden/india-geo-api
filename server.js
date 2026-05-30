require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
app.use(cors());
app.use(express.json());

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
  ssl: { rejectUnauthorized: false },
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
// 🔥 MAJOR CITY OVERRIDE
// -------------------
const majorCities = {
  "chennai": {
    label: "Chennai, Chennai, TAMIL NADU",
    value: "Chennai"
  },
  "bangalore": {
    label: "Bangalore, Bangalore Urban, KARNATAKA",
    value: "Bangalore"
  },
  "mumbai": {
    label: "Mumbai, Mumbai, MAHARASHTRA",
    value: "Mumbai"
  },
  "delhi": {
    label: "New Delhi, Delhi, DELHI",
    value: "Delhi"
  }
};

// -------------------
// 🔥 AUTOCOMPLETE (FINAL)
// -------------------
app.get('/autocomplete', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json([]);
  }


  try {
    // 🔥 STEP 1 — AI PROCESSING
    const searchQuery = processQuery(q);

console.log("Processed Query:", searchQuery);

// 🔥 LOG SEARCH QUERY
pool.query(
  'INSERT INTO search_logs (query) VALUES ($1)',
  [searchQuery]
).catch(err => console.error('Logging error:', err));

    // 🔥 STEP 2 — SMART CITY OVERRIDE (multi-word)
    for (const city in majorCities) {
      if (searchQuery.includes(city)) {
        return res.json([majorCities[city]]);
      }
    }

    // 🔥 STEP 3 — CACHE (after processing)
    if (cache.has(searchQuery)) {
      return res.json(cache.get(searchQuery));
    }

    // -------------------
    // 🔥 DB QUERY
    // -------------------
    const result = await pool.query(
      `
      SELECT DISTINCT ON (v.name)
        v.name AS village,
        sd.name AS subdistrict,
        d.name AS district,
        s.name AS state,
        similarity(v.name, $1) AS score
      FROM villages v
      JOIN subdistricts sd ON v.subdistrict_id = sd.id
      JOIN districts d ON sd.district_id = d.id
      JOIN states s ON d.state_id = s.id
      WHERE 
        similarity(v.name, $1) > 0.2
        OR v.name ILIKE $2
        OR d.name ILIKE $2
        OR s.name ILIKE $2
      ORDER BY 
        v.name,
        score DESC
      LIMIT 10
      `,
      [searchQuery, `%${searchQuery}%`]
    );

    let rows = result.rows;

    // 🔥 FALLBACK
    if (rows.length === 0) {
      const fallback = await pool.query(
        `
        SELECT 
          v.name AS village,
          sd.name AS subdistrict,
          d.name AS district,
          s.name AS state
        FROM villages v
        JOIN subdistricts sd ON v.subdistrict_id = sd.id
        JOIN districts d ON sd.district_id = d.id
        JOIN states s ON d.state_id = s.id
        WHERE v.name ILIKE $1
        LIMIT 10
        `,
        [`%${searchQuery}%`]
      );

      rows = fallback.rows;
    }

    const formatted = rows.map(r => ({
      label: `${r.village}, ${r.district}, ${r.state}`,
      value: r.village
    }));

    // 🔥 CACHE SAVE
    cache.set(searchQuery, formatted);

    res.json(formatted);

  } catch (err) {
    console.error("Autocomplete error:", err);
    res.status(500).json({ error: "Autocomplete failed" });
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
// START SERVER
// -------------------

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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});