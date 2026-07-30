# CLAUDE.md — working notes for this repo

Context for finishing/maintaining the Google News AI pilot feed system. Read alongside `google-news-ai-pilot-spec.md` (the authoritative spec).

## What this is
Two jobs, one codebase, sharing `src/lib/`:
- **Live feed** → Cloudflare Worker (`src/worker/index.ts`): serves a private RSS endpoint Google crawls every couple of minutes, rebuilt to R2 on a `*/2` cron.
- **Quarterly archive** → Node script (`src/scripts/archive.ts`) run by a **GitHub Actions cron** (`.github/workflows/archive.yml`) — cloud, no local box. Kept off the Worker cron because a full quarter is heavier than a 128 MB isolate is comfortable with. Still runnable anywhere via `npm run archive`.

Data source: Airtable `News articles` / `O&O` (`appZn7eNiJ4BO89G1` / `tblrMZhmQKluhERnP`), maintained by Zapier. **Read-only — never write to it.**

## Hard rules from Google's spec (don't "fix" these)
- **Only these four namespaces**, exactly: `content`, `dcterms`, `licensed_news`, `media`. Do **not** add `atom:` (no self-link) or `dc:`.
- Use `<dcterms:creator>` (open AND close), never `dc:creator`. Google's own example file has a bug here (`<dcterms:creator>…</dc:creator>` + a stray `dc` namespace) — do not copy it.
- `content:encoded` is **article text only**: CDATA-wrapped HTML with **no `<img>`, `<script>`, `<iframe>`, or embeds**. `sanitize.ts` enforces this.
- `media:content`/`media:title` appear in the **live feed only**. The **archive excludes all multimedia** (`includeImages: false`). Google's sample file shows media even in an "archival" file — that's template residue; ignore it.
- `media:title` is emitted only when a photo caption exists.
- **Channel `<image>`** (added at Google's request for publisher branding) is plain RSS 2.0 — *not* a new namespace, so it doesn't violate the four-namespace rule. Its `<title>`/`<link>` are derived from the channel's in `render.head()` and must keep mirroring them. Live feed uses the LNN logo the Worker serves at `/logo.png` (bundled from `assets/lnn-logo.png` via `src/worker/logo.ts`, so it ships with every deploy); archive day-files use each publication's own 512×512 site icon from `SITE_LOGO`. **Swapping the logo takes two steps:** replace `assets/lnn-logo.png`, regenerate `src/worker/logo.ts` (base64), **and bump the `?v=` on `CHANNEL_IMAGE_URL`** — the response is `max-age=86400`, so without a new URL the old image is served for up to a day (this bit us on the 128→512 swap). `robots.txt` explicitly `Allow`s `/logo.png` — the blanket `Disallow: /` would otherwise stop Google fetching it.
- `pubDate` = RFC822; `dcterms:modified` = ISO 8601 with `+00:00` offset (to match Google's example), not `Z`.
- Article `link` is the canonical URL (already correct in Airtable) and doubles as `guid`. No custom query params (UTM is allowed).
- Each live-feed fetch must be < 50 MiB (asserted in `buildLive`). Each archive day-file < 50 MB (warns; split as `feed-YYYY-MM-DD_NN.xml` if ever exceeded).

## Field mapping
All field IDs live in `src/lib/config.ts`, including `FIELD_IDS.deleteFromFeed = "fldDA1Dg18waeRqeJ"` (the `Delete from Google Feed` checkbox).
- `filterByFormula` references field **names** (`FIELD_NAMES`); projection uses field **IDs** (`returnFieldsByFieldId=true`).

**Verified against the live base 2026-06-26** (all 15 field IDs correct). Types that drove design choices:
- `Full Res Image` + `Image URL` are **`url`** fields → plain strings (not attachments), so `airtable.ts`'s `str()` mapper is correct as-is.
- `Site` is a **`singleSelect`**; the raw REST API returns the option **name** as a string ("ARLnow"), which is what `{Site}='ARLnow'` in `filterByFormula` and `SITES_IN_SCOPE` expect.
- `Photo caption` + `Unique ID` are **formula** fields (string results); empty caption is omitted from the response → `media:title` dropped automatically. The caption is regex-extracted from raw article HTML, so it carries HTML entities (`&#8217;`, `&amp;`) — `render` runs it through `decodeEntitiesText` before XML-escaping so `media:title` isn't double-escaped.
- `RSS Description` is the WordPress **excerpt**, so it has the same two problems and gets the same treatment in `render`'s `cleanDescription()`: raw HTML entities (`&#8220;`, `&hellip;`) are decoded before XML-escaping (else readers see a literal `&#8220;`), and gallery-led posts have the slider nav scraped into the excerpt (`"Previous Image 1/3 Next Image …"`) which is stripped as a prefix. Verified against the live feed 2026-07-30 (39 double-escaped + 3 nav-polluted descriptions).
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

**Don't simplify these out — they handle real LNN markup (verified against live content):**
- **Gallery/chrome stripping (`DROP_CLASS`).** LNN articles wrap lead images in `<div class="lnn-gallery js-gallery">` whose footer nav leaks `"Previous Image"`, `"Next Image"`, and a `"1/2"` slide counter as text. We drop the whole subtree of any element whose class matches `lnn-gallery`/`js-gallery`/`gallery__*`. Inline `<figure class="wp-caption">` images are already dropped by the `figure` rule (their caption still reaches the live feed's `media:title` via the `Photo caption` formula field, which is separate).
- **`safeHref`** keeps only `http(s):`/`mailto:`/root-relative hrefs, dropping `javascript:` (gallery nav buttons) and `data:`.
- **Void-aware skip counter.** Skip-depth counts non-void elements only, so a dropped subtree stays balanced regardless of whether htmlparser2 emits a close event for void tags (`img`, etc.).

## Worker specifics
- Create R2 first: `wrangler r2 bucket create google-news-feed`.
- The fetch handler serves the cached R2 object; if missing/stale (>5 min) it builds synchronously so Google never gets an empty response.
- Routes: `/gn/<FEED_PATH_TOKEN>.xml?key=<FEED_SECRET>` (live) and `/archive/<FEED_SECRET>/<file>` (download-link target for the script's zips).

## Publish poller (WordPress → same Zapier webhook)
`src/lib/wordpress.ts` + `pollAndNotify` in the Worker replace the WordPress publish plugin's one job: POST to the Zapier catch-hook on publish. **Additive** — the feed/archive pipeline and Airtable are untouched; this only adds a task to `scheduled()`.
- Runs inside the existing `*/2` `scheduled()` handler, only when `WP_POLL_ENABLED="true"`. Polls each site's cachebusted REST API (`/wp-json/wp/v2/posts?…&_cb=<ts>`), and for each **new** post (dedup by WordPress post id) POSTs `toWebhookPayload(post)` to `INGEST_WEBHOOK_URL` (a secret). Payload keys mirror the plugin exactly: `URL, Headline, Time, Categories, Excerpt, Image, Article, Author`.
- **Dedup state** = a per-site seen-id list in the existing R2 bucket (`state/wp-seen-<site>.json`, capped at `WP_SEEN_CAP`). No new binding/DB.
- **Bootstrap:** first run per site records current post ids as seen and fires nothing (prevents a burst on activation).
- **`WP_DRY_RUN="true"`** detects + logs new posts but doesn't POST — safe validation. **Preview route** (read-only): `GET /gn/poll?key=<FEED_SECRET>` → JSON of what would fire per site.
- Safe alongside the live plugin: the Zap dedups by Link, so overlapping fires are filtered — retire the plugin on your own schedule. New-post→webhook latency is up to ~2 min (vs instant plugin).
- Mapping notes: use site-local `date` for `Time` (WP `date_gmt` lacks `Z`; the Zap treats input as US/Eastern); byline from `author_names` (PublishPress), not the core author embed; `.rendered` fields are entity-decoded via `decodeEntitiesText`; `Categories` excludes tags; `Image` prefers the full-size original.

## Archive script specifics
- Cloud schedule: **GitHub Actions** (`.github/workflows/archive.yml`), triggered by **Zapier** via `repository_dispatch` (event type `archive`). Zapier owns the quarterly schedule (Schedule → Code-by-Zapier POST), so the workflow has **no `schedule:` trigger** and GitHub's ~60-day auto-disable never applies. Also `workflow_dispatch` for manual `quarter`/`sample` runs (Zapier passes the same via `client_payload`). Reads secrets from the runner env: `npm run archive` uses `--env-file-if-exists=.dev.vars`, so a missing file falls back to `process.env`. Always attaches the zip as a run artifact; uploads to R2 if those secrets are set. On finish (success or failure) a step POSTs `{status, link, quarter, fileCount, sizeMB, run_url}` to `ZAPIER_WEBHOOK_URL`; `main()` writes `out/result.json` for that callback.
- Run anywhere: `npm run archive` (last quarter) or `-- --quarter 2026-Q2` or `-- --sample 2026-06-26`. `--sample` derives its quarter from the day (`quarterOfDay`) and scopes the Airtable query to just that day.
- Uploads the zip to R2 via the S3 API (`aws4fetch`); the download link points at the Worker's `/archive/...` route.
- Notifications are owned by Zapier (the callback above), so the workflow doesn't pass `SLACK_WEBHOOK_URL`/`RESEND_API_KEY` — those code paths still exist for local runs.
- Optional future: direct Google Drive upload via a service account (JWT → Drive API) to remove the manual drag — stub it in `deliver()`/a new module; currently out of scope.

## Sanity checks when changing rendering
Run **`npm test`** (`test/validate.ts`) — 28 assertions over real + synthetic fixtures that encode spec §10: well-formed XML (parsed via `fast-xml-parser`), exactly the 4 namespaces (no `atom`/`dc`), RFC822 pubDate, ISO-8601 `+00:00` modified, no `script`/`iframe`/`noscript`/`img` in `content:encoded`, images use Full Res, `media:title` only with a caption, archive has no `media:*`, tombstone behavior, and the `mapRow` mapping. It writes `out/{live,archive}-sample.xml` to eyeball. The W3C feed validator will still flag the custom namespaces — that's expected.
