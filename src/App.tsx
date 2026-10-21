import { useEffect, useMemo, useRef, useState } from "react";
import {
  CSV_GENRES,
  CSV_LANGUAGES,
  createRegistryAdapter,
  getRegisteredMovie,
  getRegisteredMovies,
  registerMovies,
  type Movie,
} from "./data/catalogue";
import {
  api,
  apiMovieToMovie,
  catalogueItemToMovie,
  catalogueToMovie,
  movieToCatalogueItem,
  type CatalogueMovie,
  type CatalogueResponse,
  ApiError,
} from "./lib/api";
import type { AuthUser, MetricsResponse } from "./lib/api";
import {
  defaultDiscovery,
  defaultProfile,
  explainRecommendation,
  rankMovies,
  rerankMoviesForDiversity,
  type DiscoverySettings,
  type Feedback,
  type RankedMovie,
  type RecommendationContext,
  type TasteProfile,
} from "./lib/recommender";

type Page = "Discover" | "For You" | "Beyond Your Taste" | "Mood & Context" | "My Collection" | "ML Insights" | "Catalogue";
type FiltersState = { genre: string; language: string; year: string; runtime: string };
type CatalogueSeed = { query?: string; genre?: string; language?: string } | null;

const defaultFilters: FiltersState = { genre: "All", language: "All", year: "Any", runtime: "Any" };
const registryCatalogue = createRegistryAdapter();

const MOODS: Record<string, { genres: string[]; copy: string; symbol: string }> = {
  "Feel-good": { genres: ["Comedy", "Family", "Romance"], copy: "Warm, hopeful stories", symbol: "☼" },
  Suspenseful: { genres: ["Thriller", "Mystery", "Horror"], copy: "Tension that builds", symbol: "◒" },
  "Thought-provoking": { genres: ["Drama", "Documentary", "Science Fiction"], copy: "Ideas that linger", symbol: "◇" },
  Relaxing: { genres: ["Comedy", "Family", "Romance"], copy: "Gentle, easy pacing", symbol: "∿" },
  Adventurous: { genres: ["Adventure", "Action", "Fantasy"], copy: "A sense of wonder", symbol: "↗" },
  Emotional: { genres: ["Drama", "Romance", "Music"], copy: "Stories that move you", symbol: "○" },
};

function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      const parsed = stored ? JSON.parse(stored) : fallback;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Local persistence is optional. */ }
  }, [key, value]);
  return [value, setValue] as const;
}

function applyMovieFilters(items: Movie[], filters: FiltersState) {
  return items.filter((movie) => {
    const yearMatches = filters.year === "Any" || (filters.year === "2020s" ? movie.year >= 2020 : filters.year === "2010s" ? movie.year >= 2010 && movie.year <= 2019 : filters.year === "2000s" ? movie.year >= 2000 && movie.year <= 2009 : movie.year > 0 && movie.year < 2000);
    const runtimeMatches = filters.runtime === "Any" || movie.runtimeMinutes === 0 || (filters.runtime === "Under 100 min" ? movie.runtimeMinutes < 100 : filters.runtime === "100–120 min" ? movie.runtimeMinutes >= 100 && movie.runtimeMinutes <= 120 : movie.runtimeMinutes > 120);
    const languageMatches = filters.language === "All" || movie.language === filters.language || movie.languageCode === filters.language;
    return (filters.genre === "All" || movie.genres.includes(filters.genre)) && languageMatches && yearMatches && runtimeMatches;
  });
}

function dedupeMovies(items: Movie[]) {
  const map = new Map<number, Movie>();
  items.forEach((movie) => map.set(movie.id, movie));
  return [...map.values()];
}

function uniqueCatalogueResults(pages: CatalogueResponse[]) {
  const map = new Map<string, CatalogueMovie>();
  pages.forEach((page) => page.results.forEach((movie) => map.set(String(movie.external_id), movie)));
  return [...map.values()];
}

const nav: { name: Page; icon: string }[] = [
  { name: "Discover", icon: "compass" }, { name: "For You", icon: "spark" },
  { name: "Beyond Your Taste", icon: "orbit" }, { name: "Mood & Context", icon: "mood" },
  { name: "My Collection", icon: "bookmark" }, { name: "Catalogue", icon: "search" }, { name: "ML Insights", icon: "chart" },
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    compass: <><circle cx="12" cy="12" r="9" /><path d="m15.4 8.6-2.1 4.7-4.7 2.1 2.1-4.7 4.7-2.1Z" /></>,
    spark: <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" />,
    orbit: <><circle cx="12" cy="12" r="2.2" /><ellipse cx="12" cy="12" rx="9" ry="4.3" transform="rotate(-28 12 12)" /><circle cx="18.8" cy="8" r="1" fill="currentColor" /></>,
    mood: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.2c1.8 2 5.2 2 7 0M9 9h.01M15 9h.01" /></>,
    bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.8L6 21V4.5Z" />,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    play: <path d="m9 7 8 5-8 5V7Z" />,
    heart: <path d="M20.8 5.9c-1.7-1.8-4.5-1.8-6.3 0L12 8.4 9.5 5.9a4.4 4.4 0 0 0-6.3 6.3L12 21l8.8-8.8a4.4 4.4 0 0 0 0-6.3Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    star: <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3Z" />,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Button({ children, variant = "primary", icon, onClick, ariaLabel, className = "", disabled = false, type = "button" }: { children?: React.ReactNode; variant?: "primary" | "secondary" | "ghost" | "icon"; icon?: string; onClick?: () => void; ariaLabel?: string; className?: string; disabled?: boolean; type?: "button" | "submit" | "reset" }) {
  return <button type={type} className={`btn btn-${variant} ${className}`} onClick={onClick} aria-label={ariaLabel} disabled={disabled}>{icon && <Icon name={icon} />}{children}</button>;
}

function PageHeader({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{copy}</p></div>{action}</header>;
}

function Section({ title, kicker, children, action }: { title: string; kicker?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="section"><div className="section-head"><div>{kicker && <span className="eyebrow">{kicker}</span>}<h2>{title}</h2></div>{action}</div>{children}</section>;
}

function Poster({ movie }: { movie: Movie }) {
  return <img src={movie.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.src = "/favicon.svg"; }} />;
}

function MovieCard({ movie, onOpen, saved, onSave, favourite, onFavourite, explanation, showReason = false, rank, hideMatch = false }: { movie: Movie; onOpen: (m: Movie) => void; saved: boolean; onSave: (id: number) => void; favourite?: boolean; onFavourite?: (id: number) => void; explanation?: string; showReason?: boolean; rank?: number; hideMatch?: boolean }) {
  return <article className="movie-card">
    <button className="poster-button" onClick={() => onOpen(movie)} aria-label={`Open details for ${movie.title}`}>
      <Poster movie={movie} />
      <span className="poster-shade" />
      {rank && <span className="rank">{String(rank).padStart(2, "0")}</span>}
      {!hideMatch && <span className="match">{movie.source === "tmdb" ? "TMDB catalogue" : "MovieLens model"}</span>}
      <span className="poster-open"><Icon name="arrow" /></span>
    </button>
    <div className="movie-copy">
      <div className="movie-title-row"><div><h3>{movie.title}</h3><p>{movie.year > 0 ? movie.year : "Year unknown"} · {movie.language} · {movie.genres.slice(0, 2).join(" · ") || "Film"}</p></div>
        <div className="card-actions">{onFavourite && <button className={`save ${favourite ? "saved" : ""}`} onClick={() => onFavourite(movie.id)} aria-label={favourite ? "Remove from favourites" : "Add to favourites"}><Icon name="heart" size={15} /></button>}<button className={`save ${saved ? "saved" : ""}`} onClick={() => onSave(movie.id)} aria-label={saved ? "Remove from watchlist" : "Add to watchlist"}><Icon name={saved ? "check" : "plus"} size={17} /></button></div>
      </div>
      <div className="card-meta"><span className="card-score"><Icon name="star" size={11} />{movie.score}</span>{movie.voteCount ? <small>{movie.voteCount.toLocaleString()} votes</small> : null}</div>
      {showReason && <p className="reason"><Icon name="spark" size={14} />{explanation || movie.explanation || `Selected from the live catalogue for its ${movie.genres[0]?.toLowerCase() || "cinematic"} profile.`}</p>}
    </div>
  </article>;
}

function MovieGrid({ items, ...props }: { items: Movie[]; onOpen: (m: Movie) => void; saved: Set<number>; onSave: (id: number) => void; favourites?: Set<number>; onFavourite?: (id: number) => void; explanation?: (movie: Movie) => string; showReason?: boolean; ranked?: boolean; className?: string; hideMatch?: boolean }) {
  return <div className={`movie-grid ${props.className || ""}`}>{items.map((m, i) => <MovieCard key={m.id} movie={m} onOpen={props.onOpen} saved={props.saved.has(m.id)} onSave={props.onSave} favourite={props.favourites?.has(m.id)} onFavourite={props.onFavourite} explanation={props.explanation?.(m)} showReason={props.showReason} rank={props.ranked ? i + 1 : undefined} hideMatch={props.hideMatch} />)}</div>;
}

function Filters({ value, onChange, genres, languages, includeSort = false }: { value: FiltersState; onChange: (filters: FiltersState) => void; genres: string[]; languages: Record<string, string>; includeSort?: boolean }) {
  return <div className="filters">
    <select aria-label="Genre" value={value.genre} onChange={(e) => onChange({ ...value, genre: e.target.value })}><option value="All">All genres</option>{genres.map((genre) => <option key={genre}>{genre}</option>)}</select>
    <select aria-label="Language" value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value })}><option value="All">All languages</option>{Object.entries(languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
    <select aria-label="Release period" value={value.year} onChange={(e) => onChange({ ...value, year: e.target.value })}>{["Any", "2020s", "2010s", "2000s", "Before 2000"].map((year) => <option key={year}>{year}</option>)}</select>
    <select aria-label="Runtime" value={value.runtime} onChange={(e) => onChange({ ...value, runtime: e.target.value })}>{["Any", "Under 100 min", "100–120 min", "Over 120 min"].map((runtime) => <option key={runtime}>{runtime}</option>)}</select>
    {includeSort && <span className="filter-note">Filters combine with live TMDB metadata</span>}
  </div>;
}

type PageProps = {
  token: string;
  user: AuthUser | null;
  open: (m: Movie) => void;
  saved: Set<number>;
  save: (id: number) => void;
  favourites: Set<number>;
  favourite: (id: number) => void;
  ratings: Record<number, number>;
  rate: (id: number, rating: number) => void;
  feedback: Record<number, Feedback>;
  setMovieFeedback: (id: number, feedback: Feedback) => void;
  profile: TasteProfile;
  setProfile: React.Dispatch<React.SetStateAction<TasteProfile>>;
  discovery: DiscoverySettings;
  setDiscovery: React.Dispatch<React.SetStateAction<DiscoverySettings>>;
  notify: (message: string) => void;
  navigate: (page: Page) => void;
  openSearch: () => void;
  openCatalogue: (seed: CatalogueSeed) => void;
  languages: Record<string, string>;
  genres: string[];
  genreMap: Record<string, string>;
};

function recommendationContext(props: PageProps): RecommendationContext {
  return { settings: props.discovery, profile: props.profile, feedback: props.feedback, ratings: props.ratings, catalogue: registryCatalogue };
}

function Discover(props: PageProps) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [trendingRaw, setTrendingRaw] = useState<CatalogueMovie[]>([]);
  const [popular, setPopular] = useState<Movie[]>([]);
  const [gems, setGems] = useState<Movie[]>([]);
  const [personal, setPersonal] = useState<Movie[]>([]);
  const [personalLoading, setPersonalLoading] = useState(true);
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [mlPopular, setMlPopular] = useState<Movie[]>([]);
  const [related, setRelated] = useState<Movie[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCatalogueError(null);
    Promise.all([
      api.catalogueTrending({ time_window: "week" }),
      api.cataloguePopular({ page: 1 }),
      api.catalogueDiscover({ sort_by: "vote_average.desc", vote_count_gte: 250, page: 1 }),
    ]).then(([trending, popularData, quality]) => {
      if (cancelled) return;
      setTrendingRaw(trending.results.slice(0, 10));
      setPopular(popularData.results.map(catalogueToMovie));
      const gemItems = [...quality.results].sort((a, b) => (a.popularity ?? 0) - (b.popularity ?? 0)).slice(0, 4);
      setGems(gemItems.map(catalogueToMovie));
    }).catch((error) => {
      if (!cancelled) setCatalogueError(error instanceof Error ? error.message : "Catalogue unavailable");
    });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setPersonalLoading(true);
    setPersonalError(null);
    api.personalized(props.token, 10, props.discovery.diversity / 100, {
      familiarity: props.discovery.familiarity / 100,
      novelty: props.discovery.novelty / 100,
      popularity: props.discovery.popularity / 100,
    }).then((data) => {
      if (!cancelled) setPersonal(data.recommendations.map(catalogueToMovie));
    }).catch((error) => {
      if (!cancelled) setPersonalError(error instanceof Error ? error.message : "Personalized recommendations unavailable");
    }).finally(() => {
      if (!cancelled) setPersonalLoading(false);
    });
    return () => { cancelled = true; };
  }, [props.token, props.discovery, refresh]);

  useEffect(() => {
    let cancelled = false;
    api.popularMovies(6).then((data) => {
      if (!cancelled) setMlPopular(data.map(apiMovieToMovie));
    }).catch(() => { if (!cancelled) setMlPopular([]); });
    return () => { cancelled = true; };
  }, [refresh]);

  const referenceFavourite = useMemo(() => {
    const ids = [...props.favourites];
    return getRegisteredMovies(ids).find((movie) => movie.externalId) || null;
  }, [props.favourites]);

  useEffect(() => {
    let cancelled = false;
    if (!referenceFavourite?.externalId) {
      setRelated([]);
      return;
    }
    api.catalogueMovieRecommendations(referenceFavourite.externalId, 1).then((data) => {
      if (!cancelled) setRelated(data.results.slice(0, 5).map(catalogueToMovie));
    }).catch(() => { if (!cancelled) setRelated([]); });
    return () => { cancelled = true; };
  }, [referenceFavourite?.externalId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      api.catalogueSearch({ q: trimmed, page: 1 }).then((data) => {
        if (!cancelled) setSearchResults(data.results.slice(0, 12).map(catalogueToMovie));
      }).catch((error) => {
        if (!cancelled) setSearchError(error instanceof Error ? error.message : "Search failed");
      }).finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  const hero = trendingRaw[0] ? catalogueToMovie(trendingRaw[0]) : null;
  const heroRaw = trendingRaw[0];

  return <>
    <div className="discover-intro">
      <span className="eyebrow">MULTILINGUAL DISCOVERY · LIVE TMDB CATALOGUE</span>
      <h1>Stories worth<br /><em>getting lost in.</em></h1>
      <p>Recommendations shaped by your taste across Malayalam, Tamil, Hindi, English, Korean, Japanese and more.</p>
      <div className="search" role="search"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search films, languages, genres..." aria-label="Search the live TMDB catalogue" /><button type="button" onClick={props.openSearch} aria-label="Open catalogue search"><kbd>Ctrl / ⌘ K</kbd></button>{query && <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear search"><Icon name="close" size={15} /></button>}</div>
    </div>
    {query ? <Section title={`Search results · ${searchResults.length}`} action={<Button variant="secondary" onClick={() => props.openCatalogue({ query })}>Open full catalogue <Icon name="arrow" /></Button>}>{searchLoading ? <div className="loading-grid" aria-label="Searching movies">{[1, 2, 3].map((n) => <i key={n} />)}</div> : searchError ? <EmptyState icon="info" title="Search unavailable" copy={searchError} button="Retry" onAction={() => setQuery(query)} /> : searchResults.length ? <MovieGrid items={searchResults} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} /> : <EmptyState icon="search" title="No catalogue matches" copy="Try another title, genre, language, or year." button="Clear search" onAction={() => setQuery("")} />}</Section> : <>
      {hero && heroRaw ? <section className="hero">
        <img src={heroRaw.backdrop_url || heroRaw.poster_url || "/favicon.svg"} alt="" />
        <div className="hero-overlay" />
        <div className="hero-content"><span className="sample-pill">TRENDING · {hero.language.toUpperCase()}</span><p className="hero-meta">{hero.year > 0 ? `${hero.year} · ` : ""}{hero.genres.join(", ")} · ★ {hero.score}/10</p><h2>{hero.title}</h2><p className="hero-overview">{hero.overview || "A live catalogue title trending on TMDB this week."}</p><div className="hero-actions"><Button icon="play" onClick={() => props.open(hero)}>View details</Button><Button variant="secondary" icon={props.saved.has(hero.id) ? "check" : "plus"} onClick={() => props.save(hero.id)}>Watchlist</Button></div></div>
        <div className="hero-match"><strong>Live catalogue</strong><span>TMDB trending</span></div>
      </section> : catalogueError ? <Section title="Catalogue unavailable"><EmptyState icon="info" title="Connect a movie catalogue" copy={catalogueError} button="Retry" onAction={() => setRefresh((value) => value + 1)} /></Section> : <div className="loading-grid" aria-label="Loading trending movies">{[1, 2, 3].map((n) => <i key={n} />)}</div>}
      <Section kicker="PERSONALIZED · HYBRID RANKING" title="Picked for you" action={<button className="text-link" onClick={() => props.navigate("For You")}>View all recommendations <Icon name="arrow" /></button>}>
        {personalLoading ? <div className="loading-grid" aria-label="Loading personalized recommendations">{[1, 2, 3].map((n) => <i key={n} />)}</div> : personalError ? <EmptyState icon="info" title="Personalized list unavailable" copy={personalError} button="Retry" onAction={() => setRefresh((value) => value + 1)} /> : personal.length ? <MovieGrid className="poster-row" items={personal} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} explanation={(movie) => movie.explanation || "Ranked by your language, genre, and interaction signals."} showReason /> : <EmptyState icon="spark" title="Finish onboarding" copy="Choose languages and genres so the hybrid engine can rank the catalogue for you." button="Build taste profile" onAction={() => props.navigate("For You")} />}
      </Section>
      <Section kicker="LOWER POPULARITY · STRONG RATINGS" title="Hidden gems from the catalogue">{gems.length ? <div className="landscape-row">{gems.map((movie) => <button key={movie.id} className="landscape-card" onClick={() => props.open(movie)}><Poster movie={movie} /><span><small>{movie.genres.join(" · ")} · {movie.language}</small><strong>{movie.title}</strong><em>TMDB popularity · {movie.popularity}/100 · ★ {movie.score}</em></span></button>)}</div> : <EmptyState icon="search" title="No hidden gems loaded" copy="The catalogue did not return enough highly rated titles." button="Retry" onAction={() => setRefresh((value) => value + 1)} />}</Section>
      {referenceFavourite && related.length ? <section className="because"><div><span className="eyebrow">BECAUSE YOU LOVED</span><h2>{referenceFavourite.title}</h2><p>Films TMDB recommends in the same orbit, ranked against your current taste profile.</p><Button variant="secondary" onClick={() => props.open(referenceFavourite)}>Revisit this film <Icon name="arrow" /></Button></div><MovieGrid className="poster-row" items={related} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} /></section> : <Section kicker="BECAUSE YOU LOVED" title="Teach CineMind what belongs here"><EmptyState icon="heart" title="No recommendation thread yet" copy="Favourite a film from the catalogue to generate a real TMDB-powered thread." button="Explore the catalogue" onAction={() => props.openCatalogue(null)} /></Section>}
      <Section kicker="STEP OUTSIDE YOUR LANGUAGE" title="Explore different genres"><div className="genre-row">{["Science Fiction", "Documentary", "Drama", "Comedy", "Romance"].map((genre, index) => <button key={genre} className="genre-tile" onClick={() => props.openCatalogue({ genre })}><span>0{index + 1}</span><strong>{genre}</strong><small>Explore catalogue <Icon name="arrow" size={14} /></small></button>)}</div></Section>
      <Section kicker="TRAINED MOVIELENS MODEL · MATCHED TO TMDB" title="Popular from trained model">{mlPopular.length ? <><MovieGrid className="poster-row" items={mlPopular} onOpen={props.open} saved={props.saved} onSave={props.save} hideMatch /><p className="catalogue-attribution">MovieLens recommendations are matched to TMDB posters and metadata. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></> : <EmptyState icon="search" title="No model popularity returned" copy="The trained backend did not return popular titles." button="Retry" onAction={() => setRefresh((value) => value + 1)} />}</Section>
    </>}
  </>;
}

function ForYou(props: PageProps) {
  const [sort, setSort] = useState("relevance");
  const [filters, setFilters] = useState(defaultFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [backendMovies, setBackendMovies] = useState<Movie[]>([]);
  const [backendLoading, setBackendLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [ml, setMl] = useState<Movie[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.personalized(props.token, 30, props.discovery.diversity / 100, {
      familiarity: props.discovery.familiarity / 100,
      novelty: props.discovery.novelty / 100,
      popularity: props.discovery.popularity / 100,
    }).then((data) => {
      if (!cancelled) setBackendMovies(data.recommendations.map(catalogueToMovie));
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Recommendations unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [props.token, props.discovery, refresh]);

  useEffect(() => {
    let cancelled = false;
    setBackendLoading(true);
    setBackendError(null);
    api.recommendations(1, 8).then((data) => {
      if (!cancelled) setMl(data.recommendations.map(apiMovieToMovie));
    }).catch((caught) => {
      if (!cancelled) setBackendError(caught instanceof Error ? caught.message : "Recommendations unavailable");
    }).finally(() => {
      if (!cancelled) setBackendLoading(false);
    });
    return () => { cancelled = true; };
  }, [refresh]);

  const context = recommendationContext(props);
  const sorted = useMemo<RankedMovie[]>(() => {
    const filtered = applyMovieFilters(backendMovies, filters);
    const ranked = sort === "relevance" ? rerankMoviesForDiversity(filtered, context) : rankMovies(filtered, context);
    return ranked.sort((a, b) => {
      if (sort === "rating") return Number(b.movie.voteAverage || 0) - Number(a.movie.voteAverage || 0);
      if (sort === "year") return b.movie.year - a.movie.year;
      return 0;
    });
  }, [backendMovies, filters, sort, props.discovery, props.profile, props.feedback, props.ratings]);

  const refreshRecommendations = () => {
    setRefresh((value) => value + 1);
    props.notify("Recommendations refreshed from the multilingual hybrid engine.");
  };

  return <>
    <PageHeader eyebrow={`PERSONALIZED FOR ${(props.user?.name || "YOU").toUpperCase()}`} title="Your cinema, refined." copy="Hybrid ranking over the live TMDB catalogue: language and genre preferences, favourites, app-level collaborative filtering, trained MovieLens priors, and diversity reranking." action={<Button variant="secondary" icon="spark" onClick={refreshRecommendations} disabled={loading}>{loading ? "Ranking…" : "Refresh recommendations"}</Button>} />
    <div className="preference-summary"><span>YOUR CURRENT SIGNAL</span><strong>{props.profile.genres.length ? props.profile.genres.slice(0, 3).join(" · ") : "No genres selected yet"}{props.profile.languages.length ? ` · ${props.profile.languages.map((code) => props.languages[code] || code).slice(0, 3).join(" / ")}` : ""}</strong><p>{Object.keys(props.feedback).length} feedback signals · {Object.keys(props.ratings).length} personal ratings · diversity {props.discovery.diversity}% · collaborative filtering activates as more viewers rate films.</p></div>
    <div className="toolbar"><Filters value={filters} onChange={setFilters} genres={props.genres} languages={props.languages} /><div className="segmented">{[["relevance", "Relevance"], ["rating", "Rating"], ["year", "Year"]].map(([value, label]) => <button key={value} className={sort === value ? "active" : ""} onClick={() => setSort(value)}>{label}</button>)}</div></div>
    {loading ? <div className="loading-grid" aria-label="Ranking the catalogue">{[1, 2, 3].map((n) => <i key={n} />)}</div> : error ? <EmptyState icon="info" title="Recommendations unavailable" copy={error} button="Retry" onAction={refreshRecommendations} /> : sorted.length === 0 ? <EmptyState icon="search" title="No films match these filters" copy="Try broadening one of the filters to see more recommendations." button="Reset filters" onAction={() => setFilters(defaultFilters)} /> :
      <div className="recommendation-list">{sorted.slice(0, 12).map((ranked) => <article className="recommendation" key={ranked.movie.id}>
        <button className="rec-poster" onClick={() => props.open(ranked.movie)}><Poster movie={ranked.movie} /><span>{ranked.movie.source === "tmdb" ? "Live catalogue" : "MovieLens"}</span></button>
        <div className="rec-body"><div><span className="eyebrow">{ranked.movie.genres.join(" · ")} · {ranked.movie.language}</span><h2>{ranked.movie.title}</h2><p>{ranked.movie.year > 0 ? `${ranked.movie.year} · ` : ""}★ {ranked.movie.score}/10{ranked.movie.voteCount ? ` · ${ranked.movie.voteCount.toLocaleString()} votes` : ""}</p></div><div className="why"><Icon name="spark" /><div><strong>Why recommended?</strong><p>{ranked.movie.explanation || ranked.explanation}</p></div></div>
          <div className="rec-actions"><Button variant="secondary" icon="plus" onClick={() => props.save(ranked.movie.id)}>{props.saved.has(ranked.movie.id) ? "In watchlist" : "Watchlist"}</Button><button className={props.feedback[ranked.movie.id] === "more" ? "selected" : ""} onClick={() => props.setMovieFeedback(ranked.movie.id, "more")}>＋<i>More like this</i></button><button className={props.feedback[ranked.movie.id] === "less" ? "selected" : ""} onClick={() => props.setMovieFeedback(ranked.movie.id, "less")}>−<i>Less like this</i></button><button onClick={() => props.open(ranked.movie)}><Icon name="info" size={14} /><i>Why recommended?</i></button></div>
        </div>
      </article>)}</div>}
    <Section kicker="TRAINED HYBRID MODEL · ENRICHED WITH TMDB" title="MovieLens user 1 recommendations">{backendLoading ? <div className="loading-grid" aria-label="Loading model recommendations">{[1, 2, 3].map((n) => <i key={n} />)}</div> : backendError ? <EmptyState icon="info" title="Model recommendations unavailable" copy={backendError} button="Retry" onAction={refreshRecommendations} /> : ml.length ? <MovieGrid items={ml} onOpen={props.open} saved={props.saved} onSave={props.save} hideMatch /> : <EmptyState icon="search" title="No recommendations returned" copy="The trained backend returned no recommendations." button="Retry" onAction={refreshRecommendations} />}</Section>
  </>;
}

function Beyond(props: PageProps) {
  const settings = props.discovery;
  const [items, setItems] = useState<{ movie: Movie; explanation: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mlItems, setMlItems] = useState<{ movie: Movie; explanation: string }[]>([]);
  const [mlLoading, setMlLoading] = useState(true);
  const [mlError, setMlError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      api.personalizedDiverse(props.token, 12, settings.diversity / 100, {
        familiarity: settings.familiarity / 100,
        novelty: settings.novelty / 100,
        popularity: settings.popularity / 100,
      }).then((data) => {
        if (!cancelled) setItems(data.recommendations.map((item) => ({ movie: catalogueToMovie(item), explanation: item.explanation || "Diversity reranking balances relevance and genre/language variety." })));
      }).catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Diverse recommendations unavailable");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [props.token, settings, retry]);

  useEffect(() => {
    let cancelled = false;
    setMlLoading(true);
    setMlError(null);
    api.diverseRecommendations(1, settings.diversity / 100, 8).then((data) => {
      if (!cancelled) setMlItems(data.recommendations.map((item) => ({ movie: apiMovieToMovie(item), explanation: item.explanation || "MMR reranking balances relevance and genre diversity." })));
    }).catch((caught) => {
      if (!cancelled) setMlError(caught instanceof Error ? caught.message : "Diverse model recommendations unavailable");
    }).finally(() => {
      if (!cancelled) setMlLoading(false);
    });
    return () => { cancelled = true; };
  }, [settings.diversity, retry]);

  const update = (key: keyof DiscoverySettings, value: number | string) => props.setDiscovery((current) => ({ ...current, [key]: value }));
  const selected = items.map((item) => item.movie);
  const genreCounts = selected.slice(0, 8).flatMap((movie) => movie.genres).reduce<Record<string, number>>((counts, genre) => ({ ...counts, [genre]: (counts[genre] || 0) + 1 }), {});
  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([genre]) => genre);
  const languages = [...new Set(selected.map((movie) => movie.language))].slice(0, 5);
  const summary = settings.mode === "surprise"
    ? `Prioritizing ${settings.novelty > 60 ? "less-popular discoveries" : "balanced discoveries"} with ${settings.diversity > 60 ? "broader genre and language variety" : "a focused genre range"}.`
    : `Prioritizing familiar ${props.profile.genres.slice(0, 2).join(" and ") || "preferred"} stories while allowing ${settings.novelty}% novelty.`;

  return <div className="beyond-page">
    <PageHeader eyebrow="SIGNATURE DISCOVERY MODE" title="Beyond your taste." copy="The live catalogue is reranked with MMR across genres and original languages. Collaborative filtering joins in when viewers with overlapping interactions exist." action={<div className="mode-switch"><button className={settings.mode === "taste" ? "active" : ""} onClick={() => update("mode", "taste")}>My Taste</button><button className={settings.mode === "surprise" ? "active" : ""} onClick={() => update("mode", "surprise")}><Icon name="spark" /> Surprise Me</button></div>} />
    <div className="discovery-summary"><Icon name="orbit" /><div><span>LIVE DISCOVERY SUMMARY</span><p>{summary} {selected.length ? `${languages.length} languages and ${topGenres.length} genres appear in the current edit.` : "Waiting for catalogue results."}</p></div><button onClick={() => { props.setDiscovery(defaultDiscovery); props.notify("Discovery controls reset."); }}>Reset preferences</button></div>
    <div className="beyond-hero">
      <div className="controls-panel"><div className="panel-intro"><span>DISCOVERY COMPASS</span><h2>How far should we wander?</h2><p>Fine-tune the balance between the familiar and the unexpected.</p></div>
        {[["Familiarity", "familiarity", "Less familiar", "Highly familiar"], ["Genre diversity", "diversity", "Focused", "Wide-ranging"], ["Novelty", "novelty", "Comfort", "Discovery"], ["Popularity", "popularity", "Hidden", "Mainstream"]].map(([label, key, left, right]) => <label className="range-control" key={key}><span><strong>{label}</strong><em>{settings[key as keyof DiscoverySettings] as number}%</em></span><input type="range" min="0" max="100" value={settings[key as keyof DiscoverySettings] as number} onChange={(e) => update(key as keyof DiscoverySettings, +e.target.value)} /><small><i>{left}</i><i>{right}</i></small></label>)}
      </div>
      <div className="diversity-viz"><div className="viz-head"><div><span className="eyebrow">LIVE GENRE DISTRIBUTION</span><h2>{topGenres.length} genres in the leading edit</h2></div><span className="score-ring">{topGenres.length}<small>Genres</small></span></div>
        <div className="orbit-map"><span className="orbit orbit-a" /><span className="orbit orbit-b" /><span className="orbit orbit-c" /><span className="planet core">{topGenres[0] || "Drama"}</span><span className="planet p1">{topGenres[1] || "Mystery"}</span><span className="planet p2">{topGenres[2] || "Adventure"}</span><span className="planet p3">{topGenres[3] || "History"}</span><span className="planet p4">{topGenres[4] || "Comedy"}</span><span className="planet p5">{languages[0] || "World"}</span></div>
        <div className="viz-legend"><span><i className="dot current" />Your comfort zone</span><span><i className="dot new" />New territory</span></div>
      </div>
    </div>
    <Section kicker="LIVE CATALOGUE · HYBRID MMR" title="Diverse recommendations">{loading ? <div className="loading-grid" aria-label="Loading diverse recommendations">{[1, 2, 3].map((n) => <i key={n} />)}</div> : error ? <EmptyState icon="info" title="Diverse recommendations unavailable" copy={error} button="Retry" onAction={() => setRetry((value) => value + 1)} /> : items.length ? <div className="beyond-grid">{items.map((item) => <div className="beyond-card" key={item.movie.id}><MovieCard movie={item.movie} onOpen={props.open} saved={props.saved.has(item.movie.id)} onSave={props.save} favourite={props.favourites.has(item.movie.id)} onFavourite={props.favourite} hideMatch /><div className="different"><span>WHY THIS RANKED HERE</span><p>{item.explanation}</p></div></div>)}</div> : <EmptyState icon="search" title="No diverse recommendations returned" copy="Add languages or genres to your profile to guide the engine." button="Retry" onAction={() => setRetry((value) => value + 1)} />}</Section>
    <Section kicker="TRAINED MODEL · MMR" title="Diverse MovieLens recommendations">{mlLoading ? <div className="loading-grid" aria-label="Loading model diverse recommendations">{[1, 2, 3].map((n) => <i key={n} />)}</div> : mlError ? <EmptyState icon="info" title="Model recommendations unavailable" copy={mlError} button="Retry" onAction={() => setRetry((value) => value + 1)} /> : mlItems.length ? <div className="beyond-grid">{mlItems.map((item) => <div className="beyond-card" key={item.movie.id}><MovieCard movie={item.movie} onOpen={props.open} saved={props.saved.has(item.movie.id)} onSave={props.save} favourite={props.favourites.has(item.movie.id)} onFavourite={props.favourite} hideMatch /><div className="different"><span>WHY THIS RANKED HERE</span><p>{item.explanation}</p></div></div>)}</div> : <EmptyState icon="search" title="No model recommendations" copy="The trained model returned no diverse recommendations." button="Retry" onAction={() => setRetry((value) => value + 1)} />}</Section>
    <p className="filter-note">Diversity reranking is applied to the live TMDB catalogue; the trained MovieLens MMR list is shown separately.</p>
  </div>;
}

function Mood(props: PageProps) {
  const moods = Object.keys(MOODS);
  const [mood, setMood] = useState("Thought-provoking");
  const [filters, setFilters] = useState(defaultFilters);
  const [items, setItems] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const genreNames = MOODS[mood].genres;
    const requests = genreNames.map((genre) => api.catalogueDiscover({ genre, page: 1, vote_count_gte: 40, language: filters.language === "All" ? undefined : filters.language }));
    Promise.all(requests).then((pages) => {
      if (cancelled) return;
      const combined = uniqueCatalogueResults(pages).map(catalogueToMovie);
      setItems(dedupeMovies(combined));
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Mood catalogue unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [mood, filters.language, retry]);

  const results = applyMovieFilters(items, filters);

  return <>
    <PageHeader eyebrow="MOOD → GENRE MAPPING · LIVE CATALOGUE" title="What kind of evening is this?" copy="Each mood maps to real TMDB genres, then combines with your language and release-period filters. No fabricated mood tags are used." />
    <div className="mood-grid">{moods.map((entry) => <button onClick={() => setMood(entry)} className={mood === entry ? "active" : ""} key={entry}><span className="mood-symbol">{MOODS[entry].symbol}</span><strong>{entry}</strong><small>{MOODS[entry].copy}</small></button>)}</div>
    <div className="toolbar mood-toolbar"><Filters value={filters} onChange={setFilters} genres={props.genres} languages={props.languages} /><span className="result-count">{loading ? "Loading…" : `${results.length} catalogue result${results.length === 1 ? "" : "s"}`}</span></div>
    <Section kicker={`LIVE CATALOGUE · ${mood.toUpperCase()}`} title={`${mood} films for right now`}>{loading ? <div className="loading-grid" aria-label="Loading mood results">{[1, 2, 3].map((n) => <i key={n} />)}</div> : error ? <EmptyState icon="info" title="Mood catalogue unavailable" copy={error} button="Retry" onAction={() => setRetry((value) => value + 1)} /> : results.length ? <MovieGrid items={results} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} showReason ranked hideMatch explanation={(movie) => `${MOODS[mood].genres.slice(0, 2).join(" and ")} match the ${mood.toLowerCase()} mood, filtered from live TMDB metadata.`} /> : <EmptyState icon="mood" title="No films fit every choice" copy="Broaden a context filter to reveal more catalogue results." button="Reset filters" onAction={() => setFilters(defaultFilters)} />}</Section>
  </>;
}

function Collection(props: PageProps) {
  const [tab, setTab] = useState("Watchlist");
  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState("");
  const tabs = ["Watchlist", "Favourites", "Rated movies", "Preferred genres"];
  const source = tab === "Watchlist" ? getRegisteredMovies([...props.saved]) : tab === "Favourites" ? getRegisteredMovies([...props.favourites]) : getRegisteredMovies(Object.keys(props.ratings).map(Number));
  const items = applyMovieFilters(source, filters).filter((movie) => movie.title.toLowerCase().includes(query.toLowerCase()));
  const average = Object.values(props.ratings).length ? (Object.values(props.ratings).reduce((sum, value) => sum + value, 0) / Object.values(props.ratings).length).toFixed(1) : "—";
  return <>
    <PageHeader eyebrow="YOUR CATALOGUE LIBRARY" title="My collection" copy="Films you saved, loved, and rated. Interactions sync to your account so collaborative filtering can use them." action={<div className="collection-stats"><span><strong>{props.saved.size}</strong>Saved</span><span><strong>{Object.keys(props.ratings).length}</strong>Rated</span><span><strong>{average}</strong>Avg. rating</span></div>} />
    <div className="tabs">{tabs.map((entry) => <button className={tab === entry ? "active" : ""} key={entry} onClick={() => setTab(entry)}>{entry}</button>)}</div>
    {tab === "Preferred genres" ? <TasteProfile profile={props.profile} setProfile={props.setProfile} genres={props.genres} /> : <>
      <div className="toolbar"><Filters value={filters} onChange={setFilters} genres={props.genres} languages={props.languages} /><label className="mini-search"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search collection" /></label></div>
      {items.length ? <MovieGrid items={items} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} /> : <EmptyState icon={tab === "Favourites" ? "heart" : tab === "Rated movies" ? "star" : "bookmark"} title={`No ${tab.toLowerCase()} yet`} copy="Use catalogue cards or movie details to build this account-backed collection." button="Explore the catalogue" onAction={() => props.openCatalogue(null)} />}
    </>}
  </>;
}

function TasteProfile({ profile, setProfile, genres }: { profile: TasteProfile; setProfile: React.Dispatch<React.SetStateAction<TasteProfile>>; genres: string[] }) {
  return <div className="taste-profile"><div className="profile-panel"><span className="eyebrow">YOUR TASTE, IN FOCUS</span><h2>{profile.genres.length ? profile.genres.slice(0, 2).join(" meets ") : "Your profile is open."}</h2><p>Preferred genres and languages drive the hybrid catalogue ranker. Update them here or restart onboarding.</p><div className="taste-tags">{profile.genres.map((genre) => <span key={genre}>{genre}</span>)}{profile.languages.map((code) => <span key={code}>{CSV_LANGUAGES[code] || code}</span>)}</div></div><div className="profile-bars"><h3>Preferred genres</h3><div className="preferred-choices">{genres.map((genre) => <button key={genre} className={profile.genres.includes(genre) ? "active" : ""} onClick={() => setProfile((current) => { const currentGenres = Array.isArray(current?.genres) ? current.genres : []; return { ...defaultProfile, ...(current || {}), genres: currentGenres.includes(genre) ? currentGenres.filter((item) => item !== genre) : [...currentGenres, genre] }; })}>{genre}{profile.genres.includes(genre) && <Icon name="check" size={14} />}</button>)}</div></div></div>;
}

function Insights() {
  const [empty, setEmpty] = useState(true);
  const [selectedModel, setSelectedModel] = useState("Hybrid Recommendation");
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.metrics().then((data) => {
      if (!cancelled) setMetrics(data);
    }).catch((caughtError) => {
      if (!cancelled) setError(caughtError instanceof Error ? caughtError.message : "Failed to load evaluation metrics.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const modelKeyByTab: Record<string, string> = {
    "Popularity Baseline": "popularity",
    "Content-Based Filtering": "content_based",
    "SVD Collaborative Filtering": "collaborative_filtering",
    "Hybrid Recommendation": "hybrid",
  };
  const rows = metrics?.model_list ?? (metrics?.models ? Object.entries(metrics.models).map(([key, value]) => ({ model: key, ...value })) : []);
  const selectedMetrics = metrics?.models?.[modelKeyByTab[selectedModel]];
  const connected = !!metrics && rows.length > 0;

  const modelInformation: Record<string, { status: string; summary: string; inputs: string }> = {
    "Popularity Baseline": { status: connected ? "Evaluation available" : "Design specification only", summary: "Ranks items from aggregate popularity signals without personalizing to an individual user.", inputs: "Requires item interaction counts or aggregate ratings." },
    "Content-Based Filtering": { status: connected ? "Evaluation available" : "Design specification only", summary: "Compares movie metadata with a user preference profile built from genres and descriptions.", inputs: "Requires normalized movie features and user preference vectors." },
    "SVD Collaborative Filtering": { status: connected ? "Evaluation available" : "Awaiting trained model", summary: "Learns latent user and item factors from a real user–movie rating matrix.", inputs: "Requires MovieLens-style user IDs, movie IDs, ratings, and a trained artifact." },
    "Hybrid Recommendation": { status: connected ? "Evaluation available" : "Awaiting experiment pipeline", summary: "Combines collaborative, content, and catalogue signals, then applies a diversity-aware reranker.", inputs: "Requires outputs from both component models and evaluation configuration." },
  };
  const model = modelInformation[selectedModel];
  const metricDefinitions = [
    ["RMSE", "Lower is better", "Penalizes larger rating prediction errors."],
    ["MAE", "Lower is better", "Average absolute rating prediction error."],
    ["Precision@K", "Higher is better", "Share of top-K recommendations that are relevant."],
    ["Recall@K", "Higher is better", "Share of relevant items recovered in the top K."],
    ["Intra-list diversity", "Higher is broader", "How dissimilar recommended items are to one another."],
    ["Novelty", "Higher is less familiar", "How much the list surfaces less-popular items."],
  ];
  return <>
    <PageHeader eyebrow="RECOMMENDER LAB" title="ML Insights" copy={connected ? "Measured evaluation metrics from the trained backend models." : "A transparent view of how recommendation approaches are evaluated."} action={loading ? <span className="sample-pill">LOADING METRICS</span> : error ? <span className="sample-pill">METRICS UNAVAILABLE</span> : connected ? <span className="sample-pill">MEASURED · BACKEND CONNECTED</span> : <span className="sample-pill">PROTOTYPE · NO MODEL CONNECTED</span>} />
    <div className="model-tabs">{Object.keys(modelInformation).map((entry, index) => <button key={entry} className={selectedModel === entry ? "active" : ""} onClick={() => setSelectedModel(entry)} aria-pressed={selectedModel === entry}><span>0{index + 1}</span>{entry}</button>)}</div>
    <div className="model-information" aria-live="polite"><div><span>SELECTED APPROACH</span><h2>{selectedModel}</h2></div><p>{model.summary}</p><dl><div><dt>Status</dt><dd>{model.status}</dd></div><div><dt>Data needed</dt><dd>{model.inputs}</dd></div></dl></div>
    {loading ? <div className="insights-empty"><div className="empty-visual"><span className="axis axis-x" /><span className="axis axis-y" /><i className="ghost-bar b1" /><i className="ghost-bar b2" /><i className="ghost-bar b3" /><i className="ghost-line" /></div><div><span className="eyebrow">LOADING EVALUATION METRICS</span><h2>Fetching measured results.</h2><p>The ML Insights page is requesting evaluation metrics from the backend.</p></div></div> :
      error ? <EmptyState icon="info" title="Metrics unavailable" copy={error} button="Retry" onAction={() => setReloadToken((value) => value + 1)} /> :
      !connected ? (empty ? <div className="insights-empty"><div className="empty-visual"><span className="axis axis-x" /><span className="axis axis-y" /><i className="ghost-bar b1" /><i className="ghost-bar b2" /><i className="ghost-bar b3" /><i className="ghost-line" /></div><div><span className="eyebrow">AWAITING EXPERIMENT RESULTS</span><h2>Real metrics belong here.</h2><p>Once evaluation data is connected, this space will compare model accuracy, relevance, diversity, and novelty—without fabricated values.</p><Button onClick={() => setEmpty(false)} variant="secondary">Preview dashboard structure</Button></div></div> :
        <div className="metrics-preview"><div className="preview-note"><Icon name="info" /><span><strong>Illustrative structure only</strong> Values, bars, and outcomes are intentionally omitted until measured experiment output is connected.</span><button onClick={() => setEmpty(true)}>Return to empty state</button></div><div className="metric-grid">{metricDefinitions.map(([metric, direction]) => <div className="metric" key={metric}><span>{metric}</span><strong>—</strong><small>{direction} · no result</small></div>)}</div></div>) :
      <div className="metrics-preview">
        <div className="preview-note"><Icon name="info" /><span><strong>Measured results</strong> RMSE, Precision@10, and Recall@10 from the trained backend models. Relevance threshold: {metrics?.relevance_threshold ?? "—"}; top K: {metrics?.top_k ?? "—"}.</span></div>
        <div className="metric-grid">
          <div className="metric"><span>RMSE</span><strong>{selectedMetrics?.rmse.toFixed(4) ?? "—"}</strong><small>Lower is better · {selectedModel}</small></div>
          <div className="metric"><span>Precision@10</span><strong>{selectedMetrics?.precision_at_10.toFixed(4) ?? "—"}</strong><small>Higher is better · {selectedModel}</small></div>
          <div className="metric"><span>Recall@10</span><strong>{selectedMetrics?.recall_at_10.toFixed(4) ?? "—"}</strong><small>Higher is better · {selectedModel}</small></div>
        </div>
      </div>}
    <Section kicker="MODEL COMPARISON" title="Measured evaluation results by model"><div className="measure-grid">{rows.map((row, index) => <article key={row.model}><span>{String(index + 1).padStart(2, "0")}</span><h3>{row.model}</h3><strong>RMSE {row.rmse.toFixed(4)}</strong><p>Precision@10 {row.precision_at_10.toFixed(4)} · Recall@10 {row.recall_at_10.toFixed(4)}</p></article>)}</div></Section>
    <Section kicker="EVALUATION DICTIONARY" title="How each metric should be read"><div className="metric-dictionary">{metricDefinitions.map(([metric, direction, description]) => <article key={metric}><div><h3>{metric}</h3><span>{direction}</span></div><p>{description}</p></article>)}</div></Section>
  </>;
}

function EmptyState({ icon, title, copy, button, onAction }: { icon: string; title: string; copy: string; button: string; onAction: () => void }) {
  return <div className="empty-state"><Icon name={icon} size={28} /><h2>{title}</h2><p>{copy}</p><Button variant="secondary" onClick={onAction}>{button}</Button></div>;
}

function CataloguePage(props: PageProps & { seed: CatalogueSeed; clearSeed: () => void }) {
  const [query, setQuery] = useState(props.seed?.query ?? "");
  const [language, setLanguage] = useState(props.seed?.language ?? "");
  const [genre, setGenre] = useState(props.seed?.genre ?? "");
  const [year, setYear] = useState("");
  const [sort, setSort] = useState("popularity.desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CatalogueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!props.seed) return;
    setQuery(props.seed.query ?? "");
    setLanguage(props.seed.language ?? "");
    setGenre(props.seed.genre ?? "");
    setPage(1);
    props.clearSeed();
  }, [props.seed]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      const genreId = genre ? Object.entries(props.genreMap).find(([, name]) => name === genre)?.[0] : undefined;
      const parsedYear = year ? Number(year) : undefined;
      const request = query.trim()
        ? api.catalogueSearch({ q: query.trim(), language: language || undefined, genre: genreId, year: Number.isFinite(parsedYear) ? parsedYear : undefined, page })
        : api.catalogueDiscover({ language: language || undefined, genre: genreId, year: Number.isFinite(parsedYear) ? parsedYear : undefined, page, sort_by: sort });
      request.then((response) => {
        if (!cancelled) setData(response);
      }).catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Catalogue unavailable");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, language, genre, year, sort, page, retry, props.genreMap]);

  const movies = useMemo(() => data?.results.map(catalogueToMovie) ?? [], [data]);
  const totalPages = Math.max(1, Math.min(data?.total_pages ?? 1, 500));

  return <>
    <PageHeader eyebrow="LIVE MULTILINGUAL CATALOGUE" title="Movie catalogue" copy="Search and browse the full TMDB catalogue across Malayalam, Tamil, Hindi, Telugu, Kannada, Korean, Japanese, English, and more. Results are cached on the backend." action={<Button variant="secondary" icon="globe" onClick={() => { setLanguage("ml"); setPage(1); }}>Malayalam cinema</Button>} />
    <div className="catalogue-filters">
      <label className="catalogue-search"><Icon name="search" /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search titles across every language" onKeyDown={(event) => { if (event.key === "Enter") setPage(1); }} /></label>
      <select value={language} onChange={(event) => { setLanguage(event.target.value); setPage(1); }} aria-label="Filter by language"><option value="">All languages</option>{Object.entries(props.languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
      <select value={genre} onChange={(event) => { setGenre(event.target.value); setPage(1); }} aria-label="Filter by genre"><option value="">All genres</option>{props.genres.map((name) => <option key={name} value={name}>{name}</option>)}</select>
      <input className="catalogue-year" value={year} onChange={(event) => { setYear(event.target.value.replace(/\D/g, "").slice(0, 4)); setPage(1); }} placeholder="Year" inputMode="numeric" aria-label="Release year" />
      <select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }} aria-label="Sort results"><option value="popularity.desc">Popularity</option><option value="vote_average.desc">Rating</option><option value="release_date.desc">Newest</option></select>
    </div>
    {loading ? <div className="loading-grid" aria-label="Loading catalogue">{[1, 2, 3].map((n) => <i key={n} />)}</div> : error ? <EmptyState icon="info" title="Catalogue unavailable" copy={error} button="Retry" onAction={() => setRetry((value) => value + 1)} /> : movies.length ? <>
      <div className="catalogue-status"><span>{data?.total_results?.toLocaleString() ?? 0} results · page {data?.page ?? page} of {totalPages}</span>{data?.filtered ? <small>Language, genre, and year filters are applied to this page.</small> : null}</div>
      <MovieGrid className="catalogue-grid" items={movies} onOpen={props.open} saved={props.saved} onSave={props.save} favourites={props.favourites} onFavourite={props.favourite} />
      <div className="catalogue-pagination"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button><span>Page {page} / {totalPages}</span><Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
      <p className="catalogue-attribution">Data provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </> : <EmptyState icon="search" title="No movies found" copy="Try a different title, language, genre, or year. If the catalogue is not configured, add a TMDB key to backend/.env." button="Retry" onAction={() => setRetry((value) => value + 1)} />}
  </>;
}

function SearchOverlay({ close, openMovie }: { close: () => void; openMovie: (movie: Movie) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      const request = query.trim() ? api.catalogueSearch({ q: query.trim(), page: 1 }) : api.catalogueTrending({ time_window: "week", page: 1 });
      request.then((data) => {
        if (!cancelled) setResults(data.results.slice(0, 12).map(catalogueToMovie));
      }).catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Search unavailable");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);
  return <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search movie catalogue" onMouseDown={close}>
    <div className="search-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <div className="search-dialog-input"><Icon name="search" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, genres, languages…" aria-label="Search the live movie catalogue" /><button onClick={close} aria-label="Close search"><Icon name="close" /></button></div>
      <div className="search-dialog-meta"><span>{loading ? "Searching TMDB…" : `${results.length} result${results.length === 1 ? "" : "s"}`}</span><kbd>Esc to close</kbd></div>
      <div className="search-results">{loading ? <div className="loading-grid" aria-label="Searching catalogue">{[1, 2, 3].map((n) => <i key={n} />)}</div> : error ? <div className="search-no-results"><Icon name="info" /><strong>Search unavailable</strong><span>{error}</span></div> : results.length ? results.map((movie) => <button key={movie.id} onClick={() => { openMovie(movie); close(); }}><Poster movie={movie} /><span><strong>{movie.title}</strong><small>{movie.year > 0 ? `${movie.year} · ` : ""}{movie.language} · {movie.genres.join(", ")}</small></span><Icon name="arrow" /></button>) : <div className="search-no-results"><Icon name="search" /><strong>No matching catalogue films</strong><span>Try a title, genre, or language.</span></div>}</div>
    </div>
  </div>;
}

function DetailModal({ movie, close, props }: { movie: Movie; close: () => void; props: PageProps }) {
  const [similar, setSimilar] = useState<Movie[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);
  useEffect(() => {
    let cancelled = false;
    if (!movie.externalId) {
      setSimilar([]);
      return;
    }
    setSimilarLoading(true);
    api.catalogueSimilar(movie.externalId, 1).then((data) => {
      if (!cancelled) setSimilar(data.results.slice(0, 3).map(catalogueToMovie));
    }).catch(() => { if (!cancelled) setSimilar([]); }).finally(() => { if (!cancelled) setSimilarLoading(false); });
    return () => { cancelled = true; };
  }, [movie.externalId]);
  const explanation = movie.explanation || explainRecommendation(movie, recommendationContext(props));
  return <div className="modal-backdrop" onMouseDown={close}><div className="detail-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${movie.title} details`}>
    <button className="modal-close" onClick={close} aria-label="Close details"><Icon name="close" /></button>
    <div className="detail-art"><Poster movie={movie} /><div /></div>
    <div className="detail-content"><span className="sample-pill">{movie.source === "tmdb" ? "TMDB CATALOGUE" : "MOVIELENS MODEL"}</span><h2>{movie.title}</h2><p className="detail-meta">{movie.year > 0 ? `${movie.year} · ` : ""}{movie.language} · {movie.genres.join(", ") || "Genre unknown"} · ★ {movie.score}/10{movie.voteCount ? ` · ${movie.voteCount.toLocaleString()} votes` : ""}</p><p className="detail-overview">{movie.overview || "No synopsis is available for this title yet."}</p>
      <div className="detail-actions"><Button icon={props.saved.has(movie.id) ? "check" : "plus"} onClick={() => props.save(movie.id)}>{props.saved.has(movie.id) ? "In watchlist" : "Add to watchlist"}</Button><Button variant="secondary" icon="heart" onClick={() => props.favourite(movie.id)}>{props.favourites.has(movie.id) ? "Favourite" : "Add favourite"}</Button></div>
      <div className="detail-feedback"><div className="stars"><span>Your rating</span>{[1, 2, 3, 4, 5].map((n) => <button aria-label={`Rate ${n} stars`} className={(props.ratings[movie.id] || 0) >= n ? "active" : ""} onClick={() => props.rate(movie.id, n)} key={n}><Icon name="star" /></button>)}</div><div className="feedback-pair"><button className={props.feedback[movie.id] === "more" ? "active" : ""} onClick={() => props.setMovieFeedback(movie.id, "more")}>More like this</button><button className={props.feedback[movie.id] === "less" ? "active" : ""} onClick={() => props.setMovieFeedback(movie.id, "less")}>Less like this</button></div></div>
      <div className="modal-reason"><Icon name="spark" /><div><strong>Why this was recommended</strong><p>{explanation}</p></div></div>
      <h3 className="similar-title">More like this</h3>{similarLoading ? <div className="loading-inline">Loading similar films…</div> : similar.length ? <div className="similar-row">{similar.map((entry) => <button key={entry.id} onClick={() => props.open(entry)}><Poster movie={entry} /><span>{entry.title}</span></button>)}</div> : <p className="filter-note">No similar TMDB titles were returned.</p>}
    </div>
  </div></div>;
}

function Onboarding({ close, complete, languages }: { close: () => void; complete: (profile: TasteProfile, ratings: Record<number, number>, favourites: Movie[]) => void; languages: Record<string, string> }) {
  const [step, setStep] = useState(1);
  const [genres, setGenres] = useState<string[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [selectedMovies, setSelectedMovies] = useState<Movie[]>([]);
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [discovery, setDiscovery] = useState<"familiar" | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Movie[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Movie[]>([]);
  const genreOptions = CSV_GENRES;

  useEffect(() => {
    let cancelled = false;
    setOptionsLoading(true);
    setOptionsError(null);
    const timer = window.setTimeout(() => {
      const trimmed = query.trim();
      const request = trimmed
        ? api.catalogueSearch({ q: trimmed, page: 1 })
        : selectedLanguages.length
          ? Promise.all(selectedLanguages.slice(0, 3).map((language) => api.cataloguePopular({ language, page: 1 }))).then((pages) => ({ ...pages[0], results: uniqueCatalogueResults(pages).slice(0, 24) }))
          : api.catalogueTrending({ time_window: "week", page: 1 });
      request.then((data) => {
        if (!cancelled) setOptions(dedupeMovies(data.results.map(catalogueToMovie)));
      }).catch((caught) => {
        if (!cancelled) setOptionsError(caught instanceof Error ? caught.message : "Catalogue unavailable");
      }).finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, selectedLanguages]);

  useEffect(() => {
    if (step !== 5) return;
    let cancelled = false;
    const genreName = genres[0];
    const genreId = genreName ? Object.entries({ 28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 53: "Thriller", 10752: "War", 37: "Western" }).find(([, name]) => name === genreName)?.[0] : undefined;
    api.catalogueDiscover({ genre: genreId, language: selectedLanguages[0], sort_by: "vote_average.desc", vote_count_gte: 40, page: 1 }).then((data) => {
      if (!cancelled) setPreview(data.results.slice(0, 4).map(catalogueToMovie));
    }).catch(() => {
      if (!cancelled) setPreview(selectedMovies.slice(0, 4));
    });
    return () => { cancelled = true; };
  }, [step]);

  const temporaryProfile: TasteProfile = { genres, languages: selectedLanguages, favouriteMovies: selectedMovies.map((movie) => movie.id), discovery: discovery || "new" };
  const onboardingContext: RecommendationContext = { settings: { ...defaultDiscovery, mode: discovery === "familiar" ? "taste" : "surprise" }, profile: temporaryProfile, feedback: {}, ratings, catalogue: registryCatalogue };
  const initialRecommendations = preview.length ? rerankMoviesForDiversity(preview, onboardingContext, 4).map((item) => item.movie) : selectedMovies.slice(0, 4);
  const canContinue = step === 1 ? genres.length >= 2 : step === 2 ? selectedMovies.length > 0 || Boolean(optionsError) : step === 4 ? discovery !== null : true;
  const finish = () => complete({ genres, languages: selectedLanguages, favouriteMovies: selectedMovies.map((movie) => movie.id), discovery: discovery || "new" }, ratings, selectedMovies);

  return <div className="modal-backdrop onboarding-bg"><div className="onboarding" role="dialog" aria-modal="true">
    <div className="onboarding-top"><div className="brand-mark">C</div><span>BUILD YOUR TASTE PROFILE</span><button onClick={close}>Skip for now</button></div>
    <div className="progress">{[1, 2, 3, 4, 5].map((n) => <i key={n} className={step >= n ? "active" : ""} />)}</div>
    <div className="onboarding-content">
      {step === 1 && <><span className="eyebrow">STEP 1 OF 5</span><h2>What worlds pull you in?</h2><p>Choose at least two genres. Languages are optional and unlock cross-language recommendations.</p><div className="choice-grid">{genreOptions.map((genre) => <button className={genres.includes(genre) ? "active" : ""} onClick={() => setGenres(genres.includes(genre) ? genres.filter((entry) => entry !== genre) : [...genres, genre])} key={genre}>{genre}{genres.includes(genre) && <Icon name="check" />}</button>)}</div><div className="chip-row">{Object.entries(languages).slice(0, 14).map(([code, label]) => <button key={code} className={`chip ${selectedLanguages.includes(code) ? "active" : ""}`} onClick={() => setSelectedLanguages((current) => current.includes(code) ? current.filter((entry) => entry !== code) : [...current, code])}>{label}{selectedLanguages.includes(code) && <Icon name="check" size={12} />}</button>)}</div></>}
      {step === 2 && <><span className="eyebrow">STEP 2 OF 5</span><h2>Pick a few favourites.</h2><p>Search the live TMDB catalogue. Your selections become real language and genre signals.</p><label className="onboarding-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search any movie or language" /></label>{optionsError ? <p className="filter-note">Catalogue unavailable: {optionsError}. You can continue and configure TMDB later.</p> : null}<div className="onboarding-posters">{optionsLoading ? [1, 2, 3, 4, 5, 6].map((n) => <i className="poster-skeleton" key={n} />) : options.map((movie) => <button key={movie.id} className={selectedMovies.some((entry) => entry.id === movie.id) ? "active" : ""} onClick={() => setSelectedMovies((current) => current.some((entry) => entry.id === movie.id) ? current.filter((entry) => entry.id !== movie.id) : [...current, movie])}><Poster movie={movie} /><span>{movie.title}</span>{selectedMovies.some((entry) => entry.id === movie.id) && <i><Icon name="check" /></i>}</button>)}</div></>}
      {step === 3 && <><span className="eyebrow">STEP 3 OF 5 · OPTIONAL</span><h2>Make the signal sharper.</h2><p>Rate your selected films. Ratings power collaborative filtering and content signals.</p><div className="rating-stack">{selectedMovies.map((movie) => <div key={movie.id}><Poster movie={movie} /><span>{movie.title}<small>{movie.year > 0 ? movie.year : movie.language}</small></span><div>{[1, 2, 3, 4, 5].map((n) => <button className={(ratings[movie.id] || 0) >= n ? "active" : ""} onClick={() => setRatings({ ...ratings, [movie.id]: n })} aria-label={`Rate ${movie.title} ${n} stars`} key={n}><Icon name="star" /></button>)}</div></div>)}</div></>}
      {step === 4 && <><span className="eyebrow">STEP 4 OF 5</span><h2>Comfort, or discovery?</h2><p>Set your starting point. You’ll always be able to adjust it.</p><div className="discovery-choice"><button className={discovery === "familiar" ? "active" : ""} onClick={() => setDiscovery("familiar")}><Icon name="heart" size={28} /><strong>Keep it familiar</strong><span>More films close to what you already love.</span></button><button className={discovery === "new" ? "active" : ""} onClick={() => setDiscovery("new")}><Icon name="orbit" size={28} /><strong>Lead me somewhere new</strong><span>Cross-language picks with a thread back to your taste.</span></button></div></>}
      {step === 5 && <><span className="eyebrow">YOUR FIRST LIVE CATALOGUE EDIT</span><h2>Your cinema starts here.</h2><p>These titles come from the live TMDB catalogue using your genres, languages, and selected films.</p><div className="onboarding-posters result">{initialRecommendations.map((movie) => <article key={movie.id}><Poster movie={movie} /><span>{movie.title}</span><small>{movie.genres.join(" · ")} · {movie.language}</small></article>)}</div></>}
    </div>
    <div className="onboarding-footer"><span>{step === 1 ? `${genres.length} genres · ${selectedLanguages.length} languages` : step === 2 ? `${selectedMovies.length} movies selected` : step === 5 ? "Taste profile ready" : "Your choices remain editable"}</span><div>{step > 1 && <Button variant="ghost" onClick={() => setStep(step - 1)}>Back</Button>}<Button disabled={!canContinue} onClick={() => step === 5 ? finish() : setStep(step + 1)}>{step === 5 ? "Enter CineMind" : "Continue"} <Icon name="arrow" /></Button></div></div>
  </div></div>;
}

function AuthScreen({ onLogin, onRegister, loading, error }: { onLogin: (email: string, password: string) => void; onRegister: (name: string, email: string, password: string) => void; loading: boolean; error: string | null }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  return <div className="modal-backdrop" style={{ zIndex: 200 }}>
    <div style={{ maxWidth: 420, width: "100%", background: "var(--surface, #15161a)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 24 }}>
      <div className="brand-mark" style={{ marginBottom: 12 }}>C</div>
      <h2 style={{ marginTop: 0 }}>{mode === "login" ? "Sign in" : "Create account"}</h2>
      <p style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.6 }}>CineMind stores your preferences, favourites, ratings, and watchlist so the multilingual recommender can personalize across languages.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const email = String(fd.get("email") || "");
        const password = String(fd.get("password") || "");
        if (mode === "login") onLogin(email, password);
        else onRegister(String(fd.get("name") || ""), email, password);
      }}>
        {mode === "register" && <input name="name" placeholder="Name" required style={{ width: "100%", marginBottom: 8, padding: 8 }} />}
        <input name="email" type="email" placeholder="Email" required style={{ width: "100%", marginBottom: 8, padding: 8 }} />
        <input name="password" type="password" placeholder="Password" required minLength={6} style={{ width: "100%", marginBottom: 8, padding: 8 }} />
        {error && <p style={{ color: "red" }}>{error}</p>}
        <Button type="submit" disabled={loading}>{loading ? "..." : mode === "login" ? "Sign in" : "Create account"}</Button>
      </form>
      <button onClick={() => setMode(mode === "login" ? "register" : "login")} style={{ marginTop: 8, background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
        {mode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
      </button>
    </div>
  </div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("Discover");
  const [theme, setTheme] = usePersistentState<"dark" | "light">("cinemind-theme", "dark");
  const [selected, setSelected] = useState<Movie | null>(null);
  const [savedIds, setSavedIds] = usePersistentState<number[]>("cinemind-watchlist", []);
  const [favouriteIds, setFavouriteIds] = usePersistentState<number[]>("cinemind-favourites", []);
  const [ratings, setRatings] = usePersistentState<Record<number, number>>("cinemind-ratings", {});
  const [feedback, setFeedback] = usePersistentState<Record<number, Feedback>>("cinemind-feedback", {});
  const [profile, setProfile] = usePersistentState<TasteProfile>("cinemind-profile", defaultProfile);
  const [discovery, setDiscovery] = usePersistentState<DiscoverySettings>("cinemind-discovery", defaultDiscovery);
  const [onboarding, setOnboarding] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [authToken, setAuthToken] = useState<string>(() => sessionStorage.getItem("cinemind-token") || "");
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => { try { return JSON.parse(sessionStorage.getItem("cinemind-user") || "null"); } catch { return null; } });
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [catalogueSeed, setCatalogueSeed] = useState<CatalogueSeed>(null);
  const [languages, setLanguages] = useState<Record<string, string>>(CSV_LANGUAGES);
  const [genreMap, setGenreMap] = useState<Record<string, string>>({});
  const genres = useMemo(() => {
    const names = Object.values(genreMap);
    return names.length ? [...new Set(names)].sort() : CSV_GENRES;
  }, [genreMap]);

  const safeSavedIds = Array.isArray(savedIds) ? savedIds.filter(Number.isFinite) : [];
  const safeFavouriteIds = Array.isArray(favouriteIds) ? favouriteIds.filter(Number.isFinite) : [];
  const safeRatings = ratings && typeof ratings === "object" && !Array.isArray(ratings) ? ratings : {};
  const safeFeedback = feedback && typeof feedback === "object" && !Array.isArray(feedback) ? feedback : {};
  const safeTheme = theme === "light" ? "light" : "dark";
  const saved = useMemo(() => new Set(safeSavedIds), [savedIds]);
  const favourites = useMemo(() => new Set(safeFavouriteIds), [favouriteIds]);
  const safeProfile = useMemo<TasteProfile>(() => ({
    ...defaultProfile,
    ...(profile || {}),
    genres: Array.isArray(profile?.genres) ? profile.genres : defaultProfile.genres,
    languages: Array.isArray(profile?.languages) ? profile.languages : defaultProfile.languages,
    favouriteMovies: Array.isArray(profile?.favouriteMovies) ? profile.favouriteMovies : [],
    discovery: profile?.discovery === "familiar" ? "familiar" : "new",
  }), [profile]);
  const safeDiscovery = useMemo<DiscoverySettings>(() => ({ ...defaultDiscovery, ...(discovery || {}) }), [discovery]);

  useEffect(() => {
    api.catalogueConfig().then((config) => {
      if (config.languages && Object.keys(config.languages).length) setLanguages(config.languages);
      if (config.genres) setGenreMap(config.genres);
    }).catch(() => { /* The bundled language/genre metadata remains usable while the backend is offline. */ });
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const save = (id: number) => {
    const movie = getRegisteredMovie(id);
    const adding = !saved.has(id);
    setSavedIds((current) => { const ids = Array.isArray(current) ? current : []; return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; });
    if (movie?.externalId && authToken) {
      const item = movieToCatalogueItem(movie);
      if (item) {
        const request = adding ? api.addWatchlist(authToken, item) : api.removeWatchlist(authToken, "tmdb", movie.externalId);
        request.catch(() => notify("Watchlist saved locally; account sync failed."));
      }
    }
    notify(adding ? "Added to your watchlist." : "Removed from your watchlist.");
  };

  const favourite = (id: number) => {
    const movie = getRegisteredMovie(id);
    const adding = !favourites.has(id);
    setFavouriteIds((current) => { const ids = Array.isArray(current) ? current : []; return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; });
    if (movie?.externalId && authToken) {
      const item = movieToCatalogueItem(movie);
      if (item) {
        const request = adding ? api.addFavourite(authToken, item) : api.removeFavourite(authToken, "tmdb", movie.externalId);
        request.catch(() => notify("Favourite saved locally; account sync failed."));
      }
    }
    notify(adding ? "Added to your favourites." : "Removed from your favourites.");
  };

  const rate = (id: number, rating: number) => {
    setRatings((current) => ({ ...(current && typeof current === "object" ? current : {}), [id]: rating }));
    const movie = getRegisteredMovie(id);
    if (movie?.externalId && authToken) {
      api.addRating(authToken, "tmdb", movie.externalId, rating).catch(() => notify("Rating saved locally; account sync failed."));
    }
    if (movie && rating >= 4) setProfile((current) => ({ ...defaultProfile, ...(current || {}), genres: [...new Set([...(Array.isArray(current?.genres) ? current.genres : []), ...movie.genres])] }));
    notify(`Saved a ${rating}-star rating.`);
  };

  const setMovieFeedback = (id: number, value: Feedback) => {
    const removing = safeFeedback[id] === value;
    setFeedback((current) => {
      const next = { ...(current && typeof current === "object" ? current : {}) };
      if (next[id] === value) delete next[id]; else next[id] = value;
      return next;
    });
    const movie = getRegisteredMovie(id);
    if (movie && !removing) setProfile((current) => {
      const currentGenres = Array.isArray(current?.genres) ? current.genres : [];
      return { ...defaultProfile, ...(current || {}), genres: value === "more" ? [...new Set([...currentGenres, ...movie.genres])] : currentGenres.filter((genre) => !movie.genres.includes(genre) || currentGenres.length <= 1) };
    });
    notify(removing ? "Movie feedback cleared." : `Preference updated: ${value === "more" ? "more" : "less"} like this.`);
  };

  const navigate = (nextPage: Page) => { setPage(nextPage); setMobileMenu(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openCatalogue = (seed: CatalogueSeed) => { setCatalogueSeed(seed); navigate("Catalogue"); };

  const resetAccountState = () => {
    setSavedIds([]);
    setFavouriteIds([]);
    setRatings({});
    setFeedback({});
    setProfile(defaultProfile);
    setDiscovery(defaultDiscovery);
    setCatalogueSeed(null);
    setSelected(null);
    setSearchOpen(false);
    setOnboarding(false);
    setPage("Discover");
  };

  const rememberAccount = (userId: number) => {
    const marker = "cinemind-account";
    const previous = localStorage.getItem(marker);
    if (previous !== String(userId)) resetAccountState();
    localStorage.setItem(marker, String(userId));
  };

  const handleLogin = async (email: string, password: string) => {
    setAuthLoading(true); setAuthError(null);
    try {
      const res = await api.login(email, password);
      rememberAccount(res.user.id);
      setAuthToken(res.access_token); setAuthUser(res.user);
      sessionStorage.setItem("cinemind-token", res.access_token);
      sessionStorage.setItem("cinemind-user", JSON.stringify(res.user));
      setPage("Discover");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Login failed"); }
    finally { setAuthLoading(false); }
  };

  const handleRegister = async (name: string, email: string, password: string) => {
    setAuthLoading(true); setAuthError(null);
    try {
      const res = await api.register(name, email, password);
      rememberAccount(res.user.id);
      setAuthToken(res.access_token); setAuthUser(res.user);
      sessionStorage.setItem("cinemind-token", res.access_token);
      sessionStorage.setItem("cinemind-user", JSON.stringify(res.user));
      setOnboarding(true);
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Registration failed"); }
    finally { setAuthLoading(false); }
  };

  const handleLogout = () => {
    if (authToken) api.logout().catch(() => {});
    localStorage.removeItem("cinemind-account");
    setAuthToken(""); setAuthUser(null);
    sessionStorage.removeItem("cinemind-token"); sessionStorage.removeItem("cinemind-user");
    resetAccountState();
  };

  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    api.me(authToken).then((user) => {
      if (cancelled) return;
      setAuthUser(user);
      return Promise.all([
        api.getPreferences(authToken),
        api.favourites(authToken),
        api.watchlist(authToken),
        api.userRatings(authToken),
      ]).then(async ([prefs, favouriteItems, watchlistItems, ratingItems]) => {
        if (cancelled) return;
        setProfile((current) => {
          const base = { ...defaultProfile, ...(current || {}) };
          const hasRemotePreferences = prefs.onboarding_completed || prefs.genres.length > 0 || prefs.languages.length > 0;
          return hasRemotePreferences ? { ...base, genres: prefs.genres, languages: prefs.languages } : base;
        });
        const mappedFavourites = favouriteItems.map((item) => catalogueItemToMovie(item));
        const mappedWatchlist = watchlistItems.map((item) => catalogueItemToMovie(item));
        const ratingMap: Record<number, number> = {};
        await Promise.all(ratingItems.slice(0, 40).map(async (item) => {
          let movie: Movie;
          try {
            movie = catalogueToMovie(await api.catalogueMovie(item.external_id));
          } catch {
            movie = catalogueItemToMovie({ source: item.source, external_id: item.external_id, title: item.external_id, genres: [] }, item.rating);
          }
          ratingMap[movie.id] = item.rating;
        }));
        setFavouriteIds((current) => [...new Set([...(Array.isArray(current) ? current : []), ...mappedFavourites.map((movie) => movie.id)])]);
        setSavedIds((current) => [...new Set([...(Array.isArray(current) ? current : []), ...mappedWatchlist.map((movie) => movie.id)])]);
        setRatings((current) => ({ ...(current && typeof current === "object" ? current : {}), ...ratingMap }));
        if (!prefs.onboarding_completed) setOnboarding(true);
      });
    }).catch((error) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 401) handleLogout();
      else notify("The backend is unreachable; showing locally cached account data.");
    });
    return () => { cancelled = true; };
  }, [authToken]);

  const props: PageProps = {
    token: authToken,
    user: authUser,
    open: setSelected,
    saved,
    save,
    favourites,
    favourite,
    ratings: safeRatings,
    rate,
    feedback: safeFeedback,
    setMovieFeedback,
    profile: safeProfile,
    setProfile,
    discovery: safeDiscovery,
    setDiscovery,
    notify,
    navigate,
    openSearch: () => setSearchOpen(true),
    openCatalogue,
    languages,
    genres,
    genreMap,
  };

  const content = (() => {
    if (page === "Discover") return <Discover {...props} />;
    if (page === "For You") return <ForYou {...props} />;
    if (page === "Beyond Your Taste") return <Beyond {...props} />;
    if (page === "Mood & Context") return <Mood {...props} />;
    if (page === "My Collection") return <Collection {...props} />;
    if (page === "Catalogue") return <CataloguePage {...props} seed={catalogueSeed} clearSeed={() => setCatalogueSeed(null)} />;
    return <Insights />;
  })();

  const completeOnboarding = async (nextProfile: TasteProfile, onboardingRatings: Record<number, number>, onboardingFavourites: Movie[]) => {
    setProfile(nextProfile);
    setRatings((current) => ({ ...(current && typeof current === "object" ? current : {}), ...onboardingRatings }));
    setFavouriteIds((current) => [...new Set([...(Array.isArray(current) ? current : []), ...nextProfile.favouriteMovies])]);
    setDiscovery((current) => ({ ...current, mode: nextProfile.discovery === "familiar" ? "taste" : "surprise" }));
    registerMovies(onboardingFavourites);
    if (authToken) {
      try {
        await api.updatePreferences(authToken, {
          languages: nextProfile.languages,
          genres: nextProfile.genres,
          moods: [],
          release_period: "",
          duration: "",
          onboarding_completed: true,
        });
        await Promise.all(onboardingFavourites.map(async (movie) => {
          const item = movieToCatalogueItem(movie);
          if (item) await api.addFavourite(authToken, item);
          const rating = onboardingRatings[movie.id];
          if (rating && movie.externalId) await api.addRating(authToken, "tmdb", movie.externalId, rating);
        }));
      } catch {
        notify("Your taste profile was saved locally; account sync failed.");
      }
    }
    setOnboarding(false);
    setPage("For You");
    notify("Taste profile saved. The multilingual engine is ranking your catalogue.");
  };

  if (!authToken || !authUser) {
    return <AuthScreen onLogin={handleLogin} onRegister={handleRegister} loading={authLoading} error={authError} />;
  }

  return <div className={`app theme-${safeTheme}`}>
    <aside className={`sidebar ${mobileMenu ? "mobile-open" : ""}`}>
      <button className="brand" onClick={() => navigate("Discover")}><span className="brand-mark">C</span><span><strong>CineMind</strong><small>KNOW YOUR TASTE</small></span></button>
      <nav>{nav.map((item) => <button key={item.name} className={page === item.name ? "active" : ""} onClick={() => navigate(item.name)}><Icon name={item.icon} /><span>{item.name}</span>{item.name === "Beyond Your Taste" && <i>NEW</i>}</button>)}</nav>
      <div className="sidebar-bottom">
        {authUser && <button className="profile" onClick={handleLogout}><span>U</span><span><strong>{authUser.name}</strong><small>Logout</small></span><Icon name="arrow" /></button>}
        <button className="taste-progress" onClick={() => setOnboarding(true)}><span className="progress-ring">{Math.min(100, 20 + safeProfile.genres.length * 7 + safeProfile.languages.length * 5 + safeProfile.favouriteMovies.length * 4)}</span><span><strong>Taste profile</strong><small>Languages, genres & favourites</small></span><Icon name="arrow" /></button>
        <button className="theme-toggle" onClick={() => setTheme(safeTheme === "dark" ? "light" : "dark")}><Icon name={safeTheme === "dark" ? "moon" : "sun"} /><span>{safeTheme === "dark" ? "Dark" : "Light"} theme</span><i><b /></i></button>
      </div>
    </aside>
    <header className="mobile-header"><button className="brand" onClick={() => setOnboarding(true)}><span className="brand-mark">C</span><strong>CineMind</strong></button><button onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle menu"><Icon name={mobileMenu ? "close" : "menu"} /></button></header>
    <main>{content}<footer><div className="brand"><span className="brand-mark">C</span><strong>CineMind</strong></div><p>Know your taste. Discover beyond it.</p><span>Live TMDB catalogue · multilingual hybrid recommendations · TMDB attribution applies</span></footer></main>
    <nav className="mobile-nav" aria-label="Primary mobile navigation">{nav.map((item) => <button key={item.name} onClick={() => navigate(item.name)} className={page === item.name ? "active" : ""}><Icon name={item.icon} /><span>{item.name.replace("Beyond Your Taste", "Beyond").replace("Mood & Context", "Mood").replace("My Collection", "Collection").replace("ML Insights", "Insights")}</span></button>)}</nav>
    {searchOpen && <SearchOverlay close={() => setSearchOpen(false)} openMovie={setSelected} />}
    {selected && <DetailModal movie={selected} close={() => setSelected(null)} props={props} />}
    {onboarding && <Onboarding close={() => setOnboarding(false)} complete={completeOnboarding} languages={languages} />}
    {toast && <div className="toast" role="status"><Icon name="check" />{toast}<small>Account-backed when the backend is reachable</small></div>}
  </div>;
}
