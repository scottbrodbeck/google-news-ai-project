# Google News AI Pilot — Feed System

Fulfills Local News Now's Google News AI pilot requirements for **ARLnow, ALXnow, and FFXnow**:

1. **Live feed** — a private RSS endpoint Google crawls every couple of minutes (full text + images, last ~3 days, Google's custom namespaces). Served by a **Cloudflare Worker**, rebuilt to R2 on a 2-minute cron.
2. **Quarterly archive** — per-day, text-only XML files (no images), foldered by publication/year, zipped and pushed to the team via Slack + email link. A **Node script** (`src/scripts/archive.ts`), built to run on the always-on Ubuntu box.

Source of truth is the existing Airtable **News articles / O&O** base (`appZn7eNiJ4BO89G1`), maintained by Zapier — unchanged. See `google-news-ai-pilot-spec.md` for the full spec and rationale.

## Layout
```
src/lib/        portable TypeScript shared by Worker + script
  types.ts      ArticleRecord + Env
  config.ts     base/table/field IDs, site scope, genre rules
  dates.ts      RFC822, ISO8601(+00:00), Eastern-day bucketing, quarter math
  sanitize.ts   content:encoded HTML cleaner (htmlparser2)
  airtable.ts   typed REST fetch (filterByFormula, projection, pagination)
  render.ts     row -> RSS item; buildFeed(); tombstones
  notify.ts     Slack webhook + Resend email
src/worker/
  index.ts      fetch (serve live + archive links) + scheduled (live cron)
src/scripts/
  archive.ts    quarterly generator -> zip -> R2 -> Slack/email link
```

## Setup
```bash
npm install
cp .dev.vars.example .dev.vars   # fill in values
npm run typecheck
npm test                         # 28 rendering/spec-§10 checks; writes out/{live,archive}-sample.xml
```

### Secrets / vars
| Name | Used by | Notes |
|---|---|---|
| `AIRTABLE_TOKEN` | both | PAT, read-only, scoped to `appZn7eNiJ4BO89G1` |
| `FEED_PATH_TOKEN` | worker | random 32+ chars; part of the feed URL path |
| `FEED_SECRET` | both | random; required `?key=` on the feed + guards archive links |
| `SLACK_WEBHOOK_URL` | script | incoming webhook for archive notices |
| `RESEND_API_KEY` | script | archive email |
| `ARCHIVE_EMAIL_TO` / `ARCHIVE_EMAIL_FROM` | script | comma list / verified sender |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | script | R2 S3 API for uploading the zip |
| `PUBLIC_BASE_URL` | script | e.g. `https://feeds.lnn.co` — builds the download link |

For the Worker, set the first three with `wrangler secret put NAME`. The `[vars]` block in `wrangler.toml` holds non-secret config.

## Live feed
```bash
npm run dev        # local
npm run deploy     # production
```
- Create the R2 bucket first: `wrangler r2 bucket create google-news-feed`
- URL: `https://feeds.lnn.co/gn/<FEED_PATH_TOKEN>.xml?key=<FEED_SECRET>` (or the `*.workers.dev` URL until the custom domain is added).
- Submit that full URL (with `?key=`) to Google via the Contact Us form as a query-string API-key feed.

## Quarterly archive (cloud — GitHub Actions)
Runs entirely in the cloud via [.github/workflows/archive.yml](.github/workflows/archive.yml) — no local machine:
- **Trigger:** Zapier owns the schedule and fires the job via `repository_dispatch` (event type `archive`) — so there's no `schedule:` and GitHub's ~60-day auto-disable doesn't apply. The run posts status + link back to a Zapier Catch Hook, which fans out to Slack + email.
- **Manual / QA sample:** Actions tab → *Quarterly archive* → **Run workflow**, with an optional `quarter` (e.g. `2026-Q2`) or `sample` day (e.g. `2026-06-26`). Zapier can pass the same via `client_payload`.
- Each run uploads the zip to R2 (powers the Worker download link) **and** attaches it as a downloadable run artifact, so you always get the file from the cloud.

**GitHub Secrets** (Settings → Secrets and variables → Actions). Only `AIRTABLE_TOKEN` is required; the rest enable delivery and are skipped if unset:

| Secret | Needed for |
|---|---|
| `AIRTABLE_TOKEN` | **required** — read the O&O base |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | upload the zip to R2 — create an R2 API token in Cloudflare → R2 → *Manage API Tokens* |
| `PUBLIC_BASE_URL`, `FEED_SECRET` | build the `/archive/<FEED_SECRET>/…` download link the Worker serves |
| `ZAPIER_WEBHOOK_URL` | Zapier Catch Hook URL — the run POSTs `{status, link, quarter, fileCount, sizeMB, run_url}` here; Zapier sends Slack + email |

### Triggering from Zapier
Two tiny Zaps:

**Zap 1 — start the job (quarterly).** *Schedule by Zapier* (monthly, day 5) → *Filter* (only continue if the month is January / April / July / October) → *Code by Zapier (Run JavaScript)*. Set the step's **Input Data**: `token` = a GitHub PAT with **Contents: Read and write** on this repo, `owner` = `scottbrodbeck`, `repo` = `google-news-ai-project`, optional `sample` / `quarter`.

```js
const { token, owner, repo, sample, quarter } = inputData;
const client_payload = {};
if (sample) client_payload.sample = sample;       // e.g. 2026-06-26 (QA day)
if (quarter) client_payload.quarter = quarter;    // e.g. 2026-Q2

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "zapier-archive-trigger",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ event_type: "archive", client_payload }),
});
if (res.status !== 204) throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
output = { triggered: true };
```

**Zap 2 — handle the result.** *Webhooks by Zapier → Catch Hook* → Slack + Email. Paste that Catch Hook URL into the **`ZAPIER_WEBHOOK_URL`** GitHub secret; every run POSTs its status + download link there when it finishes (success *or* failure).

### Run it manually / locally (optional)
```bash
npm run archive                              # last completed quarter
npm run archive -- --quarter 2026-Q2
npm run archive -- --sample 2026-06-26       # one ET day for Google QA
```
Reads env from `.dev.vars` if present, else the process env. Only `AIRTABLE_TOKEN` is required to write `out/<label>.zip`; R2/Slack/Resend are optional. The one human step each quarter: download the zip and drop the folders into the shared Drive folder (removable later via the optional Drive service-account upload).

## robots.txt (do on each site, by you)
On **arlnow.com, alxnow.com, ffxnow.com** ensure Google-Extended isn't blocked:
```
User-agent: Google-Extended
Allow: /
```
On the feed host (`feeds.lnn.co`): `User-agent: * / Disallow: /` to keep the private feed undiscovered.

## Before going live
1. ~~Add the `Delete from Google Feed` checkbox and set its field ID in `config.ts`~~ — done (`fldDA1Dg18waeRqeJ`, verified in the live base).
2. **(Recommended, Airtable)** Add `Delete from Google Feed` to the `Last Updated` field's watched fields so checking the box on an *old* article still fires a tombstone. See CLAUDE.md → "Deletions / tombstones" for why. Tombstones for recently-published articles already work without this.
3. **Cloudflare:** `wrangler r2 bucket create google-news-feed`, then set Worker secrets (`AIRTABLE_TOKEN`, `FEED_PATH_TOKEN`, `FEED_SECRET`) with `wrangler secret put NAME`, then `npm run deploy`. Generate the two tokens with `openssl rand -hex 32`.
4. Validate (`npm test`), generate a sample archival day (`--sample`), upload it to Drive's sample folder, await Google QA.
5. Submit the feed URL + `?key=` via Google's Contact Us form and add teammates to the Google thread.
6. **robots.txt** on the three sites (Google-Extended `Allow: /`) and on the feed host (`Disallow: /`) — see above.
