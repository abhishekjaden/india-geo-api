/* eslint-disable camelcase */

// Phonetic key v3 — final-vowel insensitivity (schwa deletion).
//
// Indic scripts carry an inherent final vowel that English romanisation drops:
// कुड्डलोर transliterates as "kuddalora" while the census spells the same place
// "Cuddalore". v2 folded these to "katalara" and "katalari" — one character
// apart, so the query matched the wrong place exactly and the right one only
// approximately. No amount of ranking can recover from a key mismatch.
//
// Stripping the trailing vowel makes both "katalar". It also converts several
// previous near-misses into exact matches (Mangalore / Mangalur).

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION phonetic_key(txt text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT COALESCE(NULLIF(regexp_replace(base, '[ai]+$', ''), ''), base)
      FROM (
        SELECT regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       translate(
                         regexp_replace(
                           regexp_replace(replace(lower(unaccent_lite(txt)),'zh','l'), '[^a-z]', '', 'g'),
                           '(b|c|d|g|j|k|p|t|s|z)h', '\\1', 'g'
                         ),
                         'dgbjzxvqc', 'tkpcsswkk'
                       ),
                       '[ei]+', 'i', 'g'
                     ),
                     '[aou]+', 'a', 'g'
                   ),
                   '(.)\\1+', '\\1', 'g'
                 ),
                 '\\s', '', 'g'
               ) AS base
      ) t;
    $$;
  `);

  // Rebuild every generated column so the new function takes effect.
  for (const t of ['villages', 'subdistricts', 'districts', 'states']) {
    pgm.sql(`DROP INDEX IF EXISTS idx_${t}_phonetic_trgm;`);
    pgm.sql(`ALTER TABLE ${t} DROP COLUMN IF EXISTS phonetic_key;`);
    pgm.sql(`ALTER TABLE ${t} ADD COLUMN phonetic_key text GENERATED ALWAYS AS (phonetic_key(name)) STORED;`);
    pgm.sql(`CREATE INDEX idx_${t}_phonetic_trgm ON ${t} USING gin (phonetic_key gin_trgm_ops);`);
  }
};

exports.down = () => {
  throw new Error('Irreversible: re-run 0006/0007 to restore the previous key.');
};
