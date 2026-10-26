# Recruiter Finder: notes for future sessions

A local stdio MCP server for Claude Desktop with one tool, `find_partners`. See README.md for setup, cost and design decisions.

## Conventions
- Small pure functions. I/O happens only in `src/firecrawl.ts` (network + cache) and `src/xlsx.ts` (workbook). `people.ts` and `websearch.ts` only build requests and parse responses.
- Every number that affects a decision is a named constant, mostly at the top of `src/score.ts`.
- Every dropped or scored person has a human-readable reason. Every criterion returns `{ points, reason, evidence }`, and no evidence means 0 points.
- Don't add dependencies, abstractions or features beyond the brief without asking.

## Gotchas
- stdout is reserved for MCP protocol messages. Log only to stderr (`console.error`).
- Resolve files from `src/paths.ts` (`ROOT`), never `process.cwd()`. Claude Desktop starts the server from an unpredictable directory.
- Credits are scarce. Every call goes through the file cache in `.cache/`. Tests use `test/fixtures/` and a fake `post` or `fetch`, and never call the network.
- Never fetch or scrape LinkedIn. Source B uses only the search result's url, title and description, and never sends `scrapeOptions`. Never request or output emails or phone numbers.
- Real response shapes, from the Oct 2026 fixtures:
  - FullEnrich people are at `data.alexandria[0].data.people`. The cost is at `data.creditsCost`.
  - The LinkedIn URL is at `social_profiles.professional_network.url`. Connections are at `.connection_count`.
  - Web search results are at `data.web[]`. The cost is at `creditsUsed`.
- LinkedIn URLs show up as `uk.linkedin.com/in/x` and `linkedin.com/in/x/uk`. Always dedupe on `normaliseLinkedInUrl`.
- Language-specific words (titles, industry, independent) come from the request. Don't hard-code languages.
- After `npm run build`, fully quit and reopen Claude Desktop (Cmd-Q) to pick up changes.
