"""Thin, resilient client for The Movie Database (TMDB) API.

The client is intentionally dependency-light: it only needs ``httpx`` and the
SQLAlchemy cache table that already ships with the backend.  Every response is
normalised into the same shape so the rest of the application never has to
worry about TMDB's raw payloads.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent

# ``load_dotenv`` never overwrites variables that already exist in the process
# environment -- not even ones set to an empty string.  An empty
# ``TMDB_API_KEY=`` placeholder in the environment would therefore silently
# shadow a real key stored in ``backend/.env``.  Re-read the backend file for
# any TMDB credential the environment left empty so ``backend/.env`` is
# authoritative for the key while a non-empty environment value still wins.
load_dotenv(BACKEND_DIR / ".env")
load_dotenv()


def _env_file_value(path: Path, name: str) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


for _credential in ("TMDB_API_KEY", "TMDB_ACCESS_TOKEN"):
    if not os.getenv(_credential, "").strip():
        _from_file = _env_file_value(BACKEND_DIR / ".env", _credential)
        if _from_file:
            os.environ[_credential] = _from_file

from database import SessionLocal, TmdbCache  # noqa: E402  (needs .env loaded first)

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_ACCESS_TOKEN = os.getenv("TMDB_ACCESS_TOKEN", "").strip()
TMDB_BASE_URL = os.getenv("TMDB_BASE_URL", "https://api.themoviedb.org/3").rstrip("/")
TMDB_IMAGE_BASE = os.getenv("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p/w500").rstrip("/")
CACHE_TTL_SECONDS = int(os.getenv("TMDB_CACHE_TTL", "3600"))
DETAIL_CACHE_TTL_SECONDS = int(os.getenv("TMDB_DETAIL_CACHE_TTL", "86400"))
TMDB_TIMEOUT_SECONDS = float(os.getenv("TMDB_TIMEOUT", "15"))
TMDB_MAX_PAGE = 500
# TMDB's documented v3 limit is 40 requests per 10 seconds per IP; 0.3s keeps
# cold multi-request calls (candidate pools, filtered search scans) safely
# below it instead of tripping 429 retries.
TMDB_MIN_INTERVAL = float(os.getenv("TMDB_MIN_INTERVAL", "0.3"))
# How many raw TMDB pages a client-side filtered search may scan for matches.
TMDB_SEARCH_SCAN_PAGES = max(1, int(os.getenv("TMDB_SEARCH_SCAN_PAGES", "4")))
SEARCH_SCAN_TARGET = 20

SUPPORTED_LANGUAGES: dict[str, str] = {
    "en": "English",
    "ml": "Malayalam",
    "ta": "Tamil",
    "hi": "Hindi",
    "te": "Telugu",
    "kn": "Kannada",
    "bn": "Bengali",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "ur": "Urdu",
    "ko": "Korean",
    "ja": "Japanese",
    "zh": "Chinese",
    "fr": "French",
    "es": "Spanish",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "tr": "Turkish",
    "th": "Thai",
    "id": "Indonesian",
    "ar": "Arabic",
    "fa": "Persian",
    "nl": "Dutch",
    "sv": "Swedish",
    "pl": "Polish",
    "da": "Danish",
    "no": "Norwegian",
}

GENRE_MAP: dict[int, str] = {
    28: "Action",
    12: "Adventure",
    16: "Animation",
    35: "Comedy",
    80: "Crime",
    99: "Documentary",
    18: "Drama",
    10751: "Family",
    14: "Fantasy",
    36: "History",
    27: "Horror",
    10402: "Music",
    9648: "Mystery",
    10749: "Romance",
    878: "Science Fiction",
    10770: "TV Movie",
    53: "Thriller",
    10752: "War",
    37: "Western",
}
GENRE_NAME_TO_ID = {name.lower(): genre_id for genre_id, name in GENRE_MAP.items()}


class TmdbError(Exception):
    """Raised when TMDB cannot be reached or returns an error."""


_MEMORY_CACHE: dict[str, tuple[float, Any]] = {}
_MEMORY_LOCK = threading.RLock()
_RATE_LOCK = threading.Lock()
_LAST_REQUEST_AT = 0.0


def is_configured() -> bool:
    return bool(TMDB_API_KEY or TMDB_ACCESS_TOKEN)


def language_name(code: str | None) -> str | None:
    if not code:
        return None
    return SUPPORTED_LANGUAGES.get(code, code.upper())


def genre_names(genre_ids: list[int] | None, genres: list[dict] | None = None) -> list[str]:
    if genres:
        names = [str(item.get("name")) for item in genres if isinstance(item, dict) and item.get("name")]
        if names:
            return names
    return [GENRE_MAP[gid] for gid in (genre_ids or []) if gid in GENRE_MAP]


def genre_id_for(name: str | int | None) -> int | None:
    if name is None or isinstance(name, int):
        return name
    try:
        return int(name)
    except ValueError:
        return GENRE_NAME_TO_ID.get(str(name).strip().lower())


def _clamp_page(page: int | None) -> int:
    if not page or page < 1:
        return 1
    return min(int(page), TMDB_MAX_PAGE)


def _cache_get(key: str) -> Any | None:
    now = time.time()
    with _MEMORY_LOCK:
        cached = _MEMORY_CACHE.get(key)
        if cached is not None:
            expires, payload = cached
            if expires > now:
                return payload
            _MEMORY_CACHE.pop(key, None)
    try:
        db = SessionLocal()
        try:
            row = db.get(TmdbCache, key)
            if row is None:
                return None
            if row.expires_at < datetime.utcnow():
                db.delete(row)
                db.commit()
                return None
            payload = json.loads(row.payload)
        finally:
            db.close()
        with _MEMORY_LOCK:
            _MEMORY_CACHE[key] = (now + min(CACHE_TTL_SECONDS, 300), payload)
        return payload
    except Exception:
        return None


def _cache_set(key: str, payload: Any, ttl: int = CACHE_TTL_SECONDS) -> None:
    with _MEMORY_LOCK:
        _MEMORY_CACHE[key] = (time.time() + ttl, payload)
        if len(_MEMORY_CACHE) > 512:
            for stale_key, _ in list(_MEMORY_CACHE.items())[:128]:
                _MEMORY_CACHE.pop(stale_key, None)
    try:
        db = SessionLocal()
        try:
            expires = datetime.utcnow() + timedelta(seconds=ttl)
            row = db.get(TmdbCache, key)
            if row is None:
                db.add(TmdbCache(cache_key=key, payload=json.dumps(payload), expires_at=expires))
            else:
                row.payload = json.dumps(payload)
                row.expires_at = expires
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


def clear_cache() -> None:
    with _MEMORY_LOCK:
        _MEMORY_CACHE.clear()
    try:
        db = SessionLocal()
        try:
            db.query(TmdbCache).delete()
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


def _request(path: str, params: dict | None = None) -> dict:
    if not is_configured():
        raise TmdbError(
            "TMDB is not configured. Set TMDB_API_KEY or TMDB_ACCESS_TOKEN in backend/.env."
        )

    url = f"{TMDB_BASE_URL}/{path.lstrip('/')}"
    query: dict[str, Any] = {"language": "en-US", "include_adult": "false"}
    if params:
        query.update({key: value for key, value in params.items() if value is not None})
    headers = {"Accept": "application/json"}
    if TMDB_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {TMDB_ACCESS_TOKEN}"
    else:
        query["api_key"] = TMDB_API_KEY

    last_error: Exception | None = None
    for attempt in range(3):
        global _LAST_REQUEST_AT
        with _RATE_LOCK:
            elapsed = time.time() - _LAST_REQUEST_AT
            if elapsed < TMDB_MIN_INTERVAL:
                time.sleep(TMDB_MIN_INTERVAL - elapsed)
            _LAST_REQUEST_AT = time.time()

        try:
            with httpx.Client(timeout=TMDB_TIMEOUT_SECONDS) as client:
                response = client.get(url, params=query, headers=headers)

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "1")
                try:
                    wait = min(float(retry_after), 8.0)
                except ValueError:
                    wait = 1.0
                last_error = TmdbError("TMDB rate limit reached.")
                time.sleep(wait)
                continue

            if response.status_code in (401, 403):
                raise TmdbError(
                    "TMDB authentication failed. Check TMDB_API_KEY or TMDB_ACCESS_TOKEN."
                )
            if response.status_code == 404:
                raise TmdbError("TMDB resource not found.")
            if response.status_code >= 500:
                last_error = TmdbError(f"TMDB server error ({response.status_code}).")
                time.sleep(0.5 * (attempt + 1))
                continue
            if response.status_code >= 400:
                detail = response.text[:240]
                raise TmdbError(f"TMDB request failed ({response.status_code}): {detail}")

            try:
                payload = response.json()
            except ValueError as exc:
                raise TmdbError("TMDB returned an invalid JSON response.") from exc
            if isinstance(payload, dict) and payload.get("success") is False:
                raise TmdbError(str(payload.get("status_message") or "TMDB request failed."))
            return payload
        except httpx.TimeoutException as exc:
            last_error = TmdbError("TMDB request timed out.")
        except httpx.HTTPError as exc:
            last_error = TmdbError(f"TMDB network error: {exc}")
        time.sleep(0.4 * (attempt + 1))

    raise last_error or TmdbError("TMDB request failed after retries.")


def _image_url(path: str | None) -> str | None:
    if not path:
        return None
    if str(path).startswith("http"):
        return str(path)
    return f"{TMDB_IMAGE_BASE}{path}"


def _normalize_movie(raw: dict, *, details: bool = False) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("id") is None:
        raise TmdbError("TMDB returned an invalid movie payload.")
    release_date = raw.get("release_date") or raw.get("first_air_date") or None
    release_year: int | None = None
    if release_date:
        try:
            release_year = int(str(release_date)[:4])
        except ValueError:
            release_year = None
    raw_genres = raw.get("genres") if isinstance(raw.get("genres"), list) else None
    names = genre_names(raw.get("genre_ids"), raw_genres)
    language = raw.get("original_language")
    item: dict[str, Any] = {
        "source": "tmdb",
        "external_id": str(raw.get("id")),
        "title": raw.get("title") or raw.get("name") or raw.get("original_title") or "",
        "original_title": raw.get("original_title") or raw.get("original_name"),
        "overview": raw.get("overview") or "",
        "poster_url": _image_url(raw.get("poster_path")),
        "backdrop_url": _image_url(raw.get("backdrop_path")),
        "release_date": release_date,
        "release_year": release_year,
        "original_language": language,
        "language_name": language_name(language),
        "genres": names,
        "genre_ids": raw.get("genre_ids") or [g.get("id") for g in (raw_genres or []) if g.get("id")],
        "vote_average": raw.get("vote_average"),
        "vote_count": raw.get("vote_count"),
        "popularity": raw.get("popularity"),
        "adult": bool(raw.get("adult", False)),
    }
    if details:
        item.update(
            {
                "runtime": raw.get("runtime"),
                "tagline": raw.get("tagline") or "",
                "status": raw.get("status"),
                "spoken_languages": [lang.get("english_name") for lang in raw.get("spoken_languages", []) if lang.get("english_name")],
                "production_countries": [country.get("name") for country in raw.get("production_countries", []) if country.get("name")],
                "homepage": raw.get("homepage") or None,
            }
        )
    return item


def _paged(path: str, params: dict, cache_key: str) -> dict[str, Any]:
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    data = _request(path, params)
    page = int(data.get("page") or params.get("page") or 1)
    result = {
        "page": page,
        "total_pages": min(int(data.get("total_pages") or 1), TMDB_MAX_PAGE),
        "total_results": int(data.get("total_results") or 0),
        "results": [_normalize_movie(movie) for movie in data.get("results", []) if isinstance(movie, dict)],
        "source": "tmdb",
    }
    _cache_set(cache_key, result)
    return result


def search_movies(
    query: str,
    *,
    language: str | None = None,
    genre: int | str | None = None,
    year: int | None = None,
    page: int = 1,
) -> dict:
    """Search the global TMDB catalogue.

    ``language``, genre and year are applied client-side because TMDB's search
    endpoint has no ``original_language``/genre filter.  Filtering one raw page
    would routinely return nothing for languages that are sparse in a given
    page of global results, so a filtered search keeps scanning further raw
    pages until it has a full screen of matches, runs out of pages, or hits
    ``TMDB_SEARCH_SCAN_PAGES``.
    """

    page = _clamp_page(page)
    query = (query or "").strip()
    if not query:
        return discover_movies(language=language, genre=genre, year=year, page=page)
    cache_key = f"search:{query.lower()}:{language}:{genre}:{year}:{page}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    genre_id = genre_id_for(genre)
    filtered = bool(language or genre_id is not None or year)
    params: dict[str, Any] = {"query": query, "page": page}
    if year:
        params["primary_release_year"] = year
    data = _request("/search/movie", params)

    raw_page = int(data.get("page") or page)
    total_pages = min(int(data.get("total_pages") or 1), TMDB_MAX_PAGE)
    total_results = int(data.get("total_results") or 0)
    raw_results = [movie for movie in data.get("results", []) if isinstance(movie, dict)]

    def matches(movie: dict[str, Any]) -> bool:
        if language and movie.get("original_language") != language:
            return False
        if genre_id is not None and genre_id not in (movie.get("genre_ids") or []):
            return False
        if year and movie.get("release_year") != int(year):
            return False
        return True

    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    scanned = 1

    def add(page_results: list[dict]) -> None:
        for raw in page_results:
            movie = _normalize_movie(raw)
            external_id = str(movie.get("external_id") or "")
            if not external_id or external_id in seen or not matches(movie):
                continue
            seen.add(external_id)
            results.append(movie)

    add(raw_results)

    if filtered:
        while (
            len(results) < SEARCH_SCAN_TARGET
            and scanned < TMDB_SEARCH_SCAN_PAGES
            and raw_results  # a raw page with no results means we ran past the last page
            and raw_page + scanned <= total_pages
        ):
            try:
                more = _request("/search/movie", {**params, "page": raw_page + scanned})
            except TmdbError:
                break
            more_results = [movie for movie in more.get("results", []) if isinstance(movie, dict)]
            if not more_results:
                break
            scanned += 1
            raw_results = more_results
            add(raw_results)

    result = {
        "page": page,
        "total_pages": total_pages,
        "total_results": total_results or len(results),
        "results": results,
        "source": "tmdb",
        "filtered": filtered,
        "pages_scanned": scanned,
    }
    _cache_set(cache_key, result)
    return result


def popular_movies(*, language: str | None = None, page: int = 1) -> dict:
    page = _clamp_page(page)
    if language:
        return discover_movies(language=language, page=page, sort_by="popularity.desc")
    return _paged("/movie/popular", {"page": page}, f"popular:{language}:{page}")


def trending_movies(*, time_window: str = "week", page: int = 1) -> dict:
    if time_window not in ("day", "week"):
        time_window = "week"
    page = _clamp_page(page)
    return _paged(f"/trending/movie/{time_window}", {"page": page}, f"trending:{time_window}:{page}")


def discover_movies(
    *,
    language: str | None = None,
    genre: int | str | None = None,
    year: int | None = None,
    page: int = 1,
    sort_by: str = "popularity.desc",
    vote_count_gte: int | None = None,
    region: str | None = None,
) -> dict:
    page = _clamp_page(page)
    genre_id = genre_id_for(genre)
    cache_key = f"discover:{language}:{genre_id}:{year}:{page}:{sort_by}:{vote_count_gte}:{region}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    params: dict[str, Any] = {"page": page, "sort_by": sort_by}
    if language:
        params["with_original_language"] = language
    if genre_id is not None:
        params["with_genres"] = genre_id
    if year:
        params["primary_release_year"] = year
    if vote_count_gte is not None:
        params["vote_count.gte"] = vote_count_gte
    if region:
        params["region"] = region
    data = _request("/discover/movie", params)
    result = {
        "page": page,
        "total_pages": min(int(data.get("total_pages") or 1), TMDB_MAX_PAGE),
        "total_results": int(data.get("total_results") or 0),
        "results": [_normalize_movie(movie) for movie in data.get("results", []) if isinstance(movie, dict)],
        "source": "tmdb",
    }
    _cache_set(cache_key, result)
    return result


def movie_details(tmdb_id: int) -> dict:
    cache_key = f"movie:{tmdb_id}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    data = _request(f"/movie/{int(tmdb_id)}")
    result = _normalize_movie(data, details=True)
    _cache_set(cache_key, result, ttl=DETAIL_CACHE_TTL_SECONDS)
    return result


def movie_recommendations(tmdb_id: int, *, page: int = 1) -> dict:
    page = _clamp_page(page)
    return _paged(
        f"/movie/{int(tmdb_id)}/recommendations",
        {"page": page},
        f"recommendations:{int(tmdb_id)}:{page}",
    )


def similar_movies(tmdb_id: int, *, page: int = 1) -> dict:
    page = _clamp_page(page)
    return _paged(
        f"/movie/{int(tmdb_id)}/similar",
        {"page": page},
        f"similar:{int(tmdb_id)}:{page}",
    )


def find_movie(title: str, year: int | None = None) -> dict | None:
    """Return a cached exact-title TMDB match (used to enrich ML recommendations)."""

    clean_title = (title or "").strip()
    if not clean_title:
        return None
    cache_key = f"match:{clean_title.lower()}:{year}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached if isinstance(cached, dict) and cached.get("external_id") else None
    try:
        data = search_movies(clean_title, year=year, page=1)
    except TmdbError:
        return None
    wanted = clean_title.lower()
    match = None
    for movie in data.get("results", []):
        candidate = str(movie.get("title") or "").strip().lower()
        original = str(movie.get("original_title") or "").strip().lower()
        if candidate == wanted or original == wanted:
            if year is None or movie.get("release_year") == year:
                match = movie
                break
    if match is None and data.get("results"):
        match = data["results"][0]
    _cache_set(cache_key, match or {}, ttl=DETAIL_CACHE_TTL_SECONDS)
    return match


def attribution() -> dict[str, str]:
    return {
        "provider": "TMDB",
        "notice": "This product uses the TMDB API but is not endorsed or certified by TMDB.",
        "url": "https://www.themoviedb.org/",
    }
