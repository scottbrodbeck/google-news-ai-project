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
- **Schedule:** `0 9 5 1,4,7,10 *` (09:00 UTC, the 5th of Jan/Apr/Jul/Oct) → generates the just-ended quarter.
- **Manual / QA sample:** Actions tab → *Quarterly archive* → **Run workflow**, with an optional `quarter` (e.g. `2026-Q2`) or `sample` day (e.g. `2026-06-26`).
- Each run uploads the zip to R2 (powers the Worker download link) **and** attaches it as a downloadable run artifact, so you always get the file from the cloud.

**GitHub Secrets** (Settings → Secrets and variables → Actions). Only `AIRTABLE_TOKEN` is required; the rest enable delivery and are skipped if unset:

| Secret | Needed for |
|---|---|
| `AIRTABLE_TOKEN` | **required** — read the O&O base |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | upload the zip to R2 — create an R2 API token in Cloudflare → R2 → *Manage API Tokens* |
| `PUBLIC_BASE_URL`, `FEED_SECRET` | build the `/archive/<FEED_SECRET>/…` download link the Worker serves |
| `SLACK_WEBHOOK_URL` | Slack notice |
| `RESEND_API_KEY`, `ARCHIVE_EMAIL_TO`, `ARCHIVE_EMAIL_FROM` | email notice |

> ⚠️ GitHub auto-disables scheduled workflows after ~60 days of no repo activity, which a quarterly cadence can trip. GitHub emails first and you re-enable in one click; for fully hands-off reliability, trigger it from the Worker's cron via `repository_dispatch` (see CLAUDE.md).

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
