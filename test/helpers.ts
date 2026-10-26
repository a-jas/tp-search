import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Post } from "../src/firecrawl.js";
import type { Spec } from "../src/spec.js";

export const fixture = (name: string): any =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

export const spec: Spec = {
  industry: "fintech",
  industry_keywords: ["fintech", "payments", "banking"],
  location: "Warsaw, Poland",
  location_aliases: ["Warszawa", "Polska"],
  title_keywords: ["freelance recruiter", "independent recruiter", "headhunter", "rekruter"],
  independent_keywords: ["niezależny", "właściciel", "założyciel"],
  max_results: 6,
  dry_run: false,
};

export const emptyPeople = { success: true, data: { alexandria: [{ upstreamStatus: 200, data: { people: [] } }], creditsCost: 0 } };

export interface Call {
  path: string;
  body: any;
  estimate: number;
}

/** A fake `post` that records calls and answers from a router function. */
export function fakePost(route: (path: string, body: any) => unknown): { post: Post; calls: Call[] } {
  const calls: Call[] = [];
  const post = (async (path: string, body: unknown, estimate: number) => {
    calls.push({ path, body, estimate });
    return route(path, body);
  }) as Post;
  return { post, calls };
}
