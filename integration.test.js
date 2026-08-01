/**
 * integration.test.js — tests that run against a REAL PostgreSQL database.
 *
 * Unlike server.test.js (which only checks HTTP contracts and needs no database),
 * these exercise the actual SQL the application depends on: the pg_trgm fuzzy
 * search, the hierarchy joins, and the PostGIS point-in-polygon lookup. A change
 * that broke the autocomplete query or dropped an index would pass the contract
 * tests but fail here.
 *
 * Requires TEST_DATABASE_URL to point at a database that has had the migrations
 * applied. In CI this is a throwaway Postgres+PostGIS service container; locally
 * you can point it at any scratch database:
 *
 *   createdb geo_test
 *   DATABASE_URL=postgresql://.../geo_test npm run migrate:up
 *   TEST_DATABASE_URL=postgresql://.../geo_test node --test integration.test.js
 *
 * The suite seeds its own small fixture and cleans up after itself, so it never
 * depends on (or touches) production data.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  console.log('TEST_DATABASE_URL not set — skipping integration tests.');
  process.exit(0);
}

const pool = new Pool({ connectionString });

// ---------------------------------------------------------------- fixtures

test('setup: load fixture data', async () => {
  // Start from a clean slate so the suite is repeatable.
  await pool.query('TRUNCATE district_boundaries, villages, subdistricts, districts, states RESTART IDENTITY CASCADE');

  const st = await pool.query(
    `INSERT INTO states (name) VALUES ('TAMIL NADU'), ('KERALA') RETURNING id, name`
  );
  const tn = st.rows.find((r) => r.name === 'TAMIL NADU').id;
  const kl = st.rows.find((r) => r.name === 'KERALA').id;

  const di = await pool.query(
    `INSERT INTO districts (state_id, name) VALUES ($1,'Cuddalore'), ($1,'Chennai'), ($2,'Wayanad')
     RETURNING id, name`,
    [tn, kl]
  );
  const cuddalore = di.rows.find((r) => r.name === 'Cuddalore').id;
  const chennai = di.rows.find((r) => r.name === 'Chennai').id;

  const sd = await pool.query(
    `INSERT INTO subdistricts (district_id, name) VALUES ($1,'Tittakudi'), ($2,'Egmore')
     RETURNING id, name`,
    [cuddalore, chennai]
  );
  const tittakudi = sd.rows.find((r) => r.name === 'Tittakudi').id;
  const egmore = sd.rows.find((r) => r.name === 'Egmore').id;

  await pool.query(
    `INSERT INTO villages (subdistrict_id, name) VALUES
      ($1,'Mangalore'), ($1,'Mangalapuram'), ($1,'Vadakuthu'), ($2,'Chetpet')`,
    [tittakudi, egmore]
  );

  // A simple square polygon we can reason about exactly.
  await pool.query(
    `INSERT INTO district_boundaries (district, state, geom)
     VALUES ('Cuddalore','TAMIL NADU',
       ST_Multi(ST_GeomFromText('POLYGON((79 11, 79 12, 80 12, 80 11, 79 11))', 4326)))`
  );

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM villages');
  assert.strictEqual(rows[0].n, 4);
});

// ------------------------------------------------------- pg_trgm behaviour

test('trigram search finds a village despite a typo', async () => {
  const { rows } = await pool.query(
    `SELECT name, similarity(name, $1) AS score
     FROM villages WHERE name % $1 ORDER BY score DESC`,
    ['mangalor'] // missing the trailing 'e'
  );
  assert.ok(rows.length > 0, 'expected at least one fuzzy match');
  assert.strictEqual(rows[0].name, 'Mangalore');
  assert.ok(Number(rows[0].score) > 0.3, 'expected a meaningful similarity score');
});

test('trigram search returns nothing for an unrelated term', async () => {
  const { rows } = await pool.query('SELECT name FROM villages WHERE name % $1', ['zzzzzzzz']);
  assert.strictEqual(rows.length, 0);
});

test('autocomplete query returns the full hierarchy for a match', async () => {
  // This is the actual query shape used by GET /autocomplete.
  const q = 'mangalore';
  const { rows } = await pool.query(
    `SELECT v.name AS village, sd.name AS subdistrict, d.name AS district, s.name AS state,
            similarity(v.name, $1) AS score
     FROM villages v
     JOIN subdistricts sd ON v.subdistrict_id = sd.id
     JOIN districts d ON sd.district_id = d.id
     JOIN states s ON d.state_id = s.id
     WHERE v.name % $1 OR v.name ILIKE $2
     ORDER BY (v.name ILIKE $1 || '%') DESC, score DESC
     LIMIT 10`,
    [q, `%${q}%`]
  );
  assert.ok(rows.length > 0);
  const top = rows[0];
  assert.strictEqual(top.village, 'Mangalore');
  assert.strictEqual(top.subdistrict, 'Tittakudi');
  assert.strictEqual(top.district, 'Cuddalore');
  assert.strictEqual(top.state, 'TAMIL NADU');
});

test('prefix matches are ranked above mid-string matches', async () => {
  const q = 'manga';
  const { rows } = await pool.query(
    `SELECT v.name AS village
     FROM villages v
     WHERE v.name % $1 OR v.name ILIKE $2
     ORDER BY (v.name ILIKE $1 || '%') DESC, similarity(v.name,$1) DESC
     LIMIT 10`,
    [q, `%${q}%`]
  );
  assert.ok(rows.length >= 2);
  assert.ok(
    ['Mangalore', 'Mangalapuram'].includes(rows[0].village),
    'a prefix match should rank first'
  );
});

// --------------------------------------------------------- schema integrity

test('the trigram GIN index exists', async () => {
  const { rows } = await pool.query(
    `SELECT indexdef FROM pg_indexes
     WHERE tablename = 'villages' AND indexdef ILIKE '%gin%' AND indexdef ILIKE '%trgm%'`
  );
  assert.strictEqual(rows.length, 1, 'expected exactly one trigram GIN index on villages');
});

test('the PostGIS GiST index exists', async () => {
  const { rows } = await pool.query(
    `SELECT indexdef FROM pg_indexes
     WHERE tablename = 'district_boundaries' AND indexdef ILIKE '%gist%'`
  );
  assert.strictEqual(rows.length, 1, 'expected exactly one GiST index on district_boundaries');
});

test('hierarchy uniqueness constraints are enforced', async () => {
  await assert.rejects(
    () => pool.query(`INSERT INTO states (name) VALUES ('TAMIL NADU')`),
    /duplicate key|unique/i,
    'inserting a duplicate state name should violate the unique constraint'
  );
});

test('deleting a parent cascades to its children', async () => {
  const { rows: before } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM villages v
     JOIN subdistricts sd ON v.subdistrict_id = sd.id
     JOIN districts d ON sd.district_id = d.id
     JOIN states s ON d.state_id = s.id
     WHERE s.name = 'TAMIL NADU'`
  );
  assert.ok(before[0].n > 0);

  await pool.query(`DELETE FROM states WHERE name = 'TAMIL NADU'`);

  const { rows: after } = await pool.query('SELECT COUNT(*)::int AS n FROM villages');
  assert.strictEqual(after[0].n, 0, 'villages should be removed when their state is deleted');
});

// ------------------------------------------------------- PostGIS behaviour

test('point inside a boundary resolves to the right district', async () => {
  const { rows } = await pool.query(
    `SELECT district, state FROM district_boundaries
     WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`,
    [79.5, 11.5] // centre of the fixture square
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].district, 'Cuddalore');
  assert.strictEqual(rows[0].state, 'TAMIL NADU');
});

test('point outside every boundary returns no exact match', async () => {
  const { rows } = await pool.query(
    `SELECT district FROM district_boundaries
     WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`,
    [70.0, 5.0] // far out at sea
  );
  assert.strictEqual(rows.length, 0);
});

test('nearest-district fallback still resolves an outside point', async () => {
  // Mirrors the exact:false fallback path in GET /reverse-geocode.
  const { rows } = await pool.query(
    `SELECT district FROM district_boundaries
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
    [70.0, 5.0]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].district, 'Cuddalore');
});

test('teardown', async () => {
  await pool.query('TRUNCATE district_boundaries, villages, subdistricts, districts, states RESTART IDENTITY CASCADE');
  await pool.end();
});
