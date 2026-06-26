import { BASE_ID, TABLE_ID, FIELD_IDS } from "./config";
import type { ArticleRecord, SiteName } from "./types";

const API = "https://api.airtable.com/v0";
const PROJECTION = Object.values(FIELD_IDS);

interface AirtableRow {
  id: string;
  fields: Record<string, unknown>;
}

export interface FetchOpts {
  token: string;
  filterByFormula?: string;
  sortFieldId?: string;
  sortDir?: "asc" | "desc";
  pageSize?: number;
}

/** Fetch + map all matching rows (handles pagination). */
export async function fetchArticles(opts: FetchOpts): Promise<ArticleRecord[]> {
  const rows: AirtableRow[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`${API}/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set("returnFieldsByFieldId", "true");
    url.searchParams.set("pageSize", String(opts.pageSize ?? 100));
    for (const f of PROJECTION) url.searchParams.append("fields[]", f);
    if (opts.filterByFormula) url.searchParams.set("filterByFormula", opts.filterByFormula);
    if (opts.sortFieldId) {
      url.searchParams.set("sort[0][field]", opts.sortFieldId);
      url.searchParams.set("sort[0][direction]", opts.sortDir ?? "desc");
    }
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { records: AirtableRow[]; offset?: string };
    rows.push(...data.records);
    offset = data.offset;
  } while (offset);

  return rows.map(mapRow);
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "object" && v !== null && "name" in (v as Record<string, unknown>)) {
    return String((v as { name: unknown }).name);
  }
  return String(v);
}

export function mapRow(r: AirtableRow): ArticleRecord {
  const f = r.fields;
  const g = (id: string) => f[id];
  return {
    id: r.id,
    uniqueId: str(g(FIELD_IDS.uniqueId)) ?? r.id,
    site: (str(g(FIELD_IDS.site)) ?? "") as SiteName,
    headline: str(g(FIELD_IDS.headline)) ?? "",
    link: str(g(FIELD_IDS.link)) ?? "",
    publicationTime: str(g(FIELD_IDS.publicationTime)) ?? "",
    lastUpdated: str(g(FIELD_IDS.lastUpdated)),
    author: str(g(FIELD_IDS.author)),
    rssDescription: str(g(FIELD_IDS.rssDescription)),
    articleHtml: str(g(FIELD_IDS.articleHtml)),
    articlePlain: str(g(FIELD_IDS.articlePlain)),
    fullResImage: str(g(FIELD_IDS.fullResImage)),
    imageUrl: str(g(FIELD_IDS.imageUrl)),
    photoCaption: str(g(FIELD_IDS.photoCaption)),
    category: str(g(FIELD_IDS.category)),
    deleteFromFeed: Boolean(g(FIELD_IDS.deleteFromFeed)),
  };
}
