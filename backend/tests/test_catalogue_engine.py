import sys
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient

import main
import tmdb
from database import init_db

init_db()
client = TestClient(main.app)


def _movie(
    external_id: str,
    title: str,
    language: str,
    language_name: str,
    genres: list[str],
    genre_ids: list[int],
    year: int,
    rating: float,
    votes: int,
    popularity: float,
) -> dict:
    return {
        "source": "tmdb",
        "external_id": external_id,
        "title": title,
        "original_title": title,
        "overview": f"{title} is a real catalogue title used in the test fixture.",
        "poster_url": f"https://image.tmdb.org/t/p/w500/{external_id}.jpg",
        "backdrop_url": f"https://image.tmdb.org/t/p/original/{external_id}.jpg",
        "release_date": f"{year}-01-01",
        "release_year": year,
        "original_language": language,
        "language_name": language_name,
        "genres": genres,
        "genre_ids": genre_ids,
        "vote_average": rating,
        "vote_count": votes,
        "popularity": popularity,
        "adult": False,
    }


MOVIES = [
    _movie("101", "Manjummel Boys", "ml", "Malayalam", ["Drama", "Thriller"], [18, 53], 2024, 8.1, 420, 180.0),
    _movie("102", "Drishyam", "ml", "Malayalam", ["Drama", "Mystery"], [18, 9648], 2013, 8.3, 610, 90.0),
    _movie("103", "Vikram", "ta", "Tamil", ["Action", "Thriller"], [28, 53], 2022, 8.2, 540, 140.0),
    _movie("104", "Parasite", "ko", "Korean", ["Drama", "Thriller"], [18, 53], 2019, 8.5, 1600, 220.0),
    _movie("105", "Shoplifters", "ja", "Japanese", ["Drama", "Family"], [18, 10751], 2018, 8.0, 700, 80.0),
    _movie("106", "Inception", "en", "English", ["Science Fiction", "Thriller"], [878, 53], 2010, 8.4, 3200, 300.0),
    _movie("107", "3 Idiots", "hi", "Hindi", ["Comedy", "Drama"], [35, 18], 2009, 8.0, 1100, 150.0),
]


def _page(items: list[dict], page: int = 1) -> dict:
    return {"page": page, "total_pages": 2, "total_results": len(items), "results": items, "source": "tmdb"}


def _fake_discover(*, language=None, genre=None, year=None, page=1, sort_by="popularity.desc", vote_count_gte=None, region=None):
    items = MOVIES
    if language:
        items = [movie for movie in items if movie["original_language"] == language]
    if genre is not None:
        genre_id = int(genre) if str(genre).isdigit() else None
        if genre_id is not None:
            items = [movie for movie in items if genre_id in movie["genre_ids"]]
    if year is not None:
        items = [movie for movie in items if movie["release_year"] == int(year)]
    return _page(items, page)


def _fake_popular(*, language=None, page=1):
    return _fake_discover(language=language, page=page)


def _fake_trending(*, time_window="week", page=1):
    return _page([MOVIES[3], MOVIES[4], MOVIES[5]], page)


def _fake_movie_recommendations(tmdb_id, *, page=1):
    return _page([MOVIES[0], MOVIES[2]], page)


def _fake_movie_details(tmdb_id):
    for movie in MOVIES:
        if movie["external_id"] == str(tmdb_id):
            return {**movie, "runtime": 120, "tagline": "", "spoken_languages": []}
    raise tmdb.TmdbError("TMDB resource not found.")


@pytest.fixture()
def mocked_tmdb(monkeypatch):
    monkeypatch.setattr(tmdb, "is_configured", lambda: True)
    monkeypatch.setattr(tmdb, "discover_movies", _fake_discover)
    monkeypatch.setattr(tmdb, "popular_movies", _fake_popular)
    monkeypatch.setattr(tmdb, "trending_movies", _fake_trending)
    monkeypatch.setattr(tmdb, "movie_recommendations", _fake_movie_recommendations)
    monkeypatch.setattr(tmdb, "movie_details", _fake_movie_details)
    return tmdb


def _register(prefix: str) -> tuple[str, int]:
    email = f"{prefix}{uuid.uuid4().hex}@example.com"
    response = client.post("/auth/register", json={"name": prefix, "email": email, "password": "password123"})
    assert response.status_code == 200, response.text
    payload = response.json()
    return payload["access_token"], payload["user"]["id"]


def _preferences(token: str, languages=None, genres=None):
    headers = {"Authorization": f"Bearer {token}"}
    response = client.put(
        "/preferences",
        json={
            "languages": languages or [],
            "genres": genres or [],
            "moods": [],
            "release_period": "",
            "duration": "",
            "onboarding_completed": True,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return headers


def test_tmdb_search_filters_language_and_clamps_page(monkeypatch):
    tmdb.clear_cache()
    calls = []

    def fake_request(path, params=None):
        calls.append((path, dict(params or {})))
        return {
            "page": params.get("page"),
            "total_pages": 900,
            "total_results": 2,
            "results": [
                {
                    "id": 101,
                    "title": "Manjummel Boys",
                    "original_title": "Manjummel Boys",
                    "original_language": "ml",
                    "overview": "A real Malayalam film.",
                    "poster_path": "/one.jpg",
                    "release_date": "2024-02-22",
                    "genre_ids": [18, 53],
                    "vote_average": 8.1,
                    "vote_count": 400,
                    "popularity": 120,
                },
                {
                    "id": 106,
                    "title": "Inception",
                    "original_language": "en",
                    "overview": "A real English film.",
                    "poster_path": "/two.jpg",
                    "release_date": "2010-07-16",
                    "genre_ids": [878, 53],
                    "vote_average": 8.4,
                    "vote_count": 3200,
                    "popularity": 300,
                },
            ],
        }

    monkeypatch.setattr(tmdb, "_request", fake_request)
    result = tmdb.search_movies("film", language="ml", page=999)
    assert calls[0][1]["page"] == tmdb.TMDB_MAX_PAGE
    assert len(result["results"]) == 1
    assert result["results"][0]["original_language"] == "ml"
    assert result["results"][0]["language_name"] == "Malayalam"
    assert result["results"][0]["poster_url"].startswith("https://image.tmdb.org/")
    assert result["filtered"] is True


def test_tmdb_cache_avoids_duplicate_requests(monkeypatch):
    tmdb.clear_cache()
    counter = {"count": 0}

    def fake_request(path, params=None):
        counter["count"] += 1
        return {"page": 1, "total_pages": 1, "total_results": 0, "results": []}

    monkeypatch.setattr(tmdb, "_request", fake_request)
    first = tmdb.discover_movies(language="ml", page=1)
    second = tmdb.discover_movies(language="ml", page=1)
    assert first == second
    assert counter["count"] == 1


def test_tmdb_error_mapping_helpers():
    assert main._tmdb_http_error(tmdb.TmdbError("TMDB authentication failed")).status_code == 503
    assert main._tmdb_http_error(tmdb.TmdbError("TMDB rate limit reached")).status_code == 429
    assert main._tmdb_http_error(tmdb.TmdbError("TMDB resource not found")).status_code == 404
    assert main._tmdb_http_error(tmdb.TmdbError("TMDB network error")).status_code == 502


def test_catalogue_search_endpoint_uses_tmdb(mocked_tmdb, monkeypatch):
    captured = {}

    def fake_search(query, **kwargs):
        captured.update({"query": query, **kwargs})
        return {**_page(MOVIES[:2]), "filtered": kwargs.get("language") is not None}

    monkeypatch.setattr(tmdb, "search_movies", fake_search)
    response = client.get("/catalogue/search", params={"q": "manjummel", "language": "ml", "page": 2})
    assert response.status_code == 200
    assert captured["query"] == "manjummel"
    assert captured["language"] == "ml"
    assert captured["page"] == 2
    assert response.json()["results"][0]["title"] == "Manjummel Boys"


def test_personalized_recommendations_use_live_catalogue_and_cf(mocked_tmdb):
    token, _ = _register("main")
    headers = _preferences(token, languages=["ml", "ta"], genres=["Drama", "Thriller"])

    # The current user needs interactions before collaborative filtering can activate.
    client.post("/me/ratings", json={"source": "tmdb", "external_id": "104", "rating": 5.0}, headers=headers)

    other_token, _ = _register("neighbour")
    other_headers = _preferences(other_token, languages=["ko"], genres=["Drama"])
    client.post("/me/ratings", json={"source": "tmdb", "external_id": "104", "rating": 5.0}, headers=other_headers)
    client.post("/me/ratings", json={"source": "tmdb", "external_id": "101", "rating": 4.5}, headers=other_headers)

    response = client.get(
        "/me/recommendations",
        params={"limit": 6, "diversity": 0.35, "familiarity": 0.4, "novelty": 0.7, "popularity": 0.5},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["languages"] == ["ml", "ta"]
    assert payload["novelty"] == 0.7
    assert payload["familiarity"] == 0.4
    assert payload["collaborative_neighbours"] >= 1
    assert len(payload["recommendations"]) == 6

    ids = {movie["external_id"] for movie in MOVIES}
    languages = set()
    for item in payload["recommendations"]:
        assert item["source"] == "tmdb"
        assert item["external_id"] in ids
        assert item["title"] and item["title"] != "Untitled"
        assert item["explanation"]
        assert item["poster_url"].startswith("https://")
        assert item["external_id"] != "104"  # already rated
        languages.add(item["original_language"])
        assert "signals" in item

    assert "ml" in languages
    assert len(languages) >= 2  # cross-language recommendations are supported

    diverse = client.get(
        "/me/recommendations/diverse",
        params={"limit": 4, "diversity": 0.8, "novelty": 1.0, "popularity": 0.0},
        headers=headers,
    )
    assert diverse.status_code == 200
    assert len(diverse.json()["recommendations"]) == 4
    assert diverse.json()["novelty"] == 1.0


def test_tmdb_search_scans_further_pages_for_language_matches(monkeypatch):
    """A language filter must not report 'no results' just because page 1 is empty."""
    tmdb.clear_cache()
    calls = []

    def raw(external_id, title, language):
        return {
            "id": int(external_id),
            "title": title,
            "original_title": title,
            "original_language": language,
            "overview": f"{title} overview.",
            "poster_path": f"/{external_id}.jpg",
            "release_date": "2024-01-01",
            "genre_ids": [18],
            "vote_average": 8.0,
            "vote_count": 100,
            "popularity": 50,
        }

    def fake_request(path, params=None):
        params = dict(params or {})
        calls.append(params.get("page"))
        page = int(params.get("page") or 1)
        if page == 1:
            results = [raw(901, "English One", "en"), raw(902, "English Two", "en"), raw(903, "Korean One", "ko")]
        elif page == 2:
            results = [raw(904, "Malayalam One", "ml"), raw(905, "English Four", "en")]
        else:
            results = []
        return {"page": page, "total_pages": 5, "total_results": 5, "results": results}

    monkeypatch.setattr(tmdb, "_request", fake_request)
    result = tmdb.search_movies("anything", language="ml", page=1)

    assert [movie["title"] for movie in result["results"]] == ["Malayalam One"]
    assert result["pages_scanned"] >= 2
    assert result["filtered"] is True
    assert 1 in calls and 2 in calls


def test_env_file_value_parses_backend_env(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\n"
        "TMDB_API_KEY=  abc123  \n"
        'TMDB_ACCESS_TOKEN="tok en"\n'
        "EMPTY=\n",
        encoding="utf-8",
    )
    assert tmdb._env_file_value(env_file, "TMDB_API_KEY") == "abc123"
    assert tmdb._env_file_value(env_file, "TMDB_ACCESS_TOKEN") == "tok en"
    assert tmdb._env_file_value(env_file, "EMPTY") == ""
    assert tmdb._env_file_value(tmp_path / "missing.env", "TMDB_API_KEY") == ""


def test_personalized_requires_tmdb(monkeypatch):
    token, _ = _register("nokey")
    headers = _preferences(token, languages=["ml"], genres=["Drama"])
    monkeypatch.setattr(tmdb, "is_configured", lambda: False)
    response = client.get("/me/recommendations", headers=headers)
    assert response.status_code == 503
    assert "TMDB" in response.json()["detail"]


def test_personalized_without_interactions_still_returns_real_candidates(mocked_tmdb):
    token, _ = _register("cold")
    headers = _preferences(token)
    response = client.get("/me/recommendations", params={"limit": 5, "diversity": 0.0}, headers=headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["collaborative_neighbours"] == 0
    assert len(payload["recommendations"]) == 5
    assert all(item["source"] == "tmdb" for item in payload["recommendations"])
