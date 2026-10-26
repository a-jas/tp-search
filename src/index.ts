#!/usr/bin/env node
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ENV_PATH } from "./paths.js";
import { createClient, Credits, maxCreditsPerRun } from "./firecrawl.js";
import { estimate, run, summaryText } from "./pipeline.js";
import { openFile, writeWorkbook } from "./xlsx.js";
import { SpecShape, withDefaults } from "./spec.js";

// stdout carries MCP protocol messages only; everything else goes to stderr.
config({ path: ENV_PATH, quiet: true });
const log = (...args: unknown[]) => console.error("[recruiter-finder]", ...args);

const DESCRIPTION = `Find freelance/independent recruiters in one industry and location who could become Talent Partners. Results are scored with transparent rules and saved to an .xlsx file.

How to use:
1. Translate the user's request into the inputs, in English AND the main language(s) of the requested location (e.g. French for Paris, Polish for Warsaw):
   - title_keywords: recruiter titles, freelance ones first (e.g. Paris → ["freelance recruiter","independent recruiter","headhunter","recruteur indépendant","chasseur de têtes","recruteur freelance"]). The first 6 also form the web query.
   - industry_keywords: 2–10 synonyms and sub-sectors in both languages (e.g. fintech → ["fintech","payments","banking","paiements","banque"]).
   - independent_keywords: local words for freelance/self-employed/owner/founder (e.g. French ["indépendant","indépendante","fondateur","fondatrice","gérant","à son compte"]). English ones are built in.
   - location: "City, Country" in English (e.g. "Warsaw, Poland", not "Warszawa, Polska").
   - location_aliases: local and other-language names of that city and country (e.g. ["Warszawa","Polska","Varsovie","Pologne"]).
2. Call with dry_run: true first. Show the user the estimated credits and the inputs, and wait for them to confirm.
3. Run again with dry_run: false. Show the user the summary and the top-rows table as returned, and give them the file path.
   The tool has already saved the full .xlsx workbook (and opened it on the user's Mac). Do not create or offer another spreadsheet, CSV or file from these results.

Never invent data: every score has a reason that quotes the profile text it is based on.`;

const server = new McpServer({ name: "recruiter-finder", version: "0.1.0" });

server.registerTool(
  "find_partners",
  { title: "Find Talent Partners", description: DESCRIPTION, inputSchema: SpecShape },
  async (input) => {
    try {
      const spec = withDefaults(input);
      const budget = maxCreditsPerRun();

      if (spec.dry_run) {
        const est = estimate(spec);
        const lines = [
          `Dry run: nothing was called. Estimated credits: up to ${est.total} (budget per run: ${budget})`,
          ...est.lines.map((l) => `- ${l}`),
        ];
        if (est.total > budget) lines.push(`Warning: the estimate exceeds the budget, so the run will stop early.`);
        lines.push("", "Validated input:", "```json", JSON.stringify(spec, null, 2), "```");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const now = new Date();
      const credits = new Credits(budget);
      const post = createClient({ apiKey: process.env.FIRECRAWL_API_KEY, credits, log });
      const result = await run(spec, post, credits, now);
      const file = await writeWorkbook(spec, result, now);
      log(`run done: ${result.creditsUsed} credits, saved ${file}`);
      openFile(file, log);
      return { content: [{ type: "text", text: summaryText(spec, result, file, budget) }] };
    } catch (err) {
      log("find_partners failed:", err);
      return { isError: true, content: [{ type: "text", text: `find_partners failed: ${(err as Error).message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
log("ready on stdio");
