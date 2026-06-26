/** RFC822 for pubDate / lastBuildDate, e.g. "Fri, 26 Jun 2026 15:45:56 +0000". */
export function toRFC822(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * ISO 8601 for dcterms:modified, matching Google's example offset form
 * (e.g. "2026-06-26T15:57:25+00:00") rather than the "Z" form.
 */
export function toISO8601Offset(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");
}

const ET_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Local (Eastern) calendar day key "YYYY-MM-DD" for an instant. */
export function easternDayKey(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return ET_DAY.format(d);
}

export function easternYear(input: string | Date): string {
  return easternDayKey(input).slice(0, 4);
}

export interface Quarter {
  label: string; // "2026-Q2"
  year: number;
  q: 1 | 2 | 3 | 4;
  etStart: string; // "2026-04-01"
  etEnd: string; // "2026-06-30"
  fetchFromUTC: string; // ISO, padded -1 day (exact ET-day filtering done in JS)
  fetchToUTC: string; // ISO, padded +1 day
}

const Q_MONTHS: Record<number, [number, number]> = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };
const Q_END_DAY: Record<number, number> = { 1: 31, 2: 30, 3: 30, 4: 31 };

export function quarterOf(year: number, q: 1 | 2 | 3 | 4): Quarter {
  const [startM, endM] = Q_MONTHS[q]!;
  const etStart = `${year}-${String(startM).padStart(2, "0")}-01`;
  const etEnd = `${year}-${String(endM).padStart(2, "0")}-${String(Q_END_DAY[q]!).padStart(2, "0")}`;
  const from = new Date(`${etStart}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${etEnd}T23:59:59Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { label: `${year}-Q${q}`, year, q, etStart, etEnd, fetchFromUTC: from.toISOString(), fetchToUTC: to.toISOString() };
}

export function parseQuarter(s: string): Quarter {
  const m = /^(\d{4})-Q([1-4])$/.exec(s.trim());
  if (!m) throw new Error(`Bad quarter "${s}" — expected e.g. 2026-Q2`);
  return quarterOf(Number(m[1]), Number(m[2]) as 1 | 2 | 3 | 4);
}

export function lastCompletedQuarter(now: Date = new Date()): Quarter {
  const y = Number(easternYear(now));
  const month = Number(easternDayKey(now).slice(5, 7));
  const curQ = Math.ceil(month / 3) as 1 | 2 | 3 | 4;
  return curQ === 1 ? quarterOf(y - 1, 4) : quarterOf(y, (curQ - 1) as 1 | 2 | 3 | 4);
}
