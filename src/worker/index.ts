import { fetchArticles } from "../lib/airtable";
import { buildFeed } from "../lib/render";
import { FIELD_IDS, FIELD_NAMES, SITES_IN_SCOPE, SITE_WP_BASE, WP_SEEN_CAP } from "../lib/config";
import { fetchRecentPosts, selectNewPosts, toWebhookPayload, type WpPost } from "../lib/wordpress";
import type { SiteName } from "../lib/types";

/** Worker bindings + vars + secrets. */
export interface Env {
  FEED_BUCKET: R2Bucket;
  AIRTABLE_TOKEN: string;
  FEED_PATH_TOKEN: string;
  FEED_SECRET: string;
  CHANNEL_TITLE: string;
  CHANNEL_DESCRIPTION: string;
  WINDOW_DAYS: string;
  TOMBSTONE_DAYS: string;
  // Publish poller (WordPress REST -> same Zapier webhook). INGEST_WEBHOOK_URL is a secret.
  INGEST_WEBHOOK_URL?: string;
  WP_POLL_ENABLED?: string;
  WP_DRY_RUN?: string;
}

const LIVE_KEY = "live/google-news.xml";
const LIVE_META = "live/google-news.meta.json";
const STALE_MS = 5 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MiB hard limit per Google

/** filterByFormula: in-scope sites AND (recent OR a flagged tombstone still in its window). */
function liveFormula(windowDays: number, tombDays: number): string {
  const siteOr = SITES_IN_SCOPE.map((s) => `{${FIELD_NAMES.site}}='${s}'`).join(",");
  const outer = windowDays + tombDays;
  return (
    "AND(" +
    `OR(${siteOr}),` +
    "OR(" +
    `IS_AFTER({${FIELD_NAMES.publicationTime}},DATEADD(NOW(),-${windowDays},'days')),` +
    `AND({${FIELD_NAMES.deleteFromFeed}}=1,OR(` +
    `IS_AFTER({${FIELD_NAMES.publicationTime}},DATEADD(NOW(),-${outer},'days')),` +
    `IS_AFTER({${FIELD_NAMES.lastUpdated}},DATEADD(NOW(),-${tombDays},'days'))` +
    "))" +
    ")" +
    ")"
  );
}

function feedUrl(env: Env): string {
  return `https://feeds.lnn.co/gn/${env.FEED_PATH_TOKEN}.xml`;
}

async function buildLive(env: Env): Promise<{ xml: string; count: number; bytes: number }> {
  const windowDays = Number(env.WINDOW_DAYS || "3");
  const tombDays = Number(env.TOMBSTONE_DAYS || "14");
  const articles = await fetchArticles({
    token: env.AIRTABLE_TOKEN,
    filterByFormula: liveFormula(windowDays, tombDays),
    sortFieldId: FIELD_IDS.publicationTime,
    sortDir: "desc",
  });
  const xml = buildFeed(
    articles,
    { title: env.CHANNEL_TITLE, link: feedUrl(env), description: env.CHANNEL_DESCRIPTION },
    { includeImages: true, emitTombstones: true }
  );
  const bytes = new TextEncoder().encode(xml).length;
  if (bytes > MAX_BYTES) throw new Error(`Live feed ${bytes} bytes exceeds 50 MiB — reduce WINDOW_DAYS`);
  return { xml, count: articles.length, bytes };
}

async function putLive(env: Env, built: { xml: string; count: number; bytes: number }): Promise<void> {
  await env.FEED_BUCKET.put(LIVE_KEY, built.xml, {
    httpMetadata: { contentType: "application/rss+xml; charset=utf-8" },
  });
  await env.FEED_BUCKET.put(
    LIVE_META,
    JSON.stringify({ builtAt: new Date().toISOString(), count: built.count, bytes: built.bytes }),
    { httpMetadata: { contentType: "application/json" } }
  );
}

async function writeLive(env: Env): Promise<void> {
  const built = await buildLive(env);
  await putLive(env, built);
  console.log(`live rebuilt: ${built.count} items, ${built.bytes} bytes`);
}

// --- Publish poller: WordPress REST -> same Zapier webhook (replaces the WP plugin) ---
const seenKey = (site: string) => `state/wp-seen-${site}.json`;
interface SeenState {
  ids: number[];
  updatedAt: string;
}

async function loadSeenIds(env: Env, site: string): Promise<number[] | null> {
  const obj = await env.FEED_BUCKET.get(seenKey(site));
  if (!obj) return null;
  const s = await obj.json<SeenState>().catch(() => null);
  return s?.ids ?? null;
}

async function saveSeenIds(env: Env, site: string, ids: number[]): Promise<void> {
  const capped = ids.slice(-WP_SEEN_CAP); // keep only the most recent ids
  await env.FEED_BUCKET.put(seenKey(site), JSON.stringify({ ids: capped, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Read-only: fetch recent posts and determine which are new. `bootstrap` = first run for this site. */
async function newPostsForSite(
  env: Env,
  site: SiteName
): Promise<{ bootstrap: boolean; fresh: WpPost[]; allIds: number[]; priorIds: number[] }> {
  const posts = await fetchRecentPosts(SITE_WP_BASE[site]);
  const allIds = posts.map((p) => p.id);
  const priorIds = await loadSeenIds(env, site);
  if (priorIds === null) return { bootstrap: true, fresh: [], allIds, priorIds: [] };
  return { bootstrap: false, fresh: selectNewPosts(posts, priorIds), allIds, priorIds };
}

/** Poll one site and fire the webhook for new posts. Dedup by WP post id, persisted in R2. */
async function pollSite(env: Env, site: SiteName, dryRun: boolean): Promise<void> {
  const { bootstrap, fresh, allIds, priorIds } = await newPostsForSite(env, site);
  if (bootstrap) {
    // First run: remember what's already published, fire nothing (avoids a burst on activation).
    await saveSeenIds(env, site, allIds);
    console.log(`[wp-poll] ${site}: bootstrapped ${allIds.length} seen ids (no webhooks fired)`);
    return;
  }
  const seen = [...priorIds];
  for (const post of fresh) {
    const payload = toWebhookPayload(post);
    try {
      if (dryRun) {
        console.log(`[wp-poll] ${site} DRY-RUN would fire id=${post.id} "${payload.Headline}"`);
      } else {
        const res = await fetch(env.INGEST_WEBHOOK_URL!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
        console.log(`[wp-poll] ${site} fired id=${post.id} "${payload.Headline}"`);
      }
      seen.push(post.id); // mark seen only after a successful fire (or in dry-run)
    } catch (err) {
      // Leave unseen -> retried next cron. The Zap dedups by Link, so a retry can't duplicate.
      console.error(`[wp-poll] ${site} id=${post.id} failed: ${(err as Error).message}`);
    }
  }
  if (seen.length !== priorIds.length) await saveSeenIds(env, site, seen);
}

async function pollAndNotify(env: Env): Promise<void> {
  const dryRun = env.WP_DRY_RUN === "true";
  if (!dryRun && !env.INGEST_WEBHOOK_URL) {
    console.error("[wp-poll] enabled but INGEST_WEBHOOK_URL is unset — skipping");
    return;
  }
  for (const site of SITES_IN_SCOPE) {
    try {
      await pollSite(env, site, dryRun);
    } catch (err) {
      console.error(`[wp-poll] ${site} poll error: ${(err as Error).message}`);
    }
  }
}

function rss(xml: string): Response {
  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=120" },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export default {
  // Cron (*/2): rebuild the cached live feed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(writeLive(env));
    if (env.WP_POLL_ENABLED === "true") ctx.waitUntil(pollAndNotify(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Keep the private feed host out of search indexes (nothing here should be crawled).
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // --- Poller preview (read-only): /gn/poll?key=<secret> — shows what WOULD fire, no side effects ---
    if (path === "/gn/poll") {
      if (url.searchParams.get("key") !== env.FEED_SECRET) return notFound();
      const report: Record<string, unknown> = {};
      for (const site of SITES_IN_SCOPE) {
        try {
          const { bootstrap, fresh, allIds } = await newPostsForSite(env, site);
          report[site] = bootstrap
            ? { bootstrap: true, seenIfActivated: allIds.length }
            : { wouldFire: fresh.map((p) => ({ id: p.id, headline: toWebhookPayload(p).Headline })) };
        } catch (err) {
          report[site] = { error: (err as Error).message };
        }
      }
      return new Response(JSON.stringify(report, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // --- Live feed: /gn/<token>.xml?key=<secret> ---
    if (path === `/gn/${env.FEED_PATH_TOKEN}.xml`) {
      if (url.searchParams.get("key") !== env.FEED_SECRET) return notFound();

      const obj = await env.FEED_BUCKET.get(LIVE_KEY);
      let stale = !obj;
      if (obj) {
        const meta = await env.FEED_BUCKET.get(LIVE_META);
        const m = meta ? await meta.json<{ builtAt: string }>().catch(() => null) : null;
        if (!m || Date.now() - new Date(m.builtAt).getTime() > STALE_MS) stale = true;
      }

      if (stale) {
        // Fallback build so Google never gets an empty/expired response.
        const built = await buildLive(env);
        await putLive(env, built);
        return rss(built.xml);
      }
      return new Response(obj!.body, {
        headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=120" },
      });
    }

    // --- Archive download link target: /archive/<secret>/<file> ---
    const m = /^\/archive\/([^/]+)\/(.+)$/.exec(path);
    if (m) {
      const secret = m[1] ?? "";
      const file = m[2] ?? "";
      if (secret !== env.FEED_SECRET) return notFound();
      const obj = await env.FEED_BUCKET.get(`archive/${file}`);
      if (!obj) return notFound();
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${(file.split("/").pop() ?? "archive.zip").replace(/"/g, "")}"`,
        },
      });
    }

    return notFound();
  },
};
