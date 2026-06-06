// ask.js — natural-language /ask pipeline for GeoSense AI
//
// Design note: the LLM ONLY produces a structured "intent" (JSON matching a fixed
// schema). Our own code turns that intent into parameterized SQL built from a
// hard-coded table whitelist, with every user value passed as $1/$2 params.
// The model never writes SQL, so SQL injection is structurally impossible.

const SYSTEM_PROMPT = `
You convert questions about Indian geographic data into a structured query intent.
The data is a 4-level hierarchy: states contain districts, districts contain subdistricts, subdistricts contain villages.
Fill these fields:
- action: "count", "list", "top" (which X has the most/least Y), or "unsupported".
- target: "states", "districts", "subdistricts", or "villages".
- filter_level / filter_name: to scope to a parent (villages IN Kerala -> filter_level "state", filter_name "Kerala"). Use "none"/"" if none.
- name_prefix: for "names starting with X" (districts starting with "K" -> "K"). Else "".
- group_level / order: ONLY for "top" ("most districts" by state -> group_level "state", order "most"). Else "none"/"none".
`;

const intentSchema = {
  type: "object",
  properties: {
    action:       { type: "string", enum: ["count", "list", "top", "unsupported"] },
    target:       { type: "string", enum: ["states", "districts", "subdistricts", "villages"] },
    filter_level: { type: "string", enum: ["state", "district", "subdistrict", "none"] },
    filter_name:  { type: "string" },
    name_prefix:  { type: "string" },
    group_level:  { type: "string", enum: ["state", "district", "subdistrict", "none"] },
    order:        { type: "string", enum: ["most", "least", "none"] },
  },
  required: ["action", "target", "filter_level", "filter_name", "name_prefix", "group_level", "order"],
};

// Hierarchy: each level's table + how it links UP to its parent.
const HIER = {
  states:       { fk: null,             parent: null },
  districts:    { fk: 'state_id',       parent: 'states' },
  subdistricts: { fk: 'district_id',    parent: 'districts' },
  villages:     { fk: 'subdistrict_id', parent: 'subdistricts' },
};
const LEVEL = { state: 'states', district: 'districts', subdistrict: 'subdistricts' };

// Build JOINs walking UP from target to ancestor. null if ancestor isn't reachable.
function joinUpTo(target, ancestor) {
  const joins = [];
  let cur = target;
  while (cur !== ancestor) {
    const info = HIER[cur];
    if (!info || !info.parent) return null;
    joins.push(`JOIN ${info.parent} ON ${cur}.${info.fk} = ${info.parent}.id`);
    cur = info.parent;
  }
  return joins.join('\n');
}

// Turn a validated intent into { sql, params }, or null if unsupported.
function buildQuery(intent) {
  const { action, target, filter_level, filter_name, name_prefix, group_level, order } = intent;
  if (!HIER[target]) return null;

  if (action === 'count' || action === 'list') {
    const cols = action === 'count' ? 'COUNT(*) AS count' : `${target}.id, ${target}.name`;
    let sql = `SELECT ${cols} FROM ${target}`;
    const params = [];
    const wheres = [];

    if (filter_level !== 'none' && filter_name) {
      const ancestor = LEVEL[filter_level];
      const joins = joinUpTo(target, ancestor);
      if (joins === null) return null;
      if (joins) sql += '\n' + joins;
      params.push(filter_name);
      wheres.push(`${ancestor}.name ILIKE $${params.length}`);
    }
    if (name_prefix) {
      params.push(name_prefix + '%');
      wheres.push(`${target}.name ILIKE $${params.length}`);
    }
    if (wheres.length) sql += '\nWHERE ' + wheres.join(' AND ');
    if (action === 'list') sql += `\nORDER BY ${target}.name LIMIT 50`;
    return { sql, params };
  }

  if (action === 'top') {
    const grp = LEVEL[group_level];
    if (!grp) return null;
    const joins = joinUpTo(target, grp);
    if (joins === null) return null;
    const dir = order === 'least' ? 'ASC' : 'DESC';
    const sql =
      `SELECT ${grp}.name, COUNT(${target}.id) AS count\nFROM ${target}\n${joins}\n` +
      `GROUP BY ${grp}.name\nORDER BY count ${dir}\nLIMIT 5`;
    return { sql, params: [] };
  }

  return null; // unsupported
}

function formatAnswer(intent, rows) {
  const { action, target, filter_name, order } = intent;
  if (action === 'count') {
    return `There are ${rows[0].count} ${target}${filter_name ? ` in ${filter_name}` : ''}.`;
  }
  if (action === 'list') {
    if (!rows.length) return `No ${target} found.`;
    return `Found ${rows.length} ${target}${filter_name ? ` in ${filter_name}` : ''}: ` +
           rows.map(r => r.name).join(', ');
  }
  if (action === 'top') {
    if (!rows.length) return 'No results.';
    return `${rows[0].name} has the ${order === 'least' ? 'fewest' : 'most'} ${target} (${rows[0].count}).`;
  }
  return '';
}

// Lazy, cached Gemini client. @google/genai is ESM-only and this project is
// CommonJS, so we dynamic-import it once on first use (works on Node 24).
let _aiPromise = null;
function getAI() {
  if (!_aiPromise) {
    _aiPromise = import('@google/genai').then(
      ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    );
  }
  return _aiPromise;
}

// Main entry point: question (string) + a pg Pool -> { answer, intent, supported }.
// Throws on Gemini/network failure so the caller can decide the HTTP status.
async function answerQuestion(question, pool) {
  const ai = await getAI();

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `${SYSTEM_PROMPT}\n\nQuestion: ${question}`,
    config: { responseMimeType: 'application/json', responseSchema: intentSchema },
  });

  let intent;
  try {
    intent = JSON.parse(response.text);
  } catch {
    const err = new Error('Could not parse model response as JSON');
    err.code = 'BAD_INTENT';
    throw err;
  }

  const built = buildQuery(intent);
  if (!built) {
    return { answer: "Sorry, I can't answer that from this dataset.", intent, supported: false };
  }

  const result = await pool.query(built.sql, built.params);
  return { answer: formatAnswer(intent, result.rows), intent, supported: true };
}

module.exports = { answerQuestion };