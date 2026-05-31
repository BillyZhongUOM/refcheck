# RefCheck · 引用核查

**Paste a reference list → instantly see which citations are fabricated, retracted, or mis-cited.**

A free, browser-only tool that checks every reference in a manuscript against [Crossref](https://www.crossref.org/) (150M+ scholarly records). Built to address the 2025–26 surge in AI-hallucinated and retracted citations. This repo is the MVP / free tier — the top of a monetisation funnel (see *Business model* below).

It is the product version of the `verify-refs` skill: that skill verifies references inside Claude for one manuscript at a time; this turns the same idea into a public, self-serve web tool with zero per-check cost.

---

## What it does

For each reference you paste, RefCheck returns one of:

| Status | Meaning |
|--------|---------|
| 🟢 **Verified** | A real record matches the title, an author, and the year. |
| 🟡 **Check metadata** | The paper exists, but the year / authors / journal you wrote don't fully match. |
| 🟠 **Unconfirmed / Weak** | A similar record exists but nothing corroborates it — could be the wrong record or fabricated. |
| 🔴 **Not found** | No matching record in Crossref. Likely fabricated or badly mis-cited. (A non-existent DOI is flagged outright.) |
| 🟣 **Retracted** | The paper has been formally retracted — do not cite it. |

A summary banner tallies the counts and gives a one-line verdict.

---

## How it works (architecture)

Two files, no build step, no backend:

- **`engine.js`** is the verification engine, a pure ES module that runs unchanged in the browser and in Node 18+ (both have a global `fetch`).
  - Splits a pasted reference list into individual entries (numbered lists, blank-line-separated, or one-per-line).
  - **DOI references** resolve registrar-agnostically: Crossref first (richest retraction metadata), then doi.org content negotiation (DataCite, mEDRA, JaLC, and others). Only a DOI that no registrar knows is treated as fabricated, so a valid dataset or thesis DOI is never mistaken for a fake.
  - **Title references** are searched across **Crossref, OpenAlex, and Open Library in parallel** (roughly 400M journal-side records plus ~40M book editions: journals, books, datasets, theses, preprints, non-DOI works and non-DOI books). The best record is chosen by a **composite score** of title-word coverage, author corroboration, and year agreement, not title overlap alone (that would let same-title letters win). A reference is "not found" only when every source misses, which is what keeps real-but-obscure references from being flagged as fabricated. Because every candidate competes on the same score, an off-topic book never hijacks a journal article, and a fabricated reference is still flagged.
  - Retractions come from Crossref `updated-by`, OpenAlex `is_retracted`, and a `RETRACTED:` title fallback.
- **`index.html`** — a single-page UI that imports `engine.js` and `i18n.js`, runs checks with a concurrency pool, and renders results progressively. Editorial design (serif display, warm-monochrome surfaces, one navy accent, pastel semantic statuses, inline SVG icons, subtle motion) built to read as a serious academic tool, applying the [taste-skill](https://github.com/leonxlnx/taste-skill) anti-slop frontend guidelines.
- **`i18n.js`** — the language layer: 12 locales (English, 简体中文, 繁體中文, Español, हिन्दी, العربية, Português, Français, Русский, 日本語, Deutsch, 한국어), full right-to-left support for Arabic, browser-language auto-detection, and a saved preference. Engine notes are language-neutral codes, so a single verification result renders in any language and switches live without re-checking.

Because everything runs client-side against a free public API, **hosting cost is essentially zero** and it scales with the user's own browser. That is what makes a free tier sustainable.

- **`test_engine.mjs`** — a live smoke test (`node test_engine.mjs`) over 4 fixed references (real / retracted / fabricated / metadata-error) that asserts the engine still classifies them correctly. Run it after any change to `engine.js`.

---

## Run locally

```bash
cd citation-checker
python3 -m http.server 8137      # then open http://localhost:8137
# or, in Claude Code: preview config "citation-checker" (port 8137)

node test_engine.mjs             # run the engine smoke test
```

---

## Deploy — LIVE

- **Live URL:** https://billyzhonguom.github.io/refcheck/
- **Repo:** https://github.com/BillyZhongUOM/refcheck (GitHub Pages, `main` / root)

This folder is **both the dev copy and the source of the deployment** — there is no separate mirror repo. To update the live site:

```bash
# from this folder, after editing index.html / engine.js
git add -A && git commit -m "..." && git push    # Pages auto-rebuilds in 1–3 min
```

`notes/` is git-ignored, so the internal product plan never ships to the public repo. Optionally set `MAILTO` in `index.html` to a real contact address — Crossref's "polite pool" then gives faster, more reliable service.

---

## Business model (the funnel)

Maps directly onto the "make-it-free → traffic → monetise" logic:

1. **Free tier (this MVP)** — paste-and-check in the browser. Zero cost to run, so it can stay free forever and pull traffic. Monetise indirectly later (content, affiliate links to reference managers, sponsorship).
2. **Paid tier** — the things a free client-side tool *can't* do well, which is exactly where people will pay:
   - **Whole-PDF / Word upload** — auto-extract the reference section from a manuscript (server-side parsing).
   - **Word & Google Docs add-in** — check references in place while writing.
   - **Deeper accuracy** — add PubMed + the full Retraction Watch database + an LLM pass for messy/grey-literature references (this has a real per-check cost, which justifies the paywall).
   - **Bulk / batch API** — for journal editors and proofreading services screening submissions.
3. **Institutional** — university libraries, journals, and submission systems pay a subscription or licence the API; optional white-label ("powered by").

---

## Accuracy & limitations (MVP)

- **Coverage** is federated across Crossref, OpenAlex, and Open Library, with registrar-agnostic DOI resolution via doi.org. This spans journals, books (including non-DOI books), datasets, theses, and preprints, so real-but-obscure references are no longer falsely flagged as fabricated. Remaining gaps: very local or historical sources without a digital record. Optional further sources (PubMed for biomedical PMIDs, Semantic Scholar for CS and preprints) can be added to the same federation, though OpenAlex already ingests PubMed/MEDLINE.
- **Retraction depth** — uses Crossref's retraction metadata + title flags. The full Retraction Watch dataset catches more; that is a paid-tier upgrade.
- **Parsing** — the splitter handles common formats but very irregular bibliographies may need one-reference-per-line.
- **Rate limits** — client-side calls share the user's IP against Crossref's public pool; fine for a manuscript-sized list, not for thousands at once (that is the batch-API use case).
- This tool **flags references for human review**; it does not auto-delete or auto-"correct" anything.

---

## Privacy

Runs entirely in the visitor's browser. Pasted references are sent only to Crossref's public API for matching. Nothing is sent to or stored on any server we control.
