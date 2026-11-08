# Lab Paper Portal

A members-only web portal where the lab keeps its **paper library**, develops **project ideas** over time, and sees how the two connect in a **knowledge graph**.

- **Hosting:** a static site on GitHub Pages (this repository, no build step).
- **Logins and data:** [Supabase](https://supabase.com), free tier. It provides the Postgres database and sign-in (GitHub or an emailed link).
- **Access:** only emails on the lab's allowlist can read or write anything. This is enforced inside the database by Postgres Row Level Security, not by the web page.

## Features

| Area | What it does |
|---|---|
| **Papers** | Add by DOI, PMID, PMCID or arXiv ID, with metadata fetched from Crossref, Europe PMC and DataCite. Search Europe PMC (PubMed, PMC, bioRxiv/medRxiv) from inside the portal. Full-text search of the library, plus tags. Each member keeps their own note, 1–5 rating and reading status (to read / reading / read) per paper, visible to the whole lab. BibTeX export of any filtered list. |
| **Import** | Bulk import of Zotero, Mendeley or EndNote exports (BibTeX or RIS). Papers already in the library (same DOI, PMID, arXiv ID or title) are matched, not duplicated. Tags and project links apply to all papers in the file, new or existing. Empty fields on existing papers can be filled in from the file, without overwriting anything. A project can be chosen, or created, for the whole file; each project page has an **Import file into project** button. |
| **Projects** | A Kanban board by status (idea → exploring → pilot → active → paused → completed → archived). Each project has structured fields: summary, hypothesis, rationale, aims, open questions, next steps. **Every edit is saved as a version, with a "what changed and why" note, and any two versions can be compared word by word.** There is a dated timeline of updates (results, decisions). Papers link to projects with a typed relation: background / supports / contradicts / method / dataset / inspiration. If two people edit the same project at once, the second save is refused rather than overwriting the first. |
| **Paper links** | One click (**Import → Link papers automatically**) builds links among library papers. **Cites:** from OpenAlex reference lists. **Shared references:** bibliographic coupling, at least *k* references in common, score = shared/√(nA·nB). **Similar wording:** TF-IDF cosine of title + abstract; lexical only. Each paper page lists its related papers, and members can add their own links with a note. Automatic links are rebuilt on each run; links added by hand are kept. |
| **Insights** | Four focused views built from OpenAlex metadata. **Topic trends:** heatmap of primary topic/subfield/field (or lab tag) × year, as counts or share of each year; click a topic to compare the library's trend with the whole literature (both indexed to their own mean = 100). **Countries & institutes:** heatmap with whole counting by affiliation. **Collaborative groups:** co-authorship network with Louvain communities and group summaries; papers with >30 authors are excluded from the links. **Missing works:** works cited by ≥2 library papers, recent works citing ≥2 library papers, and OpenAlex related works, each with one-click Add. |
| **Paper suggestions for projects** | Each project's Papers tab ranks library papers by word overlap between the project's text and each paper's title and abstract (TF-IDF), project tags found in the paper's tags, OpenAlex topics, keywords or MeSH terms, and citation or shared-reference links to papers already linked to the project. The reasons are shown for each suggestion; one-click Link or Dismiss. New projects open on this tab. |
| **Technologies** (Tech tab) | Commercial platforms, kits and software, added by name or product-page link, with vendor, category, aliases, linked projects and notes. **Literature:** Europe PMC full-text search for the product name, with recent papers, most-cited papers and a papers-per-year chart; Check now, plus the daily job. **Technical updates:** the daily job watches the product page and shows the passages that appeared, and reads the vendor's news/RSS feed, auto-detected where possible. Lab members can add notes. |
| **Papers of direct relevance** | A curated shortlist at the top of each project's Overview, each with relation and a "why it matters" note. Add by pasting a link, DOI or PMID, pick from the library, or ☆ a paper on the Papers tab. |
| **Add by web link** | Paste any article URL (Import page or a project's direct-relevance box). The DOI/PMID is read from the link itself, from publisher patterns (Nature IDs, Elsevier PII via Crossref), from the page's citation tags via the optional `resolve-url` function, or finally from a Crossref title search where you pick the match. |
| **Graph** | An interactive network of papers, projects, concepts (tags) and people. Filter by node type, hide rarely used concepts, double-click a node to show only its neighbourhood (1–4 hops), and click through to a paper or project. |
| **Admin** | Manage the allowlist, approve people who are waiting, and set roles (member/admin). |

## One-time setup (about 20 minutes)

### 1. Create the Supabase project
1. Sign up at https://supabase.com and create a project. Pick the **EU (London or Frankfurt)** region for UK/EU data residency.
2. Open **SQL Editor**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and run it.
3. Make yourself the first admin by running this in the SQL Editor:
   ```sql
   insert into public.allowlist (email, role) values ('your.email@institute.ac.uk', 'admin')
     on conflict (email) do update set role = 'admin';
   ```
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**. Never use the `service_role` key in the site.

### 2. Configure sign-in (Supabase → Authentication)
- **URL Configuration:** set **Site URL** to `https://wanglab-ci.github.io/paper_database/` and add the same URL under **Redirect URLs**.
- **GitHub sign-in (recommended):** at GitHub → Settings → Developer settings → OAuth Apps → New, set the callback URL to `https://<project-ref>.supabase.co/auth/v1/callback`. Paste the app's Client ID and Secret into Supabase under **Providers → GitHub**. Members are matched by their GitHub **primary email**.
- **Email link:** this is enabled by default, but Supabase's built-in mail server only sends a handful of emails per hour and only to your own team. For real use, set up **custom SMTP** under **Authentication → Emails → SMTP settings**, using your institute's mail server or a service such as Resend, Postmark or SendGrid.
- **Optional:** to stop strangers creating accounts at all, turn off "Allow new users to sign up" and invite people from **Authentication → Users → Invite**. The allowlist already blocks any data access for unlisted users.

### 3. Configure GitHub Pages
1. In this repo, go to **Settings → Pages → Source** and choose **GitHub Actions**.
2. Go to **Settings → Secrets and variables → Actions → Variables** and add these repository variables:
   | Variable | Example |
   |---|---|
   | `SUPABASE_URL` | `https://abcd1234.supabase.co` |
   | `SUPABASE_ANON_KEY` | `eyJhbGciOi…` or `sb_publishable_…` |
   | `LAB_NAME` | `Wang Lab` |
   | `AUTH_PROVIDERS` | `github,email` (any of `github`, `google`, `email`) |
3. Push to `main`, or run the workflow from the Actions tab. The site goes live at `https://wanglab-ci.github.io/paper_database/`.

> The anon key is public by design; every request is checked by the RLS policies in `schema.sql`. Keep the repository free of real data. All lab content lives only in Supabase.

### 4. Add members
Sign in, open **Admin**, and add each member's email. People who sign in before being added appear under "Waiting for access" and can be approved with one click.

## Importing your Zotero library
In Zotero, right-click a collection → **Export Collection…** → format **BibTeX** (or RIS) → save. Then in the portal open **Import → Bulk import**, choose the file, optionally add a tag such as `zotero`, and click Import. Re-importing the same file is safe because duplicates are skipped.

## Who can do what

| | member | admin |
|---|---|---|
| Read everything | ✓ | ✓ |
| Add/edit papers, tags, projects, links | ✓ | ✓ |
| Edit own notes, ratings and timeline posts | ✓ | ✓ |
| Delete papers or projects | ones they created / lead | all |
| Manage allowlist and roles | | ✓ |

Project edits are never lost. All versions are kept in `project_versions`, and the database rejects any direct writes to that table.

## Backups
Supabase's free tier keeps daily backups for a limited period. For a lab archive, use **Database → Backups** or run `pg_dump` with the connection string from Project Settings → Database. The portal's **Export BibTeX** button exports the library.

## Development

```
site/                 static web app (no build step)
  index.html
  css/style.css
  js/app.js           auth gate + router
  js/db.js            Supabase client & helpers
  js/metadata.js      DOI / PMID / arXiv lookup
  js/bibtex.js        BibTeX/RIS parsing, BibTeX export
  js/diff.js          word-level diff for project history
  js/views/*.js       home, papers, projects, graph, import, admin
supabase/schema.sql   tables, triggers, RLS (idempotent)
tests/                parser unit tests, SQL/RLS tests, browser smoke test
```

- Run locally: put your Supabase URL and key in `site/js/config.js` (don't commit them), run `npm run serve`, and add `http://localhost:8000` to Supabase's Redirect URLs.
- `npm test` runs the parser unit tests.
- SQL/RLS tests: against any Postgres 15+, run `psql -f tests/mock_supabase_auth.sql -f supabase/schema.sql -f tests/test_rls.sql`. CI runs this on every push.
- Browser smoke test: `LIBS_DIR=… node tests/e2e/smoke.mjs` drives every page against an in-memory mock of Supabase. See the header of `tests/e2e/smoke.mjs`.

Schema changes: edit `supabase/schema.sql` so it stays idempotent (re-runnable), then re-run it in the SQL Editor.

## Technology tracking (daily job)

The workflow `.github/workflows/track-products.yml` runs daily at 05:17 UTC; you can also start it from the Actions tab with **Run workflow**. It checks each technology for:
- new Europe PMC papers,
- changes on its product page,
- new items in the vendor's news feed.

It writes to Supabase with the project's **secret** key. That key bypasses Row Level Security, so it is stored only as an encrypted GitHub secret and never in the website:

1. Supabase → **Project Settings → API Keys** → copy a **Secret key** (`sb_secret_…`) or the legacy `service_role` key.
2. GitHub → this repository → **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Name: `SUPABASE_SERVICE_KEY`; value: the key.
3. Actions tab → **Track technologies** → **Run workflow** to test it. The log lists each product and what was found.

Without the secret, the job skips itself with a warning. Literature tracking still works from the portal's **Check now** button. Some vendor sites block automated requests; the product page then shows the error, and literature tracking is unaffected.

## Optional: page reader for article links (`resolve-url`)

Most article links are resolved in the browser. Links without a DOI in the URL (e.g. Oxford Academic, some society journals) need the publisher's page to be read, and browsers block that. Deploy the small Edge Function in `supabase/functions/resolve-url/index.ts` to handle them:

1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it `resolve-url` exactly, replace the sample code with the contents of `supabase/functions/resolve-url/index.ts`, and click **Deploy**.
3. Leave **Verify JWT** on. The function also checks that the caller is an approved lab member, and refuses internal addresses.

Without it, such links fall back to a Crossref title search, where you choose the right paper. Some publishers block automated requests; those links also fall back to the title search.
