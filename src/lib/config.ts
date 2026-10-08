import type { SiteName } from "./types";

export const BASE_ID = "appZn7eNiJ4BO89G1";
export const TABLE_ID = "tblrMZhmQKluhERnP"; // O&O

/** Field IDs — used for projection (Airtable `fields[]` + returnFieldsByFieldId=true). */
export const FIELD_IDS = {
  headline: "fldWJiio2QJmUHrMS",
  author: "fldeLfqPyDko2MAW2",
  link: "fld4bmk2Zij9LEZFT",
  articleHtml: "fldNWjuUjuNfH43dj", // "Article" (HTML)
  articlePlain: "fldgwb5g2xgJfrNLM", // "Article (plain text)"
  rssDescription: "fldSrhozLD5HMBBqL",
  category: "fldIrqLAx1zVwCdAt",
  publicationTime: "fldTVGGblNLDfPnzm",
  lastUpdated: "fldHISu51SechhNL3",
  imageUrl: "fld0B5ZOSb8RP42UF", // S3 (smaller)
  fullResImage: "fldiNU1IHfGz3u82H", // WordPress original (large, preferred)
  photoCaption: "fldkvTVxpmHPwJCg2",
  site: "fldoQadEASnOPqeZN",
  uniqueId: "fldZTzAp6Jca0amiX",
  deleteFromFeed: "fldDA1Dg18waeRqeJ", // "Delete from Google Feed" checkbox
} as const;

/** Field NAMES — used inside filterByFormula, which references {Field Name}. */
export const FIELD_NAMES = {
  site: "Site",
  publicationTime: "Publication time",
  lastUpdated: "Last Updated",
  deleteFromFeed: "Delete from Google Feed",
} as const;

export const SITES_IN_SCOPE: readonly SiteName[] = ["ARLnow", "ALXnow", "FFXnow"];

/**
 * Publisher logos for the channel-level <image> (Google's branding request).
 * These are each site's WordPress site icon at full resolution (512x512 PNG) —
 * the `site_icon_url` from `/wp-json/`, i.e. the uncropped original rather than
 * a -32x32/-180x180 derivative. Used per-file by the archive.
 */
export const SITE_LOGO: Record<SiteName, string> = {
  ARLnow: "https://www.arlnow.com/wp-content/uploads/2021/04/cropped-arl-only-square-blue.png",
  ALXnow: "https://www.alxnow.com/files/2022/01/cropped-new-alxnow-logo-square-alx-only2.png",
  FFXnow: "https://www.ffxnow.com/files/2021/07/cropped-ffxnow-site-logo-square.png",
};

/**
 * licensed_news:genre derivation from the free-text Category field.
 * First match wins; if nothing matches, the element is omitted.
 * Allowed Google values: PressRelease, Satire, Blog, OpEd, Opinion, Other.
 */
export const GENRE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bop-?ed\b/i, "OpEd"],
  [/\bopinion\b/i, "Opinion"],
  [/\bpress\s*release\b/i, "PressRelease"],
  [/\bsatire\b/i, "Satire"],
  [/\bblog\b/i, "Blog"],
];
