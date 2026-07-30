import { decodeEntitiesText } from "./sanitize";
import { WP_POLL_PER_PAGE } from "./config";

/**
 * WordPress REST source for the publish poller. Pure: uses only `fetch`/`URL`,
 * so it compiles for both the Worker and Node builds (like airtable.ts).
 *
 * The poller replaces the WordPress publish plugin's one job — POSTing to the
 * Zapier catch-hook on publish. It does NOT touch the feed/archive pipeline.
 */

/** Minimal shape of a WordPress REST `posts` item fetched with `_embed=1`. */
export interface WpPost {
  id: number;
  link: string;
  date: string; // site-local publish time, e.g. "2026-07-23T10:45:31" (no offset)
  date_gmt?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  author_names?: string | string[]; // PublishPress Authors byline(s) — an array in our WP setup
  _embedded?: {
    author?: Array<{ name?: string }>;
    "wp:featuredmedia"?: Array<{
      source_url?: string;
      media_details?: { sizes?: Record<string, { source_url?: string }> };
    }>;
    "wp:term"?: Array<Array<{ name?: string; taxonomy?: string }>>;
  };
}

/** Exact payload keys the existing Zapier catch-hook reads (mirrors the plugin). */
export interface WebhookPayload {
  URL: string;
  Headline: string;
  Time: string;
  Categories: string;
  Excerpt: string;
  Image: string;
  Article: string;
  Author: string;
}

/** Fetch the most-recent published posts for one site, cachebusted for freshness. */
export async function fetchRecentPosts(baseUrl: string, perPage: number = WP_POLL_PER_PAGE): Promise<WpPost[]> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("_embed", "1");
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");
  url.searchParams.set("_cb", String(Date.now())); // cachebuster — unique URL => no edge cache hit
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "lnn-google-news-poller" },
  });
  if (!res.ok) throw new Error(`WP ${baseUrl} ${res.status}: ${await res.text()}`);
  return (await res.json()) as WpPost[];
}

/** Prefer the full-size original; fall back to the base featured source_url. */
function featuredImage(post: WpPost): string {
  const media = post._embedded?.["wp:featuredmedia"]?.[0];
  if (!media) return "";
  return media.media_details?.sizes?.full?.source_url || media.source_url || "";
}

/**
 * Categories + tags, ", "-joined — matching what the WordPress plugin sends.
 * Verified against a real plugin payload: "News, Alexandria Jail, nonprofit,
 * Sheriff's Office, …, James Cullum" = 1 `category` + 5 `post_tag` + the
 * PublishPress `author` term. WordPress returns the groups in that order, which
 * is the order the plugin emits. Downstream this feeds Airtable's `Category`,
 * which drives `licensed_news:genre`, so dropping any of them would silently
 * change genre matching. Other taxonomies (e.g. `ppma_author`) are excluded.
 */
const PAYLOAD_TAXONOMIES = new Set(["category", "post_tag", "author"]);

function categoryNames(post: WpPost): string {
  const names: string[] = [];
  for (const group of post._embedded?.["wp:term"] ?? []) {
    for (const term of group) {
      if (term?.name && PAYLOAD_TAXONOMIES.has(term.taxonomy ?? "")) names.push(decodeEntitiesText(term.name));
    }
  }
  return names.join(", "); // ", " matches the plugin payload exactly
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Plugin parity for `Time`: "April 16, 2025 2:48 pm".
 *
 * WP's `date` is already site-local (Eastern) wall-clock with no offset, so we
 * reformat its components literally. Deliberately NOT via `new Date(...)`: that
 * parses an offset-less string as UTC in the Worker, which would shift the hour
 * by 4-5 before formatting. The Zap re-parses this as US/Eastern.
 */
export function toPluginTime(wpDate: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wpDate ?? "");
  if (!m) return wpDate ?? "";
  const [, y, mo, d, hh, mi] = m;
  const h24 = Number(hh);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y} ${h12}:${mi} ${h24 < 12 ? "am" : "pm"}`;
}

/**
 * Plugin parity for `Headline`: the plugin emits ASCII quotes where WordPress
 * stores typographic ones (WP "'I'm recreating myself'" -> "'I'm recreating
 * myself'"). Only quotes/apostrophes — we have no evidence it touches dashes
 * or ellipses, so those are left alone.
 */
function toStraightQuotes(s: string): string {
  return s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/** Byline as a string. `author_names` is an array in our WP (PublishPress); fall back to core author. */
function authorByline(post: WpPost): string {
  const a = post.author_names;
  if (Array.isArray(a)) return a.filter(Boolean).join(", ").trim();
  if (typeof a === "string") return a.trim();
  return (post._embedded?.author?.[0]?.name ?? "").trim();
}

/** Map a WordPress post to the webhook payload the plugin currently sends. */
export function toWebhookPayload(post: WpPost): WebhookPayload {
  return {
    URL: post.link ?? "",
    Headline: toStraightQuotes(decodeEntitiesText(post.title?.rendered ?? "")),
    Time: toPluginTime(post.date), // "April 16, 2025 2:48 pm" — the Zap parses this as US/Eastern
    Categories: categoryNames(post),
    Excerpt: decodeEntitiesText(post.excerpt?.rendered ?? "").trim(), // decode + strip tags
    Image: featuredImage(post),
    Article: post.content?.rendered ?? "", // full HTML; the Zap processes/truncates it
    Author: authorByline(post),
  };
}

/** Pure dedup: posts whose id isn't already seen, oldest-first (social goes out in publish order). */
export function selectNewPosts(posts: WpPost[], seenIds: readonly number[]): WpPost[] {
  const seen = new Set(seenIds);
  return posts
    .filter((p) => typeof p.id === "number" && !seen.has(p.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}
