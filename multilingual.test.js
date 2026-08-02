/**
 * multilingual.test.js — cross-script search tests.
 *
 * Unit tests (script detection, phonetic folding) always run. The database
 * tests run only when TEST_DATABASE_URL is set and migration 0005 is applied.
 */
const test = require('node:test');
const assert = require('node:assert');
const { phoneticKey, toLatin, detectScript, searchMultilingual } = require('./multilingual');

// ------------------------------------------------------------ script detection
test('detects Tamil, Devanagari, and Latin', () => {
  assert.strictEqual(detectScript('மங்களூர்'), 'tamil');
  assert.strictEqual(detectScript('मंगलोर'), 'devanagari');
  assert.strictEqual(detectScript('Mangalore'), null);
});

test('transliterates Indic scripts to Latin, leaves Latin alone', () => {
  assert.match(toLatin('மங்களூர்').latin, /[a-zA-Z]/);
  assert.strictEqual(toLatin('Mangalore').latin, 'Mangalore');
  assert.strictEqual(toLatin('Mangalore').script, null);
});

// ------------------------------------------------------------ phonetic folding
test('romanisation variants fold to the same key', () => {
  // The classic problem: the same place spelled several ways.
  assert.strictEqual(phoneticKey('Tittakudi'), phoneticKey('Thittakkudi'));
  assert.strictEqual(phoneticKey('Cuddalore'), phoneticKey('Kuddalore'));
  assert.strictEqual(phoneticKey('Chennai'), phoneticKey('Cennai'));
});

test('short names keep enough signal to stay distinct (v2 folding)', () => {
  // Regression: v1 folded every vowel to 'a', so "Chennai" became "kana" and
  // collided with Ghana, Khani, Kuni and Jana. Front/back vowel classes fix it.
  const chennai = phoneticKey('Chennai');
  for (const other of ['Ghana', 'Khani', 'Kuni', 'Jana', 'Kauna']) {
    assert.notStrictEqual(chennai, phoneticKey(other), `Chennai must not fold to ${other}`);
  }
});

test('genuinely different names do not collide', () => {
  assert.notStrictEqual(phoneticKey('Mangalore'), phoneticKey('Kalpetta'));
  assert.notStrictEqual(phoneticKey('Chennai'), phoneticKey('Mumbai'));
});

test('folding is stable and idempotent', () => {
  const once = phoneticKey('Thittakkudi');
  assert.strictEqual(phoneticKey(once), once);
});

test('folding handles empty and non-alphabetic input safely', () => {
  assert.strictEqual(phoneticKey(''), '');
  assert.strictEqual(phoneticKey('12345 -- '), '');
});

// ------------------------------------------------------------------- database
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.log('TEST_DATABASE_URL not set — skipping multilingual database tests.');
} else {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl });

  test('db setup: fixture villages', async () => {
    await pool.query('TRUNCATE villages, subdistricts, districts, states RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO states(name) VALUES('TAMIL NADU'),('KERALA')`);
    await pool.query(`INSERT INTO districts(state_id,name) VALUES(1,'Cuddalore'),(2,'Wayanad')`);
    await pool.query(`INSERT INTO subdistricts(district_id,name) VALUES(1,'Tittakudi'),(2,'Sulthan Bathery')`);
    await pool.query(
      `INSERT INTO villages(subdistrict_id,name) VALUES(1,'Mangalore'),(1,'Vadakuthu'),(1,'Thittakudi'),(2,'Kalpetta')`
    );
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM villages');
    assert.strictEqual(rows[0].n, 4);
  });

  test('the SQL phonetic_key matches the JavaScript folding', async () => {
    // If these drift apart, every cross-script search silently breaks.
    for (const name of ['Mangalore', 'Vadakuthu', 'Thittakudi', 'Kalpetta', 'Chennai']) {
      const { rows } = await pool.query('SELECT phonetic_key($1) AS k', [name]);
      assert.strictEqual(rows[0].k, phoneticKey(name), `mismatch for ${name}`);
    }
  });

  test('a Tamil query finds a Latin-spelled village', async () => {
    const r = await searchMultilingual('வடகுத்து', pool, 5);
    assert.strictEqual(r.script, 'tamil');
    assert.ok(r.results.length > 0, 'expected at least one result');
    assert.strictEqual(r.results[0].value, 'Vadakuthu');
  });

  test('a Devanagari query finds a Latin-spelled village', async () => {
    const r = await searchMultilingual('मंगलोर', pool, 5);
    assert.strictEqual(r.script, 'devanagari');
    assert.ok(r.results.some((x) => x.value === 'Mangalore'));
  });

  test('a Latin query still works (no regression)', async () => {
    const r = await searchMultilingual('Mangalore', pool, 5);
    assert.strictEqual(r.script, null);
    assert.strictEqual(r.results[0].value, 'Mangalore');
    assert.strictEqual(r.results[0].exact_phonetic, true);
  });

  test('a misspelled Latin query still matches', async () => {
    const r = await searchMultilingual('mangalor', pool, 5);
    assert.ok(r.results.some((x) => x.value === 'Mangalore'));
  });

  test('a Devanagari query for Chennai does not return unrelated villages', async () => {
    // Regression for the v1 folding bug: this used to return Ghana/Khani/Kuni.
    await pool.query(
      `INSERT INTO villages(subdistrict_id,name) VALUES(1,'Chennai'),(1,'Ghana'),(1,'Khani')`
    );
    const r = await searchMultilingual('चेन्नई', pool, 5);
    const names = r.results.map((x) => x.value);
    assert.ok(!names.includes('Ghana'), 'Ghana must not match a Chennai query');
    assert.ok(!names.includes('Khani'), 'Khani must not match a Chennai query');
  });

  test('nonsense input returns no results rather than throwing', async () => {
    const r = await searchMultilingual('zzzqqqxxx', pool, 5);
    assert.strictEqual(r.results.length, 0);
  });

  test('very short input is rejected without querying', async () => {
    const r = await searchMultilingual('a', pool, 5);
    assert.deepStrictEqual(r.results, []);
  });

  test('the phonetic trigram index exists', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename='villages'
       AND indexdef ILIKE '%phonetic_key%' AND indexdef ILIKE '%gin%'`
    );
    assert.strictEqual(rows.length, 1);
  });

  test('teardown', async () => {
    await pool.query('TRUNCATE villages, subdistricts, districts, states RESTART IDENTITY CASCADE');
    await pool.end();
  });
}
