import { Parser } from "htmlparser2";

/**
 * Produce clean HTML for <content:encoded>. Per Google's spec, content:encoded
 * is article TEXT only — no images, scripts, iframes, or embeds.
 *
 * Pure-JS (htmlparser2), so it runs identically in the Worker and the Node
 * archive script. If wrangler ever flags this for the Worker bundle, the
 * fallback is a Cloudflare HTMLRewriter implementation (see CLAUDE.md).
 */

// Tags we keep (rebuilt without attributes, except <a href>).
const KEEP = new Set(["p", "a", "ul", "ol", "li", "strong", "em", "b", "i", "h2", "h3", "h4", "blockquote", "br"]);
// Tags whose entire subtree is dropped (tag + contents).
const DROP_SUBTREE = new Set(["script", "style", "iframe", "noscript", "form", "svg", "video", "audio", "object", "embed", "figure"]);
// Void tags dropped outright (no content to keep).
const DROP_VOID = new Set(["img", "source", "input", "button"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeArticleHtml(html: string | undefined): string {
  if (!html) return "";
  let out = "";
  let skip = 0; // depth inside a dropped subtree

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        const name = rawName.toLowerCase();
        if (skip > 0) {
          if (DROP_SUBTREE.has(name)) skip++;
          return;
        }
        if (DROP_SUBTREE.has(name)) {
          skip = 1;
          return;
        }
        if (DROP_VOID.has(name)) return;
        if (!KEEP.has(name)) return; // unknown tag: drop tag, keep its text
        if (name === "a") {
          const href = attribs.href;
          out += href ? `<a href="${esc(href)}">` : "<a>";
        } else if (name === "br") {
          out += "<br />";
        } else {
          out += `<${name}>`;
        }
      },
      ontext(text) {
        if (skip > 0) return;
        out += esc(text);
      },
      onclosetag(rawName) {
        const name = rawName.toLowerCase();
        if (skip > 0) {
          if (DROP_SUBTREE.has(name)) skip--;
          return;
        }
        if (DROP_VOID.has(name) || name === "br") return;
        if (KEEP.has(name)) out += `</${name}>`;
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();
  return out
    .replace(/<p>\s*<\/p>/g, "") // drop empties left behind by stripped embeds (e.g. a <p> that held only a poll <script>)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
