# Google News AI Pilot — Feed System Build Spec

**Owner:** Local News Now (Scott Brodbeck)
**Build target:** Claude Code → Cloudflare Worker (TypeScript), reading the existing Airtable "News articles" base. Zapier and Airtable unchanged.
**Publications in scope (per Google agreement):** ARLnow, ALXnow, FFXnow only.

---

## 1. What this system does

Two headless jobs, one codebase:

1. **Live feed** — a private-by-obscurity RSS endpoint Google crawls every couple of minutes. Full article text + images, last ~3 days, all three sites in one feed, in Google's custom-namespaced RSS, reflecting edits and (rare) deletions.
2. **Quarterly archive** — per-day, text-only XML files (no images), foldered by publication and year, packaged and pushed to the team via Slack + email link (the file is generated for you, not exported by hand).

```
WordPress (3 sites)
      │  (existing)
      ▼
   Zapier  ──►  Airtable "News articles" / O&O table   ◄── source of truth, unchanged
                          │
                          │  Cloudflare Worker reads via Airtable API
            ┌─────────────┴─────────────┐
            ▼                           ▼
   LIVE FEED (cron */2 min)     ARCHIVE (cron quarterly + manual)
   render → R2 → serve at        render per-day (no images) → zip → R2
   secret URL for Google         → Slack webhook + Resend email (link)
```

**Why not Zapier/Lovable/Supabase:** Zapier is metered per-task and isn't built to return large dynamic XML on a crawler hitting it ~700×/day — it stays as the ingestion layer it already is. Lovable's value is React/Supabase UI; this system renders nothing to a human. Supabase would mean migrating article storage that Airtable + Zapier already maintain, for no benefit. A Cloudflare Worker serves XML at the edge for effectively free and is already in the LNN stack.

---

## 2. Data source — Airtable

- **Base:** `News articles` — `appZn7eNiJ4BO89G1`
- **Table:** `O&O` — `tblrMZhmQKluhERnP` (8,609 records across all sites at time of writing)
- **Auth:** a Personal Access Token scoped to this base, read-only, stored as Worker secret `AIRTABLE_TOKEN`.

### 2.1 Field → RSS element mapping

| RSS element | Req. | Airtable field | Field ID | Transform |
|---|---|---|---|---|
| `item/title` | Yes | Headline | `fldWJiio2QJmUHrMS` | XML-escape |
| `item/link` | Yes | Link | `fld4bmk2Zij9LEZFT` | use as-is (already canonical dated permalink, no params) |
| `item/guid` | rec. | Link | `fld4bmk2Zij9LEZFT` | `guid` = canonical Link (default `isPermaLink="true"`). This is the key Google matches on for edits/deletes. |
| `item/pubDate` | Yes | Publication time | `fldTVGGblNLDfPnzm` | ISO(UTC) → **RFC822** |
| `item/dcterms:modified` | opt | Last Updated | `fldHISu51SechhNL3` | ISO(UTC) → **ISO 8601** (`Z` is valid). Include only if present. |
| `item/dcterms:creator` | opt | Author | `fldeLfqPyDko2MAW2` | XML-escape; include only if non-empty |
| `item/description` | opt | RSS Description | `fldSrhozLD5HMBBqL` | XML-escape (plain-text excerpt) |
| `item/content:encoded` | **Yes** | Article | `fldNWjuUjuNfH43dj` | **sanitize HTML** (§4.4) → CDATA-wrap |
| `item/media:content@url` | if image | Full Res Image → fallback Image URL | `fldiNU1IHfGz3u82H` → `fld0B5ZOSb8RP42UF` | prefer Full Res (larger), `medium="image"`. Live feed only. |
| `item/media:title` | if image + caption | Photo caption | `fldkvTVxpmHPwJCg2` | include only if non-empty |
| `item/licensed_news:genre` | opt | derived from Category | `fldIrqLAx1zVwCdAt` | map (§4.5); omit if no match |
| `item/licensed_news:deleted` | opt | **Delete from Google Feed** (NEW — §9) | _to add_ | emit `yes` when checked (§4.6) |
| _filter_ | — | Site | `fldoQadEASnOPqeZN` | ARLnow `selXvpPB6f2iuVhD1`, ALXnow `selKCuZa4wViAZ7rf`, FFXnow `sel7iEVKZ2M4ulCQQ` |
| _internal key_ | — | Unique ID | `fldZTzAp6Jca0amiX` | e.g. `pe042428`; for logging/dedup only |

**Notes from a real record (recTgT3LVndRnHTVY):**
- `Article` is HTML (`<p>`, `<a>`, `<ol>`, `<strong>`) but can contain poll/script embeds (`<script>`, `<iframe>`, `<noscript>`) — these must be stripped (§4.4).
- `Photo caption` is often empty → omit `media:title` when absent (Google allows image without caption).
- Two image fields exist: `Full Res Image` (WordPress original, large) and `Image URL` (S3, smaller). Google prefers large (≥1200px), so prefer Full Res.
- `Publication time` and `Last Updated` are stored in UTC (`...Z`).

---

## 3. Component 1 — Live feed

### 3.1 Hosting & security (private-by-obscurity + secret)
- **URL:** custom subdomain via Cloudflare, e.g. `https://feeds.lnn.co/gn/<32+ char random token>.xml`. (A `*.workers.dev` route also works if you'd rather not add a subdomain.)
- **Defense in depth:** require a secret query param too, e.g. `?key=<long secret>`. The serving handler returns `404` unless **both** the path token and `key` match. Store expected values as Worker secrets `FEED_PATH_TOKEN` and `FEED_SECRET`.
- **Discoverability:** the feed host's `robots.txt` is `Disallow: /`, and the URL is linked nowhere. You hand Google the full URL + key via the **Contact Us form** (their secure channel), per the spec's "API keys / query string parameter" auth option.
- This host is unrelated to Google-Extended (§7); Google fetches the feed directly from the submitted URL.

### 3.2 Build trigger & storage
- **Cron `*/2 * * * *`** (every 2 min) → render the live feed → write to **R2** at `live/google-news.xml` (+ `live/google-news.meta.json` with build time, item count, byte size).
- **Serving handler** reads the latest R2 object and returns it. If the object is missing/stale (>5 min), it builds synchronously as a fallback so Google never gets an empty response.
- This decouples Google's crawl rate from Airtable entirely (Airtable is hit ~1×/2min, far under its 5 req/s limit; Zapier's existing load is unaffected).
- **Response headers:** `Content-Type: application/rss+xml; charset=utf-8`, `Cache-Control: public, max-age=120`.

### 3.3 Selection rules
Build the item set from a single Airtable query (structured filters, field projection, sorted by `Publication time` desc):

- **Normal items:** `Site` ∈ {ARLnow, ALXnow, FFXnow} **AND** `Publication time` ≥ now − `WINDOW_DAYS` (default **3** — comfortably covers the "last 2 days" requirement with a buffer; the whole 3-day, 3-site payload is well under 1 MB vs the 50 MiB limit, so a buffer is free).
- **Tombstones (deletions):** see §4.6.
- Skip any record whose content (after fallback chain in §4.4) is empty; log it.

### 3.4 Channel template (exact)
Do **not** add namespaces or elements beyond what's below (the spec rejects unlisted ones — notably **no `atom:` self-link**).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:licensed_news="https://www.google.com/schemas/rss-licensed-news/" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
  <channel>
    <title>Local News Now</title>
    <link>https://feeds.lnn.co/gn/&lt;token&gt;.xml</link>
    <description>Licensed news content from ARLnow, ALXnow and FFXnow.</description>
    <language>en</language>
    <lastBuildDate>{{RFC822 now}}</lastBuildDate>
    {{items}}
  </channel>
</rss>
```

### 3.5 Item template — full item (with image), exact
```xml
    <item>
      <title>{{escape Headline}}</title>
      <link>{{Link}}</link>
      <guid>{{Link}}</guid>
      <pubDate>{{RFC822 Publication time}}</pubDate>
      <description>{{escape RSS Description}}</description>
      <dcterms:creator>{{escape Author}}</dcterms:creator>            <!-- omit if empty -->
      <dcterms:modified>{{ISO8601 Last Updated}}</dcterms:modified>   <!-- omit if empty -->
      <licensed_news:genre>{{Genre}}</licensed_news:genre>           <!-- omit if no map -->
      <content:encoded><![CDATA[{{sanitized Article HTML}}]]></content:encoded>
      <media:content url="{{Full Res Image or Image URL}}" medium="image">
        <media:title>{{escape Photo caption}}</media:title>          <!-- omit whole media:title if caption empty -->
      </media:content>
      <!-- omit entire media:content block if no image -->
    </item>
```

---

## 4. Rendering rules (shared module)

A single `render.ts` produces items for both live and archive, gated by an `includeImages` flag (archive = false).

### 4.1 RFC822 (pubDate)
`new Date(iso).toUTCString()` returns `Fri, 26 Jun 2026 15:45:56 GMT`. RFC822 wants a numeric offset → **replace `GMT` with `+0000`**. English-only (default locale of `toUTCString` is fine).

### 4.2 ISO 8601 (dcterms:modified)
`new Date(iso).toISOString()` → `2026-06-26T15:57:25.000Z`. Trailing `Z` (= `+00:00`) is valid ISO 8601; no conversion needed.

### 4.3 XML escaping
Escape `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;` in title, description, creator, media:title.

### 4.4 content:encoded sanitization (important)
Per the spec, `content:encoded` is **text content only** — no images, and in practice no scripts/embeds. Use the Worker-native **`HTMLRewriter`** (no dependencies) to:
- **Strip entirely** (tag + contents): `<script>`, `<style>`, `<iframe>`, `<noscript>`, `<form>`, and known embed wrappers.
- **Strip tag, keep nothing**: `<img>` (images belong only in `media:content`).
- **Keep**: `p, a, ul, ol, li, strong, em, b, i, h2, h3, h4, blockquote, br`. Drop other tags but keep their text.
- Then **CDATA-wrap**. Guard the CDATA close sequence: replace any `]]>` in the content with `]]]]><![CDATA[>`.

**Content fallback chain** (first non-empty wins): sanitized `Article` → `Article (plain text)` (`fldgwb5g2xgJfrNLM`) wrapped in `<p>…</p>` → `RSS Description`. If all empty, skip the item.

### 4.5 licensed_news:genre (optional, default on)
`Category` (`fldIrqLAx1zVwCdAt`) is a free-text comma list (e.g. `"Opinion,Arlnow Reader Choice"`). Case-insensitive contains-match → one allowed value, else omit:
- `opinion` → `Opinion` · `op-ed`/`oped` → `OpEd` · `press release` → `PressRelease` · `satire` → `Satire` · `blog` → `Blog`

### 4.6 Deletions / tombstones (rare but supported)
Articles are very rarely pulled. Google's model: re-send the item with `<licensed_news:deleted>yes</licensed_news:deleted>` reusing the same `guid`/`link` (no content needed), then stop sending it.

- **New Airtable field** `Delete from Google Feed` (checkbox — §9). To remove a published article from Google, an editor checks it.
- **Tombstone set** = records where the box is checked **AND** (`Publication time` ≥ now − (`WINDOW_DAYS` + `TOMBSTONE_DAYS`) **OR** `Last Updated` ≥ now − `TOMBSTONE_DAYS`). `TOMBSTONE_DAYS` default **14**. The Publication-time clause covers the common case (deleted near publish); the Last-Updated clause covers an article deleted long after publish (works if `Last Updated` is a Last Modified Time field — see §9).
- **Render:** a tombstone item is minimal — `title` (optional), `link`, `guid`, `pubDate`, and `licensed_news:deleted`yes. If the box is checked, render as a tombstone even if it would otherwise qualify as a normal item (flag wins).
- After the window, the record falls out of all queries and is no longer sent. **Do not hard-delete the Airtable row** while you want the tombstone emitted.

### 4.7 Edits
No special handling — every build reads current `Article`/`Last Updated`, so edits flow through automatically and `dcterms:modified` updates. Google re-crawls within minutes.

### 4.8 Size guard
After rendering the live feed, assert bytes < 50 MiB (will be ~1 MB in practice). If ever exceeded, reduce `WINDOW_DAYS`. Log size to the meta object.

---

## 5. Component 2 — Quarterly archive

### 5.1 Format differences vs live
- **No multimedia** at all — omit every `media:content`/`media:title` (`includeImages=false`). Content is text-only per the archival spec.
- **One file per calendar day per publication**, RSS format (same channel + item structure, sans images).
- **Folder layout** (one folder per publication, year subfolders):
  ```
  ARLnow/2026/feed-2026-01-01.xml
  ARLnow/2026/feed-2026-01-02.xml
  ALXnow/2026/feed-2026-01-01.xml
  FFXnow/2026/feed-2026-01-01.xml
  ```
- **File naming:** `feed-YYYY-MM-DD.xml`. If any single day's file exceeds 50 MB (won't happen for these pubs), split as `feed-YYYY-MM-DD_01.xml`, `_02.xml`, … per the spec.

### 5.2 Day bucketing
Bucket by **America/New_York** calendar day (these are DC-area pubs; `Publication time` is UTC). Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' })` to derive the local `YYYY-MM-DD` for each article.

### 5.3 Range
- Default range = the **just-ended quarter** (e.g. Q2 = Apr 1 – Jun 30, Eastern). One file per day that has ≥1 article; days with no articles produce no file.
- Per-publication query: `Site` = X **AND** `Publication time` within the quarter (Eastern bounds converted to UTC).

### 5.4 Packaging & delivery (answers your Slack/email question — yes, this is easier)
Pushing a finished file to you is both easier and more robust than you exporting by hand, and a **download link beats an attachment** (no 25 MB email limits, no Slack file-size quirks; a text-only quarter zips to just a few MB but a link sidesteps all of it):

1. Build the folder tree in memory → **zip** it (`archive/{YYYY}-Q{n}.zip`).
2. Write the zip to **R2**.
3. Mint a time-limited link (R2 presigned URL, ~7-day expiry) **or** a `/archive/<secret>/{file}` route on the same Worker behind `FEED_SECRET`.
4. **Notify both channels** via `notify.ts`:
   - **Slack:** POST to an Incoming Webhook (`SLACK_WEBHOOK_URL` secret) with the link and a one-line summary (quarter, file count, size). (Webhooks can't attach files — the link is the right pattern.)
   - **Email:** **Resend** (`RESEND_API_KEY` secret) to you + team with the same link. Optionally attach the zip when < ~20 MB.
5. **You then** download, unzip, and drag the publication folders into the shared Drive folder (`Google Licensed News - Local News Now`). That's the one manual step, quarterly.

> **Optional upgrade — full automation to Drive:** a Google service account (JWT → Drive API) granted access to the shared folder could upload the files directly, removing the manual drag. It adds a service-account setup; given quarterly cadence and your preference for a pushed file, the Slack/email-link path is the recommended default. Flag this if you'd rather fully automate later.

### 5.5 Trigger
- **Cron** on the 5th day after each quarter end (buffer before the 10-day deadline): `0 9 5 1,4,7,10 *` → generates for the prior quarter.
- **Manual trigger:** `GET /archive/run?key=<FEED_SECRET>&quarter=2026-Q2` to regenerate on demand (also how you produce the **sample one-day file** Google's QA wants first — generate, deliver, upload one day to Drive's sample folder, await QA feedback before the full quarter).

---

## 6. Repo structure, config, secrets

```
google-news-feed/
  wrangler.toml
  src/
    index.ts        # fetch handler (serve live + archive routes) + scheduled handler (live cron, archive cron) + manual triggers
    airtable.ts     # typed record fetch (filters, projection, pagination)
    render.ts       # row → RSS item; param includeImages; tombstone rendering
    sanitize.ts     # HTMLRewriter content:encoded cleaner
    dates.ts        # RFC822, ISO8601, Eastern-day bucketing, quarter bounds
    feed-live.ts    # build live feed → R2
    archive.ts      # build per-day files → zip → R2 → deliver
    notify.ts       # Slack webhook + Resend email
    config.ts       # base/table/field IDs, site filter, windows
```

**`wrangler.toml`** bindings: one **R2 bucket** (`FEED_BUCKET`); optional **KV** for small state/locks; **cron triggers** (`*/2 * * * *` for live, `0 9 5 1,4,7,10 *` for archive); a **custom domain/route** for `feeds.lnn.co`.

**Secrets** (`wrangler secret put`): `AIRTABLE_TOKEN`, `FEED_PATH_TOKEN`, `FEED_SECRET`, `SLACK_WEBHOOK_URL`, `RESEND_API_KEY`, _(optional)_ `GOOGLE_SA_JSON`.

**Config constants** (`config.ts`): `WINDOW_DAYS=3`, `TOMBSTONE_DAYS=14`, base `appZn7eNiJ4BO89G1`, table `tblrMZhmQKluhERnP`, the field IDs from §2.1, site choice IDs from §2.1, channel title/description.

---

## 7. Google-Extended — robots.txt change (do this on each site)

This is separate from the feed and goes on **arlnow.com, alxnow.com, and ffxnow.com** (the article pages Google's models crawl), **not** the feed host. Since your agreement covers all content on these three sites, you only need to ensure the `Google-Extended` user-agent isn't blocked. The safe, explicit form to add to each site's `robots.txt`:

```
User-agent: Google-Extended
Allow: /
```

- If a site has a blanket `Disallow: /` for `User-agent: *`, the explicit block above is **required** to opt these sites in.
- Do **not** add any `Disallow:` lines under `Google-Extended`.
- Caveat from Google's docs: Google-Extended uses the standard Googlebot user-agent, so page-level meta tags/HTTP headers can't target it — robots.txt is the only lever. (Only relevant if you ever want to opt out a subset; for full-site opt-in, the two lines above are all you need.)

The feed host (`feeds.lnn.co`) gets the opposite — `User-agent: * / Disallow: /` — to keep the private feed undiscovered.

---

## 8. What you submit to Google (manual, by you)
1. Via the **Contact Us form**: the live feed URL **with** the `?key=` secret, listed as a query-string API-key auth feed.
2. Add the feed-setup team members to the email thread (Google asked for this).
3. Upload **one sample day** of archival content to the Drive sample folder; await QA feedback before the full quarter (§5.5).

> I won't enable Google-Extended or submit credentials for you — those are account/site changes that should be done by you directly.

---

## 9. Airtable changes required (small)
1. **Add field `Delete from Google Feed`** (checkbox) to the O&O table — drives tombstones (§4.6). Paste its field ID into `config.ts`.
2. **`Last Updated` (`fldHISu51SechhNL3`):** ideally make this a **Last Modified Time** field (watching at least the `Article` and `Headline` fields, or all fields) so it auto-bumps on edits → accurate `dcterms:modified`, and on box-check → reliable tombstone windowing. If it's currently a plain dateTime set by Zapier, the system still works via the Publication-time tombstone clause; this just tightens the edge case.

No other Airtable or Zapier changes — the O&O table already carries full content, author, canonical link, images, captions, and site.

---

## 10. Validation & QA plan
- **Well-formedness:** parse the rendered XML; fail the build on parse errors.
- **W3C Feed Validator** (`validator.w3.org/feed`): expect it to flag the custom namespaces/elements (per Google's note) — confirm the *standard* RSS structure is otherwise clean.
- **Per-item checks:** every item has `title`, `link`, `pubDate`, non-empty `content:encoded`; `pubDate` matches RFC822; `link` is `https`, canonical, on one of the three domains, no query params (UTM ok).
- **content:encoded:** assert no `<script>`, `<iframe>`, `<img>` survive sanitization.
- **Images:** `media:content@url` resolves (HEAD 200); `media:title` present only when caption exists.
- **Size:** live feed < 50 MiB; each archive day-file < 50 MB.
- **Deletion test:** check the box on a test record → confirm a `deleted=yes` tombstone appears for that `guid` → confirm it drops after `TOMBSTONE_DAYS`.
- **Archive dry run:** generate one day, eyeball the file + foldering + naming, deliver via Slack/email, upload to Drive sample folder for Google QA.

---

## 11. Open items / future enhancements
- **IPTC `category` codes:** `Category` is free text today, so `category` is omitted in v1. A future lookup table could map your sections → IPTC media-topic codes if Google wants them.
- **Per-domain feeds:** v1 ships **one combined feed** (Google's stated preference for multi-domain publishers). The architecture trivially supports three routes (one per site) if Google's reviewer requests separate feeds.
- **Full Drive automation** for the quarterly drop (§5.4) — optional service-account upgrade.
- **`licensed_news:embargo`** is available if you ever schedule licensed content ahead of publish; unused in v1.

---

## 12. Addendum — Google's example file & archive runtime

### 12.1 What `feed-2000-01-01.xml` tells us
The sample in the Drive is Google's **generic RSS template** (identical to the spec doc's example), which confirms the archive uses the same technical feed spec as the live feed. Two artifacts in it are bugs/template residue — **do not copy them**:

1. **Mismatched creator tag + stray `dc` namespace.** The example declares `xmlns:dc="http://purl.org/dc/elements/1.1/"` and writes `<dcterms:creator>John Doe and Jane Doe</dc:creator>` (opens `dcterms:`, closes `dc:` — invalid XML). The spec text is explicit: use `<dcterms:creator>` and don't include unlisted namespaces. **We emit `<dcterms:creator>…</dcterms:creator>` and do not declare `dc`.** If Google's QA tooling ever complains that it wants `dc:creator`, raise it with the technical contact rather than shipping invalid XML.
2. **`media:content` present in the archival sample.** The example includes an image and a video element even though the archival requirements and onboarding email both say archival must exclude images/multimedia. It's there only because the file is a copy of the live template. **Archive files omit all `media:*` elements** (§5.1). (If you eyeball the sample and see images, that's why — it's not a real archival example.)

### 12.2 Conventions to match
- **`dcterms:modified` offset:** the example uses `2000-01-02T12:00:00+00:00`. We emit `+00:00` (not `Z`) to mirror it — equivalent ISO 8601, updated in `dates.ts`.
- **RFC822 day padding:** the example shows `Sat, 1 Jan 2000` (unpadded day). RFC822 permits padded or unpadded; `Date.toUTCString()`'s zero-padded form (`Sat, 01 Jan 2000`) is valid and what we use.

### 12.3 Archive runtime — refinement vs §5/§6
While scaffolding, one adjustment to the approved plan: the quarterly archive (a full quarter × 3 sites, ~1,500–2,000 articles → ~270 day-files → zip) is **heavier than a Cloudflare cron is comfortable with** (Worker CPU/memory limits). It's a better fit for a **Node script on your always-on Ubuntu box** (the Dell Vostro you're setting up for fire-and-forget jobs) — no CPU limits, trivial zipping, easy Slack/email delivery, and easier Drive-API upload later.

- **Live feed → Cloudflare Worker** (unchanged: edge serving + `*/2` cron rebuild to R2).
- **Archive → Node script** (`src/scripts/archive.ts`), run on a quarterly cron on the box, or on demand via `npm run archive -- --quarter 2026-Q2`.
- **Shared code:** `src/lib/` (types, config, dates, sanitize, airtable, render, notify) is portable TypeScript used by both. The Worker bundles it; the script imports it directly.
- The Worker can still mint/serve the download link behind `FEED_SECRET`, but heavy generation lives in the script.
