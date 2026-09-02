# Search Queries for Job Scraper

<!-- SETUP: Customize these queries based on your skills, target roles, and location -->

## Installed portal CLIs (primary for `/scrape`)

`/scrape` discovers every portal skill under `.agents/skills/*/SKILL.md` and runs its CLI first. Installed CLIs: `linkedin-search` and `freehire-search`. The four Danish portal demos (jobbank, jobdanmark, jobindex, jobnet) ship disabled and are not relevant to this search (Indonesia market) - leave them off.

**JobStreet is not a built-in CLI in this framework.** It has no dedicated skill, so `/scrape` falls back to the WebSearch `site:` queries below for it. If this becomes a primary channel, consider `/add-portal` to scaffold a dedicated `jobstreet-search` skill later.

The `site:` query templates in this file are the **WebSearch fallback** — for portals without a CLI (JobStreet), company career pages, or when a CLI fails.

**Language scope:** write every query category in every language listed in your CLAUDE.md Languages table (Indonesian and English). A posting requiring a language you have *not* declared, as a job condition, is excluded before scoring; a posting requiring a *higher level* than you declared in a language you *do* work in is flagged for your own judgment, not excluded — see `04-job-evaluation.md`'s Language Gate, the single source of truth for this rule.

**Internship focus:** this profile is searching for an internship (magang), not a full-time role. Prefer queries and postings that say "internship", "intern", "magang", "kerja praktik/KP", or "co-op" over generic full-time listings. `/apply` and `/rank` should weigh internship-level expectations, not full professional experience, per `04-job-evaluation.md`'s Experience Match notes.

## Search Sites

Primary (Indonesia market):
- **id.jobstreet.com** (formerly jobstreet.co.id, now under SEEK) - Indonesia's largest general job board; searched via WebSearch fallback (no CLI)
- **linkedin.com/jobs** - LinkedIn job listings (filter: Indonesia); covered by `linkedin-search` CLI
- **freehire.me** - aggregates ~50 ATS platforms globally; covered by `freehire-search` CLI, may surface Indonesian/regional companies using Greenhouse, Lever, etc.

Secondary (company career pages via Google):
- Direct Google searches with `site:` filters for known target companies (e.g. Astra Group entities, IoT/AI startups)

## Query Categories

Queries are grouped by priority. Write **each category in both Indonesian and English**. Combine each query with your location terms where the site supports it.

### Priority 1: AI/IoT & Embedded Systems Engineering Internship

These match your strongest and most desired career direction.

```
site:id.jobstreet.com "AI Engineer Intern" Indonesia
site:id.jobstreet.com "IoT Engineer Intern" Indonesia
site:id.jobstreet.com "magang AI" OR "magang IoT" Indonesia
site:id.jobstreet.com "Embedded Systems Intern" Indonesia
site:linkedin.com/jobs "AI Engineer Intern" OR "Machine Learning Intern" Indonesia
site:linkedin.com/jobs "IoT Engineer" magang Indonesia
```

### Priority 2: Computer Vision, MLOps & Industrial Automation

These match your domain expertise.

```
site:id.jobstreet.com "computer vision" magang OR intern Indonesia
site:id.jobstreet.com "automation engineer" intern OR magang Indonesia
site:id.jobstreet.com "industrial automation" magang Indonesia
site:linkedin.com/jobs "computer vision" intern Indonesia
site:linkedin.com/jobs "MLOps" intern Indonesia
```

### Priority 3: Fullstack / Software Engineering Internship

Adjacent roles you could pivot into, based on the Next.js/fullstack internship experience.

```
site:id.jobstreet.com "software engineer intern" "Next.js" OR fullstack Indonesia
site:id.jobstreet.com "magang software engineer" Indonesia
site:linkedin.com/jobs "software engineer intern" Indonesia
```

### Priority 4: Broader Technical / Electrical Engineering Internship

Wider net for general technical/electrical engineering internships that accept the Electrical Automation Engineering background.

```
site:id.jobstreet.com "electrical engineer" magang OR intern Indonesia
site:id.jobstreet.com "engineering intern" Indonesia
site:linkedin.com/jobs "electrical engineering intern" Indonesia
site:linkedin.com/jobs "technical intern" Indonesia
```

### Priority 5: Electrical & Industrial Maintenance

Direct degree match (Electrical Automation Engineering) and matches the current internship domain (Maintenance Industrial Quality at PT. Evoluzione Tyres). Many results here are labeled as full-time technician/supervisor roles rather than internships - flag rather than exclude, since the candidate is finishing an internship term and may want to see full-time entry-level options too.

```
site:id.jobstreet.com "maintenance electrical" OR "electrical maintenance" Indonesia
site:id.jobstreet.com "foreman maintenance" electrical OR automation Indonesia
site:id.jobstreet.com "graduate engineer program" electrical Indonesia
site:id.jobstreet.com "electrical engineer" magang OR intern OR "entry level" Surabaya OR "Jawa Timur"
site:linkedin.com/jobs "maintenance engineer" electrical Indonesia
site:linkedin.com/jobs "electrical maintenance" intern OR magang Indonesia
```

## Location Filter

When evaluating results, verify the job location is workable given the candidate is a full-time student in Surabaya. Define acceptable areas:
- Surabaya and surrounding areas (ideal - no relocation needed during studies)
- Jakarta, Bandung, Yogyakarta (acceptable - major tech hubs, relocation for internship period is workable)
- Remote / hybrid anywhere in Indonesia (ideal)
- Other Indonesian cities requiring full relocation (borderline - discuss with candidate given ongoing coursework)
- Outside Indonesia (too far - not in scope for this search round)

## Language Filter

Your working languages and levels are in CLAUDE.md's Languages table (Indonesian - Native, English - Professional working proficiency). When filtering scraped results, apply `04-job-evaluation.md`'s Language Gate: a posting requiring a language you haven't declared at all is excluded; a posting requiring a higher level than you declared in a language you do work in is not excluded, flag it clearly instead. Postings simply *written* in a language you don't work in, that don't require it on the job, are fine.

## Date Filter

Only include jobs posted within the last 14 days, or with an application deadline that has not yet passed. If a posting date cannot be determined, include it but flag as "date unknown".

## Adapting Queries

If the user specifies a focus area, select queries from the matching category and also generate 2-3 custom queries for that focus. For example:
- "/scrape embedded systems" -> Priority 1/2 category queries + custom embedded-systems-specific queries
