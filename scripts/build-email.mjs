#!/usr/bin/env node
// Decides whether the latest data pull deserves an email, and writes it if so.
// No dependencies: Node 20+ only.
//
// An email goes out only when a MONTHLY series (the resin and pipe price indexes)
// gains a new month. Oil and gas change most weekdays, so mailing on those would
// be noise; their latest numbers ride along in the monthly email instead.
//
// Env:
//   PREV_MANIFEST  manifest.json from before this run's fetch (required to detect news)
//   DATA_DIR       folder with the fresh docs/data/*.json (default: docs/data)
//   EMAIL_DIR      where to write subject.txt, body.txt, body.html (default: ./email)
//   SITE_URL       dashboard link put in the email
//   FORCE=true     write an email even if nothing new (for "send a test email")
//   GITHUB_OUTPUT  set by Actions; receives send=true|false

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "docs", "data");
const EMAIL_DIR = process.env.EMAIL_DIR || path.join(process.cwd(), "email");
const SITE_URL = process.env.SITE_URL || "https://rebridge.github.io/pvc-market-tracker/";
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || "");

const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };
const toDate = (s) => new Date(s + "T00:00:00Z");
const fmtMonth = (s) => toDate(s).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtDay = (s) => toDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);
// Same wording as the dashboard's one-sentence readout.
const word = (p) => (p == null ? "unchanged" : p > 0.05 ? `up ${Math.abs(p).toFixed(1)}%` : p < -0.05 ? `down ${Math.abs(p).toFixed(1)}%` : "flat");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function valueOnOrBefore(obs, dateStr) {
  let v = null;
  for (const [d, x] of obs) { if (d <= dateStr) v = x; else break; }
  return v;
}

function fmtVal(v, s) {
  if (s.units.startsWith("$")) return `$${v.toFixed(2)}`;
  return v.toFixed(1);
}

async function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`${k}=${v}`);
}

async function main() {
  const prev = process.env.PREV_MANIFEST ? await readJson(process.env.PREV_MANIFEST) : null;
  const cur = await readJson(path.join(DATA_DIR, "manifest.json"));
  if (!cur) throw new Error(`no manifest in ${DATA_DIR}`);
  const prevById = new Map((prev?.series ?? []).map((s) => [s.id, s]));

  const fresh = cur.series.filter((s) => {
    if (s.freq !== "monthly" || !s.ok || s.stale || !s.latestDate) return false;
    const p = prevById.get(s.id);
    // No previous manifest (first ever run): stay quiet rather than mail history.
    return p?.latestDate ? s.latestDate > p.latestDate : false;
  });

  if (!fresh.length && !FORCE) {
    console.log("No new monthly data point; no email.");
    return setOutput("send", "false");
  }

  // Load full series so we can compare month-on-month and year-on-year.
  const all = [];
  for (const m of cur.series) {
    const f = await readJson(path.join(DATA_DIR, `${m.id}.json`));
    if (f?.obs?.length) all.push({ ...m, obs: f.obs });
  }
  const lines = all.map((s) => {
    const [d, v] = s.obs.at(-1);
    const last = toDate(d);
    const yearAgo = valueOnOrBefore(s.obs, `${last.getUTCFullYear() - 1}-${d.slice(5)}`);
    let prevV;
    if (s.freq === "monthly") prevV = s.obs.at(-2)?.[1] ?? null;
    else { const m = new Date(last); m.setUTCMonth(m.getUTCMonth() - 1); prevV = valueOnOrBefore(s.obs, m.toISOString().slice(0, 10)); }
    return {
      s, d, v, isNew: fresh.some((x) => x.id === s.id),
      when: s.freq === "monthly" ? fmtMonth(d) : fmtDay(d),
      yoy: word(pct(v, yearAgo)), mom: word(pct(v, prevV)),
    };
  });

  const resin = lines.find((l) => l.s.key === "resin") || lines.find((l) => l.s.freq === "monthly");
  const headline = resin
    ? `Resin prices are ${resin.yoy} from a year ago and ${resin.mom} from the month before.`
    : "The dashboard has new monthly data.";
  const subject = `${FORCE && !fresh.length ? "[Test] " : ""}Resin Watch: ${resin ? resin.when : "new"} numbers are in`;
  const ctx = (l) => (l.s.freq === "monthly" ? "from the month before" : "from a month ago");

  const text = [
    headline,
    "",
    ...lines.map((l) => `- ${l.s.label}${l.isNew ? " (new)" : ""}: ${fmtVal(l.v, l.s)} for ${l.when}, ${l.yoy} from a year ago, ${l.mom} ${ctx(l)}.`),
    "",
    `See the charts: ${SITE_URL}`,
    "",
    "Sources: U.S. Bureau of Labor Statistics and U.S. Energy Information Administration, via FRED.",
    "This email is sent automatically when a new month of the resin or pipe price index is published.",
    "Claude was used in the writing of this email.",
  ].join("\n");

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2433;max-width:560px">
<p style="font-size:17px;font-weight:bold">${esc(headline)}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
<tr style="text-align:left;border-bottom:1px solid #ccc"><th>Indicator</th><th>Latest</th><th>vs. year ago</th><th>vs. prior month</th></tr>
${lines.map((l) => `<tr style="border-bottom:1px solid #eee"><td>${esc(l.s.label)}${l.isNew ? " <b>(new)</b>" : ""}<br><small style="color:#667">${esc(l.when)}</small></td><td>${esc(fmtVal(l.v, l.s))}</td><td>${esc(l.yoy)}</td><td>${esc(l.mom)}</td></tr>`).join("\n")}
</table>
<p><a href="${esc(SITE_URL)}">Open the Resin Watch dashboard</a></p>
<p style="font-size:12px;color:#667">Sources: U.S. Bureau of Labor Statistics and U.S. Energy Information Administration, via FRED.<br>
This email is sent automatically when a new month of the resin or pipe price index is published.<br>
Claude was used in the writing of this email.</p>
</body></html>
`;

  await mkdir(EMAIL_DIR, { recursive: true });
  await writeFile(path.join(EMAIL_DIR, "subject.txt"), subject);
  await writeFile(path.join(EMAIL_DIR, "body.txt"), text + "\n");
  await writeFile(path.join(EMAIL_DIR, "body.html"), html);
  console.log(`Subject: ${subject}\n\n${text}`);
  await setOutput("send", "true");
  await setOutput("subject", subject.replace(/[\r\n]/g, " "));
}

main().catch((err) => { console.error(err); process.exit(1); });
