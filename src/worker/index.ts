import { fetchArticles } from "../lib/airtable";
import { buildFeed } from "../lib/render";
import {
  FIELD_IDS, FIELD_NAMES, SITES_IN_SCOPE, SITE_WP_BASE, WP_SEEN_CAP, WP_HASH_CAP,
  WP_UPDATE_LOOKBACK_MIN, WP_UPDATE_MAX_PER_CYCLE, WP_UPDATE_MAX_PER_HOUR,
  WP_UPDATE_MAX_PER_DAY, WP_UPDATE_MAX_PER_POST_PER_HOUR,
} from "../lib/config";
import {
  fetchRecentPosts, fetchModifiedSince, selectNewPosts, selectUpdatedPosts,
  contentHash, toWebhookPayload, type WpPost,
} from "../lib/wordpress";
import type { SiteName } from "../lib/types";
import { LOGO_PNG } from "./logo";

/** Worker bindings + vars + secrets. */
export interface Env {
  FEED_BUCKET: R2Bucket;
  AIRTABLE_TOKEN: string;
  FEED_PATH_TOKEN: string;
  FEED_SECRET: string;
  CHANNEL_TITLE: string;
  CHANNEL_DESCRIPTION: string;
  CHANNEL_IMAGE_URL?: string; // publisher logo for the channel-level <image> (Google branding)
  CHANNEL_LINK?: string; // publisher homepage for the channel <link>
  WINDOW_DAYS: string;
  TOMBSTONE_DAYS: string;
  // Publish poller (WordPress REST -> same Zapier webhook). INGEST_WEBHOOK_URL is a secret.
  INGEST_WEBHOOK_URL?: string;
  WP_POLL_ENABLED?: string;
  WP_DRY_RUN?: string;
  // Updated-article poller — a SEPARATE Zapier hook from the publish one.
  UPDATE_WEBHOOK_URL?: string;
  WP_UPDATE_POLL_ENABLED?: string;
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

/**
 * Channel <link>: per RSS 2.0 this is the website the channel corresponds to —
 * the publisher's homepage, not the feed's own address. (The archive already
 * does this, using each publication's site.) Keeping the feed URL here would
 * also echo FEED_PATH_TOKEN into the feed body.
 */
function channelLink(env: Env): string {
  return env.CHANNEL_LINK || "https://lnn.co";
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
    {
      title: env.CHANNEL_TITLE,
      link: channelLink(env),
      description: env.CHANNEL_DESCRIPTION,
      imageUrl: env.CHANNEL_IMAGE_URL || undefined,
    },
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
  ids: number[]; // new-post dedup, by WordPress post id
  cursor?: string; // high-water mark of processed modified_gmt (UTC, no offset)
  hashes?: Record<string, string>; // postId -> content fingerprint (the loop guard's baseline)
  fires?: number[]; // epoch ms of update fires, rolling 24h — feeds the ceilings
  perPost?: Record<string, number[]>; // per-article fire times, rolling 1h
  updatedAt: string;
}

async function loadState(env: Env, site: string): Promise<SeenState | null> {
  const obj = await env.FEED_BUCKET.get(seenKey(site));
  if (!obj) return null;
  const s = await obj.json<SeenState>().catch(() => null);
  if (!s) return null;
  return { ids: s.ids ?? [], cursor: s.cursor, hashes: s.hashes ?? {}, fires: s.fires ?? [], perPost: s.perPost ?? {}, updatedAt: s.updatedAt };
}

/** Single write per site per run — both pollers mutate one object, so they can't clobber each other. */
async function saveState(env: Env, site: string, s: SeenState): Promise<void> {
  const ids = s.ids.slice(-WP_SEEN_CAP);
  // Retain hashes only for ids we still track, newest-first, capped.
  const keep = new Set(ids.map(String));
  const hashes: Record<string, string> = {};
  for (const id of Object.keys(s.hashes ?? {}).slice(-WP_HASH_CAP)) {
    if (keep.has(id) || Object.keys(hashes).length < WP_HASH_CAP) hashes[id] = s.hashes![id]!;
  }
  await env.FEED_BUCKET.put(
    seenKey(site),
    JSON.stringify({ ids, cursor: s.cursor, hashes, fires: s.fires, perPost: s.perPost, updatedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } }
  );
}

const prune = (ts: number[] | undefined, now: number, windowMs: number) => (ts ?? []).filter((t) => now - t < windowMs);

/** Rolling-window ceilings. Returns why firing is blocked, or null when allowed. */
function breakerReason(s: SeenState, postId: number, now: number): string | null {
  const hour = prune(s.fires, now, 3_600_000).length;
  const day = prune(s.fires, now, 86_400_000).length;
  if (hour >= WP_UPDATE_MAX_PER_HOUR) return `hourly ceiling ${WP_UPDATE_MAX_PER_HOUR} reached`;
  if (day >= WP_UPDATE_MAX_PER_DAY) return `daily ceiling ${WP_UPDATE_MAX_PER_DAY} reached`;
  const perPost = prune(s.perPost?.[String(postId)], now, 3_600_000).length;
  if (perPost >= WP_UPDATE_MAX_PER_POST_PER_HOUR) return `post ceiling ${WP_UPDATE_MAX_PER_POST_PER_HOUR}/h reached`;
  return null;
}

function recordFire(s: SeenState, postId: number, now: number): void {
  s.fires = [...prune(s.fires, now, 86_400_000), now];
  s.perPost = s.perPost ?? {};
  s.perPost[String(postId)] = [...prune(s.perPost[String(postId)], now, 3_600_000), now];
  // Drop per-post history that has fully aged out, so the object can't grow forever.
  for (const [k, v] of Object.entries(s.perPost)) if (v.length === 0) delete s.perPost[k];
}

async function firePayload(env: Env, url: string, post: WpPost, dryRun: boolean, tag: string): Promise<void> {
  const payload = toWebhookPayload(post);
  if (dryRun) {
    console.log(`[${tag}] DRY-RUN would fire id=${post.id} "${payload.Headline}"`);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  console.log(`[${tag}] fired id=${post.id} "${payload.Headline}"`);
}

/** Read-only: fetch recent posts and determine which are new. `bootstrap` = first run for this site. */
async function newPostsForSite(
  env: Env,
  site: SiteName
): Promise<{ bootstrap: boolean; fresh: WpPost[]; posts: WpPost[]; priorIds: number[] }> {
  const posts = await fetchRecentPosts(SITE_WP_BASE[site]);
  const state = await loadState(env, site);
  if (state === null) return { bootstrap: true, fresh: [], posts, priorIds: [] };
  return { bootstrap: false, fresh: selectNewPosts(posts, state.ids), posts, priorIds: state.ids };
}

/**
 * Poll one site: new posts first, then updates, against one shared state object.
 * New-first matters — a brand-new post must reach Airtable before any update for
 * it can fire, and firing it seeds the content hash that suppresses the
 * publish-time summary write-back from looking like an edit.
 */
async function pollSite(env: Env, site: SiteName, dryRun: boolean, updatesOn: boolean): Promise<void> {
  const now = Date.now();
  const posts = await fetchRecentPosts(SITE_WP_BASE[site]);
  let state = await loadState(env, site);

  // --- Bootstrap: record what's already published + hash it, fire nothing ---
  if (state === null) {
    const hashes: Record<string, string> = {};
    for (const p of posts) hashes[String(p.id)] = contentHash(p);
    state = { ids: posts.map((p) => p.id), cursor: new Date(now).toISOString().slice(0, 19), hashes, fires: [], perPost: {}, updatedAt: "" };
    await saveState(env, site, state);
    console.log(`[wp-poll] ${site}: bootstrapped ${state.ids.length} ids + hashes (no webhooks fired)`);
    return;
  }

  let dirty = false;
  const justPublished = new Set<number>();

  // --- New posts ---
  for (const post of selectNewPosts(posts, state.ids)) {
    try {
      await firePayload(env, env.INGEST_WEBHOOK_URL!, post, dryRun, `wp-new ${site}`);
      state.ids.push(post.id);
      state.hashes![String(post.id)] = contentHash(post); // baseline: kills the publish-echo update
      justPublished.add(post.id);
      dirty = true;
    } catch (err) {
      // Left unseen -> retried next cron. The Zap dedups by Link, so a retry can't duplicate.
      console.error(`[wp-new ${site}] id=${post.id} failed: ${(err as Error).message}`);
    }
  }

  // --- Updates ---
  if (updatesOn) {
    const from = new Date(Date.parse(`${state.cursor ?? new Date(now).toISOString().slice(0, 19)}Z`) - WP_UPDATE_LOOKBACK_MIN * 60_000)
      .toISOString()
      .slice(0, 19);
    const modified = await fetchModifiedSince(SITE_WP_BASE[site], from);
    const sel = selectUpdatedPosts(modified, { hashes: state.hashes ?? {}, justPublished, nowMs: now });

    let fired = 0;
    let blocked: string | null = null;
    let oldestFailure: string | undefined;

    for (const post of sel.candidates) {
      if (fired >= WP_UPDATE_MAX_PER_CYCLE) {
        blocked = `per-cycle cap ${WP_UPDATE_MAX_PER_CYCLE}`;
        break; // remainder carried to the next run (cursor is held back below)
      }
      const reason = breakerReason(state, post.id, now);
      if (reason) {
        blocked = reason;
        break;
      }
      try {
        await firePayload(env, env.UPDATE_WEBHOOK_URL!, post, dryRun, `wp-upd ${site}`);
        state.hashes![String(post.id)] = contentHash(post);
        recordFire(state, post.id, now);
        fired++;
        dirty = true;
      } catch (err) {
        console.error(`[wp-upd ${site}] id=${post.id} failed: ${(err as Error).message}`);
        if (!oldestFailure && post.modified_gmt) oldestFailure = post.modified_gmt;
      }
    }

    // Advance the cursor, but never past work we didn't finish — anything blocked
    // or failed must be re-fetched next run rather than silently dropped.
    const unfinished = oldestFailure ?? (blocked ? sel.candidates[fired]?.modified_gmt : undefined);
    const next = unfinished
      ? new Date(Date.parse(`${unfinished}Z`) - 1000).toISOString().slice(0, 19)
      : sel.newestModified;
    if (next && next !== state.cursor) {
      state.cursor = next;
      dirty = true;
    }
    if (blocked) console.warn(`[wp-upd ${site}] THROTTLED after ${fired} fires — ${blocked}`);
    if (sel.candidates.length || sel.skippedUnchanged) {
      console.log(
        `[wp-upd ${site}] scanned=${modified.length} fired=${fired} unchanged=${sel.skippedUnchanged} tooOld=${sel.skippedTooOld} publishEcho=${sel.skippedJustPublished}`
      );
    }
  }

  if (dirty) await saveState(env, site, state);
}

async function pollAndNotify(env: Env): Promise<void> {
  const dryRun = env.WP_DRY_RUN === "true";
  if (!dryRun && !env.INGEST_WEBHOOK_URL) {
    console.error("[wp-poll] enabled but INGEST_WEBHOOK_URL is unset — skipping");
    return;
  }
  const updatesOn = env.WP_UPDATE_POLL_ENABLED === "true";
  if (updatesOn && !dryRun && !env.UPDATE_WEBHOOK_URL) {
    console.error("[wp-upd] update poll enabled but UPDATE_WEBHOOK_URL is unset — updates skipped");
  }
  const doUpdates = updatesOn && (dryRun || !!env.UPDATE_WEBHOOK_URL);
  for (const site of SITES_IN_SCOPE) {
    try {
      await pollSite(env, site, dryRun, doUpdates);
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

    // Keep the private feed host out of search indexes. `/logo.png` is explicitly
    // allowed — it's the channel <image> Google must be able to fetch, and a blanket
    // Disallow would block it (Google honours the most-specific rule).
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\nAllow: /logo.png\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Publisher logo for the channel-level <image>. Public on purpose (no key):
    // Google fetches it directly, and it reveals nothing but the brand mark.
    if (path === "/logo.png") {
      return new Response(LOGO_PNG, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // --- Poller preview (read-only): /gn/poll?key=<secret> — shows what WOULD fire, no side effects ---
    if (path === "/gn/poll") {
      if (url.searchParams.get("key") !== env.FEED_SECRET) return notFound();
      const now = Date.now();
      const report: Record<string, unknown> = {
        flags: {
          newPolling: env.WP_POLL_ENABLED === "true",
          updatePolling: env.WP_UPDATE_POLL_ENABLED === "true",
          dryRun: env.WP_DRY_RUN === "true",
          caps: {
            perCycle: WP_UPDATE_MAX_PER_CYCLE,
            perHour: WP_UPDATE_MAX_PER_HOUR,
            perDay: WP_UPDATE_MAX_PER_DAY,
            perPostPerHour: WP_UPDATE_MAX_PER_POST_PER_HOUR,
          },
        },
      };
      for (const site of SITES_IN_SCOPE) {
        try {
          const { bootstrap, fresh, posts } = await newPostsForSite(env, site);
          if (bootstrap) {
            report[site] = { bootstrap: true, seenIfActivated: posts.length };
            continue;
          }
          const state = (await loadState(env, site))!;
          const from = new Date(
            Date.parse(`${state.cursor ?? new Date(now).toISOString().slice(0, 19)}Z`) - WP_UPDATE_LOOKBACK_MIN * 60_000
          )
            .toISOString()
            .slice(0, 19);
          const modified = await fetchModifiedSince(SITE_WP_BASE[site], from);
          const sel = selectUpdatedPosts(modified, {
            hashes: state.hashes ?? {},
            justPublished: new Set(fresh.map((p) => p.id)),
            nowMs: now,
          });
          report[site] = {
            newWouldFire: fresh.map((p) => ({ id: p.id, headline: toWebhookPayload(p).Headline })),
            updates: {
              cursor: state.cursor,
              scanned: modified.length,
              wouldFire: sel.candidates.map((p) => ({ id: p.id, modified: p.modified_gmt, headline: toWebhookPayload(p).Headline })),
              // High `unchanged` is the loop guard working: Zapier's summary
              // write-back bumps `modified` without changing anything we send.
              skipped: {
                unchanged: sel.skippedUnchanged,
                tooOld: sel.skippedTooOld,
                publishEcho: sel.skippedJustPublished,
              },
              firesLastHour: prune(state.fires, now, 3_600_000).length,
              firesLastDay: prune(state.fires, now, 86_400_000).length,
              baselineHashes: Object.keys(state.hashes ?? {}).length,
            },
          };
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
