// load-districts.js
// One-time loader: reads dists11.geojson (DataMeet 2011 district boundaries)
// and loads the 641 district polygons into the district_boundaries table.
// Safe to re-run: it clears the table first, so it never double-loads.
//
// Usage:
//   1. Put dists11.geojson in this same folder (the project root).
//   2. node load-districts.js

require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Normalize every feature's geometry to a valid MultiPolygon in SRID 4326.
// - ST_GeomFromGeoJSON: parse the GeoJSON geometry
// - ST_SetSRID(..., 4326): tag it as WGS84 lat/long
// - ST_MakeValid + ST_CollectionExtract(...,3): repair any self-intersections,
//   keeping only the polygonal parts (3 = polygons)
// - ST_Multi: guarantee the result is MultiPolygon, matching the column type
const GEOM_SQL =
  'ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)), 3))';

const INSERT_SQL = `
  INSERT INTO district_boundaries
    (district, state, st_cen_cd, dt_cen_cd, censuscode, geom)
  VALUES ($1, $2, $3, $4, $5, ${GEOM_SQL})
`;

function toInt(v) {
  return v === null || v === undefined ? null : Math.round(Number(v));
}

async function main() {
  const path = './dists11.geojson';
  if (!fs.existsSync(path)) {
    console.error(`ERROR: ${path} not found. Download it into this folder first.`);
    process.exit(1);
  }

  console.log('Reading dists11.geojson...');
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const features = data.features || [];
  console.log(`Parsed ${features.length} district features.`);

  console.log('Clearing existing rows (TRUNCATE)...');
  await pool.query('TRUNCATE district_boundaries RESTART IDENTITY');

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const p = f.properties || {};
    try {
      await pool.query(INSERT_SQL, [
        p.DISTRICT,
        p.ST_NM,
        toInt(p.ST_CEN_CD),
        toInt(p.DT_CEN_CD),
        toInt(p.censuscode),
        JSON.stringify(f.geometry),
      ]);
      ok++;
    } catch (err) {
      failed++;
      console.error(`  ! Failed on ${p.DISTRICT} / ${p.ST_NM}: ${err.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${features.length}`);
  }

  const count = await pool.query('SELECT COUNT(*) FROM district_boundaries');
  console.log(`\nDone. Inserted ${ok}, failed ${failed}.`);
  console.log(`Rows now in district_boundaries: ${count.rows[0].count}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Loader crashed:', err);
  process.exit(1);
});
