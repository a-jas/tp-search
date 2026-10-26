import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceeded, createClient, Credits, FirecrawlError } from "../src/firecrawl.js";
import { extractPeople, toPerson } from "../src/people.js";
import { gather, MAX_WEB_MATCHES } from "../src/pipeline.js";
import { normaliseLinkedInUrl } from "../src/score.js";
import { buildQueries, extractHits, MAX_WEB_QUERIES, parseTitle, searchBody, snippetLocation } from "../src/websearch.js";
import { emptyPeople, fakePost, fixture, spec } from "./helpers.js";

describe("normaliseLinkedInUrl", () => {
  it.each([
    ["https://www.linkedin.com/in/Jane-Doe/", "linkedin.com/in/jane-doe"],
    ["http://linkedin.com/in/jane-doe?trk=abc#x", "linkedin.com/in/jane-doe"],
    ["https://uk.linkedin.com/in/jane-doe", "linkedin.com/in/jane-doe"],
    ["https://es.linkedin.com/in/jane-doe/uk", "linkedin.com/in/jane-doe"],
    ["linkedin.com/in/jane-doe", "linkedin.com/in/jane-doe"],
    ["https://pl.linkedin.com/in/%C5%82ukasz-k", "linkedin.com/in/łukasz-k"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseLinkedInUrl(input)).toBe(expected);
  });

  it.each(["https://www.linkedin.com/company/acme", "https://example.com/in/jane", "https://notlinkedin.com/in/x"])(
    "rejects %s",
    (input) => expect(normaliseLinkedInUrl(input)).toBeNull(),
  );
});

describe("source A parsing (real fixture shape)", () => {
  it("reads people from data.alexandria[0].data.people and maps fields", () => {
    const raw = extractPeople(fixture("people-search.json"));
    expect(raw).toHaveLength(6);
    const p = toPerson(raw[0]!, "A")!;
    expect(p.key).toBe("linkedin.com/in/person-a");
    expect(p.city).toBe("Warsaw");
    expect(p.currentTitle).toBe("Rekruter");
    expect(p.jobs.length).toBeGreaterThan(0);
    expect(p.jobs[0]!.start).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("never maps contact fields", () => {
    const p = toPerson({ ...extractPeople(fixture("people-search.json"))[0]!, emails: ["x@y.z"], phones: ["1"] } as any, "A");
    expect(JSON.stringify(p)).not.toMatch(/x@y\.z|"phones"|"emails"/);
  });
});

describe("source B", () => {
  it("keeps only linkedin.com/in/ URLs", () => {
    const raw = { data: { web: [
      { url: "https://pl.linkedin.com/in/a", title: "A - Recruiter", description: "" },
      { url: "https://www.linkedin.com/company/acme", title: "Acme", description: "" },
      { url: "https://example.com/team", title: "Team", description: "" },
    ] } };
    const { hits, nonProfile } = extractHits(raw);
    expect(hits.map((h) => h.url)).toEqual(["https://pl.linkedin.com/in/a"]);
    expect(nonProfile).toBe(2);
  });

  it("query uses the request's own titles (any language), one per industry keyword, max 3", () => {
    const paris = { ...spec, location: "Paris, France", industry_keywords: ["fintech", "paiements", "banque", "crypto"],
      title_keywords: ["freelance recruiter", "chasseur de têtes", "recruteur indépendant"] };
    const qs = buildQueries(paris);
    expect(qs).toHaveLength(MAX_WEB_QUERIES);
    expect(qs[1]).toBe('site:linkedin.com/in ("freelance recruiter" OR "chasseur de têtes" OR "recruteur indépendant") "paiements" "Paris"');
    expect(qs.every((q) => q.length <= 500)).toBe(true);
  });

  it("search body never asks for page content", () => {
    expect(searchBody("q")).not.toHaveProperty("scrapeOptions");
  });

  it.each([
    ["Freelance recruiter · Location: Olsztyn · 500+ connections on LinkedIn", "Olsztyn"],
    ["Experience: X · Location: Minsk ... Магистр Banking", "Minsk"],
    ["Lokalizacja: Warszawa · 500+ kontaktów", "Warszawa"],
    ["Fintech headhunter in Warsaw", undefined],
  ])("reads the snippet location from %s", (text, expected) => expect(snippetLocation(text)).toBe(expected));

  it("parses name and headline from a result title", () => {
    expect(parseTitle("Jane Doe - Fintech Headhunter | Acme - LinkedIn")).toEqual({
      name: "Jane Doe", headline: "Fintech Headhunter | Acme",
    });
  });

  it("never sends a result URL to /scrape: every scrape call is an Alexandria call", async () => {
    const { post, calls } = fakePost((path) => (path === "/v2/search" ? fixture("web-search.json") : emptyPeople));
    await gather(spec, post);
    const scrapes = calls.filter((c) => c.path === "/v2/scrape");
    expect(scrapes.length).toBeGreaterThan(0);
    for (const c of scrapes) {
      expect(c.body).toHaveProperty("alexandria");
      expect(c.body).not.toHaveProperty("url");
    }
    for (const c of calls.filter((c) => c.path === "/v2/search")) expect(c.body).not.toHaveProperty("scrapeOptions");
  });
});

describe("gather: merge + dedupe", () => {
  it("same person from A and B → one record found by both", async () => {
    const web = { data: { web: [
      { url: "https://pl.linkedin.com/in/person-a/", title: "Person A - Rekruter", description: "fintech recruiter in Warsaw" },
    ] } };
    const { post } = fakePost((path) => (path === "/v2/search" ? web : fixture("people-search.json")));
    const g = await gather(spec, post);
    const a = g.people.filter((p) => p.key === "linkedin.com/in/person-a");
    expect(a).toHaveLength(1);
    expect(a[0]!.foundBy).toEqual(["A", "B"]);
    expect(a[0]!.web).toHaveLength(1);
    expect(g.funnel.inBoth).toBe(1);
    expect(g.funnel.afterMerge).toBe(6);
  });

  it("matches at most MAX_WEB_MATCHES new URLs, keyword snippets first; the rest stay web-only", async () => {
    const { post, calls } = fakePost((path) => (path === "/v2/search" ? fixture("web-search.json") : emptyPeople));
    const g = await gather(spec, post);
    const matches = calls.filter((c) => c.body?.alexandria?.capability === "people/match");
    expect(matches).toHaveLength(MAX_WEB_MATCHES);
    // web-person-6 (a translator, no fintech mention) should not be among the first matched
    expect(matches.map((c) => c.body.alexandria.options.linkedin_url)).not.toContain("https://www.linkedin.com/in/web-person-6");
    expect(g.funnel.matchMisses).toBe(MAX_WEB_MATCHES);
    expect(g.people.every((p) => !p.structured && p.foundBy.join() === "B")).toBe(true);
    expect(g.funnel.sourceB).toBe(10);
  });

  it("spends lookups on likely-local people first and never on people the snippet places elsewhere", async () => {
    const hit = (h: string, description: string) => ({ url: `https://www.linkedin.com/in/${h}`, title: `${h} - Headhunter`, description });
    const web = { data: { web: [
      hit("abroad", "Fintech headhunter · Location: London"),               // placed elsewhere → never looked up
      hit("kw-only", "Fintech headhunter"),                                  // 1
      hit("mentions", "Headhunter, offices in Warsaw"),                      // 2
      hit("local", "Recruiter · Location: Warszawa"),                        // 4
      hit("local-kw", "Fintech recruiter · Location: Warsaw, Poland"),      // 4 + 2 + 1
      hit("plain", "Headhunter"),                                            // 0
    ] } };
    const { post, calls } = fakePost((path) => (path === "/v2/search" ? web : emptyPeople));
    await gather({ ...spec, industry_keywords: ["fintech", "payments"] }, post);
    const looked = [...new Set(calls.filter((c) => c.body?.alexandria?.capability === "people/match")
      .map((c) => c.body.alexandria.options.linkedin_url.split("/in/")[1]))];
    expect(looked).toEqual(["local-kw", "local", "mentions", "kw-only"]);
  });

  it("a successful match becomes a structured record keyed by the web URL", async () => {
    const one = fixture("people-search.json");
    one.data.alexandria[0].data.people = one.data.alexandria[0].data.people.slice(2, 3); // person-c
    const web = { data: { web: [{ url: "https://uk.linkedin.com/in/someone", title: "X - Headhunter", description: "fintech" }] } };
    const { post } = fakePost((path, body) =>
      path === "/v2/search" ? web : body.alexandria.capability === "people/match" ? one : emptyPeople,
    );
    const g = await gather(spec, post);
    expect(g.people).toHaveLength(1);
    expect(g.people[0]!.key).toBe("linkedin.com/in/someone");
    expect(g.people[0]!.structured).toBe(true);
    expect(g.funnel.matched).toBe(1);
  });
});

describe("firecrawl client", () => {
  const tmpCache = () => mkdtempSync(join(tmpdir(), "rf-cache-"));
  const okFetch = (json: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })) as unknown as typeof fetch;

  it("reads cost from data.creditsCost and caches: the second identical call is free and offline", async () => {
    const credits = new Credits(100);
    const fetchFn = okFetch(fixture("people-search.json"));
    const post = createClient({ apiKey: "k", credits, fetchFn, cacheDir: tmpCache() });
    await post("/v2/scrape", { a: 1 }, 30);
    await post("/v2/scrape", { a: 1 }, 30);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(credits.used).toBe(30);
  });

  it("budget guard stops before overspending", async () => {
    const credits = new Credits(35);
    const fetchFn = okFetch(fixture("people-search.json")); // costs 30
    const post = createClient({ apiKey: "k", credits, fetchFn, cacheDir: tmpCache() });
    await post("/v2/scrape", { page: 1 }, 30);
    await expect(post("/v2/scrape", { page: 2 }, 30)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(credits.used).toBe(30);
  });

  it("gather keeps partial results and reports a budget stop", async () => {
    const credits = new Credits(32);
    const fetchFn = vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).endsWith("/v2/search") ? fixture("web-search.json") : fixture("people-search.json"))),
    ) as unknown as typeof fetch;
    const post = createClient({ apiKey: "k", credits, fetchFn, cacheDir: tmpCache() });
    const g = await gather({ ...spec, max_results: 12 }, post);
    expect(g.funnel.sourceA).toBe(6); // page 2 would exceed the budget
    expect(g.notes.some((n) => n.includes("Budget stop"))).toBe(true);
    expect(credits.used).toBeLessThanOrEqual(32);
  });

  it("explains auth/provider errors instead of crashing", async () => {
    const fetchFn = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const post = createClient({ apiKey: "k", credits: new Credits(100), fetchFn, cacheDir: tmpCache() });
    await expect(post("/v2/scrape", {}, 5)).rejects.toThrow(/FullEnrich provider/);
    const g = await gather(spec, post);
    expect(g.notes.join("\n")).toMatch(/403/);
  });

  it("errors are not cached", async () => {
    const dir = tmpCache();
    const bad = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(createClient({ apiKey: "k", credits: new Credits(100), fetchFn: bad, cacheDir: dir })("/x", {}, 1))
      .rejects.toBeInstanceOf(FirecrawlError);
    const good = okFetch({ success: true, creditsUsed: 2 });
    await createClient({ apiKey: "k", credits: new Credits(100), fetchFn: good, cacheDir: dir })("/x", {}, 1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
