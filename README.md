# CineMind

A multilingual, machine-learning movie recommendation engine. CineMind combines a FastAPI backend, a trained MovieLens hybrid model, live TMDB catalogue data, and a React front end to recommend films across Malayalam, Tamil, Hindi, Telugu, Kannada, Korean, Japanese, English, and more.

The app only displays real catalogue data. There is no bundled demo/fake movie list: if TMDB is not configured or unavailable, the UI shows a clear empty/error state instead of placeholder titles.

## Features

- Live TMDB search, trending, popular, discover, movie details, similar titles, genres, and languages.
- Onboarding with language, genre, mood, runtime, and release-period preferences.
- Hybrid personalization: content preferences, app interactions (favourites, watchlist, ratings), user-based collaborative filtering, and trained MovieLens priors.
- MMR-style diversity reranking plus explanations for every recommendation.
- Persistent accounts (JWT), favourites, watchlist, ratings, and preferences.
- Catalogue browsing with search, language/genre/year filters, and pagination.
- SQLite-backed TMDB cache with TTL, request throttling, retries, and friendly handling of rate limits and auth errors.
- Responsive React UI with onboarding, Discover, For You, Beyond the Algorithm, Mood Explorer, and Collection views.

## Prerequisites

- Node.js 20+ and npm
- Python 3.10+ (tested with 3.13)
- A TMDB API key or v4 read access token: https://www.themoviedb.org/settings/api

## Setup

### 1. Frontend environment

Copy `.env.example` to `.env` in the project root and adjust if needed:

```powershell
Copy-Item .env.example .env
```

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8000
```

The Vite dev server runs on port `8443` by default.

### 2. Backend environment

Copy `backend/.env.example` to `backend/.env`, then add your TMDB credentials:

```powershell
Copy-Item backend\.env.example backend\.env
```

```dotenv
TMDB_API_KEY=your-v3-api-key
# Or, instead:
# TMDB_ACCESS_TOKEN=your-v4-read-access-token

AUTH_SECRET_KEY=replace-with-a-long-random-string
TMDB_CACHE_TTL=3600
```

`TMDB_ACCESS_TOKEN` takes precedence over `TMDB_API_KEY` when both are set. Keep `backend/.env` private; it is ignored by git.

### 3. Install dependencies

```powershell
# Frontend
npm install

# Backend
python -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

### 4. Run the services

Terminal 1 — backend:

```powershell
backend\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000 --app-dir backend
```

Terminal 2 — frontend:

```powershell
npm run dev
```

Open `http://localhost:8443`, create an account, and complete onboarding.

Check the backend at `http://127.0.0.1:8000/health`; it should report `"tmdb_configured": true` once credentials are loaded.

## How recommendations work

1. Candidate generation pulls trending titles, language-specific discover results, genre matches, preferred-language popular titles, and similar titles from favourite/rated seeds.
2. Candidates are enriched with content scores (genres, languages, year, runtime, moods), collaborative scores from other users with overlapping taste, and lightweight genre priors from the trained MovieLens model.
3. Scores are blended, already-seen titles are removed, and MMR diversity reranking spreads results across genres/languages.
4. Each recommendation includes a human-readable explanation and score signals.

The old MovieLens endpoints (`/recommendations`, `/movies`, `/genres`, `/metrics`, `/model-info`) remain available and are enriched with TMDB metadata when credentials are configured.

## API overview

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Preferences | `GET/PUT /preferences` |
| Library | `GET/POST/DELETE /me/favourites`, `GET/POST/DELETE /me/watchlist`, `GET/POST/DELETE /me/ratings` |
| Personalization | `GET /me/recommendations`, `GET /me/recommendations/diverse`, `GET /recommendations/diverse/{user_id}` |
| Catalogue | `GET /catalogue/search`, `/catalogue/popular`, `/catalogue/trending`, `/catalogue/discover`, `/catalogue/movie/{id}`, `/catalogue/movie/{id}/similar`, `/catalogue/movie/{id}/recommendations`, `/catalogue/genres`, `/catalogue/languages`, `/catalogue/config` |
| Maintenance | `GET /health`, `POST /catalogue/cache/clear` |
| Legacy ML | `GET /recommendations`, `/movies`, `/genres`, `/metrics`, `/model-info`, `/recommend` |

Interactive API docs: `http://127.0.0.1:8000/docs`.

## Tests and build

```powershell
# Backend suite (includes mocked TMDB catalogue tests)
backend\.venv\Scripts\python.exe -m pytest backend\tests -q

# Frontend typecheck and production build
npx tsc --noEmit
npm run build
```

The tests mock TMDB, so no live API key is required to run them.

## Troubleshooting

- **Personalized recommendations return 503**: set `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` in `backend/.env`, restart the backend, and confirm `/health` reports `tmdb_configured: true`.
- **401/403 from TMDB**: verify the credential type and that it is active. A v4 token must be sent as a bearer token; CineMind handles this automatically.
- **429 rate limits**: CineMind retries with backoff and surfaces a friendly error. Reduce language/genre request limits or clear cached data via `POST /catalogue/cache/clear`.
- **Stale catalogue data**: lower `TMDB_CACHE_TTL` or call the cache-clear endpoint.
- **CORS errors**: add your frontend origin to `CORS_ORIGINS` in `backend/.env`.

## Data attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. Movie metadata and images are provided by TMDB. The trained recommendation model uses the MovieLens dataset.
