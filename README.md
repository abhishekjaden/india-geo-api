# India Geo API (GeoSense AI) 🌍

A production-grade REST API for searching India's administrative geography — **states → districts → sub-districts → villages** (~580,000 villages) — with fast, fuzzy autocomplete.

**Live API:** https://india-geo-api-38gp.onrender.com

---

## Features

- **Hierarchical location data** for all of India: states, districts, sub-districts, and villages.
- **Fuzzy autocomplete** using PostgreSQL trigram similarity (`pg_trgm`), so partial and slightly misspelled queries still return relevant results.
- **Query preprocessing** — normalises input, expands state shortcuts (e.g. `tn` → `tamil nadu`), and applies common spelling corrections for major cities.
- **In-memory caching** of repeated queries for fast repeat lookups.
- **Rate limiting** to protect the service from abuse.
- **Security headers** via `helmet` and verified TLS connections to the database.
- **Structured JSON logging** (`pino` / `pino-http`) with automatic request logging.
- **Graceful shutdown** so in-flight requests complete cleanly on redeploy.
- **Search analytics** endpoint exposing total and top searches.

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + Express |
| Database | PostgreSQL (Neon serverless) |
| Search | `pg_trgm` trigram similarity |
| Caching | `node-cache` |
| Security | `helmet`, `express-rate-limit`, TLS (`verify-full`) |
| Logging | `pino`, `pino-http` |
| Hosting | Render |

## API endpoints

| Method | Endpoint | Query params | Description |
|--------|----------|--------------|-------------|
| GET | `/` | — | Health check (text) |
| GET | `/health` | — | Health status + uptime (JSON) |
| GET | `/autocomplete` | `q` (min 2 chars) | Fuzzy location search → `[{ label, value }]` |
| GET | `/states` | — | All states / union territories |
| GET | `/districts` | `state_id` | Districts in a state |
| GET | `/subdistricts` | `district_id` | Sub-districts in a district |
| GET | `/villages` | `subdistrict_id` | Villages in a sub-district |
| GET | `/stats` | — | Total and top search queries |

### Example

```
GET /autocomplete?q=che
```
```json
[
  { "label": "Chennai, Chennai, TAMIL NADU", "value": "Chennai" }
]
```

## Local setup

```bash
# 1. Clone
git clone https://github.com/abhishekjaden/india-geo-api.git
cd india-geo-api

# 2. Install dependencies
npm install

# 3. Configure environment
#    Copy the example and fill in your own database URL
cp .env.example .env
#    (on Windows: copy .env.example .env)

# 4. Run
node server.js
```

The server starts on `http://localhost:3000` by default.

## Environment variables

See `.env.example`. Required:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (with `?sslmode=verify-full`) |
| `PORT` | Port to listen on (defaults to `3000`) |

> **Never commit your real `.env`.** It is git-ignored; only `.env.example` (with placeholders) is tracked.

## Deployment

The API is deployed on **Render** (auto-deploys from the `main` branch on push), backed by a **Neon** serverless PostgreSQL database. Environment variables are configured in the Render dashboard rather than committed to the repo.

## Roadmap

Planned enhancements to take the project further:

- **Semantic search** using vector embeddings (`pgvector`) to replace dictionary-based spell correction and handle alternate spellings and phonetic variants at scale.
- **Natural-language query endpoint** for plain-English location lookups.
- **Trigram GIN index** tuning and query benchmarking under load.
- **Search-log retention / aggregation** and an expanded analytics dashboard.
- **Uptime and error monitoring.**

## License

ISC

## Author

Abhishek Jaden Vethanayagam— [GitHub](https://github.com/abhishekjaden)
