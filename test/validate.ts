/**
 * Validation harness for the rendering pipeline — operationalizes spec §10.
 *
 *   npm test
 *
 * Runs render.ts / sanitize.ts / airtable.ts(mapRow) against a mix of REAL
 * records (pulled from the live Airtable O&O table) and synthetic edge cases,
 * then asserts the spec's QA invariants and well-formedness. Writes sample
 * output to ./out/{live,archive}-sample.xml for eyeballing. Exits non-zero on
 * any failure so it can gate a deploy.
 *
 * No network / no secrets — pure rendering over in-memory fixtures.
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { XMLValidator, XMLParser } from "fast-xml-parser";

import { buildFeed, type FeedMeta } from "../src/lib/render";
import { mapRow } from "../src/lib/airtable";
import { FIELD_IDS } from "../src/lib/config";
import { toRFC822, toISO8601Offset, easternDayKey, quarterOfDay } from "../src/lib/dates";
import type { ArticleRecord } from "../src/lib/types";

// ---- tiny test runner -------------------------------------------------------
let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

const ALLOWED_HOSTS = new Set(["www.arlnow.com", "www.alxnow.com", "www.ffxnow.com"]);
const RFC822 = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

// ---- fixtures ---------------------------------------------------------------
// #1 REAL record recTgT3LVndRnHTVY — poll article with script/noscript/iframe
// embeds and curly-quote Unicode. The spec's canonical "must be sanitized" case.
const poll: ArticleRecord = {
  id: "recTgT3LVndRnHTVY",
  uniqueId: "pe042428",
  site: "ARLnow",
  headline: "Poll: The best cooking classes in Arlington",
  link: "https://www.arlnow.com/2026/06/26/poll-the-best-cooking-classes-in-arlington/",
  publicationTime: "2026-06-26T15:45:56.000Z",
  lastUpdated: "2026-06-26T15:57:25.000Z",
  rssDescription:
    "Whether you want to master fresh pasta, finally conquer a sourdough loaf or just spend a fun evening at the stove, Arlington has no shortage of places to sharpen your skills in the kitchen.",
  category: "Opinion,Arlnow Reader Choice",
  fullResImage: "https://www.arlnow.com/wp-content/uploads/2026/06/Jun-26-2026_-Cooking-Classes-in-Arlington-VA.jpg",
  imageUrl: "https://lnnhub.s3.us-east-1.amazonaws.com/img/arlnow-42428.jpg",
  deleteFromFeed: false,
  articleHtml: `<p>Whether you want to master fresh pasta, finally conquer a sourdough loaf or just spend a fun evening at the stove, Arlington has no shortage of places to sharpen your skills in the kitchen.</p>
<p>Here are the nominees for “Best Cooking Classes in Arlington” as part of our <a href="https://www.arlnow.com/readers-choice/" target="_blank" rel="nofollow noopener">ARLnow Readers’ Choice awards</a>.</p>
<p><script>var pd_tags = new Array;pd_tags["17158917-src"]="poll-oembed-simple";</script><script type="text/javascript" charset="utf-8" src="https://secure.polldaddy.com/p/17158917.js"></script><noscript><iframe title="best cooking classes" src="https://poll.fm/17158917/embed" frameborder="0" class="cs-iframe-embed"></iframe></noscript></p>
<p>Two weeks ago, we voted on the <a href="https://www.arlnow.com/2026/06/12/poll/" target="_blank" rel="nofollow noopener">Best Pet Boarding in Arlington</a>. The results are now official:</p>
<ol>
<li><strong>Two Way Pet Services</strong></li>
<li><strong>Canine Cardio</strong></li>
</ol>`,
};

// #2 REAL record recHxuCDG11F8cyzM — has a Photo caption (with credit).
const captioned: ArticleRecord = {
  id: "recHxuCDG11F8cyzM",
  uniqueId: "ps042424",
  site: "FFXnow",
  headline: "Planning underway for new linear park in north Fairfax City",
  link: "https://www.ffxnow.com/2026/06/26/planning-underway-for-new-linear-park-in-north-fairfax-city/",
  publicationTime: "2026-06-26T14:00:18.000Z",
  lastUpdated: "2026-06-26T14:10:58.000Z",
  category: "News,Northfax,Parks",
  fullResImage: "https://www.ffxnow.com/files/2026/06/Screenshot-2026-06-26-095753.jpg",
  imageUrl: "https://lnnhub.s3.us-east-1.amazonaws.com/img/ffxnow-42424.jpg",
  photoCaption:
    "A mock-up of what stormwater management facilities in the future Northfax Linear Park might look like during peak rainfall (via City of Fairfax)",
  deleteFromFeed: false,
  articleHtml: `<p>The City of Fairfax is planning a new <a href="https://www.ffxnow.com/tag/parks/">linear park</a> in the Northfax area.</p><p>Construction could begin next year.</p>`,
};

// #3 article with an author but NO image (older records lack Full Res Image).
const noImage: ArticleRecord = {
  id: "recNoImage000000A",
  uniqueId: "ni000001",
  site: "ARLnow",
  headline: "County board approves budget",
  link: "https://www.arlnow.com/2026/06/26/county-board-approves-budget/",
  publicationTime: "2026-06-26T12:00:00.000Z",
  lastUpdated: "2026-06-26T12:30:00.000Z",
  author: "Jane Reporter",
  category: "News",
  deleteFromFeed: false,
  articleHtml: `<p>The board voted 5-0. <a href="https://www.arlnow.com/budget/">Full details here.</a></p>`,
};

// #4 tombstone — Delete from Google Feed checked.
const tombstone: ArticleRecord = {
  id: "recTombstone00000",
  uniqueId: "tb000001",
  site: "ALXnow",
  headline: "Retracted story",
  link: "https://www.alxnow.com/2026/06/26/retracted-story/",
  publicationTime: "2026-06-25T10:00:00.000Z",
  deleteFromFeed: true,
  articleHtml: `<p>This should never appear.</p>`,
};

// #5 content with <, >, &, and a stray ]]> + img/figure/script to strip.
const special: ArticleRecord = {
  id: "recSpecialChars00",
  uniqueId: "sc000001",
  site: "FFXnow",
  headline: 'Mayor: "growth & change" ahead',
  link: "https://www.ffxnow.com/2026/06/26/special-chars/",
  publicationTime: "2026-06-26T09:00:00.000Z",
  deleteFromFeed: false,
  articleHtml: `<p>Math: 5 > 3 & 2 < 4. End ]]> marker.</p><figure><img src="x.jpg"><figcaption>cap</figcaption></figure><script>alert(1)</script><p>After.</p>`,
};

// #6 no HTML — falls back to plain text, which must be wrapped + escaped.
const plainOnly: ArticleRecord = {
  id: "recPlainText00000",
  uniqueId: "pt000001",
  site: "ALXnow",
  headline: "Plain text only",
  link: "https://www.alxnow.com/2026/06/26/plain-text-only/",
  publicationTime: "2026-06-26T08:00:00.000Z",
  deleteFromFeed: false,
  articlePlain: "First paragraph.\n\nSecond paragraph with > and &.",
};

// #7 real LNN image-gallery markup — nav chrome ("Previous Image"/"1/2") and
// javascript: links must be stripped; the article paragraph must survive.
const gallery: ArticleRecord = {
  id: "recGallery0000001",
  uniqueId: "ga000001",
  site: "ALXnow",
  headline: "Photos: new mural downtown",
  link: "https://www.alxnow.com/2026/06/26/photos-new-mural-downtown/",
  publicationTime: "2026-06-26T11:00:00.000Z",
  deleteFromFeed: false,
  articleHtml: `<div class="lnn-gallery js-gallery block w-0 min-w-full mb-6"><div class="gallery__slider"><figure class="!mb-0"><div class="gallery__img"><img src="https://www.alxnow.com/files/2026/06/mural-1.jpg"/></div><figcaption class="gallery__meta hidden"><div class="meta__caption">The new mural (staff photo)</div></figcaption></figure></div><div class="gallery__footer"><div class="gallery__nav"><a class="nav__prev" href="javascript:void(0);" role="button"><span class="sr-only">Previous Image</span><svg viewBox="0 0 20 20"><path d="M1 2z"></path></svg></a><span class="nav__count">1/2</span><a class="nav__next" href="javascript:void(0);" role="button"><span class="sr-only">Next Image</span><svg viewBox="0 0 20 20"><path d="M1 2z"></path></svg></a></div></div></div>
<p>A vibrant new mural appeared downtown this week, painted by <a href="https://www.alxnow.com/artists/">local artists</a>.</p>`,
};

// #8 nothing usable — must be skipped entirely.
const empty: ArticleRecord = {
  id: "recEmpty000000000",
  uniqueId: "em000001",
  site: "ALXnow",
  headline: "Empty",
  link: "https://www.alxnow.com/2026/06/26/empty/",
  publicationTime: "2026-06-26T07:00:00.000Z",
  deleteFromFeed: false,
};

const fixtures = [poll, captioned, noImage, tombstone, special, plainOnly, gallery, empty];
const meta: FeedMeta = {
  title: "Local News Now",
  link: "https://feeds.lnn.co/gn/TOKEN.xml",
  description: "Licensed news content from ARLnow, ALXnow and FFXnow.",
};

const live = buildFeed(fixtures, meta, { includeImages: true, emitTombstones: true });
const archive = buildFeed(fixtures, { ...meta, title: "ALXnow" }, { includeImages: false, emitTombstones: false });

mkdirSync("out", { recursive: true });
writeFileSync("out/live-sample.xml", live);
writeFileSync("out/archive-sample.xml", archive);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (n) => n === "item" });
const liveItems: any[] = parser.parse(live).rss.channel.item ?? [];
const archiveItems: any[] = parser.parse(archive).rss.channel.item ?? [];

// ---- well-formedness (spec §10: parse, fail build on errors) ----------------
console.log("\nWell-formedness");
check("live feed parses as well-formed XML", () => {
  const v = XMLValidator.validate(live);
  assert.equal(v, true, JSON.stringify(v));
});
check("archive feed parses as well-formed XML", () => {
  const v = XMLValidator.validate(archive);
  assert.equal(v, true, JSON.stringify(v));
});

// ---- namespaces (CLAUDE.md hard rule: exactly 4, no atom/dc) -----------------
console.log("\nNamespaces");
check("declares content/dcterms/licensed_news/media namespaces", () => {
  for (const ns of ["xmlns:content=", "xmlns:dcterms=", "xmlns:licensed_news=", "xmlns:media="]) {
    assert.ok(live.includes(ns), `missing ${ns}`);
  }
});
check("does NOT declare or use atom: or dc:", () => {
  assert.ok(!/xmlns:atom|<atom:/.test(live), "atom present");
  assert.ok(!/xmlns:dc=|<dc:/.test(live), "dc present");
});

// ---- item selection ---------------------------------------------------------
console.log("\nItem selection");
check("live has 7 items (6 normal + 1 tombstone; empty skipped)", () =>
  assert.equal(liveItems.length, 7)
);
check("archive has 6 items (tombstone omitted + empty skipped)", () =>
  assert.equal(archiveItems.length, 6)
);
check("empty-content article is skipped in both feeds", () => {
  assert.ok(!live.includes("/empty/"), "empty in live");
  assert.ok(!archive.includes("/empty/"), "empty in archive");
});

// ---- content:encoded sanitization (spec §4.4 / §10) -------------------------
console.log("\ncontent:encoded sanitization");
check("no <script>, <iframe>, <noscript>, or <img> survive anywhere in live", () => {
  for (const tag of [/<script/i, /<iframe/i, /<noscript/i, /<img/i]) {
    assert.ok(!tag.test(live), `survived: ${tag}`);
  }
});
check("allowed tags (p, a[href], ol, li, strong) are preserved", () => {
  assert.ok(live.includes("<ol>") && live.includes("<li>"), "list dropped");
  assert.ok(live.includes("<strong>Two Way Pet Services</strong>"), "strong dropped");
  assert.ok(live.includes('<a href="https://www.arlnow.com/readers-choice/">'), "anchor/href dropped");
});
check("empty <p></p> left by a stripped poll embed is removed", () =>
  assert.ok(!live.includes("<p></p>"), "empty paragraph remained")
);
check("<, >, & in body text are entity-escaped (special fixture)", () =>
  assert.ok(live.includes("Math: 5 &gt; 3 &amp; 2 &lt; 4."), "raw </>/& in content")
);
check("CDATA-wrapped content keeps the feed well-formed despite a stray ]]>", () =>
  // covered by the well-formedness check above; assert the body text made it through
  assert.ok(live.includes("End ]]") || live.includes("End ]]&gt;"), "special body missing")
);
check("plain-text fallback wraps + escapes paragraphs", () => {
  assert.ok(live.includes("<p>First paragraph.</p>"), "first para not wrapped");
  assert.ok(live.includes("<p>Second paragraph with &gt; and &amp;.</p>"), "second para not escaped/wrapped");
});
check("image-gallery chrome (nav text, counter, javascript: links) is stripped", () => {
  for (const junk of ["Previous Image", "Next Image", "1/2", "javascript:", "gallery__", "sr-only", "meta__caption"]) {
    assert.ok(!live.includes(junk), `gallery junk leaked: ${junk}`);
  }
  // the actual article paragraph (and its safe link) survives
  assert.ok(live.includes('<p>A vibrant new mural appeared downtown this week, painted by <a href="https://www.alxnow.com/artists/">local artists</a>.</p>'), "gallery article body lost");
});

// ---- images / media (live only) --------------------------------------------
console.log("\nImages & media");
check("live: media:content uses the larger Full Res image", () =>
  assert.ok(
    live.includes('<media:content url="https://www.arlnow.com/wp-content/uploads/2026/06/Jun-26-2026_-Cooking-Classes-in-Arlington-VA.jpg" medium="image"'),
    "full-res image not used"
  )
);
check("live: media:title emitted only when a caption exists", () => {
  assert.ok(live.includes("<media:title>A mock-up of what stormwater"), "caption missing");
  // poll record has an image but no caption -> self-closing media:content, no media:title for it
  assert.ok(live.includes('medium="image"/>'), "expected a caption-less self-closing media:content");
});
check("archive: NO media:* elements at all", () =>
  assert.ok(!/<media:/.test(archive), "media present in archive")
);
check("no-image article omits media:content in live", () => {
  const it = liveItems.find((i) => String(i.link).includes("/county-board-approves-budget/"));
  assert.ok(it && it["media:content"] === undefined, "media:content present for image-less item");
});

// ---- optional elements ------------------------------------------------------
console.log("\nOptional elements");
check("genre derived from free-text Category (Opinion)", () =>
  assert.ok(live.includes("<licensed_news:genre>Opinion</licensed_news:genre>"), "genre not derived")
);
check("dcterms:creator emitted only when Author present", () => {
  const withAuthor = liveItems.find((i) => String(i.link).includes("/county-board-approves-budget/"));
  assert.equal(withAuthor?.["dcterms:creator"], "Jane Reporter");
  const noAuthor = liveItems.find((i) => String(i.link).includes("/poll-the-best-cooking-classes/"));
  // poll has no author
  const pollItem = liveItems.find((i) => String(i.link).includes("/poll-the-best-cooking-classes-in-arlington/"));
  assert.equal(pollItem?.["dcterms:creator"], undefined);
});

// ---- tombstones (spec §4.6) -------------------------------------------------
console.log("\nTombstones");
check("live: retracted article emits licensed_news:deleted=yes on its guid", () => {
  const it = liveItems.find((i) => String(i.guid).includes("/retracted-story/"));
  assert.ok(it, "tombstone item missing");
  assert.equal(it["licensed_news:deleted"], "yes");
});
check("live: tombstone is minimal (no content:encoded, no media)", () => {
  const it = liveItems.find((i) => String(i.guid).includes("/retracted-story/"));
  assert.equal(it["content:encoded"], undefined, "tombstone carried content");
  assert.equal(it["media:content"], undefined, "tombstone carried media");
});
check("archive: retracted article is omitted entirely (not tombstoned)", () =>
  assert.ok(!archive.includes("/retracted-story/"), "retracted leaked into archive")
);

// ---- per-item structural checks (spec §10) ---------------------------------
console.log("\nPer-item structure");
check("every item link is https, on an allowed domain, with no query string", () => {
  for (const it of liveItems) {
    const u = new URL(String(it.link));
    assert.equal(u.protocol, "https:", `${it.link} not https`);
    assert.ok(ALLOWED_HOSTS.has(u.host), `${it.link} host not allowed`);
    assert.equal(u.search, "", `${it.link} has query params`);
  }
});
check("every pubDate is valid RFC822 (+0000)", () => {
  for (const it of liveItems) assert.match(String(it.pubDate), RFC822);
});
check("every dcterms:modified is ISO 8601 with +00:00 offset", () => {
  for (const it of liveItems) {
    if (it["dcterms:modified"] !== undefined) assert.match(String(it["dcterms:modified"]), ISO_OFFSET);
  }
});
check("non-tombstone items have a non-empty content:encoded", () => {
  for (const it of liveItems) {
    if (it["licensed_news:deleted"]) continue;
    assert.ok(it["content:encoded"] && String(it["content:encoded"]).length > 0, `${it.link} empty content`);
  }
});

// ---- airtable mapRow (raw REST shape, returnFieldsByFieldId=true) -----------
console.log("\nAirtable mapRow");
check("maps a populated row: single-select site -> string, checkbox -> bool, caption", () => {
  const r = mapRow({
    id: "recRaw0000000001A",
    fields: {
      [FIELD_IDS.headline]: "Headline",
      [FIELD_IDS.site]: "ARLnow", // raw REST returns the option NAME as a plain string
      [FIELD_IDS.link]: "https://www.arlnow.com/x/",
      [FIELD_IDS.publicationTime]: "2026-06-26T15:45:56.000Z",
      [FIELD_IDS.fullResImage]: "https://www.arlnow.com/img.jpg",
      [FIELD_IDS.photoCaption]: "A caption",
      [FIELD_IDS.deleteFromFeed]: true,
    },
  });
  assert.equal(r.site, "ARLnow");
  assert.equal(r.headline, "Headline");
  assert.equal(r.photoCaption, "A caption");
  assert.equal(r.deleteFromFeed, true);
});
check("absent checkbox -> false, absent/empty optionals -> undefined", () => {
  const r = mapRow({
    id: "recRaw0000000002B",
    fields: {
      [FIELD_IDS.headline]: "H",
      [FIELD_IDS.site]: "FFXnow",
      [FIELD_IDS.link]: "https://www.ffxnow.com/y/",
      [FIELD_IDS.publicationTime]: "2026-06-26T15:45:56.000Z",
      [FIELD_IDS.author]: "   ", // whitespace-only -> undefined
    },
  });
  assert.equal(r.deleteFromFeed, false);
  assert.equal(r.photoCaption, undefined);
  assert.equal(r.author, undefined);
});

// ---- dates (bucketing + quarter math the archive depends on) ---------------
console.log("\nDates");
check("quarterOfDay maps a day to the quarter that contains it", () => {
  assert.equal(quarterOfDay("2026-06-26").label, "2026-Q2");
  assert.equal(quarterOfDay("2026-01-15").label, "2026-Q1");
  assert.equal(quarterOfDay("2026-12-31").label, "2026-Q4");
});
check("easternDayKey buckets UTC instants by America/New_York day (incl. day boundary)", () => {
  assert.equal(easternDayKey("2026-06-26T15:45:56.000Z"), "2026-06-26"); // 11:45 EDT
  assert.equal(easternDayKey("2026-06-26T03:30:00.000Z"), "2026-06-25"); // 23:30 EDT, prior day
});
check("toRFC822 + toISO8601Offset emit the expected formats", () => {
  assert.match(toRFC822("2026-06-26T15:45:56.000Z"), RFC822);
  assert.equal(toISO8601Offset("2026-06-26T15:57:25.000Z"), "2026-06-26T15:57:25+00:00");
});

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("Wrote out/live-sample.xml and out/archive-sample.xml");
