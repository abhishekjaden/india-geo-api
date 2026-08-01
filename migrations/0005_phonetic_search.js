/* eslint-disable camelcase */

// Phonetic search key for cross-script matching.
//
// Indian place names are romanised inconsistently (Chennai/Cennai, Tittakudi/
// Thittakkudi), and a name transliterated from Tamil or Devanagari rarely matches
// the census spelling character-for-character. This immutable function folds a
// name to a phonetic skeleton — aspirates collapsed, voiced/unvoiced merged,
// vowels neutralised — so variants converge on the same key. A generated column
// stores the key and a trigram GIN index makes it searchable.

const FOLD_FN = `
CREATE OR REPLACE FUNCTION phonetic_key(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 translate(
                   regexp_replace(
                     regexp_replace(replace(lower(unaccent_lite(txt)),'zh','l'), '[^a-z]', '', 'g'),
                     '(b|c|d|g|j|k|p|t|s|z)h',
                     '\\1', 'g'
                   ),
                   'dgbjzxvq', 'tkpcsswk'
                 ),
                 'c', 'k', 'g'
               ),
               '[aeiou]+', 'a', 'g'
             ),
             '(.)\\1+', '\\1', 'g'
           ),
           '\\s', '', 'g'
         );
$$;
`;

exports.up = (pgm) => {
  // Minimal accent stripper so we do not depend on the unaccent extension
  // (not always available on managed Postgres).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION unaccent_lite(txt text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT translate(
        txt,
        'áàâäãåāăạảấầẩẫậắằẳẵặéèêëēĕėẹẻẽếềểễệíìîïīĭįịỉĩóòôöõōŏọỏốồổỗộớờởỡợúùûüūŭụủũứừửữựñńňçćĉċšśŝşžźżŕřĺľłđďťņňļḷḍṭṅṇṃṛṝḥḻẖ',
        'aaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeiiiiiiiiiiooooooooooooooooooouuuuuuuuuuuuuuunnncccccsssszzzrrlllddtnnllдtnnmrrhlh'
      );
    $$;
  `);

  pgm.sql(FOLD_FN);

  // Generated column: always in sync with name, no application code required.
  pgm.sql(`
    ALTER TABLE villages
    ADD COLUMN phonetic_key text GENERATED ALWAYS AS (phonetic_key(name)) STORED;
  `);

  pgm.sql(`
    CREATE INDEX idx_villages_phonetic_trgm
    ON villages USING gin (phonetic_key gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_villages_phonetic_trgm;');
  pgm.sql('ALTER TABLE villages DROP COLUMN IF EXISTS phonetic_key;');
  pgm.sql('DROP FUNCTION IF EXISTS phonetic_key(text);');
  pgm.sql('DROP FUNCTION IF EXISTS unaccent_lite(text);');
};
