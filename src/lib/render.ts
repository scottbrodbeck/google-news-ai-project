import type { ArticleRecord } from "./types";
import { sanitizeArticleHtml } from "./sanitize";
import { toRFC822, toISO8601Offset } from "./dates";
import { GENRE_RULES } from "./config";

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** CDATA wrap, guarding any literal "]]>" in the content. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function deriveGenre(category?: string): string | undefined {
  if (!category) return undefined;
  for (const [re, val] of GENRE_RULES) if (re.test(category)) return val;
  return undefined;
}

function chooseImage(a: ArticleRecord): string | undefined {
  return a.fullResImage || a.imageUrl || undefined;
}

/** content:encoded body with fallback chain: HTML -> plain -> rss description. */
function contentHtml(a: ArticleRecord): string {
  const cleaned = sanitizeArticleHtml(a.articleHtml);
  if (cleaned) return cleaned;
  if (a.articlePlain) {
    return a.articlePlain
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${xmlEscape(p)}</p>`)
      .join("\n");
  }
  if (a.rssDescription) return `<p>${xmlEscape(a.rssDescription)}</p>`;
  return "";
}

export interface RenderOpts {
  includeImages: boolean; // live feed: true; archive: false
  emitTombstones: boolean; // live feed: true. archive: false — retracted articles are omitted, not tombstoned
}

/**
 * Render one <item>. Returns "" for items that should be skipped
 * (no usable content). A checked "Delete from Google Feed" record renders
 * as a minimal tombstone (flag wins over normal rendering).
 */
export function renderItem(a: ArticleRecord, opts: RenderOpts): string {
  if (a.deleteFromFeed) {
    // Archive omits retracted articles entirely; the live feed emits a tombstone.
    if (!opts.emitTombstones) return "";
    return [
      "    <item>",
      `      <title>${xmlEscape(a.headline)}</title>`,
      `      <link>${a.link}</link>`,
      `      <guid>${a.link}</guid>`,
      a.publicationTime ? `      <pubDate>${toRFC822(a.publicationTime)}</pubDate>` : "",
      "      <licensed_news:deleted>yes</licensed_news:deleted>",
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const body = contentHtml(a);
  if (!body) return "";

  const lines: string[] = [
    "    <item>",
    `      <title>${xmlEscape(a.headline)}</title>`,
    `      <link>${a.link}</link>`,
    `      <guid>${a.link}</guid>`,
    `      <pubDate>${toRFC822(a.publicationTime)}</pubDate>`,
  ];
  if (a.rssDescription) lines.push(`      <description>${xmlEscape(a.rssDescription)}</description>`);
  if (a.author) lines.push(`      <dcterms:creator>${xmlEscape(a.author)}</dcterms:creator>`);
  if (a.lastUpdated) lines.push(`      <dcterms:modified>${toISO8601Offset(a.lastUpdated)}</dcterms:modified>`);
  const genre = deriveGenre(a.category);
  if (genre) lines.push(`      <licensed_news:genre>${genre}</licensed_news:genre>`);
  lines.push(`      <content:encoded>${cdata(body)}</content:encoded>`);

  if (opts.includeImages) {
    const img = chooseImage(a);
    if (img) {
      if (a.photoCaption) {
        lines.push(`      <media:content url="${xmlEscape(img)}" medium="image">`);
        lines.push(`        <media:title>${xmlEscape(a.photoCaption)}</media:title>`);
        lines.push("      </media:content>");
      } else {
        lines.push(`      <media:content url="${xmlEscape(img)}" medium="image"/>`);
      }
    }
  }

  lines.push("    </item>");
  return lines.join("\n");
}

export interface FeedMeta {
  title: string;
  link: string;
  description: string;
}

function head(meta: FeedMeta, lastBuild: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:licensed_news="https://www.google.com/schemas/rss-licensed-news/" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
  <channel>
    <title>${xmlEscape(meta.title)}</title>
    <link>${xmlEscape(meta.link)}</link>
    <description>${xmlEscape(meta.description)}</description>
    <language>en</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>`;
}

const TAIL = `  </channel>
</rss>
`;

/** Build a complete feed document from a set of articles. */
export function buildFeed(articles: ArticleRecord[], meta: FeedMeta, opts: RenderOpts): string {
  const items = articles.map((a) => renderItem(a, opts)).filter(Boolean);
  return [head(meta, toRFC822(new Date())), ...items, TAIL].join("\n");
}
