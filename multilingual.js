// multilingual.js — cross-script village search.
//
// Indian users search in their own script, but the census dataset stores only
// romanised names ("Mangalore", "Tittakudi"). Two problems have to be solved:
//
//   1. Script       — a Tamil or Devanagari query has to become Latin at all.
//   2. Spelling     — transliteration produces a scholarly romanisation
//                     ("maṅghal̤ūr"), not the census spelling ("Mangalore").
//
// The first is handled by transliterating to IAST. The second is handled by
// folding both sides to a phonetic skeleton: aspirates collapsed (dh→d),
// voiced/unvoiced merged (d→t, g→k), sibilants merged, vowels neutralised, and
// runs collapsed. "Mangalore" and "maṅghal̤ūr" both fold toward "mankalara",
// and the trigram index absorbs whatever difference remains.
//
// The identical folding exists in SQL as phonetic_key() (migration 0005) on a
// generated, trigram-indexed column, so matching happens in the database.

const Sanscript = require('@indic-transliteration/sanscript');

// Unicode blocks for the scripts we support.
const SCRIPTS = [
  { name: 'devanagari', re: /[\u0900-\u097F]/ },
  { name: 'bengali',    re: /[\u0980-\u09FF]/ },
  { name: 'gurmukhi',   re: /[\u0A00-\u0A7F]/ },
  { name: 'gujarati',   re: /[\u0A80-\u0AFF]/ },
  { name: 'oriya',      re: /[\u0B00-\u0B7F]/ },
  { name: 'tamil',      re: /[\u0B80-\u0BFF]/ },
  { name: 'telugu',     re: /[\u0C00-\u0C7F]/ },
  { name: 'kannada',    re: /[\u0C80-\u0CFF]/ },
  { name: 'malayalam',  re: /[\u0D00-\u0D7F]/ },
];

/** Returns the Sanscript scheme name for a query, or null if it is already Latin. */
function detectScript(text) {
  for (const s of SCRIPTS) if (s.re.test(text)) return s.name;
  return null;
}

/** Transliterate an Indic-script string to IAST. Returns the input unchanged if already Latin. */
function toLatin(text) {
  const script = detectScript(text);
  if (!script) return { latin: text, script: null };
  try {
    return { latin: Sanscript.t(text, script, 'iast'), script };
  } catch {
    return { latin: text, script };
  }
}

/**
 * Fold a romanised name to its phonetic skeleton.
 * MUST stay in sync with the SQL phonetic_key() function in migration 0005.
 */
function phoneticKey(s) {
  let x = String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u0331\u0323\u0324]/g, '') // combining marks
    .toLowerCase()
    .replace(/zh/g, 'l')          // Tamil ழ behaves like a retroflex l
    .replace(/[^a-z]/g, '')
    .replace(/(b|c|d|g|j|k|p|t|s|z)h/g, '$1'); // aspirates -> plain

  x = x
    .replace(/[dgbjzxvq]/g, (c) => ({ d: 't', g: 'k', b: 'p', j: 'c', z: 's', x: 's', v: 'w', q: 'k' }[c]))
    .replace(/c/g, 'k')           // c and k are interchangeable in practice
    // Two vowel classes, not one. Collapsing every vowel to a single letter
    // destroyed short names ("Chennai" -> "kana", colliding with Ghana/Khani).
    // Front (e/i) and back (a/o/u) keep enough signal to separate them while
    // still absorbing romanisation differences.
    .replace(/[ei]+/g, 'i')
    .replace(/[aou]+/g, 'a')
    .replace(/(.)\1+/g, '$1');    // collapse runs

  return x;
}

/**
 * Search villages by name in any supported script.
 * Returns { query, script, latin, key, results }.
 */
async function searchMultilingual(rawQuery, pool, limit = 10) {
  const query = String(rawQuery || '').trim();
  if (query.length < 2) return { query, script: null, latin: query, key: '', results: [] };

  const { latin, script } = toLatin(query);
  const key = phoneticKey(latin);
  if (!key) return { query, script, latin, key, results: [] };

  // Very short keys carry too little signal for fuzzy matching — a 3-character
  // key matches half the country. Require an exact phonetic match instead.
  const shortKey = key.length < 4;

  // Rank exact phonetic matches first, then trigram-similar keys. The
  // phonetic_key column is generated and trigram-indexed, so this stays fast.
  const { rows } = await pool.query(
    `SELECT v.name AS village,
            sd.name AS subdistrict,
            d.name  AS district,
            s.name  AS state,
            similarity(v.phonetic_key, $1) AS score,
            (v.phonetic_key = $1) AS exact_phonetic
     FROM villages v
     JOIN subdistricts sd ON v.subdistrict_id = sd.id
     JOIN districts    d  ON sd.district_id   = d.id
     JOIN states       s  ON d.state_id       = s.id
     WHERE ${shortKey ? 'v.phonetic_key = $1' : 'v.phonetic_key % $1'}
     ORDER BY exact_phonetic DESC, score DESC
     LIMIT $2`,
    [key, limit]
  );

  return {
    query,
    script,
    latin,
    key,
    results: rows.map((r) => ({
      label: `${r.village}, ${r.subdistrict}, ${r.district}, ${r.state}`,
      value: r.village,
      score: Number(r.score),
      exact_phonetic: r.exact_phonetic,
    })),
  };
}

module.exports = { searchMultilingual, phoneticKey, toLatin, detectScript };
