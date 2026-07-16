# India Geo API · GeoSense AI 🌍

A production REST API and web interface for India's administrative geography —
**580,398 villages** organized in a four-level hierarchy (state → district → subdistrict →
village) — with fuzzy autocomplete, a natural-language query endpoint, an AI address parser,
and coordinate reverse-geocoding.

🌐 **Live demo:** https://abhishekjaden.github.io/india-geo-api/
🔌 **API base:** https://india-geo-api-1.onrender.com
📖 **API docs (Swagger UI):** https://india-geo-api-1.onrender.com/api-docs

![India Geo API demo](assets/demo.gif)

---

## Features

- **Fast fuzzy autocomplete** over ~580k village names using PostgreSQL trigram similarity
  (`pg_trgm`) — tolerant of typos and partial input, backed by a GIN index.
- **Hierarchical lookups** — drill down states → districts → subdistricts → villages.
- **Natural-language `/ask` endpoint** — plain-English questions ("How many villages are in
  Kerala?") answered via Gemini, with a safe, injection-proof query design.
- **AI address parser (`/parse-address`)** — extracts the administrative components of a
  messy free-text address and verifies each one against the real database, top-down through
  the hierarchy. Unmatched parts are reported as "not found" rather than guessed.
- **Reverse geocoding (`/reverse-geocode`)** — maps a latitude/longitude to its district and
  state via exact PostGIS point-in-polygon, with an interactive Leaflet map on the front-end.
- **Search analytics** — total and top searches, logged to reflect real intent.
- **Production hardening** — security headers, rate limiting, structured logging, error
  monitoring, graceful shutdown, TLS database connections, and in-memory caching.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + Express |
| Database | PostgreSQL (Neon serverless) with `pg_trgm` (fuzzy search) and `PostGIS` (spatial) |
| AI | Google Gemini (`gemini-2.5-flash`), structured JSON output |
| Front-end | HTML/CSS/JS + Leaflet (interactive map) |
| Caching | `node-cache` |
| Security | `helmet`, `express-rate-limit`, TLS (`sslmode=require`) |
| Logging & monitoring | `pino` / `pino-http`, Sentry error tracking |
| Docs | OpenAPI 3.0.3 via `swagger-ui-express` |
| Testing / CI | `node:test` + `supertest`, GitHub Actions on every push |
| Hosting | Render (API) + GitHub Pages (front-end), co-located US-East with the database |

---

## API endpoints

Base URL: `https://india-geo-api-1.onrender.com`

| Endpoint | Method | Params | Description |
|----------|--------|--------|-------------|
| `/health` | GET | — | Service status + uptime |
| `/autocomplete` | GET | `q` (min 2 chars) | Fuzzy village search → `[{ label, value }]` |
| `/ask` | GET | `q` | Natural-language query → `{ question, answer, intent, supported }` |
| `/parse-address` | POST | body `{ address }` | Parse + verify a free-text address |
| `/reverse-geocode` | GET | `lat`, `lng` | Coordinate → `{ district, state, exact }` |
| `/states` | GET | — | All states / union territories |
| `/districts` | GET | `state_id` | Districts in a state |
| `/subdistricts` | GET | `district_id` | Subdistricts in a district |
| `/villages` | GET | `subdistrict_id` | Villages in a subdistrict |
| `/stats` | GET | — | Total and top search queries |
| `/api-docs` | GET | — | Interactive OpenAPI / Swagger UI |

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
  "intent": { "action": "count", "target": "villages", "filter_level": "state", "filter_name": "Kerala" },
  "supported": true
}
```

```
GET /reverse-geocode?lat=13.0827&lng=80.2707
{ "lat": 13.0827, "lng": 80.2707, "district": "Chennai", "state": "Tamil Nadu", "exact": true }
```

---

## Architecture & key decisions

This project favors demonstrated engineering judgment over feature count. A few decisions
worth calling out:

**Trigram search over naive `ILIKE`.** Autocomplete is built on a GIN index using `pg_trgm`
(`gin_trgm_ops`). On ~580k rows this took the query from ~500 ms (sequential scan) to ~35 ms
(bitmap index scan) — roughly a 14× improvement — while adding typo tolerance.

**Semantic search: evaluated, then deliberately cut.** A `pgvector` semantic-search prototype
(384-dim multilingual embeddings) was built and benchmarked head-to-head against trigram. For
bare village names the embeddings collapsed toward orthographic similarity and did not beat
trigram, so the approach was dropped rather than shipped for its own sake.

**Safe natural language → SQL.** The `/ask` endpoint never lets the language model write SQL.
Gemini returns a *structured intent* constrained to a fixed JSON schema, and the server maps
that intent to parameterized SQL from a hard-coded table whitelist — user values are always
bound as query parameters, so SQL injection is structurally impossible. The Gemini call
retries once on a transient error so brief upstream blips self-heal.

**Reverse geocoding as an exact spatial join, not ML.** `/reverse-geocode` answers "which
district contains this point?" with exact PostGIS `ST_Contains` over a GiST spatial index
(sub-millisecond), falling back to the nearest district for points outside every boundary. A
KNN nearest-centroid approximation was benchmarked against it and scored only ~75% accuracy
for no meaningful speed gain, so the exact method was chosen. District boundaries are
Census-2011 vintage (a disclosed limitation: post-2011 splits and Telangana are not separated
out). See [`benchmarks/`](benchmarks/reverse-geocoding-benchmark.md) for the full write-up.

**Data integrity: caught and fixed in production.** The `/ask` endpoint surfaced inflated
counts (a state reporting ~3× its real district count), traced to an import that had run three
times and triplicated districts and subdistricts. The fix was a single guarded transaction —
keep the canonical (lowest-id) row per `(name, parent)`, re-point all children, delete the
duplicates — wrapped in a safety check that aborts and rolls back if the total village count
changes. Uniqueness constraints were then added so it cannot recur. Final counts: 530
districts, 5,354 subdistricts, 580,398 villages.

**Production practices.** Helmet security headers, request rate limiting, input length caps,
`sslmode=require` database connections, structured logging (`pino`), Sentry error monitoring,
graceful shutdown on `SIGTERM`/`SIGINT`, in-memory response caching, a contract test suite run
in CI on every push, and a full OpenAPI spec served as live Swagger docs.

---

## Local setup

**Prerequisites:** Node.js 18+, a PostgreSQL database with the `pg_trgm` and `PostGIS`
extensions, and a Google Gemini API key.

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

The server starts on `http://localhost:3000` by default. Run the tests with `npm test`.

### Environment variables

See `.env.example`. Required:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (with `?sslmode=require`) |
| `GEMINI_API_KEY` | Google Gemini API key (for `/ask` and `/parse-address`) |
| `PORT` | Port to listen on (defaults to `3000`) |
| `SENTRY_DSN` | *(optional)* Sentry DSN; error monitoring is inert if unset |

> **Never commit your real `.env`.** It is git-ignored; only `.env.example` (with
> placeholders) is tracked.

### Database

Tables: `states`, `districts`, `subdistricts`, `villages` (each linking to its parent via a
foreign key), `district_boundaries` (PostGIS polygons for reverse-geocoding), and
`search_logs` for analytics. The `pg_trgm` extension with a GIN trigram index on
`villages.name` powers autocomplete; `PostGIS` with a GiST index on
`district_boundaries.geom` powers reverse-geocoding; uniqueness constraints on
`(name, state_id)` and `(name, district_id)` keep the hierarchy clean. District boundaries can
be loaded with `load-districts.js`.

---

## Deployment

The API is deployed on **Render** (auto-deploys from the `main` branch on push), backed by a
**Neon** serverless PostgreSQL database, with the static front-end served from **GitHub
Pages**. Secrets (`DATABASE_URL`, `GEMINI_API_KEY`, `SENTRY_DSN`) are configured in the Render
dashboard, never committed.

---

## License

ISC

## Author

Abhishek Jaden — [GitHub](https://github.com/abhishekjaden)
