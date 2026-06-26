# CLAUDE.md — working notes for this repo

Context for finishing/maintaining the Google News AI pilot feed system. Read alongside `google-news-ai-pilot-spec.md` (the authoritative spec).

## What this is
Two jobs, one codebase, sharing `src/lib/`:
- **Live feed** → Cloudflare Worker (`src/worker/index.ts`): serves a private RSS endpoint Google crawls every couple of minutes, rebuilt to R2 on a `*/2` cron.
- **Quarterly archive** → Node script (`src/scripts/archive.ts`), meant to run on the always-on Ubuntu box (heavier than a Worker cron is comfortable with).

Data source: Airtable `News articles` / `O&O` (`appZn7eNiJ4BO89G1` / `tblrMZhmQKluhERnP`), maintained by Zapier. **Read-only — never write to it.**

## Hard rules from Google's spec (don't "fix" these)
- **Only these four namespaces**, exactly: `content`, `dcterms`, `licensed_news`, `media`. Do **not** add `atom:` (no self-link) or `dc:`.
- Use `<dcterms:creator>` (open AND close), never `dc:creator`. Google's own example file has a bug here (`<dcterms:creator>…</dc:creator>` + a stray `dc` namespace) — do not copy it.
- `content:encoded` is **article text only**: CDATA-wrapped HTML with **no `<img>`, `<script>`, `<iframe>`, or embeds**. `sanitize.ts` enforces this.
- `media:content`/`media:title` appear in the **live feed only**. The **archive excludes all multimedia** (`includeImages: false`). Google's sample file shows media even in an "archival" file — that's template residue; ignore it.
- `media:title` is emitted only when a photo caption exists.
- `pubDate` = RFC822; `dcterms:modified` = ISO 8601 with `+00:00` offset (to match Google's example), not `Z`.
- Article `link` is the canonical URL (already correct in Airtable) and doubles as `guid`. No custom query params (UTM is allowed).
- Each live-feed fetch must be < 50 MiB (asserted in `buildLive`). Each archive day-file < 50 MB (warns; split as `feed-YYYY-MM-DD_NN.xml` if ever exceeded).

## Field mapping
All field IDs live in `src/lib/config.ts`, including `FIELD_IDS.deleteFromFeed = "fldDA1Dg18waeRqeJ"` (the `Delete from Google Feed` checkbox).
- `filterByFormula` references field **names** (`FIELD_NAMES`); projection uses field **IDs** (`returnFieldsByFieldId=true`).

**Verified against the live base 2026-06-26** (all 15 field IDs correct). Types that drove design choices:
- `Full Res Image` + `Image URL` are **`url`** fields → plain strings (not attachments), so `airtable.ts`'s `str()` mapper is correct as-is.
- `Site` is a **`singleSelect`**; the raw REST API returns the option **name** as a string ("ARLnow"), which is what `{Site}='ARLnow'` in `filterByFormula` and `SITES_IN_SCOPE` expect.
- `Photo caption` + `Unique ID` are **formula** fields (string results); empty caption is omitted from the response → `media:title` dropped automatically.
- `Last Updated` is a **`lastModifiedTime`** field (good — spec §9.2 ideal) watching Headline, Article, Link, Category, Image URL, Author. **It does NOT watch `Delete from Google Feed`** — see the tombstone caveat below.
- `Publication time`/`Last Updated` come back as UTC ISO (`...Z`) regardless of display TZ.

## Deletions / tombstones
Articles are rarely pulled. To remove one from Google, an editor checks `Delete from Google Feed`. The live query includes flagged records still within the window, and `renderItem` emits a minimal `licensed_news:deleted=yes` item (flag wins over normal rendering). Window = `WINDOW_DAYS + TOMBSTONE_DAYS` by publish date, OR `TOMBSTONE_DAYS` by `Last Updated`. Don't hard-delete the Airtable row while you want the tombstone sent.

- **Archive vs live:** the live feed tombstones (`emitTombstones: true`); the **archive omits** retracted articles entirely (`emitTombstones: false`) — a quarterly snapshot shouldn't carry a "deleted" marker.
- **⚠️ Known gap — deleting long after publish:** because `Last Updated` (lastModifiedTime) does **not** watch the `Delete from Google Feed` checkbox, checking the box on an article older than `WINDOW_DAYS + TOMBSTONE_DAYS` (17 days) bumps nothing, so **neither** tombstone clause fires and no tombstone is sent. Deletions near publish (the common case) work via the publish-date clause. **Fix (Airtable config, by Scott):** add `Delete from Google Feed` to the `Last Updated` field's watched fields (or set it to watch *all* fields) so a box-check bumps `Last Updated` → the `TOMBSTONE_DAYS` clause fires.

## Day bucketing
Archive files are bucketed by **America/New_York** calendar day (articles store UTC). Airtable filters use a padded UTC window; exact ET-day filtering happens in JS (`easternDayKey`). Don't tighten the Airtable date bounds and remove the JS filter — DST makes exact formula bounds fragile.

## Sanitizer portability
`sanitize.ts` uses `htmlparser2` (pure JS) so the same cleaner runs in the Worker and Node. If `wrangler deploy`/bundling ever complains about a Node built-in, swap the Worker's sanitize path for a Cloudflare `HTMLRewriter` implementation (strip `script/style/iframe/noscript/form/img`, keep the same tag allowlist) and keep htmlparser2 for the Node script. The render layer only depends on `sanitizeArticleHtml(html): string`.

## Worker specifics
- Create R2 first: `wrangler r2 bucket create google-news-feed`.
- The fetch handler serves the cached R2 object; if missing/stale (>5 min) it builds synchronously so Google never gets an empty response.
- Routes: `/gn/<FEED_PATH_TOKEN>.xml?key=<FEED_SECRET>` (live) and `/archive/<FEED_SECRET>/<file>` (download-link target for the script's zips).

## Archive script specifics
- Run: `npm run archive` (last quarter) or `--quarter 2026-Q2` or `--sample 2026-06-26`.
- Uploads the zip to R2 via the S3 API (`aws4fetch`), then the download link points at the Worker's `/archive/...` route.
- Optional future: direct Google Drive upload via a service account (JWT → Drive API) to remove the manual drag — stub it in `deliver()`/a new module; currently out of scope.

## Sanity checks when changing rendering
Run **`npm test`** (`test/validate.ts`) — 28 assertions over real + synthetic fixtures that encode spec §10: well-formed XML (parsed via `fast-xml-parser`), exactly the 4 namespaces (no `atom`/`dc`), RFC822 pubDate, ISO-8601 `+00:00` modified, no `script`/`iframe`/`noscript`/`img` in `content:encoded`, images use Full Res, `media:title` only with a caption, archive has no `media:*`, tombstone behavior, and the `mapRow` mapping. It writes `out/{live,archive}-sample.xml` to eyeball. The W3C feed validator will still flag the custom namespaces — that's expected.
