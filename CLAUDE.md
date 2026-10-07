# CLAUDE.md — working notes for this repo

Context for finishing/maintaining the Google News AI pilot feed system. Read alongside `google-news-ai-pilot-spec.md` (the authoritative spec).

## What this is
Two jobs, one codebase, sharing `src/lib/`:
- **Live feed** → Cloudflare Worker (`src/worker/index.ts`): serves a private RSS endpoint Google crawls every couple of minutes, rebuilt to R2 on a `*/2` cron.
- **Quarterly archive** → Node script (`src/scripts/archive.ts`) run by a **GitHub Actions cron** (`.github/workflows/archive.yml`) — cloud, no local box. Kept off the Worker cron because a full quarter is heavier than a 128 MB isolate is comfortable with. Still runnable anywhere via `npm run archive`.

Data source: the **LNN Tools archive API** (`https://api.lnn.co`, bearer token `LNN_API_TOKEN`) via `src/lib/lnntools.ts`. **Read-only.** It replaced Airtable on 2026-10-07, when Airtable stopped being updated. `src/lib/airtable.ts` is kept for reference/rollback but nothing imports it at runtime.

## Hard rules from Google's spec (don't "fix" these)
- **Only these four namespaces**, exactly: `content`, `dcterms`, `licensed_news`, `media`. Do **not** add `atom:` (no self-link) or `dc:`.
- Use `<dcterms:creator>` (open AND close), never `dc:creator`. Google's own example file has a bug here (`<dcterms:creator>…</dc:creator>` + a stray `dc` namespace) — do not copy it.
- `content:encoded` is **article text only**: CDATA-wrapped HTML with **no `<img>`, `<script>`, `<iframe>`, or embeds**. `sanitize.ts` enforces this.
- `media:content`/`media:title` appear in the **live feed only**. The **archive excludes all multimedia** (`includeImages: false`). Google's sample file shows media even in an "archival" file — that's template residue; ignore it.
- `media:title` is emitted only when a photo caption exists.
- **Channel `<image>`** (added at Google's request for publisher branding) is plain RSS 2.0 — *not* a new namespace, so it doesn't violate the four-namespace rule. Its `<title>`/`<link>` are derived from the channel's in `render.head()` and must keep mirroring them. Live feed uses the LNN logo the Worker serves at `/logo.png` (bundled from `assets/lnn-logo.png` via `src/worker/logo.ts`, so it ships with every deploy); archive day-files use each publication's own 512×512 site icon from `SITE_LOGO`. **Swapping the logo takes two steps:** replace `assets/lnn-logo.png`, regenerate `src/worker/logo.ts` (base64), **and bump the `?v=` on `CHANNEL_IMAGE_URL`** — the response is `max-age=86400`, so without a new URL the old image is served for up to a day (this bit us on the 128→512 swap). `robots.txt` explicitly `Allow`s `/logo.png` — the blanket `Disallow: /` would otherwise stop Google fetching it.
- `pubDate` = RFC822; `dcterms:modified` = ISO 8601 with `+00:00` offset (to match Google's example), not `Z`.
- Article `link` is the canonical URL (already canonical in the source) and doubles as `guid`. No custom query params (UTM is allowed).
- Each live-feed fetch must be < 50 MiB (asserted in `buildLive`). Each archive day-file < 50 MB (warns; split as `feed-YYYY-MM-DD_NN.xml` if ever exceeded).

## LNN Tools API — facts the code depends on
Schema: `GET /archive/openapi.json` (same bearer token; the bare `/openapi.json` needs a browser session). Verified against the live API 2026-10-07:
- **List** `GET /archive/articles?site=&since=&until=&limit=&fields=body,featured`. `fields=body` puts `content_html`/`content_text` on each row (there is **no `body` key**); `fields=featured` includes `featured.full`, the library original. Both are byte-identical to the detail route (`/archive/articles/{site}/{wp_id}`), so the feed makes **no per-article calls**. `limit` caps at 200; `since` inclusive, `until` exclusive; newest-first by `published_at`. The default list **hides retracted rows**.
- **Never derive the full-res URL** from `featured.src` by stripping `-600x400`: originals often keep an uppercase extension (`.JPEG`) that WordPress lowercases on derivatives, so derived URLs 404'd on 11/79 recent posts. Use `featured.full`.
- **Retractions** `GET /archive/articles?site=a,b,c&gone_since=<ISO>` returns rows whose `gone_at` ≥ it, whatever their publish date, with the URL **as it was while published** (never the `__trashed` slug). `gone_at` is set on trash/delete/back-to-draft/private and cleared on republish; LNN Tools polls WordPress for withdrawals every 5 min. Use `gone_since`, not `include_gone=true` (that one still applies the publish-date window).
- **Paging:** `offset` now works, but `listSite()` deliberately walks `until` backward (keyset): offset pages shift if a post is published or retracted mid-walk, which can silently skip a row. Each page re-reads the oldest second (+1s, `until` is exclusive) and de-dupes by `wp_id`.
- Unknown query params are logged, not rejected (rejection may come later). Send only documented ones.
- Python's default User-Agent gets a 403 (bot filter). Node/Worker fetch is fine; we send `lnn-google-news-feed/1.0` anyway.
- **No `flag` filter.** Sponsored posts went to Google via Airtable (verified), so `!sponsored` would shrink the licensed corpus.
- **Daily Debriefs are not in LNN Tools** (`/archive/articles/arlnow/426069` → "not in the archive"). That's fine: Scott confirmed 2026-10-07 they're **not wanted in the Google feed** (they went via Airtable only because Airtable carried everything).
- **Parity with Airtable, 2026-Q3:** 1,711/1,711 articles accounted for (Airtable's other 191 rows were Debriefs). 1,708 matched URL-for-URL; on the other 3 the slug was edited after publish, and LNN Tools has the current URL (Airtable's 301s to it).

## Field mapping (`mapItem` in `lnntools.ts`)
One list row → `ArticleRecord`. `title`→headline, `url`→link/guid, `published_at`/`modified_at`, `authors[]`/`categories[]` joined with `", "`, `excerpt`→rssDescription, `content_html`/`content_text`→body, `featured.full`→fullResImage, `featured.src`→imageUrl, `featured.caption`→photoCaption, `gone_at`→deleteFromFeed. `uniqueId` = `site/wp_id` (list rows carry no id).
- **`rssDescription` is the `excerpt`, never `summary`.** `summary` (and the detail route's `ai`) is Gemini output, and model-generated text must not go into a licensed feed. A test asserts this.
- Bylines are PublishPress `author_names`, matching WordPress. Airtable's were wrong on 5/30 articles checked (generic "ARLnow.com" fallbacks, a dropped AP co-byline, one wrong reporter).
- `render`'s entity decoding (`cleanDescription()`, `decodeEntitiesText` on the caption) stays. LNN Tools text arrives decoded, and decoding again is harmless.

## Live-feed build
`buildLive()` makes ~4 API calls in parallel: one list per site for the last `WINDOW_DAYS`, plus one `gone_since` call for the last `TOMBSTONE_DAYS`. `assembleLive()` merges them (a retraction wins if an article is in both) newest-first. ~80 items / ~400 KB, ~300 ms. No R2 state besides the feed itself.
- If a fallback build in the fetch handler throws (source down, bad token), the Worker serves the **last good feed** instead of a 500, and returns 503 only when nothing is cached.

## Deletions / tombstones
A retraction is `gone_at` on the LNN Tools record; editors don't do anything feed-specific — trashing or unpublishing the post in WordPress is the signal. The live feed sends a minimal `licensed_news:deleted=yes` item (title, link/guid, pubDate; no body or media) for **`TOMBSTONE_DAYS` (14) after the retraction**, then stops — Google's model per spec §4.6. Because it's keyed on `gone_at`, retracting an article months after publication still reaches Google.
- **Archive vs live:** the live feed tombstones (`emitTombstones: true`); the **archive omits** retracted articles entirely (`emitTombstones: false`, and `listSite` drops `gone_at` rows) — a quarterly snapshot shouldn't carry a "deleted" marker.
- Removing an article from the feed is NOT enough on its own: the feed is a rolling window, so every article eventually disappears, and absence tells Google nothing. Only the tombstone does.
- No real retraction existed in the archive as of 2026-10-07 to test against; the path is covered by fixtures shaped per the API docs (`npm test` → "LNN Tools retractions").

## Day bucketing
Archive files are bucketed by **America/New_York** calendar day (articles store UTC). The API query uses a padded UTC window (`since`/`until`); exact ET-day filtering happens in JS (`easternDayKey`). Don't tighten the bounds and remove the JS filter — DST makes exact bounds fragile.

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
`src/lib/wordpress.ts` + `pollAndNotify` in the Worker replace the WordPress publish plugin's one job: POST to the Zapier catch-hook on publish. **Independent of the feed** — it runs as its own `ctx.waitUntil` task in `scheduled()`, so a poller error or slow WordPress response can't stop the feed rebuild. The feed doesn't read anything the poller produces (the feed reads LNN Tools; the webhook feeds Zapier's alert/social Zap).
- Runs inside the existing `*/2` `scheduled()` handler, only when `WP_POLL_ENABLED="true"` — **on in production since 2026-10-07**. Each poll asks each site's cachebusted REST API for **ids + dates only** (`_fields=id,date`, ~1 KB / ~0.3 s), and fetches full posts (`include=<ids>&_embed=1`) **only for unseen ids**, then POSTs `toWebhookPayload(post)` to `INGEST_WEBHOOK_URL` (a secret) for each. **Don't go back to `_embed` on every poll**: that was ~2 MB and ~7 s of uncached PHP per site every 2 minutes (~4 GB/day off the WordPress origins) just to learn nothing was new. Payloads are byte-identical either way (verified). Payload keys mirror the plugin exactly: `URL, Headline, Time, Categories, Excerpt, Image, Article, Author`.
- **Dedup state** = a per-site seen-id list in the existing R2 bucket (`state/wp-seen-<site>.json`, capped at `WP_SEEN_CAP`). No new binding/DB.
- **Bootstrap:** first run per site records current post ids as seen and fires nothing (prevents a burst on activation).
- **`WP_DRY_RUN="true"`** detects + logs new posts but doesn't POST — safe validation. **Preview route** (read-only): `GET /gn/poll?key=<FEED_SECRET>` → JSON of what would fire per site.
- Safe alongside the live plugin: the Zap dedups by Link, so overlapping fires are filtered — retire the plugin on your own schedule. New-post→webhook latency is up to ~2 min (vs instant plugin).
- Mapping notes: use site-local `date` for `Time` (WP `date_gmt` lacks `Z`; the Zap treats input as US/Eastern); byline from `author_names` (PublishPress), not the core author embed; `.rendered` fields are entity-decoded via `decodeEntitiesText`; `Categories` excludes tags; `Image` prefers the full-size original.

## Updated-article poller (⚠️ read before touching the hash)
Second mode of the same poller, firing a **separate** Zapier hook (`UPDATE_WEBHOOK_URL`) when an article's content actually changes. Replaces a WP Automator "post updated" trigger that flooded that hook with ~20k calls in 2 days. Gated by `WP_UPDATE_POLL_ENABLED` (default off); shares `WP_DRY_RUN`.

**The loop hazard — this is the whole design constraint.** Zapier writes an article summary back into a WordPress **meta** field after every publish *and* every update, and that write-back **bumps `post_modified`**. Verified empirically: every post with a populated `article_summary` has `modified` 2–11 min after `published`; the one post without a summary had `modified` == `published` exactly. So `modified` is *not* evidence of an editorial change, and firing on it gives you:
`update fires → Zap writes summary → modified bumps → update fires → …` — the runaway.

**`contentHash()` in `wordpress.ts` is the loop breaker.** It fingerprints only what we send — title, content, excerpt, featured image, categories/tags/author — and **nothing else**. A summary write-back leaves the hash unchanged, so the fire never happens. **Never add post meta (`article_summary`, `acf`, `meta`, …) to that hash.** Verified against live data: hashes are stable across independent fetches (15/15 posts, no volatile/nonce content), and in a 12-hour real sample all 7 `modified` events were publish-echoes → 0 fires.

Mechanics:
- **Cursor, not diffing:** `?modified_after=<cursor − WP_UPDATE_LOOKBACK_MIN>&orderby=modified&order=asc`. Ascending + high-water mark = no missed edits, self-healing after downtime. The lookback overlap makes WP's `modified_after` timezone semantics irrelevant — re-seen posts are dropped by the hash, not re-fired.
- **Cursor never advances past unfinished work.** If a fire fails or a cap trips, the cursor is held just below that post's `modified_gmt` so it retries next run instead of being silently lost.
- **One state object per site, one load + one save per run** (`state/wp-seen-<site>.json`: `ids`, `cursor`, `hashes`, `fires`, `perPost`). New-posts run **first** so the Zap sees a new article before any update for it, and so firing it seeds the baseline hash that suppresses its own publish-echo.
- **No baseline hash → fires** (deliberate: the receiving Zap does its own genuine-update check). Bootstrap therefore seeds hashes for the most recent `WP_BOOTSTRAP_HASH_PAGE` posts and fires nothing, so activation doesn't stampede.
- **Ceilings** (`config.ts`, calibrated to a measured ~1–3 genuine edits/site/day): 10/cycle, 60/hour, 300/day per site, 20/hour per post. A breaking-news story with a dozen-plus real edits passes; a loop trips the breaker. On trip it logs `THROTTLED` and holds the cursor. A legitimate mass edit **will** trip the hourly ceiling — that's intended; raise it deliberately rather than removing it.
- **Preview:** `GET /gn/poll?key=<FEED_SECRET>` reports both modes per site — candidates, cursor, `skipped.unchanged` (high = loop guard working), fires last hour/day, baseline count.

## Archive script specifics
- Cloud schedule: **GitHub Actions** (`.github/workflows/archive.yml`), triggered by **Zapier** via `repository_dispatch` (event type `archive`). Zapier owns the quarterly schedule (Schedule → Code-by-Zapier POST), so the workflow has **no `schedule:` trigger** and GitHub's ~60-day auto-disable never applies. Also `workflow_dispatch` for manual `quarter`/`sample` runs (Zapier passes the same via `client_payload`). Reads secrets from the runner env: `npm run archive` uses `--env-file-if-exists=.dev.vars`, so a missing file falls back to `process.env`. Always attaches the zip as a run artifact; uploads to R2 if those secrets are set. On finish (success or failure) a step POSTs `{status, link, quarter, fileCount, sizeMB, run_url}` to `ZAPIER_WEBHOOK_URL`; `main()` writes `out/result.json` for that callback.
- Run anywhere: `npm run archive` (last quarter) or `-- --quarter 2026-Q2` or `-- --sample 2026-06-26`. `--sample` derives its quarter from the day (`quarterOfDay`) and scopes the API query to just that day.
- Uploads the zip to R2 via the S3 API (`aws4fetch`); the download link points at the Worker's `/archive/...` route.
- Notifications are owned by Zapier (the callback above), so the workflow doesn't pass `SLACK_WEBHOOK_URL`/`RESEND_API_KEY` — those code paths still exist for local runs.
- Optional future: direct Google Drive upload via a service account (JWT → Drive API) to remove the manual drag — stub it in `deliver()`/a new module; currently out of scope.

## Sanity checks when changing rendering
Run **`npm test`** (`test/validate.ts`) — 50 assertions over real + synthetic fixtures that encode spec §10: well-formed XML (parsed via `fast-xml-parser`), exactly the 4 namespaces (no `atom`/`dc`), RFC822 pubDate, ISO-8601 `+00:00` modified, no `script`/`iframe`/`noscript`/`img` in `content:encoded`, images use Full Res, `media:title` only with a caption, archive has no `media:*`, tombstone behavior, the LNN Tools `mapItem` mapping (incl. excerpt-not-summary) and retraction→tombstone path, and the legacy `mapRow`. It writes `out/{live,archive}-sample.xml` to eyeball. The W3C feed validator will still flag the custom namespaces — that's expected.
