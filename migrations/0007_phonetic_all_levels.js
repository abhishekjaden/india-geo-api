/* eslint-disable camelcase */

// Extend phonetic search to every level of the hierarchy.
//
// Searching only `villages` meant a query for a city ("Chennai", which is a
// district) could never return the right answer — it is not in the search
// space. Each level now carries the same generated phonetic_key column and
// trigram index, so a single query can rank matches across all four.

const LEVELS = ['states', 'districts', 'subdistricts'];

exports.up = (pgm) => {
  for (const t of LEVELS) {
    pgm.sql(`
      ALTER TABLE ${t}
      ADD COLUMN IF NOT EXISTS phonetic_key text GENERATED ALWAYS AS (phonetic_key(name)) STORED;
    `);
    pgm.sql(`
      CREATE INDEX IF NOT EXISTS idx_${t}_phonetic_trgm
      ON ${t} USING gin (phonetic_key gin_trgm_ops);
    `);
  }
};

exports.down = (pgm) => {
  for (const t of LEVELS) {
    pgm.sql(`DROP INDEX IF EXISTS idx_${t}_phonetic_trgm;`);
    pgm.sql(`ALTER TABLE ${t} DROP COLUMN IF EXISTS phonetic_key;`);
  }
};
