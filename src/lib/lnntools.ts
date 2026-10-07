import { SITES_IN_SCOPE } from "./config";
import type { ArticleRecord, SiteName } from "./types";

/**
 * LNN Tools archive API — the article source that replaced Airtable (2026-10-07).
 *
 * Same contract as `airtable.ts`: produce `ArticleRecord[]` and let the render layer
 * stay source-agnostic. Pure fetch/URL so it runs in the Worker and Node.
 * Schema: GET /archive/openapi.json (bearer). Facts this module relies on, verified
 * against the live API 2026-10-07:
 *
 * - LIST  GET /archive/articles?site=&since=&until=&limit=&fields=body,featured
 *   With `fields=body` each row carries `content_html`/`content_text` (there is no
 *   `body` key); with `fields=featured`, `featured.full` is the library original.
 *   Both equal the detail route's values, so no per-article calls are needed.
 *   `limit` caps at 200; `since` inclusive, `until` exclusive; newest-first.
 *   The default list HIDES retracted rows.
 * - RETRACTIONS  same route with `gone_since=` returns rows whose gone_at >= it,
 *   whatever their published_at, with the URL as it was while published.
 * - Python's default User-Agent gets a 403 (bot filter); Node/Worker fetch is fine,
 *   but we send an explicit UA so these calls are identifiable in LNN Tools' logs.
 */

const DEFAULT_BASE = "https://api.lnn.co";
const USER_AGENT = "lnn-google-news-feed/1.0";
const PAGE_LIMIT = 200;

/** SiteName (still the canonical name throughout render/config) <-> LNN Tools slug. */
const SLUG: Record<SiteName, string> = { ARLnow: "arlnow", ALXnow: "alxnow", FFXnow: "ffxnow" };
const SITE_BY_SLUG: Record<string, SiteName> = { arlnow: "ARLnow", alxnow: "ALXnow", ffxnow: "FFXnow" };

/**
 * NO `flag` filter, deliberately. The newsletter Zap uses `flag=!sponsored,!debrief`
 * because a newsletter shouldn't lead with an ad. The Google feed is the opposite
 * case: sponsored posts went to Google via Airtable (verified 2026-10-07), so
 * filtering here would silently shrink the licensed corpus. (Daily Debriefs aren't
 * in LNN Tools at all, and Scott confirmed they're not wanted in the feed.)
 */

/** One row from the list endpoint, with `fields=body,featured`. */
export interface LnnListItem {
  site: string;
  wp_id: number;
  title: string;
  url: string;
  status?: string;
  authors?: string[];
  categories?: string[];
  published_at: string; // ISO UTC
  modified_at?: string;
  excerpt?: string; // the WordPress excerpt — this is what feeds <description>
  summary?: string; // Gemini-generated; MUST NOT reach the feed
  content_html?: string;
  content_text?: string;
  featured?: { src?: string; full?: string; alt?: string; caption?: string; title?: string } | null;
  gone_at?: string | null; // non-null => retracted => tombstone
}

export interface LnnClient {
  token: string;
  baseUrl?: string;
}

async function getItems(c: LnnClient, q: URLSearchParams): Promise<LnnListItem[]> {
  const path = `/archive/articles?${q}`;
  const res = await fetch(`${c.baseUrl || DEFAULT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${c.token}`, "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`LNN Tools ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { items?: LnnListItem[] }).items ?? [];
}

/** +1s on an ISO UTC instant (`until` is exclusive; see listSite). */
function plusOneSecond(iso: string): string {
  return new Date(Date.parse(iso) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Every live (non-retracted) article for one site with since <= published_at < until,
 * bodies and full-res image included.
 *
 * Pages by walking `until` backward (keyset) rather than `offset`: offset pages shift
 * when a post is published or retracted mid-walk, which can silently skip a row,
 * while a timestamp cursor can't. Each next page re-reads the oldest second (+1s,
 * since `until` is exclusive) and de-duplicates by wp_id, so ties aren't lost.
 */
export async function listSite(
  c: LnnClient,
  site: SiteName,
  since: string,
  until?: string
): Promise<LnnListItem[]> {
  const seen = new Map<number, LnnListItem>();
  let cursor = until;
  for (;;) {
    const q = new URLSearchParams({ site: SLUG[site], since, limit: String(PAGE_LIMIT), fields: "body,featured" });
    if (cursor) q.set("until", cursor);
    const items = await getItems(c, q);
    let fresh = 0;
    for (const a of items) {
      if (!seen.has(a.wp_id)) {
        seen.set(a.wp_id, a);
        fresh++;
      }
    }
    if (items.length < PAGE_LIMIT) break;
    const oldest = items.reduce((m, a) => (a.published_at < m ? a.published_at : m), items[0]!.published_at);
    const next = plusOneSecond(oldest);
    // >200 posts in one second would stall the cursor; fail loudly rather than loop.
    if (fresh === 0 || next === cursor) throw new Error(`LNN Tools paging stalled for ${site} at ${cursor}`);
    cursor = next;
  }
  // Defensive: only published posts — a scheduled post must never reach Google early.
  return [...seen.values()].filter((a) => !a.gone_at && (!a.status || a.status === "publish"));
}

/** All in-scope sites, in parallel. */
export async function listArticles(
  c: LnnClient,
  since: string,
  until?: string,
  sites: readonly SiteName[] = SITES_IN_SCOPE
): Promise<LnnListItem[]> {
  return (await Promise.all(sites.map((s) => listSite(c, s, since, until)))).flat();
}

/**
 * Articles retracted (gone_at) since `goneSince`, whatever their publish date — the
 * tombstone set. Retractions are rare (none in the archive's history as of
 * 2026-10-07), so one page is plenty; a full page is logged rather than paged.
 */
export async function listRetracted(
  c: LnnClient,
  goneSince: string,
  sites: readonly SiteName[] = SITES_IN_SCOPE
): Promise<LnnListItem[]> {
  const q = new URLSearchParams({
    site: sites.map((s) => SLUG[s]).join(","),
    gone_since: goneSince,
    limit: String(PAGE_LIMIT),
  });
  const items = await getItems(c, q);
  if (items.length >= PAGE_LIMIT) console.warn(`[lnntools] ${items.length} retractions since ${goneSince}; oldest may be cut off`);
  // Only in-scope sites, and only rows that really are retracted.
  return items.filter((a) => a.gone_at && a.site in SITE_BY_SLUG);
}

/**
 * The live feed's item set: current articles plus a tombstone for each retraction.
 * A retraction wins if the same article somehow appears in both. Newest-first.
 */
export function assembleLive(current: LnnListItem[], retracted: LnnListItem[]): ArticleRecord[] {
  const byKey = new Map<string, LnnListItem>();
  for (const a of current) byKey.set(`${a.site}/${a.wp_id}`, a);
  for (const a of retracted) byKey.set(`${a.site}/${a.wp_id}`, a);
  return [...byKey.values()]
    .sort((x, y) => (x.published_at < y.published_at ? 1 : -1))
    .map(mapItem);
}

function clean(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim();
  return t || undefined;
}

function joined(v: string[] | undefined): string | undefined {
  return v && v.length ? clean(v.join(", ")) : undefined;
}

export function mapItem(a: LnnListItem): ArticleRecord {
  const id = `${a.site}/${a.wp_id}`;
  return {
    id,
    uniqueId: id,
    site: SITE_BY_SLUG[a.site] ?? a.site,
    headline: clean(a.title) ?? "",
    link: clean(a.url) ?? "",
    publicationTime: a.published_at ?? "",
    lastUpdated: clean(a.modified_at),
    author: joined(a.authors),
    // `excerpt` is the WordPress excerpt (what Airtable's "RSS Description" held).
    // `a.summary` is model output — never put it in a licensed feed.
    rssDescription: clean(a.excerpt),
    articleHtml: clean(a.content_html),
    articlePlain: clean(a.content_text),
    fullResImage: clean(a.featured?.full),
    imageUrl: clean(a.featured?.src),
    photoCaption: clean(a.featured?.caption),
    category: joined(a.categories),
    deleteFromFeed: Boolean(a.gone_at),
  };
}
