import type { Spec } from "./spec.js";
import { normaliseLinkedInUrl } from "./score.js";

export const SCRAPE_PATH = "/v2/scrape";
export const PAGE_SIZE = 6; // FullEnrich people/search max per page
export const CREDITS_PER_RECORD = 5; // per returned record; empty results are free

export type Source = "A" | "B";

export interface Job {
  title: string;
  company: string;
  companyIndustry?: string;
  description?: string;
  start?: string; // ISO date
  end?: string; // ISO date; absent = current
  isCurrent: boolean;
}

export interface WebHit {
  url: string;
  title: string;
  description: string;
}

/** One merged person. `key` is the normalised LinkedIn URL used for dedupe. */
export interface Person {
  key: string;
  profileUrl: string;
  name: string;
  headline?: string;
  description?: string;
  city?: string;
  country?: string;
  locationText?: string; // web-only people: "Location: …" read from the search snippet
  currentTitle?: string;
  currentCompany?: string;
  connections?: number; // LinkedIn connection count; only structured records have it
  jobs: Job[];
  structured: boolean; // true = has a FullEnrich record
  web: WebHit[]; // web-search evidence
  foundBy: Source[];
}

export function searchBody(spec: Spec, offset: number, limit: number) {
  return {
    alexandria: {
      provider: "fullenrich",
      capability: "people/search",
      options: {
        limit,
        offset,
        person_locations: [{ value: spec.location }],
        current_position_titles: spec.title_keywords.map((value) => ({ value })),
      },
    },
  };
}

export function matchBody(linkedinUrl: string) {
  return {
    alexandria: { provider: "fullenrich", capability: "people/match", options: { linkedin_url: linkedinUrl } },
  };
}

/** Pages needed to reach max_results: [{offset, limit}, ...]. */
export function searchPages(maxResults: number): { offset: number; limit: number }[] {
  const pages = [];
  for (let offset = 0; offset < maxResults; offset += PAGE_SIZE) {
    pages.push({ offset, limit: Math.min(PAGE_SIZE, maxResults - offset) });
  }
  return pages;
}

// Only the fields we read. Contact fields are never requested and never mapped.
interface RawJob {
  title?: string | null;
  description?: string | null;
  company?: { name?: string | null; industry?: { main_industry?: string | null } | null } | null;
  start_at?: string | null;
  end_at?: string | null;
  is_current?: boolean | null;
}

export interface RawPerson {
  full_name?: string | null;
  headline?: string | null;
  description?: string | null;
  location?: { city?: string | null; country?: string | null } | null;
  employment?: { current?: RawJob | null; all?: RawJob[] | null } | null;
  social_profiles?: { professional_network?: { url?: string | null; connection_count?: number | null } | null } | null;
}

interface AlexandriaResponse {
  data?: { alexandria?: { upstreamStatus?: number; data?: { people?: RawPerson[] } }[] };
}

/** people[] from an Alexandria response (search or match). Real shape: data.alexandria[0].data.people. */
export function extractPeople(raw: unknown): RawPerson[] {
  const call = (raw as AlexandriaResponse).data?.alexandria?.[0];
  if (call?.upstreamStatus && call.upstreamStatus >= 400) {
    throw new Error(`FullEnrich returned status ${call.upstreamStatus}`);
  }
  return call?.data?.people ?? [];
}

const str = (s: string | null | undefined) => (s && s.trim() ? s.trim() : undefined);

function toJob(j: RawJob): Job | null {
  const title = str(j.title);
  if (!title) return null;
  return {
    title,
    company: str(j.company?.name) ?? "",
    companyIndustry: str(j.company?.industry?.main_industry),
    description: str(j.description),
    start: str(j.start_at),
    end: str(j.end_at),
    isCurrent: Boolean(j.is_current) || !j.end_at,
  };
}

/** Map a FullEnrich record to a Person. Returns null when it has no LinkedIn URL (no dedupe key). */
export function toPerson(raw: RawPerson, foundBy: Source): Person | null {
  const profileUrl = str(raw.social_profiles?.professional_network?.url);
  const key = profileUrl ? normaliseLinkedInUrl(profileUrl) : null;
  if (!profileUrl || !key) return null;
  const current = raw.employment?.current ? toJob(raw.employment.current) : null;
  return {
    key,
    profileUrl: `https://www.${key}`,
    name: str(raw.full_name) ?? "(no name)",
    headline: str(raw.headline),
    description: str(raw.description),
    city: str(raw.location?.city),
    country: str(raw.location?.country),
    currentTitle: current?.title,
    currentCompany: current?.company || undefined,
    connections: raw.social_profiles?.professional_network?.connection_count ?? undefined,
    jobs: (raw.employment?.all ?? []).map(toJob).filter((j): j is Job => j !== null),
    structured: true,
    web: [],
    foundBy: [foundBy],
  };
}
