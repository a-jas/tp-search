import { z } from "zod";

export const MAX_RESULTS_DEFAULT = 12;
export const MAX_RESULTS_HARD = 24;

const nonEmpty = (what: string) => z.string().trim().min(1, `${what} must not be empty`);

// Raw shape (not z.object) so the MCP SDK can publish it as the tool's JSON schema.
export const SpecShape = {
  industry: nonEmpty("industry").describe('Industry to search, e.g. "fintech"'),
  industry_keywords: z
    .array(nonEmpty("industry keyword"))
    .min(2, "industry_keywords needs at least 2 keywords")
    .max(10, "industry_keywords allows at most 10 keywords")
    .describe('2–10 keywords for the industry, e.g. ["fintech","payments","banking"]'),
  location: nonEmpty("location").describe('"City, Country" in English, e.g. "Warsaw, Poland" (not "Warszawa, Polska")'),
  location_aliases: z
    .array(nonEmpty("location alias"))
    .max(10, "location_aliases allows at most 10 names")
    .optional()
    .describe('Other names for the city/country as they may appear on profiles, e.g. ["Warszawa","Polska","Varsovie"]'),
  title_keywords: z
    .array(nonEmpty("title keyword"))
    .min(1, "title_keywords needs at least 1 title")
    .describe('Recruiter titles in English and the local language, freelance ones first, e.g. ["freelance recruiter","independent recruiter","headhunter","recruteur indépendant","chasseur de têtes"]'),
  independent_keywords: z
    .array(nonEmpty("independent keyword"))
    .max(20, "independent_keywords allows at most 20 words")
    .optional()
    .describe('Local-language words for freelance/self-employed/owner/founder, e.g. French ["indépendant","fondateur","gérant","à son compte"]. English is built in.'),
  max_results: z
    .number()
    .int("max_results must be a whole number")
    .min(1, "max_results must be at least 1")
    .max(MAX_RESULTS_HARD, `max_results is capped at ${MAX_RESULTS_HARD}`)
    .optional()
    .describe(`Structured profiles to fetch (default ${MAX_RESULTS_DEFAULT}, max ${MAX_RESULTS_HARD})`),
  dry_run: z
    .boolean()
    .optional()
    .describe("true = return the estimated credit cost and call nothing"),
};

export const SpecSchema = z.object(SpecShape);
export type SpecInput = z.infer<typeof SpecSchema>;
export type Spec = Required<SpecInput>;

export function withDefaults(input: SpecInput): Spec {
  return {
    ...input,
    independent_keywords: input.independent_keywords ?? [],
    location_aliases: input.location_aliases ?? [],
    max_results: input.max_results ?? MAX_RESULTS_DEFAULT,
    dry_run: input.dry_run ?? false,
  };
}

/** "Warsaw, Poland" → { city: "Warsaw", country: "Poland" }. A single part is treated as both. */
export function parseLocation(location: string): { city: string; country: string } {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  return { city: parts[0] ?? location, country: parts[parts.length - 1] ?? location };
}
