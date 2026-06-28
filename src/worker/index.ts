import { fetchArticles } from "../lib/airtable";
import { buildFeed } from "../lib/render";
import { FIELD_IDS, FIELD_NAMES, SITES_IN_SCOPE } from "../lib/config";

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
