export type SiteName = "ARLnow" | "ALXnow" | "FFXnow";

/** Normalized article, mapped from the Airtable O&O row. */
export interface ArticleRecord {
  id: string; // Airtable record id
  uniqueId: string; // e.g. "pe042428"
  site: SiteName | string;
  headline: string;
  link: string; // canonical article URL
  publicationTime: string; // ISO UTC
  lastUpdated?: string; // ISO UTC
  author?: string;
  rssDescription?: string;
  articleHtml?: string; // full body (HTML) -> content:encoded
  articlePlain?: string; // stripped fallback
  fullResImage?: string; // preferred (large)
  imageUrl?: string; // fallback (S3)
  photoCaption?: string;
  category?: string; // free-text comma list
  deleteFromFeed: boolean; // "Delete from Google Feed" checkbox
}
