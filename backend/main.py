import json
import math
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import database
import tmdb
from database import (
    Favourite,
    User,
    UserPreference,
    UserRating,
    WatchlistItem,
    get_db,
    init_db,
)

BACKEND_DIR = Path(__file__).resolve().parent
MODELS_DIR = BACKEND_DIR / "models"
METRICS_PATH = MODELS_DIR / "metrics.json"

_default_origins = ",".join(
    [
        "http://localhost:8443",
        "http://127.0.0.1:8443",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
)
CORS_ORIGINS = [origin.strip() for origin in os.getenv("CORS_ORIGINS", _default_origins).split(",") if origin.strip()]

MAX_LANGUAGE_REQUESTS = int(os.getenv("TMDB_MAX_LANGUAGE_REQUESTS", "6"))
MAX_GENRE_REQUESTS = int(os.getenv("TMDB_MAX_GENRE_REQUESTS", "4"))
MAX_FAVOURITE_SEEDS = int(os.getenv("TMDB_MAX_FAVOURITE_SEEDS", "3"))
MIN_CANDIDATES = int(os.getenv("TMDB_MIN_CANDIDATES", "40"))

state: dict[str, Any] = {
    "models": None,
    "ratings_by_user": {},
    "rated_items": {},
    "genre_prior": None,
    "error": None,
}


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    email: str
    password: str


class PreferenceRequest(BaseModel):
    languages: list[str] = []
    genres: list[str] = []
    moods: list[str] = []
    release_period: str = ""
    duration: str = ""
    onboarding_completed: bool = False


class CatalogueItemRequest(BaseModel):
    source: str = "tmdb"
    external_id: str
    title: str
    poster_url: str | None = None
    genres: list[str] = []


class RatingRequest(BaseModel):
    source: str = "tmdb"
    external_id: str
    rating: float = Field(ge=0.5, le=5.0)


bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    user_id = auth.decode_token(credentials.credentials)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    user = db.get(User, int(user_id))
    if user is None:
        raise HTTPException(status_code=401, detail="User not found.")
    return user


# ---------------------------------------------------------------------------
# Trained-model artifacts
# ---------------------------------------------------------------------------


def load_ratings_data() -> tuple[dict[int, pd.DataFrame], dict[int, set[int]]]:
    ratings_by_user: dict[int, pd.DataFrame] = {}
    rated_items: dict[int, set[int]] = {}
    try:
        from src.data.load_dataset import load_ratings

        ratings = load_ratings()
        for uid, group in ratings.groupby("UserID"):
            uid = int(uid)
            ratings_by_user[uid] = group[["MovieID", "Rating"]].copy()
            rated_items[uid] = set(int(x) for x in group["MovieID"].tolist())
    except Exception as exc:  # noqa: BLE001
        state["error"] = f"Ratings data unavailable: {exc}"
    return ratings_by_user, rated_items


def load_artifacts() -> None:
    state["error"] = None
    required = ["hybrid_model.joblib", "movie_metadata.joblib"]
    missing = [name for name in required if not (MODELS_DIR / name).is_file()]
    if missing:
        state["models"] = None
        state["error"] = "Missing model artifacts: " + ", ".join(missing)
        return
    try:
        hybrid = joblib.load(MODELS_DIR / "hybrid_model.joblib")
        metadata = joblib.load(MODELS_DIR / "movie_metadata.joblib")
        popularity = None
        popularity_path = MODELS_DIR / "popularity_model.joblib"
        if popularity_path.is_file():
            popularity = joblib.load(popularity_path)
        state["models"] = {
            "hybrid": hybrid,
            "metadata": metadata,
            "popularity": popularity,
        }
        state["genre_prior"] = None
    except Exception as exc:  # noqa: BLE001
        state["models"] = None
        state["error"] = f"Failed to load model artifacts: {exc}"


def metadata_lookup(metadata: pd.DataFrame) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for _, row in metadata.iterrows():
        result[int(row["MovieID"])] = {
            "movie_id": int(row["MovieID"]),
            "title": str(row["Title"]),
            "genres": str(row["Genres"]),
        }
    return result


def content_user_profile(genre_matrix, movie_to_idx, user_ratings, global_mean):
    if user_ratings is None or user_ratings.empty:
        return None
    vec = np.zeros(genre_matrix.shape[1], dtype=float)
    weight_sum = 0.0
    for _, row in user_ratings.iterrows():
        idx = movie_to_idx.get(int(row["MovieID"]))
        if idx is None:
            continue
        weight = float(row["Rating"]) - global_mean
        vec += weight * genre_matrix[idx].toarray().ravel()
        weight_sum += abs(weight)
    if weight_sum == 0:
        return None
    norm = np.linalg.norm(vec)
    if norm == 0:
        return None
    return vec / norm


def recommend_for_user(user_id: int, top_k: int = 10) -> tuple[list[int], list[float]]:
    models = state["models"]
    if not models:
        raise RuntimeError("Models are not loaded.")
    hybrid = models["hybrid"]
    movie_ids = hybrid["movie_ids"]
    user_to_idx = hybrid["user_to_idx"]
    movie_to_idx = hybrid["movie_to_idx"]
    user_factors = hybrid["user_factors"]
    movie_factors = hybrid["movie_factors"]
    genre_matrix = hybrid["genre_matrix"]
    cf_global = hybrid["global_mean"]
    content_global = hybrid.get("pop_global_mean", cf_global)
    rated = state["rated_items"].get(user_id, set())
    candidates = [mid for mid in movie_ids if mid not in rated]
    if not candidates:
        candidates = list(movie_ids)

    user_ratings = state["ratings_by_user"].get(user_id)
    u = user_to_idx.get(user_id)
    if u is not None:
        all_cf = cf_global + user_factors[u] @ movie_factors.T
        cf_vals = np.array([float(all_cf[movie_to_idx[mid]]) for mid in candidates], dtype=float)
    else:
        cf_vals = np.full(len(candidates), cf_global, dtype=float)

    profile = content_user_profile(genre_matrix, movie_to_idx, user_ratings if user_ratings is not None else pd.DataFrame(), content_global)
    if profile is not None:
        content_arr = np.asarray(genre_matrix @ profile).ravel()
        ct_vals = np.array([float(content_arr[movie_to_idx[mid]]) for mid in candidates], dtype=float)
    else:
        ct_vals = np.zeros(len(candidates), dtype=float)

    cf_norm = (cf_vals - cf_vals.min()) / (cf_vals.max() - cf_vals.min() + 1e-12)
    ct_norm = (ct_vals - ct_vals.min()) / (ct_vals.max() - ct_vals.min() + 1e-12)
    scores = hybrid["cf_weight"] * cf_norm + hybrid["content_weight"] * ct_norm
    order = np.argsort(scores)[::-1][:top_k]
    rec_ids = [candidates[i] for i in order]
    rec_scores = [float(scores[i]) for i in order]
    return rec_ids, rec_scores


def _movie_genres(metadata: pd.DataFrame, movie_id: int) -> list[str]:
    rows = metadata[metadata["MovieID"] == movie_id]
    if rows.empty:
        return []
    return [genre for genre in str(rows.iloc[0]["Genres"]).split("|") if genre]


def candidate_scores(user_id: int) -> list[tuple[int, float]]:
    models = state["models"]
    if not models:
        raise RuntimeError("Models are not loaded.")
    hybrid = models["hybrid"]
    movie_ids = hybrid["movie_ids"]
    user_to_idx = hybrid["user_to_idx"]
    movie_to_idx = hybrid["movie_to_idx"]
    user_factors = hybrid["user_factors"]
    movie_factors = hybrid["movie_factors"]
    genre_matrix = hybrid["genre_matrix"]
    cf_global = hybrid["global_mean"]
    content_global = hybrid.get("pop_global_mean", cf_global)
    rated = state["rated_items"].get(user_id, set()) if user_id in user_to_idx else set()
    candidates = [mid for mid in movie_ids if mid not in rated]
    if not candidates:
        candidates = list(movie_ids)
    if not candidates:
        return []

    user_ratings = state["ratings_by_user"].get(user_id)
    u = user_to_idx.get(user_id)
    if u is not None:
        all_cf = cf_global + user_factors[u] @ movie_factors.T
        cf_vals = np.array([float(all_cf[movie_to_idx[mid]]) for mid in candidates], dtype=float)
    else:
        cf_vals = np.full(len(candidates), cf_global, dtype=float)

    profile = content_user_profile(
        genre_matrix,
        movie_to_idx,
        user_ratings if user_ratings is not None else pd.DataFrame(),
        content_global,
    )
    if profile is not None:
        content_arr = np.asarray(genre_matrix @ profile).ravel()
        ct_vals = np.array([float(content_arr[movie_to_idx[mid]]) for mid in candidates], dtype=float)
    else:
        ct_vals = np.zeros(len(candidates), dtype=float)

    cf_norm = (cf_vals - cf_vals.min()) / (cf_vals.max() - cf_vals.min() + 1e-12)
    ct_norm = (ct_vals - ct_vals.min()) / (ct_vals.max() - ct_vals.min() + 1e-12)
    scores = hybrid["cf_weight"] * cf_norm + hybrid["content_weight"] * ct_norm
    return [(mid, float(score)) for mid, score in zip(candidates, scores)]


def diverse_recommendations(user_id: int, diversity: float, limit: int) -> list[dict[str, Any]]:
    scored = candidate_scores(user_id)
    if not scored:
        return []
    scored.sort(key=lambda item: (-item[1], item[0]))
    pool_size = min(len(scored), max(limit * 5, 50))
    pool = scored[:pool_size]
    metadata = state["models"]["metadata"]
    genre_sets = {mid: set(_movie_genres(metadata, mid)) for mid, _ in pool}

    def genre_similarity(left: int, right: int) -> float:
        left_genres = genre_sets.get(left, set())
        right_genres = genre_sets.get(right, set())
        union = left_genres | right_genres
        if not union:
            return 0.0
        return len(left_genres & right_genres) / len(union)

    selected_ids: list[int] = []
    selected: list[dict[str, Any]] = []
    remaining = list(pool)
    while len(selected) < limit and remaining:
        best_index = 0
        best_mmr = None
        best_similarity = 0.0
        for index, (movie_id, relevance) in enumerate(remaining):
            if not selected_ids:
                mmr = (1.0 - diversity) * relevance
                max_similarity = 0.0
            else:
                similarities = [genre_similarity(movie_id, selected_id) for selected_id in selected_ids]
                max_similarity = max(similarities) if similarities else 0.0
                mmr = (1.0 - diversity) * relevance - diversity * max_similarity
            if (
                best_mmr is None
                or mmr > best_mmr
                or (mmr == best_mmr and movie_id < remaining[best_index][0])
            ):
                best_index = index
                best_mmr = mmr
                best_similarity = max_similarity
        movie_id, relevance = remaining.pop(best_index)
        if diversity > 0 and best_similarity > 0:
            most_similar = max(selected_ids, key=lambda selected_id: genre_similarity(movie_id, selected_id))
            explanation = (
                f"MMR balances relevance ({relevance:.3f}) against genre overlap "
                f"({best_similarity:.2f}) with movie {most_similar}."
            )
        else:
            explanation = "Selected by relevance; no diversity penalty applied."
        selected_ids.append(movie_id)
        selected.append(
            {
                "movie_id": movie_id,
                "relevance_score": relevance,
                "mmr_score": float(best_mmr if best_mmr is not None else relevance),
                "explanation": explanation,
            }
        )
    return selected


def popular_movies(top_k: int = 10) -> tuple[list[int], list[float]]:
    models = state["models"]
    if not models:
        raise RuntimeError("Models are not loaded.")
    hybrid = models["hybrid"]
    pop_stats = hybrid.get("pop_stats")
    if pop_stats is None and models.get("popularity"):
        pop_stats = models["popularity"].get("pop_stats")
    if pop_stats is None:
        movie_ids = hybrid["movie_ids"][:top_k]
        return movie_ids, [0.0] * len(movie_ids)
    stats = pop_stats.sort_values(["rating_mean", "rating_count"], ascending=[False, False])
    ids = stats["MovieID"].head(top_k).tolist()
    scores = [float(x) for x in stats["rating_mean"].head(top_k).tolist()]
    return [int(x) for x in ids], scores


# ---------------------------------------------------------------------------
# TMDB <-> trained MovieLens integration
# ---------------------------------------------------------------------------


_GENRE_ALIASES = {
    "children's": "Family",
    "sci-fi": "Science Fiction",
    "film-noir": "Crime",
    "musical": "Music",
    "tv movie": "TV Movie",
}

_TITLE_YEAR = re.compile(r"^(?P<title>.*?)\s*\((?P<year>\d{4})\)\s*$")


def _split_ml_title(title: str) -> tuple[str, int | None]:
    match = _TITLE_YEAR.match(str(title).strip())
    if match:
        return match.group("title").strip(), int(match.group("year"))
    return str(title).strip(), None


def _normalise_genre(name: str) -> str:
    return _GENRE_ALIASES.get(name.strip().lower(), name.strip())


def _ml_genre_prior() -> dict[str, float]:
    """Genre quality prior derived from the trained popularity/content artifacts."""

    if state.get("genre_prior"):
        return state["genre_prior"]
    models = state.get("models")
    if not models:
        return {}
    hybrid = models.get("hybrid") or {}
    metadata = models.get("metadata")
    pop_stats = hybrid.get("pop_stats")
    if pop_stats is None and models.get("popularity"):
        pop_stats = models["popularity"].get("pop_stats")
    if metadata is None:
        return {}
    if pop_stats is None:
        prior = {_normalise_genre(g): 0.5 for g in metadata["Genres"].astype(str).str.split("|").explode().unique()}
        state["genre_prior"] = prior
        return prior

    stats = pop_stats.set_index("MovieID")
    totals: dict[str, float] = {}
    counts: dict[str, float] = {}
    all_ratings: list[float] = []
    for _, row in metadata.iterrows():
        movie_id = int(row["MovieID"])
        if movie_id not in stats.index:
            continue
        record = stats.loc[movie_id]
        mean = float(record["rating_mean"])
        count = float(record["rating_count"])
        all_ratings.append(mean)
        for genre in str(row["Genres"]).split("|"):
            key = _normalise_genre(genre)
            if not key:
                continue
            totals[key] = totals.get(key, 0.0) + mean * count
            counts[key] = counts.get(key, 0.0) + count
    global_mean = float(np.mean(all_ratings)) if all_ratings else 3.5
    prior = {}
    for genre, total in totals.items():
        mean = total / counts[genre]
        prior[genre] = max(0.0, min(1.0, (mean - 1.0) / 4.0))
    state["genre_prior"] = {"global": global_mean, "genres": prior}
    return state["genre_prior"]


def _ml_prior_for_genres(genres: list[str]) -> float:
    prior = _ml_genre_prior()
    if not prior:
        return 0.5
    mapping = prior.get("genres", prior)
    values = [float(mapping.get(_normalise_genre(genre), 0.5)) for genre in genres]
    return float(np.mean(values)) if values else 0.5


def _enrich_item(item: dict[str, Any]) -> dict[str, Any]:
    if not tmdb.is_configured():
        return {**item, "source": item.get("source", "movielens"), "catalogue_available": False}
    title, year = _split_ml_title(item.get("title") or "")
    match = tmdb.find_movie(title, year)
    if not match:
        return {**item, "source": "movielens", "catalogue_available": True}
    enriched = {
        **item,
        "source": "tmdb",
        "external_id": match.get("external_id"),
        "title": match.get("title") or item.get("title"),
        "poster_url": match.get("poster_url"),
        "backdrop_url": match.get("backdrop_url"),
        "overview": match.get("overview"),
        "release_date": match.get("release_date"),
        "release_year": match.get("release_year"),
        "original_language": match.get("original_language"),
        "language_name": match.get("language_name"),
        "vote_average": match.get("vote_average"),
        "vote_count": match.get("vote_count"),
        "popularity": match.get("popularity"),
        "catalogue_available": True,
    }
    if not enriched.get("genres"):
        enriched["genres"] = "|".join(match.get("genres") or [])
    return enriched


def _enrich_items(items: list[dict[str, Any]], enabled: bool = True) -> list[dict[str, Any]]:
    if not enabled or not tmdb.is_configured():
        return [{**item, "catalogue_available": tmdb.is_configured()} for item in items]
    return [_enrich_item(item) for item in items]


# ---------------------------------------------------------------------------
# Multilingual hybrid recommendation engine
# ---------------------------------------------------------------------------

_MOOD_GENRES: dict[str, set[str]] = {
    "feel-good": {"Comedy", "Family", "Romance", "Animation"},
    "suspenseful": {"Thriller", "Mystery", "Horror", "Crime"},
    "thought-provoking": {"Drama", "Documentary", "Science Fiction", "History"},
    "relaxing": {"Comedy", "Family", "Romance", "Animation"},
    "adventurous": {"Adventure", "Action", "Fantasy", "Science Fiction"},
    "emotional": {"Drama", "Romance", "Music"},
}

_PERIOD_RANGES: dict[str, tuple[int | None, int | None]] = {
    "2020s": (2020, 2029),
    "2010s": (2010, 2019),
    "2000s": (2000, 2009),
    "1990s": (1990, 1999),
    "classic": (None, 1989),
    "before 2000": (None, 1999),
    "before 2010": (None, 2009),
    "recent": (2015, None),
}


def _period_range(period: str) -> tuple[int | None, int | None] | None:
    if not period:
        return None
    return _PERIOD_RANGES.get(period.strip().lower())


def _in_period(year: int | None, period: str) -> bool | None:
    if year is None or not period:
        return None
    bounds = _period_range(period)
    if not bounds:
        return None
    low, high = bounds
    if low is not None and year < low:
        return False
    if high is not None and year > high:
        return False
    return True


def _preference_dict(user: User) -> dict[str, Any]:
    prefs = user.preferences
    if prefs is None:
        return {
            "languages": [],
            "genres": [],
            "moods": [],
            "release_period": "",
            "duration": "",
            "onboarding_completed": False,
        }
    return prefs.as_dict()


def _user_catalogue_signals(db: Session, user: User) -> dict[str, Any]:
    favourites = list(user.favourites)
    watchlist = list(user.watchlist)
    ratings = list(user.ratings)
    fav_genres: set[str] = set()
    fav_ids: set[str] = set()
    for favourite in favourites:
        try:
            fav_genres |= {_normalise_genre(g) for g in json.loads(favourite.genres or "[]") if g}
        except Exception:  # noqa: BLE001
            continue
        fav_ids.add(str(favourite.external_id))
    liked_genres: set[str] = set()
    disliked_genres: set[str] = set()
    liked_ids: set[str] = set()
    rated_ids: set[str] = set()
    for rating in ratings:
        rated_ids.add(str(rating.external_id))
    # Genres for rated catalogue items are recovered from favourites/watchlist when available.
    known_genres: dict[str, list[str]] = {}
    for item in favourites + watchlist:
        try:
            known_genres[str(item.external_id)] = json.loads(item.genres or "[]")
        except Exception:  # noqa: BLE001
            known_genres[str(item.external_id)] = []
    missing_genres = [
        str(rating.external_id)
        for rating in ratings
        if str(rating.external_id) not in known_genres and str(rating.source) == "tmdb"
    ]
    for external_id in missing_genres[:12]:
        if not tmdb.is_configured():
            break
        try:
            details = tmdb.movie_details(int(external_id))
        except (ValueError, tmdb.TmdbError):
            continue
        known_genres[external_id] = list(details.get("genres") or [])
    for rating in ratings:
        genres = {_normalise_genre(g) for g in known_genres.get(str(rating.external_id), []) if g}
        if rating.rating >= 4:
            liked_ids.add(str(rating.external_id))
            liked_genres |= genres
        elif rating.rating <= 2:
            disliked_genres |= genres
    seen_ids = fav_ids | rated_ids | {str(item.external_id) for item in watchlist}
    return {
        "favourites": favourites,
        "watchlist": watchlist,
        "fav_genres": fav_genres,
        "liked_genres": liked_genres,
        "disliked_genres": disliked_genres,
        "liked_ids": liked_ids,
        "seen_ids": seen_ids,
    }


def _collect_interactions(db: Session) -> dict[int, dict[str, float]]:
    interactions: dict[int, dict[str, float]] = {}

    def bucket(user_id: int) -> dict[str, float]:
        return interactions.setdefault(int(user_id), {})

    for rating in db.query(UserRating).all():
        key = f"{rating.source}:{rating.external_id}"
        bucket(rating.user_id)[key] = float(rating.rating)
    for favourite in db.query(Favourite).all():
        key = f"{favourite.source}:{favourite.external_id}"
        bucket(favourite.user_id).setdefault(key, 4.5)
    for item in db.query(WatchlistItem).all():
        key = f"{item.source}:{item.external_id}"
        bucket(item.user_id).setdefault(key, 3.5)
    return interactions


def _collaborative_scores(
    db: Session, user: User, candidates: set[str]
) -> tuple[dict[str, float], int]:
    """User-based CF over real app interactions (ratings, favourites, watchlist)."""

    interactions = _collect_interactions(db)
    current = interactions.get(int(user.id), {})
    if not current or not candidates:
        return {}, 0
    current_keys = set(current)
    neighbours: list[tuple[float, dict[str, float]]] = []
    for other_id, values in interactions.items():
        if other_id == int(user.id):
            continue
        overlap = current_keys & set(values)
        if not overlap:
            continue
        dot = sum(current[key] * values[key] for key in overlap)
        norm_current = math.sqrt(sum(current[key] ** 2 for key in overlap))
        norm_other = math.sqrt(sum(values[key] ** 2 for key in overlap))
        if norm_current == 0 or norm_other == 0:
            continue
        similarity = dot / (norm_current * norm_other)
        if similarity > 0:
            neighbours.append((similarity, values))
    if not neighbours:
        return {}, 0
    neighbours.sort(key=lambda pair: pair[0], reverse=True)
    neighbours = neighbours[:50]
    weighted: dict[str, float] = {}
    totals: dict[str, float] = {}
    for similarity, values in neighbours:
        for external_id in candidates:
            key = f"tmdb:{external_id}"
            if key not in values:
                continue
            weighted[external_id] = weighted.get(external_id, 0.0) + similarity * values[key]
            totals[external_id] = totals.get(external_id, 0.0) + similarity
    scores = {external_id: weighted[external_id] / totals[external_id] for external_id in weighted if totals[external_id] > 0}
    return scores, len(neighbours)


def _candidate_pool(
    prefs: dict[str, Any],
    signals: dict[str, Any],
    languages: list[str],
    genres: list[str],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []

    def extend(payload: dict | None) -> None:
        if payload:
            candidates.extend(payload.get("results", []))

    try:
        extend(tmdb.trending_movies(time_window="week", page=1))
        extend(tmdb.trending_movies(time_window="day", page=1))
    except tmdb.TmdbError:
        pass

    for language in languages[:MAX_LANGUAGE_REQUESTS]:
        try:
            extend(tmdb.discover_movies(language=language, page=1, sort_by="popularity.desc"))
        except tmdb.TmdbError:
            continue

    for genre in genres[:MAX_GENRE_REQUESTS]:
        genre_id = tmdb.genre_id_for(genre)
        if genre_id is None:
            continue
        try:
            extend(tmdb.discover_movies(genre=genre_id, page=1, sort_by="popularity.desc"))
        except tmdb.TmdbError:
            continue

    for favourite in signals["favourites"][:MAX_FAVOURITE_SEEDS]:
        if str(favourite.source) != "tmdb":
            continue
        try:
            extend(tmdb.movie_recommendations(int(favourite.external_id), page=1))
        except (ValueError, tmdb.TmdbError):
            continue

    if len(candidates) < MIN_CANDIDATES:
        for page in (1, 2):
            try:
                extend(tmdb.popular_movies(page=page))
            except tmdb.TmdbError:
                continue

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    seen_ids = signals["seen_ids"]
    for movie in candidates:
        external_id = str(movie.get("external_id") or "")
        if not external_id or external_id in seen or external_id in seen_ids:
            continue
        seen.add(external_id)
        unique.append(movie)
    return unique


def _score_catalogue_movie(
    movie: dict[str, Any],
    prefs: dict[str, Any],
    signals: dict[str, Any],
    cf_scores: dict[str, float],
    tuning: dict[str, float] | None = None,
) -> tuple[float, dict[str, Any]]:
    tuning = tuning or {}
    familiarity = max(0.0, min(1.0, float(tuning.get("familiarity", 0.5))))
    novelty = max(0.0, min(1.0, float(tuning.get("novelty", 0.5))))
    popularity_weight = max(0.0, min(1.0, float(tuning.get("popularity", 0.5))))
    genres = {_normalise_genre(g) for g in (movie.get("genres") or [])}
    preferred_genres = {_normalise_genre(g) for g in prefs.get("genres", [])}
    moods = prefs.get("moods", [])
    mood_genres: set[str] = set()
    for mood in moods:
        mood_genres |= _MOOD_GENRES.get(str(mood).strip().lower(), set())

    language = movie.get("original_language")
    preferred_languages = set(prefs.get("languages", []))
    language_match = bool(language and language in preferred_languages)
    cross_language = bool(preferred_languages and language and language not in preferred_languages)

    preferred_overlap = genres & preferred_genres
    favourite_overlap = genres & signals["fav_genres"]
    liked_overlap = genres & signals["liked_genres"]
    disliked_overlap = genres & signals["disliked_genres"]
    mood_overlap = genres & mood_genres

    genre_affinity = len(preferred_overlap) / max(len(genres), 1)
    favourite_affinity = len(favourite_overlap) / max(len(genres), 1)
    liked_affinity = len(liked_overlap) / max(len(genres), 1)
    disliked_affinity = len(disliked_overlap) / max(len(genres), 1)

    ml_prior = _ml_prior_for_genres(list(genres))
    vote_average = float(movie.get("vote_average") or 0.0)
    vote_count = int(movie.get("vote_count") or 0)
    # Bayesian rating so films with a handful of votes do not outrank proven titles.
    bayesian = (vote_average * vote_count + 6.5 * 80) / (vote_count + 80) if vote_count >= 0 else 0.0
    popularity = float(movie.get("popularity") or 0.0)

    cf_score = cf_scores.get(str(movie.get("external_id")))
    period_match = _in_period(movie.get("release_year"), prefs.get("release_period", ""))

    score = 0.0
    score += (3.8 + 2.4 * familiarity) if language_match else 0.0
    score += (1.4 + 1.6 * familiarity) * genre_affinity
    score += 1.5 * favourite_affinity
    score += 1.8 * liked_affinity
    score -= 2.4 * disliked_affinity
    score += 0.9 * len(mood_overlap)
    score += 1.0 * ml_prior
    score += (bayesian / 10.0) * 1.6
    score += min(math.log1p(max(popularity, 0.0)) / 5.0, 1.0) * (0.15 + 1.1 * popularity_weight)
    score += novelty * (1.2 * (1.0 - genre_affinity) + 1.0 * (1.0 if cross_language else 0.0))
    if cf_score is not None:
        score += (cf_score - 3.0) * 0.9 + 0.6
    if period_match is True:
        score += 1.4
    elif period_match is False:
        score -= 0.6
    if cross_language:
        score += 0.35
    if movie.get("poster_url"):
        score += 0.1

    signals_payload = {
        "language_match": language_match,
        "cross_language": cross_language,
        "preferred_overlap": sorted(preferred_overlap),
        "favourite_overlap": sorted(favourite_overlap),
        "liked_overlap": sorted(liked_overlap),
        "disliked_overlap": sorted(disliked_overlap),
        "mood_overlap": sorted(mood_overlap),
        "ml_prior": round(ml_prior, 4),
        "collaborative_score": round(cf_score, 4) if cf_score is not None else None,
        "bayesian_rating": round(bayesian, 3),
        "period_match": period_match,
        "novelty": round(novelty, 3),
        "popularity_weight": round(popularity_weight, 3),
        "familiarity": round(familiarity, 3),
    }
    return float(score), signals_payload


def _explain_catalogue_movie(movie: dict[str, Any], signals: dict[str, Any], prefs: dict[str, Any]) -> str:
    reasons: list[str] = []
    language = movie.get("language_name") or movie.get("original_language")
    if signals["language_match"]:
        reasons.append(f"matches your {language} language choice")
    elif signals["cross_language"]:
        reasons.append(f"cross-language discovery from {language} cinema")
    if signals["preferred_overlap"]:
        reasons.append("matches your " + " and ".join(signals["preferred_overlap"][:2]) + " preference")
    elif signals["favourite_overlap"]:
        reasons.append("shares " + " and ".join(signals["favourite_overlap"][:2]) + " with your favourites")
    elif signals["liked_overlap"]:
        reasons.append("shares " + " and ".join(signals["liked_overlap"][:2]) + " with films you rated highly")
    if signals["collaborative_score"] is not None:
        reasons.append(f"viewers with similar ratings scored it {signals['collaborative_score']:.1f}/5")
    if signals["ml_prior"] >= 0.62:
        reasons.append("the trained MovieLens genre prior ranks this genre highly")
    if not reasons:
        reasons.append(f"strong catalogue quality ({signals['bayesian_rating']:.1f}/10 weighted rating)")
    return "; ".join(reasons[:3]).capitalize() + "."


def _select_diverse(
    scored: list[tuple[dict[str, Any], float, dict[str, Any]]],
    limit: int,
    diversity: float,
) -> list[tuple[dict[str, Any], float, dict[str, Any]]]:
    if not scored:
        return []
    scored = sorted(scored, key=lambda item: (-item[1], item[0].get("external_id", "")))
    pool = scored[: max(limit * 8, 80)]
    if diversity <= 0:
        return pool[:limit]
    values = [item[1] for item in pool]
    low, high = min(values), max(values)
    span = high - low

    def similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
        left_genres = {_normalise_genre(g) for g in left.get("genres") or []}
        right_genres = {_normalise_genre(g) for g in right.get("genres") or []}
        union = left_genres | right_genres
        genre_sim = len(left_genres & right_genres) / len(union) if union else 0.0
        same_language = left.get("original_language") == right.get("original_language")
        return 0.7 * genre_sim + 0.3 * (1.0 if same_language else 0.0)

    selected: list[tuple[dict[str, Any], float, dict[str, Any]]] = []
    remaining = list(pool)
    while remaining and len(selected) < limit:
        best_index = 0
        best_value = None
        for index, item in enumerate(remaining):
            relevance = (item[1] - low) / span if span > 0 else 1.0
            if not selected:
                value = relevance
            else:
                max_similarity = max(similarity(item[0], chosen[0]) for chosen in selected)
                value = (1.0 - diversity) * relevance - diversity * max_similarity
            if best_value is None or value > best_value:
                best_index = index
                best_value = value
        selected.append(remaining.pop(best_index))
    return selected


def _personalized_recommendations(
    user: User,
    db: Session,
    limit: int,
    diversity: float,
    familiarity: float = 0.5,
    novelty: float = 0.5,
    popularity_weight: float = 0.5,
) -> dict[str, Any]:
    if not tmdb.is_configured():
        raise HTTPException(
            status_code=503,
            detail="TMDB_API_KEY or TMDB_ACCESS_TOKEN is not configured. Add it to backend/.env.",
        )
    prefs = _preference_dict(user)
    signals = _user_catalogue_signals(db, user)

    languages = [str(code) for code in prefs.get("languages", []) if code]
    if not languages and signals["favourites"]:
        # Use the favourite movies as language seeds when onboarding skipped languages.
        for favourite in signals["favourites"][:MAX_FAVOURITE_SEEDS]:
            if str(favourite.source) != "tmdb":
                continue
            try:
                details = tmdb.movie_details(int(favourite.external_id))
            except (ValueError, tmdb.TmdbError):
                continue
            if details.get("original_language"):
                languages.append(str(details["original_language"]))
    languages = list(dict.fromkeys(languages))[:MAX_LANGUAGE_REQUESTS]

    genres = list(
        dict.fromkeys(
            [str(g) for g in prefs.get("genres", []) if g]
            + sorted(signals["fav_genres"])
            + sorted(signals["liked_genres"])
        )
    )
    candidates = _candidate_pool(prefs, signals, languages, genres)
    if not candidates:
        raise HTTPException(status_code=502, detail="TMDB returned no catalogue candidates.")

    cf_scores, neighbour_count = _collaborative_scores(
        db, user, {str(movie.get("external_id")) for movie in candidates}
    )
    tuning = {"familiarity": familiarity, "novelty": novelty, "popularity": popularity_weight}
    scored: list[tuple[dict[str, Any], float, dict[str, Any]]] = []
    for movie in candidates:
        if movie.get("adult"):
            continue
        score, movie_signals = _score_catalogue_movie(movie, prefs, signals, cf_scores, tuning)
        scored.append((movie, score, movie_signals))

    selected = _select_diverse(scored, limit, diversity)
    items: list[dict[str, Any]] = []
    for movie, score, movie_signals in selected:
        items.append(
            {
                "source": "tmdb",
                "external_id": movie.get("external_id"),
                "movie_id": None,
                "title": movie.get("title"),
                "original_title": movie.get("original_title"),
                "genres": list(movie.get("genres") or []),
                "genre_ids": list(movie.get("genre_ids") or []),
                "poster_url": movie.get("poster_url"),
                "backdrop_url": movie.get("backdrop_url"),
                "overview": movie.get("overview"),
                "release_date": movie.get("release_date"),
                "release_year": movie.get("release_year"),
                "original_language": movie.get("original_language"),
                "language_name": movie.get("language_name"),
                "vote_average": movie.get("vote_average"),
                "vote_count": movie.get("vote_count"),
                "popularity": movie.get("popularity"),
                "score": score,
                "explanation": _explain_catalogue_movie(movie, movie_signals, prefs),
                "signals": movie_signals,
            }
        )
    return {
        "user_id": user.id,
        "known_user": True,
        "diversity": diversity,
        "novelty": novelty,
        "popularity_weight": popularity_weight,
        "familiarity": familiarity,
        "languages": languages,
        "collaborative_neighbours": neighbour_count,
        "recommendations": items,
    }


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    load_artifacts()
    state["ratings_by_user"], state["rated_items"] = load_ratings_data()
    yield


app = FastAPI(title="CineMind Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    loaded = state["models"] is not None
    return {
        "status": "healthy" if loaded else "degraded",
        "backend": "running",
        "models_loaded": loaded,
        "tmdb_configured": tmdb.is_configured(),
        "error": state["error"],
    }


@app.get("/metrics")
def metrics() -> dict[str, Any]:
    if not METRICS_PATH.is_file():
        raise HTTPException(status_code=404, detail="Evaluation metrics are not available.")
    try:
        with METRICS_PATH.open("r", encoding="utf-8") as metrics_file:
            return json.load(metrics_file)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read evaluation metrics: {exc}") from exc


@app.get("/movies")
def list_movies(
    search: str | None = Query(default=None),
    genre: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    page: int = Query(default=1, ge=1),
    enrich: bool = Query(default=True),
) -> list[dict[str, Any]]:
    models = state["models"]
    if not models:
        raise HTTPException(status_code=503, detail=state["error"] or "Models not loaded.")
    metadata = models["metadata"]
    df = metadata.copy()
    if search:
        df = df[df["Title"].astype(str).str.contains(search, case=False, na=False)]
    if genre:
        df = df[df["Genres"].astype(str).str.contains(genre, case=False, na=False)]
    start = (page - 1) * limit
    df = df.iloc[start : start + limit]
    lookup = metadata_lookup(df)
    return _enrich_items(list(lookup.values()), enabled=enrich)


@app.get("/recommendations/popular")
def recommendations_popular(
    limit: int = Query(default=10, ge=1, le=50),
    enrich: bool = Query(default=True),
) -> list[dict[str, Any]]:
    models = state["models"]
    if not models:
        raise HTTPException(status_code=503, detail=state["error"] or "Models not loaded.")
    metadata = models["metadata"]
    lookup = metadata_lookup(metadata)
    ids, scores = popular_movies(limit)
    result = []
    for mid, score in zip(ids, scores):
        info = lookup.get(mid, {"movie_id": mid, "title": None, "genres": None})
        result.append({**info, "score": score})
    return _enrich_items(result, enabled=enrich)


@app.get("/recommendations/{user_id}")
def recommendations(
    user_id: int,
    limit: int = Query(default=10, ge=1, le=50),
    enrich: bool = Query(default=True),
) -> dict[str, Any]:
    models = state["models"]
    if not models:
        raise HTTPException(status_code=503, detail=state["error"] or "Models not loaded.")
    metadata = models["metadata"]
    lookup = metadata_lookup(metadata)
    hybrid = models["hybrid"]
    user_to_idx = hybrid["user_to_idx"]
    known = user_id in user_to_idx
    try:
        ids, scores = recommend_for_user(user_id, limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Recommendation failed: {exc}") from exc
    items = []
    for mid, score in zip(ids, scores):
        info = lookup.get(mid, {"movie_id": mid, "title": None, "genres": None})
        items.append({**info, "score": score})
    items = _enrich_items(items, enabled=enrich)
    return {
        "user_id": user_id,
        "known_user": known,
        "catalogue_available": tmdb.is_configured(),
        "recommendations": items,
    }


@app.get("/recommendations/diverse/{user_id}")
def recommendations_diverse(
    user_id: int,
    diversity: float = Query(default=0.5, ge=0.0, le=1.0),
    limit: int = Query(default=10, ge=1, le=50),
    enrich: bool = Query(default=True),
) -> dict[str, Any]:
    models = state["models"]
    if not models:
        raise HTTPException(status_code=503, detail=state["error"] or "Models not loaded.")
    metadata = models["metadata"]
    lookup = metadata_lookup(metadata)
    hybrid = models["hybrid"]
    user_to_idx = hybrid["user_to_idx"]
    known = user_id in user_to_idx
    try:
        diverse = diverse_recommendations(user_id, diversity, limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Diverse recommendation failed: {exc}") from exc
    items = []
    for item in diverse:
        movie_id = int(item["movie_id"])
        info = lookup.get(movie_id, {"movie_id": movie_id, "title": None, "genres": None})
        items.append(
            {
                **info,
                "score": item["relevance_score"],
                "relevance_score": item["relevance_score"],
                "mmr_score": item["mmr_score"],
                "explanation": item["explanation"],
            }
        )
    items = _enrich_items(items, enabled=enrich)
    return {
        "user_id": user_id,
        "known_user": known,
        "diversity": diversity,
        "catalogue_available": tmdb.is_configured(),
        "recommendations": items,
    }


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


@app.post("/auth/register")
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered.")
    user = User(name=payload.name.strip(), email=email, password_hash=auth.hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    prefs = UserPreference(user_id=user.id)
    db.add(prefs)
    db.commit()
    token = auth.create_access_token(str(user.id))
    return {"access_token": token, "token_type": "bearer", "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.post("/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if user is None or not auth.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    token = auth.create_access_token(str(user.id))
    return {"access_token": token, "token_type": "bearer", "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.post("/auth/logout")
def logout():
    return {"ok": True}


@app.get("/auth/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "name": current_user.name,
        "email": current_user.email,
        "created_at": current_user.created_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------


@app.get("/preferences")
def get_preferences(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    prefs = current_user.preferences
    if prefs is None:
        prefs = UserPreference(user_id=current_user.id)
        db.add(prefs)
        db.commit()
        db.refresh(prefs)
    return prefs.as_dict()


@app.put("/preferences")
def update_preferences(
    payload: PreferenceRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    prefs = current_user.preferences
    if prefs is None:
        prefs = UserPreference(user_id=current_user.id)
        db.add(prefs)
    prefs.languages = json.dumps(payload.languages)
    prefs.genres = json.dumps(payload.genres)
    prefs.moods = json.dumps(payload.moods)
    prefs.release_period = payload.release_period
    prefs.duration = payload.duration
    prefs.onboarding_completed = 1 if payload.onboarding_completed else prefs.onboarding_completed
    db.commit()
    db.refresh(prefs)
    return prefs.as_dict()


# ---------------------------------------------------------------------------
# Favourites
# ---------------------------------------------------------------------------


@app.get("/me/favourites")
def list_favourites(current_user: User = Depends(get_current_user)):
    return [
        {
            "id": f.id,
            "source": f.source,
            "external_id": f.external_id,
            "title": f.title,
            "poster_url": f.poster_url,
            "genres": json.loads(f.genres or "[]"),
            "created_at": f.created_at.isoformat(),
        }
        for f in current_user.favourites
    ]


@app.post("/me/favourites")
def add_favourite(
    payload: CatalogueItemRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(Favourite)
        .filter(
            Favourite.user_id == current_user.id,
            Favourite.source == payload.source,
            Favourite.external_id == payload.external_id,
        )
        .first()
    )
    if existing:
        return {"ok": True, "id": existing.id}
    fav = Favourite(
        user_id=current_user.id,
        source=payload.source,
        external_id=payload.external_id,
        title=payload.title,
        poster_url=payload.poster_url,
        genres=json.dumps(payload.genres),
    )
    db.add(fav)
    db.commit()
    db.refresh(fav)
    return {"ok": True, "id": fav.id}


@app.delete("/me/favourites/{source}/{external_id}")
def remove_favourite(
    source: str,
    external_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    fav = (
        db.query(Favourite)
        .filter(
            Favourite.user_id == current_user.id,
            Favourite.source == source,
            Favourite.external_id == external_id,
        )
        .first()
    )
    if fav:
        db.delete(fav)
        db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------


@app.get("/me/watchlist")
def list_watchlist(current_user: User = Depends(get_current_user)):
    return [
        {
            "id": w.id,
            "source": w.source,
            "external_id": w.external_id,
            "title": w.title,
            "poster_url": w.poster_url,
            "genres": json.loads(w.genres or "[]"),
            "created_at": w.created_at.isoformat(),
        }
        for w in current_user.watchlist
    ]


@app.post("/me/watchlist")
def add_watchlist(
    payload: CatalogueItemRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(WatchlistItem)
        .filter(
            WatchlistItem.user_id == current_user.id,
            WatchlistItem.source == payload.source,
            WatchlistItem.external_id == payload.external_id,
        )
        .first()
    )
    if existing:
        return {"ok": True, "id": existing.id}
    item = WatchlistItem(
        user_id=current_user.id,
        source=payload.source,
        external_id=payload.external_id,
        title=payload.title,
        poster_url=payload.poster_url,
        genres=json.dumps(payload.genres),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"ok": True, "id": item.id}


@app.delete("/me/watchlist/{source}/{external_id}")
def remove_watchlist(
    source: str,
    external_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    item = (
        db.query(WatchlistItem)
        .filter(
            WatchlistItem.user_id == current_user.id,
            WatchlistItem.source == source,
            WatchlistItem.external_id == external_id,
        )
        .first()
    )
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# User ratings on catalogue movies
# ---------------------------------------------------------------------------


@app.post("/me/ratings")
def add_user_rating_catalogue(
    payload: RatingRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(UserRating)
        .filter(
            UserRating.user_id == current_user.id,
            UserRating.source == payload.source,
            UserRating.external_id == payload.external_id,
        )
        .first()
    )
    if existing:
        existing.rating = payload.rating
    else:
        db.add(
            UserRating(
                user_id=current_user.id,
                source=payload.source,
                external_id=payload.external_id,
                rating=payload.rating,
            )
        )
    db.commit()
    return {"ok": True}


@app.delete("/me/ratings/{source}/{external_id}")
def remove_user_rating(
    source: str,
    external_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rating = (
        db.query(UserRating)
        .filter(
            UserRating.user_id == current_user.id,
            UserRating.source == source,
            UserRating.external_id == external_id,
        )
        .first()
    )
    if rating:
        db.delete(rating)
        db.commit()
    return {"ok": True}


@app.get("/me/ratings")
def list_user_ratings(current_user: User = Depends(get_current_user)):
    return [
        {
            "source": r.source,
            "external_id": r.external_id,
            "rating": r.rating,
            "created_at": r.created_at.isoformat(),
        }
        for r in current_user.ratings
    ]


# ---------------------------------------------------------------------------
# TMDB catalogue endpoints
# ---------------------------------------------------------------------------


def _tmdb_guard() -> None:
    if not tmdb.is_configured():
        raise HTTPException(
            status_code=503,
            detail="TMDB is not configured. Set TMDB_API_KEY or TMDB_ACCESS_TOKEN in backend/.env.",
        )


def _tmdb_http_error(exc: tmdb.TmdbError) -> HTTPException:
    message = str(exc)
    if "authentication" in message.lower():
        return HTTPException(status_code=503, detail=message)
    if "rate limit" in message.lower():
        return HTTPException(status_code=429, detail=message)
    if "not found" in message.lower():
        return HTTPException(status_code=404, detail=message)
    return HTTPException(status_code=502, detail=message)


@app.get("/catalogue/search")
def catalogue_search(
    q: str = Query(..., min_length=1),
    language: str | None = None,
    genre: str | int | None = None,
    year: int | None = None,
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
):
    _tmdb_guard()
    try:
        return tmdb.search_movies(q, language=language, genre=genre, year=year, page=page)
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/popular")
def catalogue_popular(
    language: str | None = None,
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
):
    _tmdb_guard()
    try:
        return tmdb.popular_movies(language=language, page=page)
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/trending")
def catalogue_trending(
    time_window: str = Query(default="week", pattern="^(day|week)$"),
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
):
    _tmdb_guard()
    try:
        return tmdb.trending_movies(time_window=time_window, page=page)
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/discover")
def catalogue_discover(
    language: str | None = None,
    genre: str | int | None = None,
    year: int | None = None,
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
    sort_by: str = Query(default="popularity.desc"),
    vote_count_gte: int | None = Query(default=None, ge=0),
):
    _tmdb_guard()
    try:
        return tmdb.discover_movies(
            language=language,
            genre=genre,
            year=year,
            page=page,
            sort_by=sort_by,
            vote_count_gte=vote_count_gte,
        )
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/movie/{external_id}")
def catalogue_movie(external_id: str):
    _tmdb_guard()
    try:
        return tmdb.movie_details(int(external_id))
    except ValueError:
        raise HTTPException(status_code=422, detail="TMDB movie id must be numeric.")
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/movie/{external_id}/recommendations")
def catalogue_movie_recommendations(
    external_id: str,
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
):
    _tmdb_guard()
    try:
        return tmdb.movie_recommendations(int(external_id), page=page)
    except ValueError:
        raise HTTPException(status_code=422, detail="TMDB movie id must be numeric.")
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/movie/{external_id}/similar")
def catalogue_movie_similar(
    external_id: str,
    page: int = Query(default=1, ge=1, le=tmdb.TMDB_MAX_PAGE),
):
    _tmdb_guard()
    try:
        return tmdb.similar_movies(int(external_id), page=page)
    except ValueError:
        raise HTTPException(status_code=422, detail="TMDB movie id must be numeric.")
    except tmdb.TmdbError as exc:
        raise _tmdb_http_error(exc)


@app.get("/catalogue/genres")
def catalogue_genres():
    return tmdb.GENRE_MAP


@app.get("/catalogue/languages")
def catalogue_languages():
    return tmdb.SUPPORTED_LANGUAGES


@app.get("/catalogue/config")
def catalogue_config():
    return {
        "configured": tmdb.is_configured(),
        "languages": tmdb.SUPPORTED_LANGUAGES,
        "genres": tmdb.GENRE_MAP,
        "max_page": tmdb.TMDB_MAX_PAGE,
        "cache_ttl_seconds": tmdb.CACHE_TTL_SECONDS,
        "attribution": tmdb.attribution(),
    }


@app.post("/catalogue/cache/clear")
def catalogue_cache_clear():
    tmdb.clear_cache()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Personalized multilingual recommendations
# ---------------------------------------------------------------------------


@app.get("/me/recommendations")
def personalized_recommendations(
    limit: int = Query(default=10, ge=1, le=50),
    diversity: float = Query(default=0.35, ge=0.0, le=1.0),
    familiarity: float = Query(default=0.5, ge=0.0, le=1.0),
    novelty: float = Query(default=0.5, ge=0.0, le=1.0),
    popularity: float = Query(default=0.5, ge=0.0, le=1.0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _personalized_recommendations(
        current_user, db, limit, diversity, familiarity, novelty, popularity
    )


@app.get("/me/recommendations/diverse")
def personalized_diverse_recommendations(
    limit: int = Query(default=10, ge=1, le=50),
    diversity: float = Query(default=0.55, ge=0.0, le=1.0),
    familiarity: float = Query(default=0.5, ge=0.0, le=1.0),
    novelty: float = Query(default=0.5, ge=0.0, le=1.0),
    popularity: float = Query(default=0.5, ge=0.0, le=1.0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _personalized_recommendations(
        current_user, db, limit, diversity, familiarity, novelty, popularity
    )
