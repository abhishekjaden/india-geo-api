/**
 * seed.js — populate a freshly-migrated database from the village CSV.
 *
 * Usage:
 *   node seed.js path/to/final_india_villages.csv
 *
 * Expects CSV columns: state,district,subdistrict,village,code
 *
 * Design notes:
 *  - Streams the file, so a 27 MB / 580k-row CSV never loads fully into memory.
 *  - Resolves the hierarchy top-down and caches ids in memory, so each distinct
 *    state/district/subdistrict is inserted once (ON CONFLICT DO NOTHING relies on
 *    the uniqueness constraints created by the migrations).
 *  - Inserts villages in batches inside a single transaction: the whole seed either
 *    succeeds or rolls back, so you never end up with a half-populated database.
 *  - Refuses to run against a non-empty villages table unless --force is passed,
 *    which makes it safe to run by accident.
 */

require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse');
const { Pool } = require('pg');

const BATCH = 1000;

const csvPath = process.argv[2];
const force = process.argv.includes('--force');

if (!csvPath) {
  console.error('Usage: node seed.js <path-to-csv> [--force]');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const clean = (v) => (v == null ? '' : String(v).trim());

async function main() {
  const client = await pool.connect();

  try {
    // Guard: don't silently double-seed an already-populated database.
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM villages');
    if (rows[0].n > 0 && !force) {
      console.error(
        `villages already contains ${rows[0].n} rows. Refusing to seed.\n` +
        `Re-run with --force if you really want to add to an existing database.`
      );
      process.exit(1);
    }

    await client.query('BEGIN');

    // id caches so each distinct name is inserted only once
    const stateIds = new Map();       // "STATE"            -> id
    const districtIds = new Map();    // "STATE|DISTRICT"   -> id
    const subdistrictIds = new Map(); // "STATE|DIST|SUB"   -> id

    async function getStateId(name) {
      if (stateIds.has(name)) return stateIds.get(name);
      const r = await client.query(
        `INSERT INTO states (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name]
      );
      stateIds.set(name, r.rows[0].id);
      return r.rows[0].id;
    }

    async function getDistrictId(stateId, key, name) {
      if (districtIds.has(key)) return districtIds.get(key);
      const r = await client.query(
        `INSERT INTO districts (state_id, name) VALUES ($1, $2)
         ON CONFLICT (name, state_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [stateId, name]
      );
      districtIds.set(key, r.rows[0].id);
      return r.rows[0].id;
    }

    async function getSubdistrictId(districtId, key, name) {
      if (subdistrictIds.has(key)) return subdistrictIds.get(key);
      const r = await client.query(
        `INSERT INTO subdistricts (district_id, name) VALUES ($1, $2)
         ON CONFLICT (name, district_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [districtId, name]
      );
      subdistrictIds.set(key, r.rows[0].id);
      return r.rows[0].id;
    }

    let pending = [];   // [subdistrict_id, village_name]
    let inserted = 0;
    let skipped = 0;

    async function flush() {
      if (!pending.length) return;
      const values = [];
      const params = [];
      pending.forEach(([sdId, name], i) => {
        values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
        params.push(sdId, name);
      });
      await client.query(
        `INSERT INTO villages (subdistrict_id, name) VALUES ${values.join(',')}`,
        params
      );
      inserted += pending.length;
      pending = [];
      if (inserted % 50000 === 0) console.log(`  ...${inserted.toLocaleString()} villages`);
    }

    const parser = fs
      .createReadStream(csvPath)
      .pipe(parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }));

    console.log(`Seeding from ${csvPath} ...`);

    for await (const row of parser) {
      const state = clean(row.state);
      const district = clean(row.district);
      const subdistrict = clean(row.subdistrict);
      const village = clean(row.village);

      // Every level is required to place a village in the hierarchy.
      if (!state || !district || !subdistrict || !village) {
        skipped++;
        continue;
      }

      const sId = await getStateId(state);
      const dKey = `${state}|${district}`;
      const dId = await getDistrictId(sId, dKey, district);
      const sdKey = `${dKey}|${subdistrict}`;
      const sdId = await getSubdistrictId(dId, sdKey, subdistrict);

      pending.push([sdId, village]);
      if (pending.length >= BATCH) await flush();
    }
    await flush();

    await client.query('COMMIT');

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM states)        AS states,
        (SELECT COUNT(*) FROM districts)     AS districts,
        (SELECT COUNT(*) FROM subdistricts)  AS subdistricts,
        (SELECT COUNT(*) FROM villages)      AS villages
    `);
    const c = counts.rows[0];
    console.log('\nSeed complete.');
    console.log(`  states:        ${Number(c.states).toLocaleString()}`);
    console.log(`  districts:     ${Number(c.districts).toLocaleString()}`);
    console.log(`  subdistricts:  ${Number(c.subdistricts).toLocaleString()}`);
    console.log(`  villages:      ${Number(c.villages).toLocaleString()}`);
    if (skipped) console.log(`  skipped rows (missing fields): ${skipped.toLocaleString()}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nSeed failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
