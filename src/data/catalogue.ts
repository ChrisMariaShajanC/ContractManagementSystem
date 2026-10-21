export type Movie = {
  id: number;
  title: string;
  year: number;
  runtime: string;
  genres: string[];
  image: string;
  score: string;
  match: number;
  overview: string;
  language: string;
  runtimeMinutes: number;
  popularity: number;
  moods: string[];
  tags: string[];
  source?: "tmdb" | "movielens" | "local";
  externalId?: string;
  languageCode?: string | null;
  releaseDate?: string | null;
  voteAverage?: number | null;
  voteCount?: number | null;
  explanation?: string | null;
  scoreValue?: number | null;
};

export type MovieCatalogueAdapter = {
  getAll: () => Movie[];
  getById: (id: number) => Movie | undefined;
  search: (query: string) => Movie[];
  getGenres: () => string[];
  getLanguages: () => string[];
};

const registry = new Map<number, Movie>();

export function registerMovie(movie: Movie): Movie {
  registry.set(movie.id, movie);
  return movie;
}

export function registerMovies(movies: Movie[]): Movie[] {
  movies.forEach(registerMovie);
  return movies;
}

export function getRegisteredMovie(id: number): Movie | undefined {
  return registry.get(id);
}

export function getRegisteredMovies(ids: number[]): Movie[] {
  return ids.map((id) => registry.get(id)).filter((movie): movie is Movie => Boolean(movie));
}

export function createCatalogueAdapter(source: Movie[]): MovieCatalogueAdapter {
  const movies = source.map((movie) => registerMovie({ ...movie, genres: [...movie.genres], moods: [...movie.moods], tags: [...movie.tags] }));
  return {
    getAll: () => movies,
    getById: (id) => movies.find((movie) => movie.id === id) ?? registry.get(id),
    search: (query) => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return movies;
      return movies.filter((movie) => `${movie.title} ${movie.genres.join(" ")} ${movie.language} ${movie.moods.join(" ")} ${movie.tags.join(" ")}`.toLowerCase().includes(normalized));
    },
    getGenres: () => [...new Set(movies.flatMap((movie) => movie.genres))].sort(),
    getLanguages: () => [...new Set(movies.map((movie) => movie.language))].sort(),
  };
}

export function createRegistryAdapter(fallback: Movie[] = []): MovieCatalogueAdapter {
  const values = () => {
    const merged = new Map<number, Movie>();
    fallback.forEach((movie) => merged.set(movie.id, movie));
    registry.forEach((movie, id) => merged.set(id, movie));
    return [...merged.values()];
  };
  return {
    getAll: values,
    getById: (id) => registry.get(id) ?? fallback.find((movie) => movie.id === id),
    search: (query) => {
      const normalized = query.trim().toLowerCase();
      const movies = values();
      if (!normalized) return movies;
      return movies.filter((movie) => `${movie.title} ${movie.genres.join(" ")} ${movie.language}`.toLowerCase().includes(normalized));
    },
    getGenres: () => [...new Set(values().flatMap((movie) => movie.genres))].sort(),
    getLanguages: () => [...new Set(values().map((movie) => movie.language))].sort(),
  };
}

export const CSV_GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Romance",
  "Science Fiction",
  "Thriller",
  "TV Movie",
  "War",
  "Western",
];

export const CSV_LANGUAGES: Record<string, string> = {
  en: "English",
  ml: "Malayalam",
  ta: "Tamil",
  hi: "Hindi",
  te: "Telugu",
  kn: "Kannada",
  bn: "Bengali",
  mr: "Marathi",
  gu: "Gujarati",
  pa: "Punjabi",
  ur: "Urdu",
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  tr: "Turkish",
  th: "Thai",
  id: "Indonesian",
  ar: "Arabic",
  fa: "Persian",
};
