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
