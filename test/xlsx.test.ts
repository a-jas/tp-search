import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { Credits } from "../src/firecrawl.js";
import { run, summaryText } from "../src/pipeline.js";
import { resultsPath, writeWorkbook } from "../src/xlsx.js";
import { fakePost, fixture, spec } from "./helpers.js";

const NOW = new Date("2026-10-25T10:00:00Z");

async function fixtureRun() {
  const { post } = fakePost((path, body) =>
    path === "/v2/search" ? fixture("web-search.json")
      : body.alexandria.capability === "people/match" ? { data: { alexandria: [{ data: { people: [] } }] } }
      : fixture("people-search.json"),
  );
  return run(spec, post, new Credits(100), NOW);
}

describe("workbook", () => {
  it("names the file results/YYYY-MM-DD_<industry>_<location>.xlsx", () => {
    expect(resultsPath({ ...spec, location: "Kraków, Poland" }, NOW, "/r")).toBe("/r/2026-10-25_fintech_krakow-poland.xlsx");
  });

  it("writes Results / Run report / Dropped with frozen headers, filters and links", async () => {
    const r = await fixtureRun();
    const file = await writeWorkbook(spec, r, NOW, mkdtempSync(join(tmpdir(), "rf-xlsx-")));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Results", "Run report", "Dropped"]);

    const res = wb.getWorksheet("Results")!;
    const headers = (res.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      "Name", "Status", "Score", "Status note", "Market fit reason", "Independent reason", "Experience reason",
      "Location", "Headline", "Connections", "Data", "Profile URL", "Found by", "Accept/Reject",
    ]);
    expect(res.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(res.autoFilter).toBeTruthy();
    expect(res.rowCount - 1).toBe(r.counts.candidates + r.counts.review);
    const link = res.getRow(2).getCell(12).value as { hyperlink: string };
    expect(link.hyperlink).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    // web-only people are labelled so they can be filtered out
    const data = res.getColumn(11).values.slice(2);
    expect(data).toContain("Web snippet only");

    const dropped = wb.getWorksheet("Dropped")!;
    expect(dropped.rowCount - 1).toBe(r.counts.dropped);
    for (let i = 2; i <= dropped.rowCount; i++) expect(String(dropped.getRow(i).getCell(2).value)).not.toBe("");

    const report = wb.getWorksheet("Run report")!;
    const items = report.getColumn(1).values.slice(2).map(String);
    expect(items).toEqual(expect.arrayContaining(["Inputs", "Credits used", "After merge", "Web query 1"]));
  });

  it("chat summary has the file, funnel, credits and a top-10 table without dropped people", async () => {
    const r = await fixtureRun();
    const text = summaryText(spec, r, "/x/file.xlsx", 100);
    expect(text).toContain("Saved: /x/file.xlsx");
    expect(text).toMatch(/After merge: \d+ → \d+ Candidates \/ \d+ Review \/ \d+ dropped/);
    expect(text).toContain("Credits used:");
    const rows = text.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.some((l) => l.includes("| Dropped |"))).toBe(false);
  });
});
