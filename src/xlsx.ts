import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { RESULTS_DIR } from "./paths.js";
import type { RunResult } from "./pipeline.js";
import type { Scored } from "./score.js";
import type { Spec } from "./spec.js";

const slug = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** results/YYYY-MM-DD_<industry>_<location>.xlsx */
export function resultsPath(spec: Spec, now: Date, dir = RESULTS_DIR): string {
  return join(dir, `${now.toISOString().slice(0, 10)}_${slug(spec.industry)}_${slug(spec.location)}.xlsx`);
}

export const dataLabel = (s: Scored) => (s.person.structured ? "Full profile" : "Web snippet only");

export const foundByLabel = (s: Scored) => (s.person.foundBy.length > 1 ? "both" : s.person.foundBy[0]!);

export function locationLabel(s: Scored): string {
  return [s.person.city, s.person.country].filter(Boolean).join(", ") || "unknown";
}

/** Status notes for the sheet, e.g. "insufficient data: no location (web snippet only)". */
export function statusNote(s: Scored): string {
  return s.notes.map((n) => (n.startsWith("insufficient data") && !s.person.structured ? `${n} (web snippet only)` : n)).join("; ");
}

const RESULT_COLUMNS: { header: string; width: number; value: (s: Scored) => string | number | null }[] = [
  { header: "Name", width: 26, value: (s) => s.person.name },
  { header: "Status", width: 11, value: (s) => s.status },
  { header: "Score", width: 7, value: (s) => s.score },
  { header: "Status note", width: 34, value: statusNote },
  { header: "Market fit reason", width: 50, value: (s) => `${s.marketFit.points} · ${s.marketFit.reason}` },
  { header: "Independent reason", width: 50, value: (s) => `${s.independent.points} · ${s.independent.reason}` },
  { header: "Experience reason", width: 40, value: (s) => `${s.experience.points} · ${s.experience.reason}` },
  { header: "Location", width: 20, value: locationLabel },
  { header: "Headline", width: 40, value: (s) => s.person.headline ?? "" },
  { header: "Connections", width: 12, value: (s) => s.person.connections ?? null },
  { header: "Data", width: 17, value: dataLabel },
  { header: "Profile URL", width: 38, value: (s) => s.person.profileUrl },
  { header: "Found by", width: 9, value: foundByLabel },
  { header: "Accept/Reject", width: 14, value: () => "" },
];

function styleHeader(ws: ExcelJS.Worksheet, columns: number): void {
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
}

export async function writeWorkbook(spec: Spec, r: RunResult, now: Date, dir = RESULTS_DIR): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.created = now;

  // 1. Results: Candidates and Review only (dropped people are counted in the Run report).
  const ws = wb.addWorksheet("Results");
  ws.columns = RESULT_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  const urlCol = RESULT_COLUMNS.findIndex((c) => c.header === "Profile URL") + 1;
  for (const s of r.scored.filter((s) => s.status !== "Dropped")) {
    const row = ws.addRow(RESULT_COLUMNS.map((c) => c.value(s)));
    row.getCell(urlCol).value = { text: s.person.profileUrl, hyperlink: encodeURI(s.person.profileUrl) };
    row.getCell(urlCol).font = { color: { argb: "FF0563C1" }, underline: true };
    row.alignment = { vertical: "top", wrapText: true };
  }
  styleHeader(ws, RESULT_COLUMNS.length);

  // 2. Run report
  const rep = wb.addWorksheet("Run report");
  rep.columns = [{ header: "Item", width: 34 }, { header: "Value", width: 110 }];
  const f = r.funnel;
  const rows: [string, string | number][] = [
    ["Timestamp", now.toISOString()],
    ["Inputs", JSON.stringify(spec, null, 2)],
    ...r.queries.map((q, i): [string, string] => [`Web query ${i + 1}`, q]),
    ["Source A: structured profiles", f.sourceA],
    ["Source A: total matches reported", f.sourceATotal ?? "unknown"],
    ["Source B: LinkedIn profiles", f.sourceB],
    ["Source B: non-profile results skipped", f.sourceBNonProfile],
    ["Found in both sources", f.inBoth],
    ["Web profiles matched to full profiles", f.matched],
    ["Web profiles not matched", f.matchMisses],
    ["After merge", f.afterMerge],
    ["Candidates", r.counts.candidates],
    ["Review", r.counts.review],
    ["Dropped", r.counts.dropped],
    ...Object.entries(r.dropReasons).map(([k, n]): [string, number] => [`Dropped: ${k}`, n]),
    ["Credits used", r.creditsUsed],
    ...r.notes.map((n): [string, string] => ["Note", n]),
  ];
  for (const row of rows) rep.addRow(row).alignment = { vertical: "top", wrapText: true };
  styleHeader(rep, 2);

  // 3. Dropped: every dropped person with the reason, for checking the filters.
  const dr = wb.addWorksheet("Dropped");
  dr.columns = [
    { header: "Name", width: 26 }, { header: "Reason", width: 60 }, { header: "Score", width: 7 },
    { header: "Headline", width: 40 }, { header: "Profile URL", width: 38 }, { header: "Found by", width: 9 },
  ];
  for (const s of r.scored.filter((s) => s.status === "Dropped")) {
    const row = dr.addRow([s.person.name, s.dropReason ?? "", s.score, s.person.headline ?? "", s.person.profileUrl, foundByLabel(s)]);
    row.getCell(5).value = { text: s.person.profileUrl, hyperlink: encodeURI(s.person.profileUrl) };
    row.getCell(5).font = { color: { argb: "FF0563C1" }, underline: true };
  }
  styleHeader(dr, 6);

  await mkdir(dir, { recursive: true });
  const file = resultsPath(spec, now, dir);
  await wb.xlsx.writeFile(file);
  return file;
}

/** Opens the workbook in the default app (Excel/Numbers) on macOS, unless OPEN_RESULTS=false. Never throws. */
export function openFile(file: string, log: (...args: unknown[]) => void): void {
  if (process.platform !== "darwin" || process.env.OPEN_RESULTS === "false") return;
  execFile("open", [file], (err) => {
    if (err) log(`could not open ${file}: ${err.message}`);
  });
}
