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
// 🔥 AI QUERY PROCESSOR (FINAL)
// -------------------
function processQuery(input) {
  let q = input.toLowerCase().trim();

  // remove extra spaces
  q = q.replace(/\s+/g, " ");

  const parts = q.split(" ");

  // 🔥 state shortcuts
  const stateMap = {
    "tn": "tamil nadu",
    "ka": "karnataka",
    "mh": "maharashtra",
    "dl": "delhi"
  };

  // expand last word if state code
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (stateMap[last]) {
      parts[parts.length - 1] = stateMap[last];
      q = parts.join(" ");
    }
  }

  // 🔥 spell correction
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

  if (corrections[q]) {
    q = corrections[q];
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
// AUTOCOMPLETE (FINAL)
// -------------------
app.get('/autocomplete', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json([]);
  }

  // 🔥 CACHE CHECK
  if (cache.has(q)) {
    return res.json(cache.get(q));
  }

  try {
    // 🔥 AI PROCESSING
    const searchQuery = processQuery(q);

    // 🔥 CITY OVERRIDE (fast path)
    // 🔥 SMART CITY OVERRIDE (multi-word support)
for (const city in majorCities) {
  if (searchQuery.includes(city)) {
    return res.json([majorCities[city]]);
  }
}
    // -------------------
    // 🔥 SMART SEARCH QUERY
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

    // 🔥 FALLBACK (if nothing good found)
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

    // 🔥 FORMAT RESPONSE
    const formatted = rows.map(r => ({
      label: `${r.village}, ${r.district}, ${r.state}`,
      value: r.village
    }));

    // 🔥 SAVE CACHE
    cache.set(q, formatted);

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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});