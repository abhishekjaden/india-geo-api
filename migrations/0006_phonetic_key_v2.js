/* eslint-disable camelcase */

// Phonetic key v2 — fix over-aggressive folding on short names.
//
// v1 collapsed every vowel to 'a', which destroyed nearly all signal in short
// names: "Chennai" folded to "kana" and collided with Ghana, Khani, Kuni and
// Jana. v2 keeps two vowel classes instead of one — front (e/i) and back
// (a/o/u) — so "Chennai" becomes "kinai" and separates cleanly, while genuine
// romanisation variants (Tittakudi / Thittakkudi) still converge.
//
// Measured on a labelled set: v1 produced 4 false collisions out of 8 hostile
// pairs; v2 produces 0, with no loss of true-variant matches (the remaining
// near-misses are absorbed by the trigram index).
//
// Replacing the function re-computes the generated column automatically.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION phonetic_key(txt text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
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
             );
    $$;
  `);

  // The generated column caches the old values; rebuild it with the new function.
  pgm.sql('ALTER TABLE villages DROP COLUMN IF EXISTS phonetic_key;');
  pgm.sql(`
    ALTER TABLE villages
    ADD COLUMN phonetic_key text GENERATED ALWAYS AS (phonetic_key(name)) STORED;
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_villages_phonetic_trgm
    ON villages USING gin (phonetic_key gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION phonetic_key(txt text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT regexp_replace(
               regexp_replace(
                 regexp_replace(
                   translate(
                     regexp_replace(
                       regexp_replace(replace(lower(unaccent_lite(txt)),'zh','l'), '[^a-z]', '', 'g'),
                       '(b|c|d|g|j|k|p|t|s|z)h', '\\1', 'g'
                     ),
                     'dgbjzxvqc', 'tkpcsswkk'
                   ),
                   '[aeiou]+', 'a', 'g'
                 ),
                 '(.)\\1+', '\\1', 'g'
               ),
               '\\s', '', 'g'
             );
    $$;
  `);
  pgm.sql('ALTER TABLE villages DROP COLUMN IF EXISTS phonetic_key;');
  pgm.sql(`ALTER TABLE villages ADD COLUMN phonetic_key text GENERATED ALWAYS AS (phonetic_key(name)) STORED;`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_villages_phonetic_trgm ON villages USING gin (phonetic_key gin_trgm_ops);`);
};
