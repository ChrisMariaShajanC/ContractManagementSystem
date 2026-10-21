import { registerMovie, type Movie } from "../data/catalogue";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";

export type ApiMovie = {
  movie_id: number | null;
  source?: string;
  external_id?: string | null;
  title: string;
  genres: string | string[];
  score?: number | null;
  explanation?: string | null;
  relevance_score?: number | null;
  mmr_score?: number | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  overview?: string | null;
  release_date?: string | null;
  release_year?: number | null;
  original_language?: string | null;
  language_name?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
  popularity?: number | null;
  catalogue_available?: boolean;
};

export type RecommendationResponse = {
  user_id: number;
  known_user: boolean;
  catalogue_available?: boolean;
  recommendations: ApiMovie[];
};

export type CatalogueMovie = {
  source: string;
  external_id: string;
  title: string;
  original_title?: string | null;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  release_date?: string | null;
  release_year?: number | null;
  original_language?: string | null;
  language_name?: string | null;
  genres: string[];
  genre_ids?: number[];
  vote_average?: number | null;
  vote_count?: number | null;
  popularity?: number | null;
  runtime?: number | null;
  tagline?: string | null;
};

export type CatalogueResponse = {
  page: number;
  total_pages: number;
  total_results: number;
  results: CatalogueMovie[];
  source?: string;
  filtered?: boolean;
};

export type PersonalRecommendation = CatalogueMovie & {
  score?: number | null;
  explanation?: string | null;
  signals?: Record<string, unknown>;
};

export type PersonalizedResponse = {
  user_id: number;
  known_user: boolean;
  diversity: number;
  languages: string[];
  collaborative_neighbours: number;
  recommendations: PersonalRecommendation[];
};

export type HealthResponse = {
  status: string;
  backend: string;
  models_loaded: boolean;
  tmdb_configured?: boolean;
  error: string | null;
};

export type ModelMetrics = {
  model: string;
  rmse: number;
  precision_at_10: number;
  recall_at_10: number;
};

export type MetricsResponse = {
  relevance_threshold: number;
  top_k: number;
  test_ratio: number;
  models: Record<string, {
    rmse: number;
    precision_at_10: number;
    recall_at_10: number;
  }>;
  model_list: ModelMetrics[];
};

export type AuthUser = { id: number; name: string; email: string };

export type AuthResponse = { access_token: string; token_type: string; user: AuthUser };

export type PreferencePayload = {
  languages: string[];
  genres: string[];
  moods: string[];
  release_period: string;
  duration: string;
  onboarding_completed: boolean;
};

export type CatalogueItem = {
  id?: number;
  source: string;
  external_id: string;
  title: string;
  poster_url?: string | null;
  genres: string[];
  created_at?: string;
};

export type UserRatingItem = {
  source: string;
  external_id: string;
  rating: number;
  created_at?: string;
};

export type CatalogueConfig = {
  configured: boolean;
  languages: Record<string, string>;
  genres: Record<string, string>;
  max_page: number;
  cache_ttl_seconds: number;
  attribution: { provider: string; notice: string; url: string };
};

type CacheEntry = { expires: number; value: unknown };
const getCache = new Map<string, CacheEntry>();

function cacheKey(path: string) {
  return `${API_BASE_URL}${path}`;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function fetchJson<T>(path: string, init?: RequestInit, options: { cacheMs?: number } = {}): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const key = cacheKey(path);
  if (method === "GET") {
    const cached = getCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }
  }
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && typeof payload.detail === "string") detail = payload.detail;
      else if (payload && typeof payload.error === "string") detail = payload.error;
    } catch {
      // The response had no JSON body; keep the HTTP status message.
    }
    throw new ApiError(`API request failed: ${detail}`, response.status);
  }
  const value = (await response.json()) as T;
  if (method === "GET" && options.cacheMs) {
    getCache.set(key, { expires: Date.now() + options.cacheMs, value });
  }
  return value;
}

function jsonBody(body: unknown, token?: string | null): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  };
}

function deleteRequest(path: string, token: string): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

function authHeaders(token: string | null): HeadersInit | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

const CATALOGUE_CACHE_MS = 5 * 60 * 1000;

export const api = {
  baseUrl: API_BASE_URL,
  health: () => fetchJson<HealthResponse>("/health"),
  popularMovies: (limit = 10) => fetchJson<ApiMovie[]>(`/recommendations/popular?limit=${limit}`),
  searchMovies: (params: { search?: string; genre?: string; limit?: number; page?: number }) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.genre) query.set("genre", params.genre);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.page) query.set("page", String(params.page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJson<ApiMovie[]>(`/movies${suffix}`);
  },
  recommendations: (userId: number, limit = 10) =>
    fetchJson<RecommendationResponse>(`/recommendations/${userId}?limit=${limit}`),
  diverseRecommendations: (userId: number, diversity = 0.5, limit = 10) =>
    fetchJson<RecommendationResponse>(`/recommendations/diverse/${userId}?diversity=${diversity}&limit=${limit}`),
  metrics: () => fetchJson<MetricsResponse>("/metrics"),

  // Auth
  register: (name: string, email: string, password: string) =>
    fetchJson<AuthResponse>("/auth/register", jsonBody({ name, email, password })),
  login: (email: string, password: string) =>
    fetchJson<AuthResponse>("/auth/login", jsonBody({ email, password })),
  logout: () => fetchJson<{ ok: boolean }>("/auth/logout", jsonBody({})).catch(() => ({ ok: true })),
  me: (token: string) => fetchJson<AuthUser>("/auth/me", { headers: authHeaders(token) }),

  // Preferences
  getPreferences: (token: string) => fetchJson<PreferencePayload>("/preferences", { headers: authHeaders(token) }),
  updatePreferences: (token: string, payload: PreferencePayload) =>
    fetchJson<PreferencePayload>("/preferences", { ...jsonBody(payload, token), method: "PUT" }),

  // Favourites / watchlist / ratings
  favourites: (token: string) => fetchJson<CatalogueItem[]>("/me/favourites", { headers: authHeaders(token) }),
  addFavourite: (token: string, item: unknown) => fetchJson<{ ok: boolean; id: number }>("/me/favourites", jsonBody(item, token)),
  removeFavourite: (token: string, source: string, externalId: string) =>
    deleteRequest(`/me/favourites/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`, token),
  watchlist: (token: string) => fetchJson<CatalogueItem[]>("/me/watchlist", { headers: authHeaders(token) }),
  addWatchlist: (token: string, item: unknown) => fetchJson<{ ok: boolean; id: number }>("/me/watchlist", jsonBody(item, token)),
  removeWatchlist: (token: string, source: string, externalId: string) =>
    deleteRequest(`/me/watchlist/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`, token),
  userRatings: (token: string) => fetchJson<UserRatingItem[]>("/me/ratings", { headers: authHeaders(token) }),
  addRating: (token: string, source: string, externalId: string, rating: number) =>
    fetchJson<{ ok: boolean }>("/me/ratings", jsonBody({ source, external_id: externalId, rating }, token)),
  removeRating: (token: string, source: string, externalId: string) =>
    deleteRequest(`/me/ratings/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`, token),

  // Catalogue
  catalogueConfig: () => fetchJson<CatalogueConfig>("/catalogue/config", undefined, { cacheMs: CATALOGUE_CACHE_MS }),
  catalogueSearch: (params: { q: string; language?: string; genre?: number | string; year?: number; page?: number }) => {
    const query = new URLSearchParams({ q: params.q });
    if (params.language) query.set("language", params.language);
    if (params.genre !== undefined && params.genre !== "") query.set("genre", String(params.genre));
    if (params.year) query.set("year", String(params.year));
    if (params.page) query.set("page", String(params.page));
    return fetchJson<CatalogueResponse>(`/catalogue/search?${query.toString()}`, undefined, { cacheMs: CATALOGUE_CACHE_MS });
  },
  cataloguePopular: (params: { language?: string; page?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.language) query.set("language", params.language);
    if (params.page) query.set("page", String(params.page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJson<CatalogueResponse>(`/catalogue/popular${suffix}`, undefined, { cacheMs: CATALOGUE_CACHE_MS });
  },
  catalogueTrending: (params: { time_window?: string; page?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.time_window) query.set("time_window", params.time_window);
    if (params.page) query.set("page", String(params.page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJson<CatalogueResponse>(`/catalogue/trending${suffix}`, undefined, { cacheMs: CATALOGUE_CACHE_MS });
  },
  catalogueDiscover: (params: { language?: string; genre?: number | string; year?: number; page?: number; sort_by?: string; vote_count_gte?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.language) query.set("language", params.language);
    if (params.genre !== undefined && params.genre !== "") query.set("genre", String(params.genre));
    if (params.year) query.set("year", String(params.year));
    if (params.page) query.set("page", String(params.page));
    if (params.sort_by) query.set("sort_by", params.sort_by);
    if (params.vote_count_gte !== undefined) query.set("vote_count_gte", String(params.vote_count_gte));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJson<CatalogueResponse>(`/catalogue/discover${suffix}`, undefined, { cacheMs: CATALOGUE_CACHE_MS });
  },
  catalogueMovie: (externalId: string) =>
    fetchJson<CatalogueMovie>(`/catalogue/movie/${encodeURIComponent(externalId)}`, undefined, { cacheMs: CATALOGUE_CACHE_MS }),
  catalogueSimilar: (externalId: string, page = 1) =>
    fetchJson<CatalogueResponse>(`/catalogue/movie/${encodeURIComponent(externalId)}/similar?page=${page}`, undefined, { cacheMs: CATALOGUE_CACHE_MS }),
  catalogueMovieRecommendations: (externalId: string, page = 1) =>
    fetchJson<CatalogueResponse>(`/catalogue/movie/${encodeURIComponent(externalId)}/recommendations?page=${page}`, undefined, { cacheMs: CATALOGUE_CACHE_MS }),
  catalogueGenres: () => fetchJson<Record<string, string>>("/catalogue/genres", undefined, { cacheMs: CATALOGUE_CACHE_MS }),
  catalogueLanguages: () => fetchJson<Record<string, string>>("/catalogue/languages", undefined, { cacheMs: CATALOGUE_CACHE_MS }),

  // Personalised multilingual catalogue recommendations
  personalized: (token: string, limit = 10, diversity = 0.35, tuning?: { familiarity?: number; novelty?: number; popularity?: number }) => {
    const query = new URLSearchParams({ limit: String(limit), diversity: String(diversity) });
    if (tuning?.familiarity !== undefined) query.set("familiarity", String(tuning.familiarity));
    if (tuning?.novelty !== undefined) query.set("novelty", String(tuning.novelty));
    if (tuning?.popularity !== undefined) query.set("popularity", String(tuning.popularity));
    return fetchJson<PersonalizedResponse>(`/me/recommendations?${query.toString()}`, { headers: authHeaders(token) });
  },
  personalizedDiverse: (token: string, limit = 10, diversity = 0.55, tuning?: { familiarity?: number; novelty?: number; popularity?: number }) => {
    const query = new URLSearchParams({ limit: String(limit), diversity: String(diversity) });
    if (tuning?.familiarity !== undefined) query.set("familiarity", String(tuning.familiarity));
    if (tuning?.novelty !== undefined) query.set("novelty", String(tuning.novelty));
    if (tuning?.popularity !== undefined) query.set("popularity", String(tuning.popularity));
    return fetchJson<PersonalizedResponse>(`/me/recommendations/diverse?${query.toString()}`, { headers: authHeaders(token) });
  },
};

export function idFromExternalId(externalId: string | number): number {
  const numeric = Number(externalId);
  if (Number.isFinite(numeric) && numeric > 0) return -Math.abs(Math.trunc(numeric));
  let hash = 0;
  for (const character of String(externalId)) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return -Math.abs(hash || 1);
}

function yearFromDate(date: string | null | undefined): number {
  if (!date) return 0;
  const parsed = Number(String(date).slice(0, 4));
  return Number.isFinite(parsed) ? parsed : 0;
}

function genresList(genres: string | string[] | null | undefined): string[] {
  if (Array.isArray(genres)) return genres.filter(Boolean);
  if (!genres) return [];
  return genres.split("|").map((genre) => genre.trim()).filter(Boolean);
}

function tmdbPopularity(value: number | null | undefined): number {
  if (!value || value <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round(Math.log10(value + 1) * 34)));
}

export function catalogueToMovie(item: PersonalRecommendation | CatalogueMovie): Movie {
  const externalId = String(item.external_id);
  const year = item.release_year ?? yearFromDate(item.release_date);
  const scoreValue = typeof (item as PersonalRecommendation).score === "number" ? (item as PersonalRecommendation).score : item.vote_average;
  return registerMovie({
    id: idFromExternalId(externalId),
    title: item.title || "Untitled",
    year,
    runtime: item.runtime ? `${Math.floor(item.runtime / 60)}h ${item.runtime % 60}m` : "—",
    genres: item.genres || [],
    image: item.poster_url || "/favicon.svg",
    score: item.vote_average != null ? Number(item.vote_average).toFixed(1) : "—",
    match: 0,
    overview: item.overview || "",
    language: item.language_name || item.original_language || "Unknown",
    languageCode: item.original_language ?? null,
    runtimeMinutes: item.runtime || 0,
    popularity: tmdbPopularity(item.popularity),
    moods: [],
    tags: [],
    source: "tmdb",
    externalId,
    releaseDate: item.release_date ?? null,
    voteAverage: item.vote_average ?? null,
    voteCount: item.vote_count ?? null,
    explanation: (item as PersonalRecommendation).explanation ?? null,
    scoreValue: scoreValue ?? null,
  });
}

export function apiMovieToMovie(apiMovie: ApiMovie): Movie {
  const externalId = apiMovie.external_id ? String(apiMovie.external_id) : null;
  const movieId = typeof apiMovie.movie_id === "number" ? apiMovie.movie_id : externalId ? idFromExternalId(externalId) : 0;
  const year = apiMovie.release_year ?? yearFromDate(apiMovie.release_date);
  return registerMovie({
    id: movieId,
    title: apiMovie.title || "Untitled",
    year,
    runtime: "—",
    genres: genresList(apiMovie.genres),
    image: apiMovie.poster_url || "/favicon.svg",
    score: apiMovie.vote_average != null ? Number(apiMovie.vote_average).toFixed(1) : apiMovie.score != null ? Number(apiMovie.score).toFixed(1) : "—",
    match: 0,
    overview: apiMovie.overview || "",
    language: apiMovie.language_name || apiMovie.original_language || (apiMovie.source === "tmdb" ? "Unknown" : "MovieLens"),
    languageCode: apiMovie.original_language ?? null,
    runtimeMinutes: 0,
    popularity: tmdbPopularity(apiMovie.popularity),
    moods: [],
    tags: [],
    source: apiMovie.source === "tmdb" ? "tmdb" : "movielens",
    externalId: externalId ?? undefined,
    releaseDate: apiMovie.release_date ?? null,
    voteAverage: apiMovie.vote_average ?? null,
    voteCount: apiMovie.vote_count ?? null,
    explanation: apiMovie.explanation ?? null,
    scoreValue: apiMovie.score ?? null,
  });
}

export function catalogueItemToMovie(item: CatalogueItem, rating?: number): Movie {
  const externalId = String(item.external_id);
  return registerMovie({
    id: idFromExternalId(externalId),
    title: item.title || "Untitled",
    year: 0,
    runtime: "—",
    genres: item.genres || [],
    image: item.poster_url || "/favicon.svg",
    score: rating != null ? `${rating}/5` : "—",
    match: 0,
    overview: "",
    language: "Unknown",
    languageCode: null,
    runtimeMinutes: 0,
    popularity: 0,
    moods: [],
    tags: [],
    source: "tmdb",
    externalId,
    releaseDate: null,
    scoreValue: rating ?? null,
  });
}

export function movieToCatalogueItem(movie: Movie): CatalogueItem | null {
  if (!movie.externalId) return null;
  return {
    source: movie.source === "tmdb" ? "tmdb" : "tmdb",
    external_id: movie.externalId,
    title: movie.title,
    poster_url: movie.image === "/favicon.svg" ? null : movie.image,
    genres: movie.genres,
  };
}
