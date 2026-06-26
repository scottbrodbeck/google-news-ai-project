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

## Quarterly archive
```bash
npm run archive                                   # last completed quarter
npx tsx --env-file=.dev.vars src/scripts/archive.ts --quarter 2026-Q2
npx tsx --env-file=.dev.vars src/scripts/archive.ts --sample 2026-06-26   # one ET day for Google QA
```
Produces `out/<label>.zip`, uploads to R2, and posts a download link to Slack + email. Download, unzip, drag the publication folders into the shared Drive folder. Schedule on the box ~5 days after each quarter ends (cron: `0 9 5 1,4,7,10 *`).

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
