import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./paths.js";

export const API_BASE = "https://api.firecrawl.dev";
export const MAX_CREDITS_PER_RUN_DEFAULT = 100;

export function maxCreditsPerRun(): number {
  const n = Number(process.env.MAX_CREDITS_PER_RUN);
  return Number.isFinite(n) && n > 0 ? n : MAX_CREDITS_PER_RUN_DEFAULT;
}

/** Cache key = hash of endpoint path + request body, so identical requests are free on re-run. */
export function cacheKey(path: string, body: unknown): string {
  return createHash("sha256").update(path).update(JSON.stringify(body)).digest("hex").slice(0, 32);
}

export function cachePath(path: string, body: unknown, dir = CACHE_DIR): string {
  return join(dir, `${cacheKey(path, body)}.json`);
}

export function isCached(path: string, body: unknown, dir = CACHE_DIR): boolean {
  return existsSync(cachePath(path, body, dir));
}

export class BudgetExceeded extends Error {
  constructor(public readonly needed: number, public readonly used: number, public readonly max: number) {
    super(`Budget stop: the next call could cost ${needed} credits, but ${used} of ${max} are already used.`);
  }
}

export class FirecrawlError extends Error {}

/** Credits spent in one run. The guard runs before every uncached call, using the worst-case cost. */
export class Credits {
  used = 0;
  constructor(public readonly max: number) {}
  check(estimate: number): void {
    if (this.used + estimate > this.max) throw new BudgetExceeded(estimate, this.used, this.max);
  }
  add(n: number): void {
    this.used += n;
  }
}

export interface ClientOptions {
  apiKey: string | undefined;
  credits: Credits;
  fetchFn?: typeof fetch;
  cacheDir?: string;
  log?: (...args: unknown[]) => void;
}

export type Post = <T>(path: string, body: unknown, estimate: number) => Promise<T>;

export function createClient(opts: ClientOptions): Post {
  const { apiKey, credits, fetchFn = fetch, cacheDir = CACHE_DIR, log = () => {} } = opts;

  return async function post<T>(path: string, body: unknown, estimate: number): Promise<T> {
    const file = cachePath(path, body, cacheDir);
    if (existsSync(file)) {
      log(`cache hit ${path}`);
      return JSON.parse(await readFile(file, "utf8")) as T;
    }

    credits.check(estimate);
    if (!apiKey) throw new FirecrawlError("FIRECRAWL_API_KEY is not set. Add it to the .env file in the project folder.");

    const res = await fetchFn(API_BASE + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FirecrawlError(describeHttpError(res.status, text));

    const json = JSON.parse(text) as {
      success?: boolean;
      error?: string;
      creditsUsed?: number; // /v2/search
      data?: { creditsCost?: number }; // /v2/scrape with alexandria
    };
    if (json.success === false) throw new FirecrawlError(`Firecrawl returned an error: ${json.error ?? text.slice(0, 300)}`);

    const cost = json.data?.creditsCost ?? json.creditsUsed ?? estimate;
    credits.add(cost);
    log(`${path} cost ${cost} credits (run total ${credits.used})`);

    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, text);
    return json as T;
  };
}

export function describeHttpError(status: number, body: string): string {
  const detail = body.slice(0, 300);
  switch (status) {
    case 401:
      return `Firecrawl rejected the API key (401). Check FIRECRAWL_API_KEY in .env. ${detail}`;
    case 402:
      return `Firecrawl says the account is out of credits (402). ${detail}`;
    case 403:
      return `Firecrawl refused access (403). The FullEnrich provider may need to be accepted in the Firecrawl dashboard. ${detail}`;
    case 429:
      return `Firecrawl rate limit hit (429). Wait a minute and retry; cached calls are free. ${detail}`;
    default:
      return `Firecrawl HTTP ${status}: ${detail}`;
  }
}
