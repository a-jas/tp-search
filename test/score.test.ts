import { describe, expect, it } from "vitest";
import { Credits } from "../src/firecrawl.js";
import type { Job, Person } from "../src/people.js";
import { run } from "../src/pipeline.js";
import {
  CANDIDATE_MIN, checkLocation, checkRecruiting, classify, evaluate, EXPERIENCE_MAX, INDEPENDENT_MAX,
  MARKET_FIT_MAX, recruitingRegex, recruitingYears, REVIEW_MIN, scoreExperience, scoreIndependent,
  scoreMarketFit, THIN_NETWORK_BELOW,
} from "../src/score.js";
import { fakePost, fixture, spec } from "./helpers.js";

const NOW = new Date("2026-10-25T00:00:00Z");

const job = (title: string, start: string, end?: string, extra: Partial<Job> = {}): Job => ({
  title, company: "Acme", start, end, isCurrent: !end, ...extra,
});

const person = (over: Partial<Person> = {}): Person => ({
  key: "linkedin.com/in/x", profileUrl: "https://www.linkedin.com/in/x", name: "X",
  city: "Warsaw", country: "Poland", currentTitle: "Recruiter", jobs: [], structured: true, web: [], foundBy: ["A"],
  ...over,
});

describe("location filter", () => {
  it("passes on city", () => expect(checkLocation(person({ country: "Germany" }), spec).result).toBe("pass"));
  it("passes on country", () => expect(checkLocation(person({ city: "Kraków" }), spec).result).toBe("pass"));
  it("is case- and accent-insensitive", () =>
    expect(checkLocation(person({ city: "WARSAW", country: undefined }), spec).result).toBe("pass"));
  it("drops elsewhere, with a reason", () => {
    const r = checkLocation(person({ city: "London", country: "United Kingdom" }), spec);
    expect(r).toEqual({ result: "drop", reason: "location London, United Kingdom is not Warsaw, Poland" });
  });
  it("missing → missing (not drop)", () =>
    expect(checkLocation(person({ city: undefined, country: undefined }), spec).result).toBe("missing"));
  it("accepts local names from location_aliases", () =>
    expect(checkLocation(person({ city: "Warszawa", country: undefined }), spec).result).toBe("pass"));
  it("web snippet location in the area → pass; elsewhere → drop with reason", () => {
    const web = { city: undefined, country: undefined, structured: false };
    expect(checkLocation(person({ ...web, locationText: "Warszawa, mazowieckie" }), spec).result).toBe("pass");
    expect(checkLocation(person({ ...web, locationText: "Minsk" }), spec)).toEqual({
      result: "drop", reason: "location Minsk (web snippet) is not Warsaw, Poland",
    });
  });
});

describe("recruiting filter", () => {
  it("passes on an English title", () => expect(checkRecruiting(person({ currentTitle: "Senior Tech Recruiter" }), spec).result).toBe("pass"));
  it("passes on a Polish title", () => expect(checkRecruiting(person({ currentTitle: "Specjalista ds. Rekrutacji" }), spec).result).toBe("pass"));
  it("passes on headline when the title is not recruiting", () =>
    expect(checkRecruiting(person({ currentTitle: "Owner", headline: "Headhunter for fintech" }), spec).result).toBe("pass"));
  it("uses title_keywords too", () =>
    expect(checkRecruiting(person({ currentTitle: "Personaldienstleister" }), { ...spec, title_keywords: ["personaldienstleister"] }).result).toBe("pass"));
  it("recognises 'Executive & Professional Search'", () =>
    expect(checkRecruiting(person({ currentTitle: "Partner | Executive & Professional Search" }), spec).result).toBe("pass"));
  it("drops a non-recruiter with a reason", () =>
    expect(checkRecruiting(person({ currentTitle: "Accountant", headline: "Numbers" }), spec)).toEqual({
      result: "drop", reason: 'not recruiting: "Accountant"',
    }));
  it("missing → missing (not drop)", () =>
    expect(checkRecruiting(person({ currentTitle: undefined, headline: undefined }), spec).result).toBe("missing"));
});

describe("market fit", () => {
  it(`${MARKET_FIT_MAX} points with the matched text as evidence`, () => {
    const c = scoreMarketFit(person({ headline: "I place engineers in FinTech startups" }), spec);
    expect(c.points).toBe(MARKET_FIT_MAX);
    expect(c.evidence[0]).toContain("FinTech");
  });
  it("finds keywords in company industry and web snippets", () => {
    expect(scoreMarketFit(person({ jobs: [job("Recruiter", "2020-01-01", undefined, { companyIndustry: "Banking" })] }), spec).points).toBe(MARKET_FIT_MAX);
    expect(scoreMarketFit(person({ web: [{ url: "u", title: "t", description: "payments recruiter" }] }), spec).points).toBe(MARKET_FIT_MAX);
  });
  it("whole words only: 'banking' does not match 'bankingly'… nor 'payment' match 'payments'", () =>
    expect(scoreMarketFit(person({ headline: "unbankingly prepaymentsx" }), spec).points).toBe(0));
  it("no evidence ⇒ 0", () => {
    const c = scoreMarketFit(person({ headline: "Recruiter in retail" }), spec);
    expect(c).toMatchObject({ points: 0, evidence: [] });
  });
});

describe("independent", () => {
  it.each([
    ["Freelance Recruiter", "currentTitle"],
    ["Headhunter / CEO", "currentTitle"],
    ["Niezależny konsultant, rekruter", "currentTitle"], // from spec.independent_keywords
  ])("%s (%s) → full points", (text, field) => {
    expect(scoreIndependent(person({ [field]: text }), spec).points).toBe(INDEPENDENT_MAX);
  });
  it("local words come from the request, not a fixed list (French)", () => {
    const paris = { ...spec, location: "Paris, France", independent_keywords: ["indépendant", "fondateur", "à son compte"] };
    expect(scoreIndependent(person({ currentTitle: "Recruteur indépendant" }), paris).points).toBe(INDEPENDENT_MAX);
    expect(scoreIndependent(person({ headline: "Chasseur de têtes à son compte" }), paris).points).toBe(INDEPENDENT_MAX);
    // the Polish word is not built in: without it in the request, no points
    expect(scoreIndependent(person({ currentTitle: "Niezależny rekruter" }), paris).points).toBe(0);
  });
  it("whole words: 'Downer Group' is not 'owner'", () =>
    expect(scoreIndependent(person({ currentTitle: "Recruiter", currentCompany: "Downer Group" }), spec).points).toBe(0));
  it("uses web snippets only for web-only people", () => {
    const web = [{ url: "u", title: "X - Independent Recruiter", description: "" }];
    expect(scoreIndependent(person({ structured: false, currentTitle: undefined, web }), spec).points).toBe(INDEPENDENT_MAX);
    expect(scoreIndependent(person({ structured: true, web }), spec).points).toBe(0);
  });
  it("no evidence ⇒ 0", () => expect(scoreIndependent(person({ currentTitle: "Recruiter", currentCompany: "Bank" }), spec)).toMatchObject({ points: 0, evidence: [] }));
});

describe("experience", () => {
  const re = recruitingRegex(spec);
  it("counts overlapping recruiting roles once and ignores other roles", () => {
    const { years } = recruitingYears([
      job("Recruiter", "2020-01-01T00:00:00Z", "2022-01-01T00:00:00Z"),
      job("Sourcer", "2021-01-01T00:00:00Z", "2023-01-01T00:00:00Z"), // overlaps by 1 yr
      job("Accountant", "2010-01-01T00:00:00Z", "2019-01-01T00:00:00Z"),
    ], re, NOW);
    expect(years).toBeCloseTo(3, 1);
  });
  it.each([
    [1, 0], [2.5, 15], [6, EXPERIENCE_MAX],
  ])("%d years → %d points", (yrs, pts) => {
    const start = new Date(NOW.getTime() - yrs * 365.25 * 24 * 3600 * 1000).toISOString();
    expect(scoreExperience(person({ jobs: [job("Recruiter", start)] }), spec, NOW).points).toBe(pts);
  });
  it("evidence lists the roles with dates", () => {
    const c = scoreExperience(person({ jobs: [job("Rekruter", "2019-03-01T00:00:00Z")] }), spec, NOW);
    expect(c.evidence).toEqual(["Rekruter @ Acme (2019-03 – now)"]);
  });
  it("no employment data ⇒ 0", () =>
    expect(scoreExperience(person({ jobs: [] }), spec, NOW)).toEqual({ points: 0, reason: "no employment data", evidence: [] }));
});

describe("thresholds and status", () => {
  it.each([
    [CANDIDATE_MIN, "Candidate"], [CANDIDATE_MIN - 1, "Review"], [REVIEW_MIN, "Review"], [REVIEW_MIN - 1, "Dropped"],
  ] as const)("score %d → %s", (s, status) => expect(classify(s)).toBe(status));

  const strong = person({
    headline: "Freelance fintech recruiter",
    currentTitle: "Freelance Recruiter",
    connections: 900,
    jobs: [job("Freelance Recruiter", "2015-01-01T00:00:00Z")],
  });

  it("strong profile → Candidate with 100", () => {
    const s = evaluate(strong, spec, NOW);
    expect(s).toMatchObject({ score: 100, status: "Candidate", notes: [] });
  });
  it(`under ${THIN_NETWORK_BELOW} connections → at most Review, with a note`, () => {
    const s = evaluate({ ...strong, connections: 212 }, spec, NOW);
    expect(s).toMatchObject({ score: 100, status: "Review", notes: ["thin network (212)"] });
  });
  it("unknown connection count is not a thin network", () =>
    expect(evaluate({ ...strong, connections: undefined }, spec, NOW).status).toBe("Candidate"));
  it("missing location → Review even with a high score", () => {
    const s = evaluate({ ...strong, city: undefined, country: undefined }, spec, NOW);
    expect(s.status).toBe("Review");
    expect(s.notes).toContain("insufficient data: no location");
  });
  it("missing data is never dropped, even with a low score", () =>
    expect(evaluate(person({ city: undefined, country: undefined, currentTitle: "Recruiter" }), spec, NOW).status).toBe("Review"));
  it("failed filter → Dropped with the filter's reason", () => {
    const s = evaluate({ ...strong, city: "Berlin", country: "Germany" }, spec, NOW);
    expect(s).toMatchObject({ status: "Dropped", dropReason: "location Berlin, Germany is not Warsaw, Poland" });
  });
  it("low score → Dropped with the score as reason", () =>
    expect(evaluate(person({ currentTitle: "Recruiter" }), spec, NOW)).toMatchObject({ status: "Dropped", dropReason: `score 0 below ${REVIEW_MIN}` }));
});

describe("pipeline end to end on the fixtures (no network)", () => {
  it("every person has a status, a score that equals its parts, and a reason", async () => {
    const { post } = fakePost((path, body) =>
      path === "/v2/search" ? fixture("web-search.json")
        : body.alexandria.capability === "people/match" ? { data: { alexandria: [{ data: { people: [] } }] } }
        : fixture("people-search.json"),
    );
    const r = await run(spec, post, new Credits(100), NOW);
    expect(r.scored.length).toBe(r.funnel.afterMerge);
    expect(r.counts.candidates + r.counts.review + r.counts.dropped).toBe(r.scored.length);
    for (const s of r.scored) {
      expect(s.score).toBe(s.marketFit.points + s.independent.points + s.experience.points);
      for (const c of [s.marketFit, s.independent, s.experience]) {
        expect(c.reason.length).toBeGreaterThan(0);
        if (c.evidence.length === 0) expect(c.points).toBe(0);
      }
      if (s.status === "Dropped") expect(s.dropReason).toBeTruthy();
    }
    // Ranked: Candidates, then Review, then Dropped
    const order = r.scored.map((s) => s.status);
    expect([...order].sort((a, b) => ["Candidate", "Review", "Dropped"].indexOf(a) - ["Candidate", "Review", "Dropped"].indexOf(b))).toEqual(order);
  });
});
