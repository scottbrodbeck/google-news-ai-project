# Operations Guide — Google News AI Pilot (Local News Now)

How to run the licensed-content system for **ARLnow, ALXnow, FFXnow**, organized by what Google needs from you.

**The system runs itself in the cloud.** This is the short list of things a person still does. Most of it is one-time; after that it's one drag-to-Drive per quarter.

---

## ✅ Google requirement 1 — The live feed *(submit once)*

A single combined RSS feed for all three sites (last ~3 days, Google's namespaces), rebuilt every 2 minutes. Already built, deployed, and verified.

- **Feed URL to submit** (the access key is the `?key=` parameter):
  ```
  https://google-news-feed.local-news-now-group.workers.dev/gn/<FEED_PATH_TOKEN>.xml?key=<FEED_SECRET>
  ```
  Use the exact URL you tested. The token and key are stored as Cloudflare Worker secrets and are deliberately **not** in this repo.
- **Where to submit:** Google's news-partner **Contact Us form** (the secure channel from your pilot onboarding). List it as a **query-string API-key** feed.
- **Also:** add the feed-setup teammates to that Google email thread (Google asked for this).
- **After submitting:** nothing ongoing. It refreshes itself and reflects article edits and deletions automatically.

---

## ✅ Google requirement 2 — Google-Extended on the three sites *(once, per site)*

Separate from the feed — this opts your article pages into the AI pilot. Add to the **robots.txt** of **arlnow.com**, **alxnow.com**, and **ffxnow.com**:

```
User-agent: Google-Extended
Allow: /
```

Don't put any `Disallow:` under `Google-Extended`. (The feed host itself returns `Disallow: /` to stay private — that's intentional, leave it.)

---

## ✅ Google requirement 3 — Archive QA sample *(once, before the first full quarter)*

Google reviews one sample day before you send a full quarter.

1. **GitHub → Actions → "Quarterly archive" → Run workflow**, set **sample** = a recent date, e.g. `2026-06-26`. (Or trigger it from your Zapier scheduler.)
2. Get the zip — from the **Slack/email link** the run sends, or the run's **Artifacts**.
3. Upload that one day's folders to Google's **Drive sample folder** and wait for their QA sign-off.

---

## 🔁 Google requirement 4 — Quarterly archive *(every quarter, automatic)*

~5 days after each quarter ends, Zapier triggers the job, it builds the prior quarter, and you get a **Slack/email with a download link**.

**Your one step each quarter:** download the zip → unzip → drag the publication folders into the shared Drive folder **"Google Licensed News - Local News Now."**

- Files come structured the way Google wants: `ARLnow/2026/feed-2026-04-01.xml`, `ALXnow/…`, `FFXnow/…` (text-only, no images).
- Need a specific quarter or a re-run? Actions → Run workflow → **quarter** = `2026-Q2`.
- If a run fails you'll get a Zapier alert — just re-run it from Actions.
- Old zips auto-delete from storage after 90 days; your Drive copy is the permanent record.

---

## 🔁 Day-to-day — pulling an article from Google *(as needed)*

To retract a published article:

- In Airtable, check **"Delete from Google Feed"** on that row.
- The live feed sends Google a deletion marker. **Leave the box checked ~2 weeks**, then it ages out on its own. Don't delete the Airtable row while you want it pulled.

*Edits need no action* — change the article in Airtable as usual; the feed reflects it within minutes.

---

## 🔍 Health check *(anytime)*

Open the feed URL in a browser. You should see XML listing recent articles from all three sites, with a `<lastBuildDate>` from within the last few minutes. That's everything working.

---

## Where things live *(for when you need to touch something)*

| Need to… | Go to |
|---|---|
| Re-run / sample the archive | GitHub → Actions → "Quarterly archive" |
| Change the schedule or notifications | Zapier |
| Rotate the feed key, see secrets | Cloudflare → Workers → `google-news-feed` |
| Pull/edit article content | Airtable (O&O table) |
