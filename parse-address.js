// parse-address.js — AI address parser / normalizer.
//
// Step 1: Gemini extracts the administrative components from free-text as
//         constrained JSON (it never writes SQL — same safe pattern as /ask).
// Step 2: each extracted name is matched against the real database via trigram
//         similarity, walking the hierarchy top-down and scoping every level by
//         its matched parent. So every field returned is verified against real
//         data — the parser cannot invent a place that doesn't exist.

const EXTRACT_PROMPT = `
You extract the administrative-geography components from a messy Indian address.
Return JSON with exactly these fields, using "" when a part is absent or unclear:
- state: the Indian state or union territory
- district: the district
- subdistrict: the subdistrict / taluk / tehsil / mandal
- village: the village or locality name
Extract only what is present in the text. Do not guess, expand, or invent values.
`;

const addressSchema = {
  type: 'object',
  properties: {
    state: { type: 'string' },
    district: { type: 'string' },
    subdistrict: { type: 'string' },
    village: { type: 'string' },
  },
  required: ['state', 'district', 'subdistrict', 'village'],
};

let _aiPromise = null;
function getAI() {
  if (!_aiPromise) {
    _aiPromise = import('@google/genai').then(
      ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    );
  }
  return _aiPromise;
}

async function extractComponents(ai, address, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      return await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `${EXTRACT_PROMPT}\n\nAddress: ${address}`,
        config: { responseMimeType: 'application/json', responseSchema: addressSchema },
      });
    } catch (err) {
      const status = err && err.status;
      const transient = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (i < tries - 1 && transient) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
}

// Best trigram match for `name` in `table`, optionally scoped to a parent row.
// Returns { id, name, score } or null when nothing clears the similarity threshold.
async function matchOne(pool, table, name, parentCol, parentId) {
  if (!name || !name.trim()) return null;
  const params = [name.trim()];
  let sql = `SELECT id, name, similarity(name, $1) AS score FROM ${table} WHERE name % $1`;
  if (parentCol && parentId != null) {
    params.push(parentId);
    sql += ` AND ${parentCol} = $${params.length}`;
  }
  sql += ' ORDER BY score DESC LIMIT 1';
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name, score: Number(rows[0].score) };
}

// Villages are matched scoped to a subdistrict if we have one, else scoped to the
// district (via join). Never matched fully unscoped — across 580k rows an unscoped
// match would routinely return a same-named village from the wrong region.
async function matchVillage(pool, name, subdistrictId, districtId) {
  if (!name || !name.trim()) return null;
  if (subdistrictId != null) {
    return matchOne(pool, 'villages', name, 'subdistrict_id', subdistrictId);
  }
  if (districtId != null) {
    const { rows } = await pool.query(
      `SELECT v.id, v.name, similarity(v.name, $1) AS score
       FROM villages v
       JOIN subdistricts sd ON v.subdistrict_id = sd.id
       WHERE v.name % $1 AND sd.district_id = $2
       ORDER BY score DESC LIMIT 1`,
      [name.trim(), districtId]
    );
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name, score: Number(rows[0].score) };
  }
  return null;
}

async function parseAddress(address, pool) {
  const ai = await getAI();
  const response = await extractComponents(ai, address);

  let extracted;
  try {
    extracted = JSON.parse(response.text);
  } catch {
    const e = new Error('Could not parse model response as JSON');
    e.code = 'BAD_EXTRACT';
    throw e;
  }

  // Walk the hierarchy top-down. Each level is scoped by its matched parent, so a
  // same-named place in the wrong region can't slip through.
  const state = await matchOne(pool, 'states', extracted.state, null, null);
  const district = await matchOne(
    pool, 'districts', extracted.district,
    state ? 'state_id' : null, state ? state.id : null
  );

  // Subdistrict: addresses often label a subdistrict (taluk/tehsil/mandal) as just
  // "the place", so if the subdistrict slot is empty we try the village-slot token
  // here first. Only matched within the district.
  const sdName =
    extracted.subdistrict && extracted.subdistrict.trim()
      ? extracted.subdistrict
      : extracted.village;
  const subdistrict = district
    ? await matchOne(pool, 'subdistricts', sdName, 'district_id', district.id)
    : null;

  // Village: don't reuse a token that was already consumed as the subdistrict.
  // Scoped to the subdistrict if we have one, otherwise to the district.
  let villageName = extracted.village;
  if (subdistrict && sdName === extracted.village) villageName = '';
  const village = await matchVillage(
    pool,
    villageName,
    subdistrict ? subdistrict.id : null,
    district ? district.id : null
  );

  const levels = { state, district, subdistrict, village };
  const round = (n) => Math.round(n * 100) / 100;

  return {
    input: address,
    extracted, // raw components the model pulled out
    verified: {
      state: state ? state.name : null,
      district: district ? district.name : null,
      subdistrict: subdistrict ? subdistrict.name : null,
      village: village ? village.name : null,
    },
    scores: Object.fromEntries(
      Object.entries(levels).map(([k, v]) => [k, v ? round(v.score) : null])
    ),
    complete: Boolean(state && district && subdistrict && village),
  };
}

module.exports = { parseAddress };
