import type { Person, WebHit } from "./people.js";
import { normaliseLinkedInUrl } from "./score.js";
import { parseLocation, type Spec } from "./spec.js";

export const SEARCH_PATH = "/v2/search";
export const SEARCH_LIMIT = 10;
export const CREDITS_PER_SEARCH = 2; // 2 credits per 10 results
export const MAX_WEB_QUERIES = 3;
export const MAX_TITLES_IN_QUERY = 6; // keeps queries well under Firecrawl's 500-char limit

// Edit freely. {titles} = the first title_keywords, quoted and OR-ed (so they follow the request's
// language); {industry_keyword} and {city} are substituted.
export const QUERY_TEMPLATE = 'site:linkedin.com/in ({titles}) "{industry_keyword}" "{city}"';

const unquote = (s: string) => s.replace(/"/g, "");

export function buildQueries(spec: Spec): string[] {
  const { city } = parseLocation(spec.location);
  const titles = spec.title_keywords.slice(0, MAX_TITLES_IN_QUERY).map((t) => `"${unquote(t)}"`).join(" OR ");
  return spec.industry_keywords
    .slice(0, MAX_WEB_QUERIES)
    .map((kw) =>
      QUERY_TEMPLATE.replace("{titles}", titles).replace("{industry_keyword}", unquote(kw)).replace("{city}", unquote(city)),
    );
}

// Never add scrapeOptions here: we use only url/title/description, never page content.
// highlights:false keeps `description` as the plain search-engine snippet.
export function searchBody(query: string) {
  return { query, limit: SEARCH_LIMIT, highlights: false };
}

interface SearchResponse {
  data?: { web?: { url?: string; title?: string; description?: string }[] };
}

/** LinkedIn profile hits from a search response; everything that isn't linkedin.com/in/ is dropped. */
export function extractHits(raw: unknown): { hits: WebHit[]; nonProfile: number } {
  const rows = (raw as SearchResponse).data?.web ?? [];
  const hits: WebHit[] = [];
  for (const r of rows) {
    if (r.url && normaliseLinkedInUrl(r.url)) {
      hits.push({ url: r.url, title: r.title ?? "", description: r.description ?? "" });
    }
  }
  return { hits, nonProfile: rows.length - hits.length };
}

/** "Jane Doe - Fintech Headhunter | Acme - LinkedIn" → { name: "Jane Doe", headline: "Fintech Headhunter | Acme" } */
export function parseTitle(title: string): { name: string; headline?: string } {
  const clean = title.replace(/\s*[-|–]\s*LinkedIn\s*$/i, "").trim();
  const m = clean.match(/^(.+?)\s+[-–|]\s+(.+)$/);
  return m ? { name: m[1]!.trim(), headline: m[2]!.trim() } : { name: clean };
}

// Labels LinkedIn snippets use before a member's location (search-engine text, not page content).
export const LOCATION_LABELS = [
  "Location", "Lokalizacja", "Standort", "Localisation", "Lieu", "Ubicación", "Localização", "Località", "Locatie",
  "Местоположение", "Місцезнаходження",
];
const LOCATION_RE = new RegExp(`(?:${LOCATION_LABELS.join("|")})\\s*:\\s*(.+?)\\s*(?=·|\\||\\.\\.\\.|…|$)`, "iu");

/** "… · Location: Minsk ... Магистр" → "Minsk". */
export function snippetLocation(text: string): string | undefined {
  return text.match(LOCATION_RE)?.[1]?.trim() || undefined;
}

/** A person known only from search snippets (no structured record). */
export function webOnlyPerson(key: string, hits: WebHit[]): Person {
  const { name, headline } = parseTitle(hits[0]!.title);
  return {
    key,
    profileUrl: `https://www.${key}`,
    name,
    headline,
    locationText: hits.map((h) => snippetLocation(h.description)).find(Boolean),
    jobs: [],
    structured: false,
    web: hits,
    foundBy: ["B"],
  };
}
