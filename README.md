# Recruiter Finder

A local MCP server for Claude Desktop. Give it an industry and a location, and it finds freelance and independent recruiters who could become Talent Partners. It scores each person with simple, transparent rules, shows the top results in the chat and saves everything to an `.xlsx` file.

## 1. Install and build

```bash
npm install
npm run build
npm test        # offline: uses saved fixtures, never the network
```

## 2. API key

```bash
cp .env.example .env
```

Put your Firecrawl key in `.env` (`FIRECRAWL_API_KEY=fc-…`).
- `MAX_CREDITS_PER_RUN` (default 100) is the most one run may spend.
- `OPEN_RESULTS` (default true) opens the workbook in Excel or Numbers after each run on macOS. Set it to `false` to turn that off.

People data comes from **FullEnrich through Firecrawl Alexandria**. If a run reports a 403 error, open the FullEnrich page in the Firecrawl dashboard (https://firecrawl.dev/app/alexandria/fullenrich) and accept or enable the provider.

## 3. Connect to Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, next to any keys already there:

```json
{
  "mcpServers": {
    "recruiter-finder": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/aniaj/Work/techtree/recruiter-finder/dist/index.js"]
    }
  }
}
```

Use the absolute paths from `which node` and from this folder. Claude Desktop doesn't load your shell's PATH. Then **fully quit Claude Desktop (Cmd-Q) and reopen it**. Do the same after every `npm run build`.

**Logs:**
- Claude Desktop: `~/Library/Logs/Claude/mcp-server-recruiter-finder.log`
- MCP Inspector: run `npm run inspect` to call the tool by hand in your browser.

## 4. Example prompt

> Find freelance fintech recruiters in Warsaw, Poland. Do a dry run first.

Claude fills in the inputs in English and the local language:
- recruiter titles
- industry words
- freelance or owner words
- local names for the place, e.g. "Warszawa", "Polska"

It runs `dry_run: true` and shows you the estimated cost. Once you confirm, it runs for real, shows the summary and the top 10, and gives you the path to `results/YYYY-MM-DD_<industry>_<location>.xlsx`. The workbook also opens automatically.

The chat shows only the summary and the top 10. Claude Desktop can't display a local Excel file inside the chat, so the full results are in the workbook. If Claude offers to "create a spreadsheet", you don't need it.

The workbook has three sheets:
- **Results:** Candidates and Review, with a reason for each score, connections, whether it's a full profile or a web snippet only, and an empty Accept/Reject column.
- **Run report:** inputs, web queries, funnel counts, drop reasons, credits and notes.
- **Dropped:** every dropped person with the reason.

## 5. Cost

A default run (`max_results` 12) costs **up to about 86 credits**:

| Step | Credits |
|---|---|
| Structured search: 12 profiles × 5 | 60 |
| Web search: 3 queries × 2 | 6 |
| Full-profile lookup for up to 4 new web results × 5 (misses are free) | 20 |

Every response is saved in `.cache/`, keyed by the exact request, so **re-running the same search costs 0**. Before each paid call, the tool checks it against `MAX_CREDITS_PER_RUN`. If a call would go over, the tool stops, keeps what it has and says so. The free plan has 1,000 credits a month.

## 6. Design decisions and limits

- **Two sources:**
  - **Structured profiles (A)** provide reliable fields: location, current title and company, dated job history, connection count. A title search alone mostly returns in-house recruiters, though.
  - **Web search (B)** with `site:linkedin.com/in` queries finds people who describe themselves ("freelance fintech headhunter") in ways title filters miss. It's noisier: many results are elsewhere and only mention the city.
  - Up to 4 new web results are turned into full profiles. People whose snippet already places them elsewhere are skipped. The rest are ranked: snippet location in the area first, then any mention of the city or country, then an industry keyword.
- **Claude plans, code decides:** Claude turns your request into inputs, including translations. Everything that affects a decision is deterministic code with named constants in `src/score.ts`, so every result can be explained and repeated.
- **Scoring (0–100):**
  - **Market fit (40):** an industry keyword appears in the profile or snippet.
  - **Independent (35):** freelance, owner, founder or similar in the current title, company or headline.
  - **Experience (25):** years in recruiting roles. 2+ years = 15, 5+ = 25.
  - **No evidence means 0 points**, and every reason quotes the text it matched.
  - **Status:** ≥60 Candidate, 35–59 Review, below 35 dropped.
- **Missing data isn't failure:** if a filter's data is missing (for example, a web-only person has no location), the person goes to Review with "insufficient data", never dropped.
- **Location for web-only people:** taken from the snippet's "Location: …" text when there is one, which is about 1 in 7 snippets. A city with no country (e.g. "Olsztyn") can only match the requested city or its aliases.
- **Connections:** used only as a warning. Under 300 means "thin network", and that person can be Review at most. They aren't scored, because a big network says little about recruiting quality. Only full profiles have a count.
- **No LinkedIn scraping:** the tool never fetches LinkedIn pages. From web search it uses only the result URL, title and snippet given by the search engine. It never calls `/scrape` on a result. Emails and phone numbers are never requested or output.
- **Local languages:** titles, industry words, freelance/owner words and place-name aliases all come from the request, so a Paris search uses French. The main location is written in English, because the structured data uses English place names.
- **What v2 would add:**
  - evals on a labelled set (precision, recall, false positives)
  - more query variants and better location extraction from web snippets
  - a compliance check (GDPR basis, opt-out list) before any outreach
