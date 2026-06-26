/**
 * Quarterly archive generator (Node — run on the always-on Ubuntu box).
 *
 *   npx tsx --env-file=.dev.vars src/scripts/archive.ts --quarter 2026-Q2
 *   npx tsx --env-file=.dev.vars src/scripts/archive.ts            # last completed quarter
 *   npx tsx --env-file=.dev.vars src/scripts/archive.ts --sample 2026-06-26   # one ET day, for Google QA
 *
 * Output: per-publication, per-day, TEXT-ONLY RSS files (no images), foldered
 * Publication/YYYY/feed-YYYY-MM-DD.xml, zipped, copied to ./out, uploaded to R2,
 * and announced via Slack + email with a download link.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { zipSync } from "fflate";
import { AwsClient } from "aws4fetch";

import { fetchArticles } from "../lib/airtable";
import { buildFeed } from "../lib/render";
import { FIELD_NAMES, SITES_IN_SCOPE } from "../lib/config";
import { easternDayKey, easternYear, lastCompletedQuarter, parseQuarter, type Quarter } from "../lib/dates";
import { sendSlack, sendEmail } from "../lib/notify";
import type { ArticleRecord } from "../lib/types";

const env = process.env;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function siteQuarterFormula(site: string, q: Quarter): string {
  // Padded UTC window; exact ET-day filtering happens below in JS.
  return (
    "AND(" +
    `{${FIELD_NAMES.site}}='${site}',` +
    `IS_AFTER({${FIELD_NAMES.publicationTime}},DATETIME_PARSE('${q.fetchFromUTC}')),` +
    `IS_BEFORE({${FIELD_NAMES.publicationTime}},DATETIME_PARSE('${q.fetchToUTC}'))` +
    ")"
  );
}

interface DayGroup {
  site: string;
  day: string; // YYYY-MM-DD (ET)
  year: string;
  articles: ArticleRecord[];
}

async function collectGroups(q: Quarter, onlyDay?: string): Promise<DayGroup[]> {
  const groups = new Map<string, DayGroup>();
  for (const site of SITES_IN_SCOPE) {
    const rows = await fetchArticles({
      token: required("AIRTABLE_TOKEN"),
      filterByFormula: siteQuarterFormula(site, q),
      sortFieldId: undefined,
    });
    for (const a of rows) {
      if (!a.publicationTime) continue;
      const day = easternDayKey(a.publicationTime);
      if (onlyDay) {
        if (day !== onlyDay) continue;
      } else if (day < q.etStart || day > q.etEnd) {
        continue; // drop padded-window spillover
      }
      const key = `${site}|${day}`;
      let g = groups.get(key);
      if (!g) {
        g = { site, day, year: easternYear(a.publicationTime), articles: [] };
        groups.set(key, g);
      }
      g.articles.push(a);
    }
  }
  // newest-first within each day
  for (const g of groups.values()) {
    g.articles.sort((x, y) => (x.publicationTime < y.publicationTime ? 1 : -1));
  }
  return [...groups.values()].sort((a, b) => (a.site + a.day).localeCompare(b.site + b.day));
}

function buildFiles(groups: DayGroup[]): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  for (const g of groups) {
    const xml = buildFeed(
      g.articles,
      {
        title: `${g.site}`,
        link: `https://www.${g.site.toLowerCase()}.com/`,
        description: `${g.site} — archival feed for ${g.day}`,
      },
      { includeImages: false, emitTombstones: false } // archival: no multimedia; retracted articles omitted entirely
    );
    const bytes = enc.encode(xml);
    if (bytes.length > MAX_FILE_BYTES) {
      // Won't happen for these pubs; if it ever does, split into feed-YYYY-MM-DD_NN.xml.
      console.warn(`WARN ${g.site}/${g.day} is ${bytes.length} bytes (>50MB) — needs splitting.`);
    }
    files[`${g.site}/${g.year}/feed-${g.day}.xml`] = bytes;
  }
  return files;
}

async function uploadToR2(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET || "google-news-feed";
  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.warn("R2 credentials not set — skipping upload (local copy in ./out only).");
    return;
  }
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region: "auto", service: "s3" });
  const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const res = await aws.fetch(url, { method: "PUT", body, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error(`R2 upload ${res.status}: ${await res.text()}`);
}

async function deliver(q: Quarter, fileCount: number, zipBytes: Uint8Array, key: string): Promise<void> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const secret = env.FEED_SECRET;
  const link = base && secret ? `${base}/archive/${secret}/${key.replace(/^archive\//, "")}` : "(set PUBLIC_BASE_URL + FEED_SECRET for a link)";
  const sizeMB = (zipBytes.length / 1024 / 1024).toFixed(1);
  const summary = `Google News archive ready: ${q.label} — ${fileCount} day-files, ${sizeMB} MB.`;

  if (env.SLACK_WEBHOOK_URL) {
    await sendSlack(env.SLACK_WEBHOOK_URL, `${summary}\nDownload: ${link}\nThen unzip and drag the folders into the shared Google Drive folder.`);
  }
  if (env.RESEND_API_KEY && env.ARCHIVE_EMAIL_TO && env.ARCHIVE_EMAIL_FROM) {
    const small = zipBytes.length < 20 * 1024 * 1024;
    await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from: env.ARCHIVE_EMAIL_FROM,
      to: env.ARCHIVE_EMAIL_TO.split(",").map((s) => s.trim()),
      subject: `Google News archive — ${q.label}`,
      html: `<p>${summary}</p><p><a href="${link}">Download the zip</a>, unzip, and drag the publication folders into the shared <em>Google Licensed News</em> Drive folder.</p>`,
      attachment: small ? { filename: `${q.label}.zip`, content: Buffer.from(zipBytes).toString("base64") } : undefined,
    });
  }
  console.log(summary);
  console.log(`link: ${link}`);
}

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const sampleDay = arg("sample");
  const q = arg("quarter") ? parseQuarter(arg("quarter")!) : lastCompletedQuarter();

  console.log(`Building ${sampleDay ? `sample day ${sampleDay}` : `quarter ${q.label}`} (ET ${q.etStart}..${q.etEnd})`);
  const groups = await collectGroups(q, sampleDay);
  const files = buildFiles(groups);
  const fileNames = Object.keys(files);
  console.log(`Generated ${fileNames.length} files across ${SITES_IN_SCOPE.length} publications.`);

  const zipBytes = zipSync(files, { level: 6 });
  const label = sampleDay ? `${q.label}-sample-${sampleDay}` : q.label;

  await mkdir("out", { recursive: true });
  await writeFile(`out/${label}.zip`, zipBytes);
  console.log(`Wrote out/${label}.zip (${(zipBytes.length / 1024).toFixed(0)} KB)`);

  const key = `archive/${label}.zip`;
  await uploadToR2(key, zipBytes, "application/zip");
  await deliver(q, fileNames.length, zipBytes, key);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
