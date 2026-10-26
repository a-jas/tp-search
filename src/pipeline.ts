import { BudgetExceeded, isCached, type Credits, type Post } from "./firecrawl.js";
import * as people from "./people.js";
import type { Person, WebHit } from "./people.js";
import { areaNames, checkLocation, evaluate, fold, normaliseLinkedInUrl, REVIEW_MIN, type Scored, type Status } from "./score.js";
import type { Spec } from "./spec.js";
import * as web from "./websearch.js";

export const MAX_WEB_MATCHES = 4;
// Which new web URLs get a paid people/match first (higher total wins).
export const MATCH_PRIORITY = { snippetLocation: 4, mentionsArea: 2, industryKeyword: 1 } as const;

export interface Estimate {
  total: number;
  lines: string[];
}

/** Worst-case credits for a run; anything already in the cache counts as 0. */
export function estimate(spec: Spec): Estimate {
  const lines: string[] = [];

  let a = 0;
  for (const { offset, limit } of people.searchPages(spec.max_results)) {
    const cached = isCached(people.SCRAPE_PATH, people.searchBody(spec, offset, limit));
    const cost = cached ? 0 : limit * people.CREDITS_PER_RECORD;
    a += cost;
    lines.push(`Source A people/search offset ${offset}, limit ${limit}: ${cost}${cached ? " (cached)" : ""}`);
  }

  let b = 0;
  for (const q of web.buildQueries(spec)) {
    const cached = isCached(web.SEARCH_PATH, web.searchBody(q));
    const cost = cached ? 0 : web.CREDITS_PER_SEARCH;
    b += cost;
    lines.push(`Source B search: ${cost}${cached ? " (cached)" : ""} · ${q}`);
  }

  // URLs to match are unknown until search runs, so assume the worst case.
  const m = MAX_WEB_MATCHES * people.CREDITS_PER_RECORD;
  lines.push(`people/match for new web URLs: up to ${m} (${MAX_WEB_MATCHES} × ${people.CREDITS_PER_RECORD}; misses are free)`);

  return { total: a + b + m, lines };
}

export interface GatherFunnel {
  sourceA: number; // structured records with a LinkedIn URL
  sourceATotal?: number; // matches FullEnrich reports for the query
  sourceB: number; // unique LinkedIn profiles from web search
  sourceBNonProfile: number; // web results dropped for not being linkedin.com/in/
  matched: number; // web-only URLs turned into structured records
  matchMisses: number;
  inBoth: number;
  afterMerge: number;
}

export interface Gathered {
  people: Person[];
  funnel: GatherFunnel;
  queries: string[];
  notes: string[]; // budget stops and source errors, shown to Claude
}

/** Runs one paid call; on budget stop or API error, records a note and returns null instead of throwing. */
async function attempt<T>(notes: string[], label: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    const note = err instanceof BudgetExceeded ? `${label}: ${err.message}` : `${label} failed: ${(err as Error).message}`;
    if (!notes.includes(note)) notes.push(note);
    return null;
  }
}

const mentionsAny = (text: string, keywords: string[]) => {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
};

/** Sources A and B → matches for new web URLs → one record per normalised LinkedIn URL. */
export async function gather(spec: Spec, post: Post): Promise<Gathered> {
  const notes: string[] = [];
  const byKey = new Map<string, Person>();
  const funnel: GatherFunnel = {
    sourceA: 0, sourceB: 0, sourceBNonProfile: 0, matched: 0, matchMisses: 0, inBoth: 0, afterMerge: 0,
  };

  // Source A: paged structured search.
  for (const { offset, limit } of people.searchPages(spec.max_results)) {
    const raw = await attempt(notes, `Source A (offset ${offset})`, () =>
      post<unknown>(people.SCRAPE_PATH, people.searchBody(spec, offset, limit), limit * people.CREDITS_PER_RECORD),
    );
    if (raw === null) break;
    const page = people.extractPeople(raw);
    funnel.sourceATotal ??= (raw as { data?: { alexandria?: { data?: { metadata?: { total?: number } } }[] } })
      .data?.alexandria?.[0]?.data?.metadata?.total;
    for (const rp of page) {
      const p = people.toPerson(rp, "A");
      if (p && !byKey.has(p.key)) {
        byKey.set(p.key, p);
        funnel.sourceA++;
      }
    }
    if (page.length < limit) break; // no more results
  }

  // Source B: site: web search. Collect unique profile URLs with all their snippets.
  const queries = web.buildQueries(spec);
  const webHits = new Map<string, WebHit[]>();
  for (const q of queries) {
    const raw = await attempt(notes, `Source B search`, () =>
      post<unknown>(web.SEARCH_PATH, web.searchBody(q), web.CREDITS_PER_SEARCH),
    );
    if (raw === null) continue;
    const { hits, nonProfile } = web.extractHits(raw);
    funnel.sourceBNonProfile += nonProfile;
    for (const h of hits) {
      const key = normaliseLinkedInUrl(h.url)!;
      const seen = webHits.get(key) ?? [];
      const dup = seen.some((s) => s.title === h.title && s.description === h.description);
      if (!dup) webHits.set(key, [...seen, h]);
    }
  }
  funnel.sourceB = webHits.size;

  // Merge B into A; anything new becomes a match candidate.
  const newKeys: string[] = [];
  for (const [key, hits] of webHits) {
    const existing = byKey.get(key);
    if (existing) {
      existing.web.push(...hits);
      existing.foundBy = ["A", "B"];
      funnel.inBoth++;
    } else {
      newKeys.push(key);
    }
  }

  // Match up to MAX_WEB_MATCHES new URLs. Skip people the snippet already places elsewhere;
  // prefer a snippet location in the area, then the city/country named anywhere, then an industry keyword.
  const priority = (key: string): number => {
    const hits = webHits.get(key)!;
    const text = hits.map((h) => `${h.title} ${h.description}`).join(" ");
    const loc = checkLocation(web.webOnlyPerson(key, hits), spec).result;
    if (loc === "drop") return -1;
    const folded = fold(text);
    return (
      (loc === "pass" ? MATCH_PRIORITY.snippetLocation : 0) +
      (areaNames(spec).some((n) => folded.includes(n)) ? MATCH_PRIORITY.mentionsArea : 0) +
      (mentionsAny(text, spec.industry_keywords) ? MATCH_PRIORITY.industryKeyword : 0)
    );
  };
  const ranked = newKeys.map((k) => ({ k, p: priority(k) })).filter((x) => x.p >= 0).sort((a, b) => b.p - a.p);
  const toMatch = new Set(ranked.slice(0, MAX_WEB_MATCHES).map((x) => x.k));

  // Highest priority first, so a budget stop cuts the least promising lookups.
  for (const key of [...toMatch, ...newKeys.filter((k) => !toMatch.has(k))]) {
    const hits = webHits.get(key)!;
    let person: Person | null = null;
    if (toMatch.has(key)) {
      const raw = await attempt(notes, `people/match ${key}`, () =>
        post<unknown>(people.SCRAPE_PATH, people.matchBody(`https://www.${key}`), people.CREDITS_PER_RECORD),
      );
      const rp = raw === null ? undefined : people.extractPeople(raw)[0];
      person = rp ? people.toPerson(rp, "B") : null;
      if (person) funnel.matched++;
      else if (raw !== null) funnel.matchMisses++;
    }
    if (person) {
      person.key = key; // keep the web URL's key so dedupe stays consistent
      person.web = hits;
      person.foundBy = ["B"];
    } else {
      person = web.webOnlyPerson(key, hits);
    }
    byKey.set(key, person);
  }

  funnel.afterMerge = byKey.size;
  return { people: [...byKey.values()], funnel, queries, notes };
}

export interface RunResult extends Gathered {
  scored: Scored[]; // every person, best first
  counts: { candidates: number; review: number; dropped: number };
  dropReasons: Record<string, number>; // reason category → count
  creditsUsed: number;
}

/** Collapses a drop reason to its category for counting, e.g. "location Berlin, Germany is not …" → "location". */
export function dropCategory(reason: string): string {
  if (reason.startsWith("location")) return "location outside the requested area";
  if (reason.startsWith("not recruiting")) return "current title is not recruiting";
  if (reason.startsWith("score")) return `score below ${REVIEW_MIN}`;
  return reason;
}

const STATUS_ORDER: Record<Status, number> = { Candidate: 0, Review: 1, Dropped: 2 };

export function rank(a: Scored, b: Scored): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    b.score - a.score ||
    (b.person.connections ?? -1) - (a.person.connections ?? -1)
  );
}

export async function run(spec: Spec, post: Post, credits: Credits, now = new Date()): Promise<RunResult> {
  const gathered = await gather(spec, post);
  const scored = gathered.people.map((p) => evaluate(p, spec, now)).sort(rank);
  const counts = { candidates: 0, review: 0, dropped: 0 };
  const dropReasons: Record<string, number> = {};
  for (const s of scored) {
    if (s.status === "Candidate") counts.candidates++;
    else if (s.status === "Review") counts.review++;
    else {
      counts.dropped++;
      const cat = dropCategory(s.dropReason ?? "unknown");
      dropReasons[cat] = (dropReasons[cat] ?? 0) + 1;
    }
  }
  return { ...gathered, scored, counts, dropReasons, creditsUsed: credits.used };
}

export const SUMMARY_TOP_N = 10;

/** One short reason per person for the chat table; the workbook has the full quoted evidence. */
export function oneLineReason(s: Scored, spec: Spec): string {
  const parts = [
    s.marketFit.points > 0 ? `${spec.industry} fit` : `no ${spec.industry} mention`,
    s.independent.points > 0 ? "independent" : "not clearly independent",
    s.experience.reason,
    ...s.notes,
  ];
  return parts.join(" · ");
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** Compact text block returned to Claude: file, funnel, credits, top 10. */
export function summaryText(spec: Spec, r: RunResult, file: string, budget: number): string {
  const f = r.funnel;
  const lines = [
    `Saved: ${file}`,
    "",
    "Funnel:",
    `- Source A (structured): ${f.sourceA} profiles${f.sourceATotal !== undefined ? ` (of ${f.sourceATotal} matching)` : ""}`,
    `- Source B (web search): ${f.sourceB} LinkedIn profiles from ${r.queries.length} queries`,
    `- In both: ${f.inBoth} · web profiles matched to full profiles: ${f.matched} (not found: ${f.matchMisses})`,
    `- After merge: ${f.afterMerge} → ${r.counts.candidates} Candidates / ${r.counts.review} Review / ${r.counts.dropped} dropped`,
  ];
  const drops = Object.entries(r.dropReasons);
  if (drops.length) lines.push(`- Dropped because: ${drops.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  lines.push("", `Credits used: ${r.creditsUsed} (budget ${budget}; cached calls are free)`);
  if (r.notes.length) lines.push("", "Notes:", ...r.notes.map((n) => `- ${n}`));

  const top = r.scored.filter((s) => s.status !== "Dropped").slice(0, SUMMARY_TOP_N);
  lines.push("", `Top ${top.length}:`, "", "| # | Name | Status | Score | Why | Profile |", "|---|---|---|---|---|---|");
  top.forEach((s, i) =>
    lines.push(`| ${i + 1} | ${cell(s.person.name)} | ${s.status} | ${s.score} | ${cell(oneLineReason(s, spec))} | ${encodeURI(s.person.profileUrl)} |`),
  );
  if (top.length === 0) lines.push("| – | No Candidates or Review results | | | | |");
  return lines.join("\n");
}
