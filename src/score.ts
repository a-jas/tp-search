import type { Job, Person } from "./people.js";
import { parseLocation, type Spec } from "./spec.js";

// ── Thresholds and weights ──────────────────────────────────────────────────
export const CANDIDATE_MIN = 60; // score ≥ 60 → Candidate
export const REVIEW_MIN = 35; // 35–59 → Review; below → dropped

export const MARKET_FIT_MAX = 40;
export const INDEPENDENT_MAX = 35;
export const EXPERIENCE_MAX = 25;
// Years in recruiting roles → points; first matching row wins.
export const EXPERIENCE_STEPS = [
  { minYears: 5, points: 25 },
  { minYears: 2, points: 15 },
] as const;

// Fewer connections than this → "thin network", status at most Review.
export const THIN_NETWORK_BELOW = 300;

const EVIDENCE_CONTEXT_CHARS = 40; // characters shown either side of a match

// ── Vocabulary (edit freely; matched case-insensitively) ────────────────────
// Recruiting background: stems, so "rekrut" covers rekruter/rekrutacji/rekrutacja.
export const RECRUITING_TERMS = [
  "recruit", "rekrut", "headhunt", "head hunter", "talent acquisition", "talent partner",
  "sourcer", "sourcing", "executive search", "professional search", "talent search",
  "personalberat", "personalvermitt", "staffing",
];
// Independent: whole words. English base; local-language words come from spec.independent_keywords.
export const INDEPENDENT_TERMS = [
  "freelance", "freelancer", "independent", "self-employed", "self employed", "founder", "co-founder",
  "owner", "contract", "contractor", "ceo", "managing partner",
];

// ── Text matching ───────────────────────────────────────────────────────────
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Regex matching any term; `wholeWord` stops "owner" matching "downer". Letters include non-ASCII. */
export function termRegex(terms: string[], wholeWord: boolean): RegExp {
  const alts = terms.filter(Boolean).map(escape).join("|");
  return wholeWord ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu") : new RegExp(`(?:${alts})`, "iu");
}

export function recruitingRegex(spec: Spec): RegExp {
  return termRegex([...RECRUITING_TERMS, ...spec.title_keywords], false);
}

export interface Field {
  label: string;
  text: string | undefined;
}

/** First match across fields, as quotable evidence: `headline: "…Fintech Headhunter…"`. */
export function findEvidence(fields: Field[], re: RegExp): string | null {
  for (const { label, text } of fields) {
    if (!text) continue;
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - EVIDENCE_CONTEXT_CHARS);
    const end = Math.min(text.length, m.index + m[0].length + EVIDENCE_CONTEXT_CHARS);
    const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
    return `${label}: "${snippet}"`;
  }
  return null;
}

// ── URL normalisation ───────────────────────────────────────────────────────
/**
 * Normalised LinkedIn profile URL, the dedupe key: "linkedin.com/in/<handle>".
 * Lowercases; strips protocol, www./country subdomains (uk., pl.), query, hash, trailing slash
 * and anything after the handle (e.g. the "/uk" language suffix). Returns null if not a /in/ profile.
 */
export function normaliseLinkedInUrl(url: string): string | null {
  const m = url
    .trim()
    .toLowerCase()
    .match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^/?#\s]+)/);
  if (!m) return null;
  let handle = m[1]!;
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // keep the raw handle if it isn't valid percent-encoding
  }
  return `linkedin.com/in/${handle}`;
}

// ── Filters ─────────────────────────────────────────────────────────────────
export type FilterResult = { result: "pass"; reason: string } | { result: "drop"; reason: string } | { result: "missing"; reason: string };

/** Requested city and country plus aliases from the request (e.g. "Warszawa", "Polska"), folded for comparison. */
export function areaNames(spec: Spec): string[] {
  const want = parseLocation(spec.location);
  return [want.city, want.country, ...spec.location_aliases].map(fold).filter(Boolean);
}

export function checkLocation(p: Person, spec: Spec): FilterResult {
  const names = areaNames(spec);
  if (p.city || p.country) {
    const where = [p.city, p.country].filter(Boolean).join(", ");
    const inArea = [p.city, p.country].some((x) => x && names.includes(fold(x)));
    return inArea
      ? { result: "pass", reason: `lives in ${where}` }
      : { result: "drop", reason: `location ${where} is not ${spec.location}` };
  }
  if (p.locationText) {
    const text = fold(p.locationText);
    return names.some((n) => termRegex([n], true).test(text))
      ? { result: "pass", reason: `web snippet location: ${p.locationText}` }
      : { result: "drop", reason: `location ${p.locationText} (web snippet) is not ${spec.location}` };
  }
  return { result: "missing", reason: "insufficient data: no location" };
}

export function checkRecruiting(p: Person, spec: Spec): FilterResult {
  const fields = [
    { label: "current title", text: p.currentTitle },
    { label: "headline", text: p.headline },
  ];
  if (!fields.some((f) => f.text)) return { result: "missing", reason: "insufficient data: no title or headline" };
  const ev = findEvidence(fields, recruitingRegex(spec));
  return ev
    ? { result: "pass", reason: ev }
    : { result: "drop", reason: `not recruiting: "${p.currentTitle ?? p.headline}"` };
}

// ── Scoring ─────────────────────────────────────────────────────────────────
export interface Criterion {
  points: number;
  reason: string;
  evidence: string[]; // exact matched text; empty ⇒ points must be 0
}

const noEvidence = (reason: string): Criterion => ({ points: 0, reason, evidence: [] });

const webFields = (p: Person): Field[] =>
  p.web.flatMap((h) => [
    { label: "web result title", text: h.title },
    { label: "web result snippet", text: h.description },
  ]);

export function scoreMarketFit(p: Person, spec: Spec): Criterion {
  const fields: Field[] = [
    { label: "headline", text: p.headline },
    { label: "about", text: p.description },
    ...p.jobs.flatMap((j) => [
      { label: `job title (${j.company || "?"})`, text: j.title },
      { label: "company", text: j.company },
      { label: `${j.company || "company"} industry`, text: j.companyIndustry },
      { label: `job description (${j.company || "?"})`, text: j.description },
    ]),
    ...webFields(p),
  ];
  const ev = findEvidence(fields, termRegex(spec.industry_keywords, true));
  return ev ? { points: MARKET_FIT_MAX, reason: `mentions ${spec.industry}: ${ev}`, evidence: [ev] } : noEvidence(`no mention of ${spec.industry_keywords.join("/")}`);
}

export function scoreIndependent(p: Person, spec: Spec): Criterion {
  const fields: Field[] = [
    { label: "current title", text: p.currentTitle },
    { label: "current company", text: p.currentCompany },
    { label: "headline", text: p.headline },
    ...(p.structured ? [] : webFields(p)), // web-only people have nothing else
  ];
  const ev = findEvidence(fields, termRegex([...INDEPENDENT_TERMS, ...spec.independent_keywords], true));
  return ev ? { points: INDEPENDENT_MAX, reason: `independent: ${ev}`, evidence: [ev] } : noEvidence("no freelance/independent/owner signal");
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/** Years covered by recruiting jobs, overlapping periods counted once. Jobs without a start date are skipped. */
export function recruitingYears(jobs: Job[], re: RegExp, now: Date): { years: number; jobs: Job[] } {
  const matched = jobs.filter((j) => re.test(j.title) && j.start);
  const spans = matched
    .map((j) => [Date.parse(j.start!), j.end ? Date.parse(j.end) : now.getTime()] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [s, e] of spans) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return { years: total / MS_PER_YEAR, jobs: matched };
}

export function scoreExperience(p: Person, spec: Spec, now: Date): Criterion {
  if (p.jobs.length === 0) return noEvidence("no employment data");
  const { years, jobs } = recruitingYears(p.jobs, recruitingRegex(spec), now);
  if (jobs.length === 0) return noEvidence("no dated recruiting roles in employment history");
  const evidence = jobs.map((j) => `${j.title} @ ${j.company || "?"} (${j.start!.slice(0, 7)} – ${j.end ? j.end.slice(0, 7) : "now"})`);
  const step = EXPERIENCE_STEPS.find((s) => years >= s.minYears);
  const y = years.toFixed(1);
  return step
    ? { points: step.points, reason: `${y} yrs in recruiting roles`, evidence }
    : { points: 0, reason: `${y} yrs in recruiting roles (under ${EXPERIENCE_STEPS[EXPERIENCE_STEPS.length - 1]!.minYears})`, evidence };
}

// ── Status ──────────────────────────────────────────────────────────────────
export type Status = "Candidate" | "Review" | "Dropped";

export function classify(score: number): Status {
  if (score >= CANDIDATE_MIN) return "Candidate";
  if (score >= REVIEW_MIN) return "Review";
  return "Dropped";
}

export interface Scored {
  person: Person;
  location: FilterResult;
  recruiting: FilterResult;
  marketFit: Criterion;
  independent: Criterion;
  experience: Criterion;
  score: number;
  status: Status;
  notes: string[]; // why the status was capped/kept, e.g. "thin network (212)"
  dropReason?: string;
}

/**
 * Filters, then score, then status:
 * - a filter that fails on real data → Dropped with that reason
 * - a filter with missing data → never dropped, at most Review ("insufficient data")
 * - fewer than THIN_NETWORK_BELOW connections → at most Review ("thin network")
 */
export function evaluate(p: Person, spec: Spec, now: Date): Scored {
  const location = checkLocation(p, spec);
  const recruiting = checkRecruiting(p, spec);
  const marketFit = scoreMarketFit(p, spec);
  const independent = scoreIndependent(p, spec);
  const experience = scoreExperience(p, spec, now);
  const score = marketFit.points + independent.points + experience.points;
  const base = { person: p, location, recruiting, marketFit, independent, experience, score };

  const failed = [location, recruiting].find((f) => f.result === "drop");
  if (failed) return { ...base, status: "Dropped", notes: [], dropReason: failed.reason };

  let status = classify(score);
  const notes: string[] = [];
  const missing = [location, recruiting].filter((f) => f.result === "missing");
  if (missing.length > 0) {
    notes.push(...missing.map((f) => f.reason));
    status = "Review";
  }
  if (p.connections !== undefined && p.connections < THIN_NETWORK_BELOW) {
    notes.push(`thin network (${p.connections})`);
    if (status === "Candidate") status = "Review";
  }
  if (status === "Dropped") {
    return { ...base, status, notes, dropReason: `score ${score} below ${REVIEW_MIN}` };
  }
  return { ...base, status, notes };
}
