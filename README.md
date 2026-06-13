# India Geo API · GeoSense AI 🌍

A production REST API and web interface for India's administrative geography — **580,398 villages** organized in a four-level hierarchy (state → district → subdistrict → village) — with fast fuzzy autocomplete and a natural-language query endpoint.

🌐 **Live demo:** https://abhishekjaden.github.io/india-geo-api/
🔌 **API base:** https://india-geo-api-1.onrender.com

---

## Features

- **Fast fuzzy autocomplete** over ~580k village names using PostgreSQL trigram similarity (`pg_trgm`) — tolerant of typos and partial input, backed by a GIN index.
- **Hierarchical lookups** — drill down states → districts → subdistricts → villages.
- **Natural-language `/ask` endpoint** — plain-English questions ("How many villages are in Kerala?", "Which state has the most districts?") answered via Gemini, with a safe, injection-proof query design.
- **Search analytics** — total and top searches, logged intelligently to reflect real intent.
- **Production hardening** — security headers, rate limiting, structured logging, graceful shutdown, verified-TLS database connections, and in-memory caching.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + Express |
| Database | PostgreSQL (Neon serverless), `pg_trgm` |
| AI | Google Gemini (`gemini-2.5-flash`), structured output |
| Caching | `node-cache` |
| Security | `helmet`, `express-rate-limit`, TLS (`verify-full`) |
| Logging | `pino` / `pino-http` |
| Hosting | Render (API) + GitHub Pages (frontend), co-located US-East with the database |

---

## API endpoints

All endpoints are `GET`. Base URL: `https://india-geo-api-1.onrender.com`

| Endpoint | Query params | Description |
|----------|--------------|-------------|
| `/health` | — | Service status + uptime |
| `/autocomplete` | `q` (min 2 chars) | Fuzzy village search → `[{ label, value }]` |
| `/ask` | `q` | Natural-language query → `{ question, answer, intent, supported }` |
| `/states` | — | All states / union territories |
| `/districts` | `state_id` | Districts in a state |
| `/subdistricts` | `district_id` | Subdistricts in a district |
| `/villages` | `subdistrict_id` | Villages in a subdistrict |
| `/stats` | — | Total and top search queries |

### Examples

```
GET /autocomplete?q=mangalore
[
  { "label": "Mangalore, Tittakudi, Cuddalore, TAMIL NADU", "value": "Mangalore" }
]
```

```
GET /ask?q=How many villages are in Kerala?
{
  "question": "How many villages are in Kerala?",
  "answer": "There are 1495 villages in Kerala.",
  "intent": { "action": "count", "target": "villages", "filter_level": "state", "filter_name": "Kerala", "...": "" },
  "supported": true
}
```

---

## Architecture & key decisions

This project favors demonstrated engineering judgment over feature count. A few decisions worth calling out:

**Trigram search over naive `ILIKE`.** Autocomplete is built on a GIN index using `pg_trgm` (`gin_trgm_ops`). On ~580k rows this took the query from ~500 ms (sequential scan) to ~35 ms (bitmap index scan) — roughly a 14× improvement — while adding typo tolerance. A light input-normalization pass (state-code expansion, common typo fixes) runs ahead of the query.

**Semantic search: evaluated, then deliberately cut.** A `pgvector` semantic-search prototype (384-dim multilingual embeddings) was built and benchmarked head-to-head against trigram. For bare village names the embeddings collapsed toward orthographic similarity and did not beat trigram, so the approach was dropped rather than shipped for its own sake.

**Safe natural language → SQL.** The `/ask` endpoint never lets the language model write SQL. Gemini returns a *structured intent* constrained to a fixed JSON schema, and the server maps that intent to parameterized SQL from a hard-coded table whitelist — user values are always bound as query parameters, so SQL injection is structurally impossible. The Gemini call retries once on a transient error so brief upstream blips self-heal.

**Data integrity: caught and fixed in production.** The `/ask` endpoint surfaced inflated counts (a state reporting ~3× its real district count), traced to an import that had run three times and triplicated districts and subdistricts. The fix was a single guarded transaction — keep the canonical (lowest-id) row per `(name, parent)`, re-point all children, delete the duplicates — wrapped in a safety check that aborts and rolls back if the total village count changes. Uniqueness constraints were then added so it cannot recur. Final counts: 530 districts, 5,354 subdistricts, 580,398 villages.

**Production practices.** Helmet security headers, request rate limiting, input length caps, `sslmode=verify-full` database connections, structured logging (`pino`), graceful shutdown on `SIGTERM`/`SIGINT`, in-memory response caching, and search logging filtered to substantive, result-bearing queries.

---

## Local setup

**Prerequisites:** Node.js 18+, a PostgreSQL database with the `pg_trgm` extension, and a Google Gemini API key.

```bash
# 1. Clone
git clone https://github.com/abhishekjaden/india-geo-api.git
cd india-geo-api

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env      # on Windows: copy .env.example .env
#    then fill in DATABASE_URL and GEMINI_API_KEY

# 4. Run
npm start
```

The server starts on `http://localhost:3000` by default.

### Environment variables

See `.env.example`. Required:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (with `?sslmode=verify-full`) |
| `GEMINI_API_KEY` | Google Gemini API key (for the `/ask` endpoint) |
| `PORT` | Port to listen on (defaults to `3000`) |

> **Never commit your real `.env`.** It is git-ignored; only `.env.example` (with placeholders) is tracked.

### Database

Four tables — `states`, `districts`, `subdistricts`, `villages` — each linking to its parent via a foreign key, plus a `search_logs` table for analytics. The `pg_trgm` extension and a GIN trigram index on `villages.name` power autocomplete; uniqueness constraints on `(name, state_id)` and `(name, district_id)` keep the hierarchy clean.

---

## Deployment

The API is deployed on **Render** (auto-deploys from the `main` branch on push), backed by a **Neon** serverless PostgreSQL database, with the static frontend served from **GitHub Pages**. Secrets (`DATABASE_URL`, `GEMINI_API_KEY`) are configured in the Render dashboard, never committed.

---

## License

ISC

## Author

Abhishek Jaden — [GitHub](https://github.com/abhishekjaden)
