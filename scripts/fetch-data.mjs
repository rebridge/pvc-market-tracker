#!/usr/bin/env node
// Pulls every series listed in series.json from FRED and writes docs/data/*.json.
// No dependencies: Node 20+ only. Run: node scripts/fetch-data.mjs
//
// Design goals:
//  - Never wipe good data. If a pull fails, the previous file is kept and the
//    failure is recorded in manifest.json so the dashboard can say so.
//  - Files are stable and sorted so a re-run with no new observations
//    produces no git diff.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Both can be overridden for offline tests (see README).
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, "docs", "data");
const CONFIG = path.join(ROOT, "series.json");
const FRED_BASE = process.env.FRED_BASE || "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
const FRED_CSV = (id) => `${FRED_BASE}${encodeURIComponent(id)}`;
const TIMEOUT_MS = 30_000;

async function fetchCsv(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "pvc-market-tracker (github.com/rebridge/pvc-market-tracker)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// FRED CSV: header is "observation_date,<ID>" (older exports used "DATE").
// Missing values are a lone ".".
function parseFredCsv(text, id) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("empty CSV");
  const header = lines[0].split(",");
  if (header.length < 2 || !/date/i.test(header[0])) {
    throw new Error(`unexpected header: ${lines[0].slice(0, 80)}`);
  }
  const obs = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(",");
    if (!date || raw === undefined || raw === "." || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    obs.push([date, v]);
  }
  if (!obs.length) throw new Error(`no numeric observations for ${id}`);
  obs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return obs;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  await mkdir(OUT_DIR, { recursive: true });
  const now = new Date().toISOString();
  const previous = (await readJson(path.join(OUT_DIR, "manifest.json"))) ?? { series: [] };
  const prevById = new Map(previous.series.map((s) => [s.id, s]));

  const manifestSeries = [];
  let failures = 0;

  for (const s of config.series) {
    const file = path.join(OUT_DIR, `${s.id}.json`);
    const entry = { ...s, ok: false, updated: null, latestDate: null, latestValue: null, count: 0, error: null };
    try {
      const csv = await fetchCsv(FRED_CSV(s.id));
      const obs = parseFredCsv(csv, s.id);
      const payload = { ...s, updated: now, obs };
      // Keep the previous "updated" stamp if nothing changed, so the file is byte-stable.
      const prev = await readJson(file);
      if (prev && JSON.stringify(prev.obs) === JSON.stringify(obs)) payload.updated = prev.updated ?? now;
      await writeFile(file, JSON.stringify(payload) + "\n");
      const last = obs[obs.length - 1];
      Object.assign(entry, { ok: true, updated: payload.updated, latestDate: last[0], latestValue: last[1], count: obs.length });
      console.log(`ok    ${s.id.padEnd(18)} ${obs.length} obs, latest ${last[0]} = ${last[1]}`);
    } catch (err) {
      failures++;
      const prev = prevById.get(s.id);
      const kept = existsSync(file) && prev?.ok;
      Object.assign(entry, {
        ok: kept ? true : false,
        stale: kept ? true : undefined,
        updated: prev?.updated ?? null,
        latestDate: prev?.latestDate ?? null,
        latestValue: prev?.latestValue ?? null,
        count: prev?.count ?? 0,
        error: `${err.message}${kept ? " (kept previous data)" : ""}`,
      });
      console.error(`FAIL  ${s.id.padEnd(18)} ${entry.error}`);
    }
    manifestSeries.push(entry);
  }

  const manifest = {
    generated: now,
    generator: "scripts/fetch-data.mjs",
    series: manifestSeries,
  };
  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nmanifest written: ${manifestSeries.length} series, ${failures} failure(s)`);

  // Only fail the job if nothing at all could be fetched: one bad series should
  // not block the others from publishing.
  if (failures === config.series.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
