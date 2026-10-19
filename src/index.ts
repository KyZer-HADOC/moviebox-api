// src/index.ts
// Spün MovieBox Worker — main entry point.
// Routes:
//   GET  /                             — API info & route listing (public)
//   GET  /health                       — health check (public)
//   POST /search                       — { keyword, page?, perPage? }
//   GET  /info/:subjectId              — subject detail
//   GET  /season/:subjectId            — season/episode structure
//   GET  /stream/:subjectId            — ?se=X&ep=Y  MP4 URLs for specific episode
//   GET  /stream/:subjectId/all        — all episodes with streams (shorts/series bulk)
//   GET  /download/:subjectId          — full pack grouped by season/episode
//   GET  /home                         — homepage rows + subjects (Africa feed)
//   GET  /home/subjects?opId=X         — subjects for a specific row
//
// /stream, /stream/all, and /download use the Android resource endpoint (7-host pool).
// /home and /home/subjects use the H5 web endpoint (no HMAC signing required).
// All routes except / and /health require X-Worker-Secret header.

import {
  fetchWithHostPool,
  PATHS,
  type MBDetailData,
  type MBSeasonData,
  type MBResourceData,
  type MBResourceItem,
} from './moviebox.js';
import { generateClientToken, generateSignature, type SigningEnv } from './signing.js';

// subjectType: 1=movie, 2=tv, 7=shorts — all others filtered out
const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

function isNonEnglishDub(title: string, language?: string | null): boolean {
  const haystack = `${title} ${language ?? ''}`;
  const bracketDubPattern =
    /[\[(].*?\b(hindi|tamil|telugu|malayalam|kannada|bengali|punjabi|urdu|spanish|espanol|latino|french|german|italian|korean|japanese|arabic|portuguese|russian|chinese|thai|indonesian|filipino|dub|dubbed|dual-audio|multi-audio)\b.*?[\])]/i;

  if (bracketDubPattern.test(haystack)) {
    return true;
  }

  const wordDubPattern =
    /\b(hindi|tamil|telugu|malayalam|kannada|bengali|punjabi|urdu|dubbed|dual-audio|multi-audio)\b/i;

  if (wordDubPattern.test(haystack)) {
    return true;
  }

  return false;
}

export interface Env extends SigningEnv {
  MOVIEBOX_SECRET: string;
  // Nigerian IP for X-Forwarded-For — ensures the H5 upstream returns the full
  // Africa region feed (35 rows). Cloudflare edge IPs get a truncated feed (30 rows).
  // Set in wrangler.toml or Cloudflare dashboard. Falls back to a known MTN Nigeria IP.
  NIGERIA_IP?: string;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  const secret = request.headers.get('X-Worker-Secret');
  return !!secret && secret === env.MOVIEBOX_SECRET;
}

// ─── Language name map ────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',   fr: 'Français',  ar: 'Arabic',    zh: 'Chinese',
  ru: 'Russian',   pt: 'Português', es: 'Spanish',   de: 'German',
  ja: 'Japanese',  ko: 'Korean',    it: 'Italian',   sw: 'Kiswahili',
  ha: 'Hausa',     ms: 'Malay',     bn: 'Bengali',   ur: 'Urdu',
  pa: 'Punjabi',   fil: 'Filipino', id: 'Indonesian',
};

// ─── Shared: fetch full resource pack (all resolutions, all pages) ───────────
// MovieBox's resource endpoint is resolution-filtered — omitting the resolution
// param returns only one quality. We loop over every known resolution and
// paginate each until hasMore=false, deduplicating by resourceId across passes.
// se=0&ep=0 is the magic value that returns all episodes in bulk.
// perPage must be 10 — server silently rejects higher values with code !== 0.

const RESOLUTIONS = [360, 480, 720, 1080];

async function fetchResourcePack(
  env: Env,
  subjectId: string,
  se = 0,
  ep = 0
): Promise<MBResourceItem[] | null> {
  const seenResourceIds = new Set<string>();
  const allItems: MBResourceItem[] = [];
  const perPage = 10;

  const promises = RESOLUTIONS.map(async (resolution) => {
    let page = 1;
    const resItems: MBResourceItem[] = [];
    while (true) {
      const data = await fetchWithHostPool<MBResourceData>(
        env, PATHS.resource, 'GET', { subjectId, se, ep, resolution, page, perPage }
      );

      if (!data?.list?.length) break;

      for (const item of data.list) {
        resItems.push(item);
      }

      if (!data.pager?.hasMore) break;

      page++;

      if (page > 100) break;
    }
    return resItems;
  });

  const results = await Promise.all(promises);
  for (const resItems of results) {
    for (const item of resItems) {
      if (!seenResourceIds.has(item.resourceId)) {
        seenResourceIds.add(item.resourceId);
        allItems.push(item);
      }
    }
  }

  if (!allItems.length) return null;

  return allItems.sort((a, b) => b.resolution - a.resolution);
}

// ─── Shared: map a resource item to a stream/download object ─────────────────

function mapResourceItem(item: MBResourceItem) {
  const sizeMb = item.size
    ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB`
    : null;

  const captions = (item.extCaptions || []).map((cap) => ({
    language:      cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url:           cap.url,
  }));

  return {
    quality:    `${item.resolution}p`,
    resolution: item.resolution,
    url:        item.resourceLink,
    format:     'mp4' as const,
    size:       sizeMb,
    codecName:  item.codecName ?? null,
    duration:   item.duration ?? null,
    captions,
    se:         item.se,
    ep:         item.ep,
  };
}

// ─── H5 homepage fetcher ──────────────────────────────────────────────────────
// No HMAC signing needed — the H5 API only requires standard browser headers.
// The Africa/Lagos timezone pin in X-Client-Info is what produces the Africa
// region feed (Nollywood, Anime Dub, Black Shows rows). Do not change it.

const H5_HOSTS = [
  'https://netnaija.film',
  'https://h5.aoneroom.com',
  'https://moviebox.pk',
];

const H5_PATH = '/wefeed-h5-bff/web/home';

interface H5Subject {
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        number;
  genre?:           string;
  cover?:           { url?: string; thumbnail?: string };
  countryName?:     string;
  imdbRatingValue?: string;
  hasResource?:     boolean;
  language?:        string;
}

interface H5Row {
  title:    string;
  opId:     string;
  type:     string;
  subjects: H5Subject[];
}

interface H5HomeData {
  operatingList: H5Row[];
}

async function fetchH5Home(nigeriaIp?: string): Promise<H5HomeData | null> {
  // Use provided IP or fall back to a known stable MTN Nigeria IP.
  // This is needed because Cloudflare edge nodes have non-Nigerian IPs and the
  // upstream server returns a region-filtered feed based on the requester's IP.
  const forwardedIp = nigeriaIp || '197.210.65.1';

  for (const base of H5_HOSTS) {
    try {
      const response = await fetch(`${base}${H5_PATH}`, {
        method: 'GET',
        headers: {
          'X-Client-Info':   '{"timezone":"Africa/Lagos"}',
          'Accept':           'application/json',
          'User-Agent':       'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0',
          'Referer':          `${base}/`,
          'X-Forwarded-For':  forwardedIp,
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        console.warn(`[H5] Host ${base} returned ${response.status} — trying next`);
        continue;
      }

      const data = await response.json() as { code: number; data?: H5HomeData };

      if (data.code === 0 && data.data) {
        return data.data;
      }

      console.warn(`[H5] Host ${base} returned API code ${data.code} — trying next`);
    } catch (e) {
      console.warn(`[H5] Host ${base} failed: ${e} — trying next`);
    }
  }

  console.error('[H5] All hosts exhausted');
  return null;
}

function normalizeH5Subject(item: H5Subject) {
  const rawDuration = item.duration;
  const runtimeMinutes = rawDuration && rawDuration > 0
    ? Math.round(rawDuration / 60)
    : null;

  return {
    subjectId:   item.subjectId,
    subjectType: item.subjectType,
    type:        resolveSubjectType(item.subjectType),
    title:       item.title,
    description: item.description ?? '',
    releaseDate: item.releaseDate ?? null,
    runtime:     runtimeMinutes,
    genre:       item.genre ?? null,
    poster:      item.cover?.url ?? null,
    thumbnail:   item.cover?.thumbnail ?? '',
    country:     item.countryName ?? null,
    rating:      item.imdbRatingValue && item.imdbRatingValue !== '0'
                   ? parseFloat(item.imdbRatingValue)
                   : null,
    hasResource: item.hasResource ?? false,
    language:    item.language ?? null,
  };
}

// ─── H5 search client ─────────────────────────────────────────────────────────
// The Android API host pool currently returns HTTP 440 during anonymous-token
// bootstrap. Use MovieBox's H5 catalogue API with its signed anonymous bootstrap.

const H5_API_BASE = 'https://h5-api.aoneroom.com';
const H5_TOKEN_KEY = 'h5_auth_token';
const H5_TOKEN_KV_TTL = 60 * 60 * 24;
const H5_CLIENT_INFO = JSON.stringify({ timezone: 'Asia/Colombo' });
const H5_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

interface H5CachedToken {
  token: string;
  expiresAtSeconds: number;
}

function readJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadText = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadText + '='.repeat((4 - (payloadText.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

async function saveH5Token(env: Env, token: string): Promise<void> {
  const expiresAtSeconds =
    readJwtExp(token) ?? Math.floor(Date.now() / 1000) + 3600;
  const value: H5CachedToken = { token, expiresAtSeconds };
  try {
    await env.MOVIEBOX_SESSION_KV.put(
      H5_TOKEN_KEY,
      JSON.stringify(value),
      { expirationTtl: H5_TOKEN_KV_TTL }
    );
  } catch (error) {
    console.warn(`[H5 Auth] Could not cache H5 token in KV: ${error}`);
  }
}

async function readH5Token(env: Env): Promise<string | null> {
  try {
    const raw = await env.MOVIEBOX_SESSION_KV.get(H5_TOKEN_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as H5CachedToken;
    if (cached.token && cached.expiresAtSeconds > Math.floor(Date.now() / 1000) + 60) {
      return cached.token;
    }
  } catch (error) {
    console.warn(`[H5 Auth] Could not read H5 token from KV: ${error}`);
  }
  return null;
}

async function invalidateH5Token(env: Env): Promise<void> {
  try {
    await env.MOVIEBOX_SESSION_KV.delete(H5_TOKEN_KEY);
  } catch (error) {
    console.warn(`[H5 Auth] Could not invalidate H5 token in KV: ${error}`);
  }
}

function readXUserToken(response: Response): string | null {
  const value = response.headers.get('x-user');
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { token?: string };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

async function sendH5Request(
  env: Env,
  url: string,
  method: 'GET' | 'POST',
  body: string | null,
  bearerToken: string | null
): Promise<Response> {
  const timestamp = Date.now();
  const accept = 'application/json';
  const contentType = body !== null ? 'application/json; charset=utf-8' : '';
  const headers: Record<string, string> = {
    'Accept': accept,
    'User-Agent': H5_USER_AGENT,
    'Referer': 'https://themoviebox.org/',
    'X-Client-Token': await generateClientToken(timestamp),
    'x-tr-signature': await generateSignature(
      method, accept, contentType, url, body, timestamp
    ),
    'X-Client-Info': H5_CLIENT_INFO,
    'x-request-lang': 'en',
    'X-Client-Status': '0',
  };
  if (body !== null) headers['Content-Type'] = contentType;
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ?? undefined,
    signal: AbortSignal.timeout(12000),
  });

  const rotatedToken = readXUserToken(response);
  if (rotatedToken) await saveH5Token(env, rotatedToken);
  return response;
}

async function bootstrapH5Token(env: Env): Promise<string | null> {
  // These guest endpoints return the anonymous bearer in the x-user response header.
  const urls = [
    `${H5_API_BASE}/wefeed-h5api-bff/country-code`,
    `${H5_API_BASE}/wefeed-h5api-bff/home?host=themoviebox.org`,
    `${H5_API_BASE}/wefeed-h5api-bff/home?host=moviebox.ph`,
  ];

  for (const url of urls) {
    try {
      const response = await sendH5Request(env, url, 'GET', null, null);
      const token = readXUserToken(response);
      if (token) {
        await saveH5Token(env, token);
        console.log(`[H5 Auth] Anonymous token bootstrap succeeded (HTTP ${response.status})`);
        return token;
      }
      console.warn(`[H5 Auth] ${new URL(url).pathname} returned no x-user token (HTTP ${response.status})`);
    } catch (error) {
      console.warn(`[H5 Auth] Bootstrap request failed: ${error}`);
    }
  }

  console.error('[H5 Auth] Could not obtain an anonymous H5 token from bootstrap endpoints');
  return null;
}

async function getH5Token(env: Env): Promise<string | null> {
  return (await readH5Token(env)) ?? (await bootstrapH5Token(env));
}

async function fetchH5Search(
  env: Env,
  keyword: string,
  page: number,
  perPage: number
): Promise<Record<string, any> | null> {
  const endpoints = [
    `${H5_API_BASE}/wefeed-h5api-bff/subject/search`,
    'https://h5.aoneroom.com/wefeed-h5api-bff/subject/search',
  ];
  const body = JSON.stringify({ keyword, page, perPage, subjectType: 0 });

  for (const endpoint of endpoints) {
    try {
      let token = await getH5Token(env);
      if (!token) return null;

      let response = await sendH5Request(env, endpoint, 'POST', body, token);

      // Refresh an expired anonymous token and retry once.
      if ([401, 403, 440].includes(response.status)) {
        await invalidateH5Token(env);
        token = await bootstrapH5Token(env);
        if (token) response = await sendH5Request(env, endpoint, 'POST', body, token);
      }

      if (!response.ok) {
        const message = (await response.text()).slice(0, 180).replace(/\s+/g, ' ');
        console.warn(`[H5 Search] ${endpoint} returned HTTP ${response.status}: ${message}`);
        continue;
      }

      const envelope = await response.json() as Record<string, any>;
      if (envelope.code !== undefined && Number(envelope.code) !== 0) {
        console.warn(`[H5 Search] ${endpoint} returned API code ${envelope.code}: ${envelope.message ?? ''}`);
        continue;
      }

      const data = envelope.data && typeof envelope.data === 'object'
        ? envelope.data as Record<string, any>
        : envelope;
      const unwrapped = data.data && typeof data.data === 'object'
        ? data.data as Record<string, any>
        : data;

      console.log(`[H5 Search] Search succeeded via ${new URL(endpoint).hostname}`);
      return unwrapped;
    } catch (error) {
      console.warn(`[H5 Search] ${endpoint} failed: ${error} — trying next`);
    }
  }

  console.error('[H5 Search] All search endpoints failed');
  return null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleRoot(): Response {
  return json({
    name:        'Spün MovieBox API',
    description: 'An unofficial REST API built by Spün for MovieBox — wrapping the MovieBox Android & H5 APIs with host pool fallback, request signing, and structured responses.',
    version:     '1.1.0',
    routes: [
      { method: 'GET',  path: '/',                          auth: false,  description: 'API info and route listing' },
      { method: 'GET',  path: '/health',                    auth: false,  description: 'Worker health check' },
      { method: 'POST', path: '/search',                    auth: true,   description: 'Search for movies, TV shows, and shorts. Body: { keyword, page?, perPage? }' },
      { method: 'GET',  path: '/info/:subjectId',           auth: true,   description: 'Get detail for a subject' },
      { method: 'GET',  path: '/season/:subjectId',         auth: true,   description: 'Get season and episode structure for a TV show or shorts series' },
      { method: 'GET',  path: '/stream/:subjectId',         auth: true,   description: 'Stream URLs for a specific episode. Params: se (season), ep (episode). Use se=0&ep=0 for movies.' },
      { method: 'GET',  path: '/stream/:subjectId/all',     auth: true,   description: 'All stream URLs for all episodes grouped by episode. Useful for shorts and full series bulk fetch.' },
      { method: 'GET',  path: '/download/:subjectId',       auth: true,   description: 'Full download pack grouped by season → episode → quality' },
      { method: 'GET',  path: '/home',                      auth: true,   description: 'MovieBox homepage rows with subjects (Africa/Lagos feed)' },
      { method: 'GET',  path: '/home/rows',                 auth: true,   description: 'All homepage row titles and opIds — use to discover rows before fetching subjects' },
      { method: 'GET',  path: '/home/subjects?opId=X',      auth: true,   description: 'Subjects for a specific homepage row by opId' },
    ],
  });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return err('Invalid JSON body');
  }

  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  if (!keyword) return err('keyword is required');

  const page = Math.max(1, Number(body.page ?? 1) || 1);
  const perPage = Math.min(20, Math.max(1, Number(body.perPage ?? 20) || 20));

  // H5 search avoids the mobile API's bearer-token bootstrap, which currently
  // receives HTTP 440 across the Android host pool.
  const data = await fetchH5Search(env, keyword, page, perPage);

  if (!data) {
    return json({
      error: 'MovieBox H5 search endpoints failed. Check the Worker logs for [H5 Search] errors.',
      keyword
    }, 502);
  }

  // Accept known list containers and normalize numeric IDs/types.
  const raw = data;
  const rawItems: any[] = Array.isArray(raw.items) ? raw.items
    : Array.isArray(raw.list) ? raw.list
    : Array.isArray(raw.subjects) ? raw.subjects
    : Array.isArray(raw.results) ? raw.results
    : [];

  const items = rawItems
    .filter((item) => item && typeof item === 'object')
    .map((item) => item.subject && typeof item.subject === 'object'
      ? { ...item, ...item.subject }
      : item)
    .filter((item) => String(item.subjectId ?? item.subject_id ?? item.id ?? '').trim() !== '')
    .filter((item) => String(item.title ?? item.name ?? '').trim() !== '')
    // Some responses serialize subjectType as a string. Treat a missing/unknown
    // type as a movie for display rather than silently dropping every result.
    .map((item) => {
      const parsedType = Number(item.subjectType ?? item.subject_type ?? item.typeId);
      const subjectType = ALLOWED_SUBJECT_TYPES.has(parsedType) ? parsedType : 1;
      const cover = item.cover;
      const poster = (typeof cover === 'string' ? cover : cover?.url)
        ?? item.poster
        ?? item.posterUrl
        ?? item.image?.url
        ?? null;
      const thumbnail = (typeof cover === 'object' && cover ? cover.thumbnail : null)
        ?? item.thumbnail
        ?? null;
      const ratingValue = item.imdbRatingValue ?? item.rating;
      const rating = ratingValue && String(ratingValue) !== '0' && Number.isFinite(Number(ratingValue))
        ? Number(ratingValue)
        : null;

      return {
        subjectId: String(item.subjectId ?? item.subject_id ?? item.id),
        subjectType,
        title: String(item.title ?? item.name).trim(),
        description: item.description ?? '',
        releaseDate: item.releaseDate ?? item.release_date ?? null,
        duration: item.duration ?? null,
        genre: item.genre ?? null,
        poster,
        thumbnail,
        country: item.countryName ?? item.country ?? null,
        rating,
        language: item.language ?? null,
        type: resolveSubjectType(subjectType),
      };
    });

  // Don't silently filter out all titles based on locale/dub labels. Return the
  // results MovieBox provided; users can pick the language/version they need.
  return json({
    items,
    pager: raw.pager ?? null,
    debug: {
      keyword,
      rawCount: rawItems.length,
      returnedCount: items.length,
      responseKeys: Object.keys(raw),
    },
  });
}

async function handleInfo(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBDetailData>(
    env, PATHS.get, 'GET', { subjectId }
  );

  if (!data?.subjectId) return err('Not found', 404);

  const staffList = (data as any).staffList || [];

  const rawDuration = (data as any).duration;
  let runtimeMinutes: number | null = null;
  if (typeof rawDuration === 'number') {
    runtimeMinutes = Math.round(rawDuration / 60);
  } else if (typeof rawDuration === 'string') {
    const hMatch = rawDuration.match(/(\d+)h/);
    const mMatch = rawDuration.match(/(\d+)m/);
    const h = hMatch ? parseInt(hMatch[1]) : 0;
    const m = mMatch ? parseInt(mMatch[1]) : 0;
    runtimeMinutes = h * 60 + m || null;
  }

  return json({
    subjectId:   data.subjectId,
    subjectType: data.subjectType,
    type:        resolveSubjectType(data.subjectType),
    title:       data.title,
    description: data.description ?? '',
    releaseDate: data.releaseDate ?? null,
    runtime:     runtimeMinutes,
    genre:       data.genre ?? null,
    poster:      data.cover?.url ?? null,
    country:     data.countryName ?? null,
    rating:      data.imdbRatingValue && data.imdbRatingValue !== '0'
                   ? parseFloat(data.imdbRatingValue)
                   : null,
    hasResource: data.hasResource ?? false,
    language:    data.language ?? null,
    staff:       staffList.map((s: any) => ({
      name:   s.name,
      role:   s.role,
      avatar: s.avatar?.url ?? null,
    })),
  });
}

async function handleSeason(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBSeasonData>(
    env, PATHS.seasonInfo, 'GET', { subjectId }
  );

  if (!data?.seasons?.length) return json({ seasons: [] });

  return json({
    seasons: data.seasons.map((s) => {
      const bestEpCount = s.resolutions?.length
        ? Math.max(...s.resolutions.map((r) => r.epNum))
        : s.maxEp;

      return {
        season:            s.se,
        totalEpisode:      s.maxEp,
        episodesAvailable: bestEpCount,
        resolutions:       s.resolutions || [],
        episodes:          Array.from({ length: s.maxEp }, (_, i) => ({
          episode:     i + 1,
          title:       null,
          releaseDate: null,
        })),
      };
    }),
  });
}

// GET /stream/:subjectId?se=X&ep=Y
// Returns MP4 URLs for a specific episode, deduplicated by quality.
// Use se=0&ep=0 for movies (returns full pack as one item per quality).

async function handleStream(subjectId: string, se: number, ep: number, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId, se, ep);
  if (!pack) return err('No streams available', 404);

  const isMovie = se === 0 && ep === 0;
  let items = pack;

  if (!isMovie) {
    const filtered = pack.filter((r) => r.se === se && r.ep === ep);
    if (!filtered.length) return err('No streams available for this episode', 404);
    items = filtered;
  }

  // Deduplicate by quality — keep first (highest resolution sort already applied)
  const seenQualities = new Set<string>();
  const streams = items
    .filter((item) => {
      const q = `${item.resolution}p`;
      if (seenQualities.has(q)) return false;
      seenQualities.add(q);
      return true;
    })
    .map(mapResourceItem);

  return json({ streams, total: streams.length });
}

// GET /stream/:subjectId/all
// Returns ALL stream URLs grouped by season → episode.
// Works for both shorts (se=1, flat episode list) and full TV series.
// No se/ep filtering — always returns the complete pack.

async function handleStreamAll(subjectId: string, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No streams available', 404);

  // Group by season (se) → episode (ep) — deduplicate by quality within each episode
  const seasonMap = new Map<number, Map<number, ReturnType<typeof mapResourceItem>[]>>();

  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;

    if (!seasonMap.has(seKey)) seasonMap.set(seKey, new Map());
    const epMap = seasonMap.get(seKey)!;

    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const streams = epMap.get(epKey)!;

    const q = `${item.resolution}p`;
    if (!streams.find((x) => x.quality === q)) {
      streams.push(mapResourceItem(item));
    }
  }

  const seasons = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, streams]) => ({
          episode: epNum,
          streams,
          total:   streams.length,
        })),
    }));

  return json({ seasons, total_seasons: seasons.length });
}

// GET /download/:subjectId
// Returns full pack grouped by season → episodes → qualities.

async function handleDownload(subjectId: string, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No downloads available', 404);

  const seasonMap = new Map<number, Map<number, ReturnType<typeof mapResourceItem>[]>>();

  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;

    if (!seasonMap.has(seKey)) seasonMap.set(seKey, new Map());
    const epMap = seasonMap.get(seKey)!;

    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const qualities = epMap.get(epKey)!;

    const q = `${item.resolution}p`;
    if (!qualities.find((x) => x.quality === q)) {
      qualities.push(mapResourceItem(item));
    }
  }

  const seasons = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, qualities]) => ({
          episode:  epNum,
          qualities,
        })),
    }));

  return json({ seasons, total_seasons: seasons.length });
}

// GET /home/rows
// Returns all homepage row titles and opIds — lightweight discovery endpoint.
// Use this to find opIds before calling /home/subjects.

async function handleHomeRows(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId:  row.opId,
  }));

  return json({ total: rows.length, rows });
}

// GET /home
// Returns all homepage rows with their subjects (Africa/Lagos feed).

async function handleHome(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title:    row.title,
    opId:     row.opId,
    type:     row.type,
    total:    (row.subjects || []).length,
    subjects: (row.subjects || [])
      .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
      .filter((s) => !isNonEnglishDub(s.title))
      .map(normalizeH5Subject),
  }));

  return json({ total: rows.length, rows });
}

// GET /home/subjects?opId=X
// Returns subjects for a specific homepage row.

async function handleHomeSubjects(opId: string, env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const row = (data.operatingList || []).find((r) => r.opId === opId);
  if (!row) return err('Row not found', 404);

  const subjects = (row.subjects || [])
    .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
    .filter((s) => !isNonEnglishDub(s.title))
    .map(normalizeH5Subject);

  return json({
    opId:     row.opId,
    title:    row.title,
    total:    subjects.length,
    subjects,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // Public routes — no auth required
    if (path === '/' && request.method === 'GET') {
      return handleRoot();
    }

    if (path === '/health' && request.method === 'GET') {
      return json({ status: 'ok', worker: 'moviebox-worker', ts: Date.now() });
    }

    if (path === '/debug-sig' && request.method === 'GET') {
      const ts = 1782346250180;
      const method = 'GET';
      const accept = 'application/json';
      const contentType = 'application/json';
      const url = 'https://api6.aoneroom.com/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=';
      const body = null;
      
      const { generateSignature } = await import('./signing.js');
      const sig = await generateSignature(method, accept, contentType, url, body, ts);
      return json({ signature: sig });
    }

    if (!isAuthorized(request, env)) {
      return err('Unauthorized', 401);
    }

    // POST /search
    if (path === '/search' && request.method === 'POST') {
      return handleSearch(request, env);
    }

    // GET /info/:subjectId
    const infoMatch = path.match(/^\/info\/([^/]+)$/);
    if (infoMatch && request.method === 'GET') {
      return handleInfo(infoMatch[1], env);
    }

    // GET /season/:subjectId
    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === 'GET') {
      return handleSeason(seasonMatch[1], env);
    }

    // GET /stream/:subjectId/all — must be checked before /stream/:subjectId
    const streamAllMatch = path.match(/^\/stream\/([^/]+)\/all$/);
    if (streamAllMatch && request.method === 'GET') {
      return handleStreamAll(streamAllMatch[1], env);
    }

    // GET /stream/:subjectId?se=X&ep=Y
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleStream(streamMatch[1], se, ep, env);
    }

    // GET /download/:subjectId
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') {
      return handleDownload(downloadMatch[1], env);
    }

    // GET /home/rows — must be checked before /home
    if (path === '/home/rows' && request.method === 'GET') {
      return handleHomeRows(env);
    }

    // GET /home/subjects?opId=X — must be checked before /home
    if (path === '/home/subjects' && request.method === 'GET') {
      const opId = url.searchParams.get('opId');
      if (!opId) return err('opId is required');
      return handleHomeSubjects(opId, env);
    }

    // GET /home
    if (path === '/home' && request.method === 'GET') {
      return handleHome(env);
    }

    return err('Not found', 404);
  },
};