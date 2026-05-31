// RefCheck verification engine.
// Pure ES module that runs unchanged in the browser (<script type="module">)
// and in Node 18+ (both expose a global `fetch`).
//
// Public API:
//   splitReferences(text)            -> string[]   (one raw reference per entry)
//   checkReference(raw, opts)        -> Promise<Result>
//
// A Result looks like:
//   { status, label, input, confidence, notes:[{code,...params}], matched:{...}|null }
// status ∈ 'verified' | 'check' | 'weak' | 'notfound' | 'retracted' | 'error'
//
// `notes` are language-neutral CODES (with params) so the UI can render them in
// any language. The optional `label` is English, for Node tests only; the UI
// derives its label from `status` via the i18n layer and ignores it.

const CROSSREF = 'https://api.crossref.org/works';
const OPENALEX = 'https://api.openalex.org/works';

// Generic English function words only. We deliberately keep domain words
// (clinical, trial, quantum, cancer …) because those carry the matching signal.
const STOPWORDS = new Set(`a an the and or of to in on for with from by as at is are was were be been
that this these those it its we our their his her which who whom but not no nor so than then into onto
over under between among during after before via about against upon within without per also can may
using used based study studies report reports review article paper`.split(/\s+/));

// ---------------------------------------------------------------- text utils
function normalize(s) {
  // Unicode-aware: fold Latin accents (NFKD drops the combining marks, which are
  // \p{M} not \p{L}), but PRESERVE non-Latin scripts (CJK, Cyrillic, Arabic,
  // Greek) so non-English titles keep their matching signal instead of becoming
  // an empty string.
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function significantTokens(s) {
  return normalize(s).split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function extractYear(s) {
  const m = (s || '').match(/\b(18|19|20)\d{2}\b/g);
  if (!m) return null;
  const years = m.map(Number).filter(y => y <= 2100);
  return years.length ? Math.max(...years) : null;
}

function extractDOI(s) {
  // DOI suffixes legitimately contain parentheses (e.g. the Elsevier/Lancet
  // S-DOIs like 10.1016/S0140-6736(97)11096-0), so we must NOT stop at "(".
  // We capture up to whitespace, then trim trailing citation punctuation, so a
  // DOI written inside "(doi:...)" loses only the closing bracket, not an
  // internal one.
  const m = (s || '').match(/10\.\d{4,9}\/[^\s"<>]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;>)\]]+$/, '');
}

// ---------------------------------------------------------- reference splitter
export function splitReferences(text) {
  const raw = (text || '').replace(/\r/g, '').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  const markerRe = /^\s*(\[\d{1,3}\]|\(?\d{1,3}[.)])\s+/;
  const markered = lines.filter(l => markerRe.test(l)).length;

  let parts;
  if (markered >= 1) {
    // Numbered list: a new reference starts at each marker; wrapped continuation
    // lines fold into the current entry. Works for a single wrapped numbered
    // reference too, not only lists of two or more.
    parts = [];
    let cur = '';
    for (const line of lines) {
      if (markerRe.test(line)) {
        if (cur.trim()) parts.push(cur);
        cur = line;
      } else {
        cur += ' ' + line;
      }
    }
    if (cur.trim()) parts.push(cur);
  } else if (raw.includes('\n\n')) {
    parts = raw.split(/\n\s*\n/);
  } else {
    parts = lines;
  }

  return parts
    .map(p => p.replace(markerRe, '').replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 10);
}

// --------------------------------------------------------------- crossref I/O
const REQUEST_TIMEOUT_MS = 15000;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// Combine an optional user signal with a per-call timeout signal.
function anySignal(...signals) {
  const ctl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

// Fetch JSON with retry + backoff AND a per-request timeout. Transient failures
// (network drop, timeout, 429 rate limit, 5xx) are retried. A user cancel (the
// passed signal aborting) propagates immediately. If every attempt fails the
// call THROWS, so callers can tell "service unreachable" apart from "service
// said this does not exist" (a 404, returned as {status:404}).
async function fetchJSON(url, signal, tries = 3, accept = 'application/json') {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const timer = new AbortController();
    const to = setTimeout(() => timer.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: anySignal(signal, timer.signal), headers: { Accept: accept } });
      clearTimeout(to);
      if (res.status === 404) return { status: 404, data: null };
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await delay(500 * (attempt + 1), signal);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, data: await res.json() };
    } catch (err) {
      clearTimeout(to);
      if (signal && signal.aborted) throw err;   // genuine user cancel: stop
      lastErr = err;                             // timeout or network: retry
      await delay(500 * (attempt + 1), signal);
    }
  }
  throw lastErr || new Error('request failed');
}

async function crossrefQuery(raw, mailto, signal) {
  let url = `${CROSSREF}?rows=8&query.bibliographic=${encodeURIComponent(raw)}`;
  if (mailto) url += `&mailto=${encodeURIComponent(mailto)}`;
  const { data } = await fetchJSON(url, signal);
  return (data && data.message && data.message.items) || [];
}

async function crossrefByDOI(doi, mailto, signal) {
  let url = `${CROSSREF}/${encodeURIComponent(doi)}`;
  if (mailto) url += `?mailto=${encodeURIComponent(mailto)}`;
  const { status, data } = await fetchJSON(url, signal);
  if (status === 404) return null;
  return (data && data.message) || null;
}

// OpenAlex: ~250M works across every discipline (journals, books, datasets,
// theses, preprints, non-DOI works). The single broadest complement to Crossref.
async function openalexQuery(raw, mailto, signal) {
  let url = `${OPENALEX}?per_page=8&search=${encodeURIComponent(raw)}`;
  if (mailto) url += `&mailto=${encodeURIComponent(mailto)}`;
  const { data } = await fetchJSON(url, signal);
  return ((data && data.results) || []).map(normalizeOpenAlex);
}

function stripTags(s) { return (s || '').replace(/<[^>]*>/g, ''); }

// Normalise an OpenAlex work into the same shape the scoring helpers expect.
function normalizeOpenAlex(w) {
  const authors = (w.authorships || []).map(a => {
    const dn = (a.author && a.author.display_name) || a.raw_author_name || '';
    const parts = dn.trim().split(/\s+/);
    return parts.length > 1 ? { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') } : { family: dn };
  });
  return {
    title: [stripTags(w.title || w.display_name || '')],
    author: authors,
    'container-title': [(w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || ''],
    issued: { 'date-parts': [[w.publication_year].filter(Boolean)] },
    DOI: (w.doi || '').replace(/^https?:\/\/doi\.org\//, ''),
    type: w.type,
    _retracted: !!w.is_retracted,
    _src: 'openalex',
  };
}

// Open Library: ~40M book editions. Fills the non-DOI book and humanities gap
// that journal indexes miss. Competes in the same composite scoring, so it only
// wins when a real book genuinely matches and loses for journal articles.
async function openlibraryQuery(raw, signal) {
  const url = `https://openlibrary.org/search.json?limit=5&fields=title,author_name,first_publish_year,publisher&q=${encodeURIComponent(raw)}`;
  const { data } = await fetchJSON(url, signal);
  return ((data && data.docs) || []).map(normalizeOpenLibrary);
}

function normalizeOpenLibrary(d) {
  const authors = (d.author_name || []).slice(0, 5).map(dn => {
    const parts = String(dn).trim().split(/\s+/);
    return parts.length > 1 ? { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') } : { family: dn };
  });
  return {
    title: [stripTags(d.title || '')],
    author: authors,
    'container-title': [(d.publisher && d.publisher[0]) || ''],
    issued: { 'date-parts': [[d.first_publish_year].filter(Boolean)] },
    DOI: null,
    type: 'book',
    _src: 'openlibrary',
  };
}

// Registrar-agnostic DOI resolution via doi.org content negotiation (CSL JSON).
// Resolves Crossref, DataCite, mEDRA, JaLC, etc. so a valid non-Crossref DOI is
// not mistaken for a fabricated one.
async function resolveDoiOrg(doi, signal) {
  const url = `https://doi.org/${encodeURIComponent(doi)}`;
  const { status, data } = await fetchJSON(url, signal, 2, 'application/vnd.citationstyles.csl+json');
  if (status === 404 || !data || typeof data !== 'object') return null;
  return {
    title: [stripTags(Array.isArray(data.title) ? data.title[0] : data.title || '')],
    author: data.author || [],
    'container-title': [Array.isArray(data['container-title']) ? data['container-title'][0] : (data['container-title'] || '')],
    issued: data.issued || {},
    DOI: data.DOI || doi,
    type: data.type,
    _src: 'doi.org',
  };
}

// ------------------------------------------------------------- scoring helpers
function titleCoverage(item, inputTokenSet) {
  const title = item.title && item.title[0];
  const tt = [...new Set(significantTokens(title))];
  if (tt.length === 0) return 0;
  let shared = 0;
  for (const t of tt) if (inputTokenSet.has(t)) shared++;
  return shared / tt.length;
}

function authorInInput(item, inputNorm) {
  const authors = item.author || [];
  for (const a of authors) {
    const fam = normalize(a.family || '').replace(/ /g, '');
    if (fam.length >= 3 && inputNorm.includes(fam)) return true;
  }
  return false;
}

function itemYear(item) {
  const di = item.issued && item.issued['date-parts'] && item.issued['date-parts'][0];
  if (di && di[0]) return Number(di[0]);
  const dp = item['published-print'] || item['published-online'] || item.published;
  const d2 = dp && dp['date-parts'] && dp['date-parts'][0];
  return d2 && d2[0] ? Number(d2[0]) : null;
}

function retractionInfo(item) {
  if (item._retracted) return { retracted: true };
  const rels = [...(item['updated-by'] || []), ...(item['update-to'] || []), ...(item.relation && item.relation['is-retracted-by'] || [])];
  for (const u of rels) {
    const t = (u.type || u['id-type'] || '').toLowerCase();
    const l = (u.label || '').toLowerCase();
    if (t.includes('retraction') || l.includes('retract')) return { retracted: true };
    if (t.includes('concern') || l.includes('concern')) return { concern: true };
  }
  const title = ((item.title && item.title[0]) || '').trim();
  if (/^retracted[:\s]/i.test(title)) return { retracted: true };
  if (/expression of concern/i.test(title)) return { concern: true };
  return {};
}

function formatAuthors(item) {
  const a = item.author || [];
  if (!a.length) return '';
  const names = a.slice(0, 3).map(x => {
    const fam = x.family || x.name || '';
    const ini = (x.given || '').split(/\s+/).map(g => g[0]).filter(Boolean).join('');
    return ini ? `${fam} ${ini}` : fam;
  });
  return names.join(', ') + (a.length > 3 ? ', et al.' : '');
}

function matchedView(item) {
  return {
    title: (item.title && item.title[0]) || '(no title)',
    authors: formatAuthors(item),
    journal: (item['container-title'] && item['container-title'][0]) || '',
    year: itemYear(item),
    doi: item.DOI || null,
  };
}

// True when the matched record's journal clearly does not appear in the input.
// Abbreviation-tolerant: a journal word counts as present if its first 4 letters
// occur anywhere in the input, so "Lancet" vs "The Lancet" and "J Clin Oncol"
// vs "Journal of Clinical Oncology" are NOT flagged. Only fires when the record
// has real journal words and none of them surface in the citation.
function journalMismatch(item, inputNorm) {
  const j = (item['container-title'] || [])[0] || '';
  const jt = significantTokens(j).filter(t => t.length >= 4);
  if (!jt.length) return false;
  const compact = inputNorm.replace(/ /g, '');
  for (const t of jt) if (compact.includes(t.slice(0, 4))) return false;
  return true;
}

// ------------------------------------------------------------------- classify
function buildResult(raw, item, cov, inputNorm, inputYear) {
  const notes = [];
  const matched = matchedView(item);
  const rinfo = retractionInfo(item);
  const hasAuthors = (item.author || []).length > 0;
  const authorMatched = authorInInput(item, inputNorm);
  const myear = matched.year;
  const yearGiven = !!inputYear;
  const yearCorrob = !!(inputYear && myear && Math.abs(inputYear - myear) <= 1);
  const yearConflict = !!(inputYear && myear && Math.abs(inputYear - myear) > 1);

  const journalOff = journalMismatch(item, inputNorm);

  if (yearConflict) notes.push({ code: 'year', you: inputYear, record: myear });
  if (hasAuthors && !authorMatched) notes.push({ code: 'authors', authors: formatAuthors(item) });
  // A journal mismatch downgrades Verified to Check (below); no separate note is
  // needed because the matched record card already shows the record's journal
  // for the user to compare against their citation.

  // Retraction / concern override, only trusted on a confident match.
  if (rinfo.retracted && cov >= 0.5)
    return mk('retracted', 'Retracted', raw, matched, cov, [{ code: 'retracted' }, ...notes]);
  if (rinfo.concern && cov >= 0.5)
    return mk('check', 'Expression of Concern', raw, matched, cov, [{ code: 'concern' }, ...notes]);

  const corrob = (authorMatched ? 1 : 0) + (yearCorrob ? 1 : 0);

  // Title + author + year all agree. Only call it Verified if the journal also
  // looks right; a clear journal mismatch downgrades to Check metadata so a
  // mis-cited venue is not hidden behind a green badge.
  if (cov >= 0.6 && authorMatched && (yearCorrob || !yearGiven))
    return journalOff
      ? mk('check', 'Check metadata', raw, matched, cov, notes)
      : mk('verified', 'Verified', raw, matched, cov, notes);
  if (cov >= 0.6 && corrob >= 1)
    return mk('check', 'Check metadata', raw, matched, cov, notes.length ? notes : [{ code: 'check_generic' }]);
  if (cov >= 0.6 && corrob === 0)
    return mk('weak', 'Unconfirmed', raw, matched, cov, [{ code: 'unconfirmed' }, ...notes]);
  if (cov >= 0.4 && corrob >= 1)
    return mk('weak', 'Weak match', raw, matched, cov, [{ code: 'weak' }, ...notes]);
  return mk('notfound', 'No match', raw, null, cov, [{ code: 'notfound' }]);
}

function mk(status, label, input, matched, confidence, notes) {
  return { status, label, input, matched, confidence: Math.round(confidence * 100) / 100, notes };
}

// --------------------------------------------------------------- main entry
export async function checkReference(raw, opts = {}) {
  const { mailto, signal } = opts;
  const inputNorm = normalize(raw);
  const inputTokenSet = new Set(significantTokens(raw));
  const inputYear = extractYear(raw);
  const doi = extractDOI(raw);

  try {
    // 1) If the citation carries a DOI, that is the strongest signal. Resolve it
    //    registrar-agnostically: Crossref first (richest retraction metadata),
    //    then doi.org content negotiation (DataCite, mEDRA, JaLC, ...). Only a
    //    DOI that NO registrar knows is treated as fabricated.
    if (doi) {
      let item = null, hadError = false;
      try { item = await crossrefByDOI(doi, mailto, signal); }
      catch (e) { if (e.name === 'AbortError') throw e; hadError = true; }
      if (!item) {
        try { item = await resolveDoiOrg(doi, signal); }
        catch (e) { if (e.name === 'AbortError') throw e; hadError = true; }
      }
      if (!item) {
        // No registrar returned the DOI. A clean 404 from every registrar means
        // the DOI is fabricated; a network error means we simply could not check,
        // and must NOT be reported as fabrication.
        return hadError
          ? mk('error', 'Error', raw, null, 0, [{ code: 'error' }])
          : mk('notfound', 'Fake DOI', raw, null, 0, [{ code: 'fakedoi', doi }]);
      }
      const cov = titleCoverage(item, inputTokenSet);
      // The DOI is an exact identifier, so trust a retraction or concern on the
      // resolved record regardless of how much of the title the user typed.
      const rin = retractionInfo(item);
      if (rin.retracted) return mk('retracted', 'Retracted', raw, matchedView(item), Math.max(cov, 0.9), [{ code: 'retracted' }]);
      if (rin.concern) return mk('check', 'Expression of Concern', raw, matchedView(item), cov, [{ code: 'concern' }]);
      const r = buildResult(raw, item, cov, inputNorm, inputYear);
      // A resolved DOI proves the paper exists: never label it fabricated.
      if (r.status === 'notfound') return mk('weak', 'Weak match', raw, matchedView(item), cov, [{ code: 'doimismatch' }]);
      if (cov < 0.35) r.notes.unshift({ code: 'doimismatch' });
      return r;
    }

    // 2) Otherwise federate the title search across Crossref AND OpenAlex, then
    //    pick the best record by a composite of title overlap + author + year.
    //    Federation is what keeps real-but-obscure references (books, datasets,
    //    theses, preprints, regional journals) from being flagged as fabricated:
    //    we only say "not found" when EVERY source misses.
    const settle = async (p) => {
      try { return { ok: true, items: await p }; }
      catch (e) { if (e.name === 'AbortError') throw e; return { ok: false, items: [] }; }
    };
    const settled = await Promise.all([
      settle(crossrefQuery(raw, mailto, signal)),
      settle(openalexQuery(raw, mailto, signal)),
      settle(openlibraryQuery(raw, signal)),
    ]);
    const anyOk = settled.some(s => s.ok);
    const items = settled.flatMap(s => s.items);
    if (!items.length) {
      // No matches anywhere. If at least one source actually answered, that is a
      // genuine "not found". If EVERY source failed (offline, CORS, rate limit),
      // we could not verify and must say so instead of crying fabrication.
      return anyOk
        ? mk('notfound', 'No match', raw, null, 0, [{ code: 'notfound' }])
        : mk('error', 'Error', raw, null, 0, [{ code: 'error' }]);
    }

    let best = null, bestScore = -1, bestCov = 0;
    for (const it of items) {
      const cov = titleCoverage(it, inputTokenSet);
      const aOk = authorInInput(it, inputNorm);
      const my = itemYear(it);
      const yOk = !!(inputYear && my && Math.abs(inputYear - my) <= 1);
      const typeBonus = (it.type === 'journal-article' || it.type === 'proceedings-article') ? 0.05 : 0;
      const score = 0.6 * cov + 0.25 * (aOk ? 1 : 0) + 0.15 * (yOk ? 1 : 0) + typeBonus;
      if (score > bestScore) { best = it; bestScore = score; bestCov = cov; }
    }

    // For a confident match, re-fetch the canonical record by DOI so we see
    // authoritative relation metadata (retractions, expressions of concern).
    let item = best, cov = bestCov;
    if (cov >= 0.6 && authorInInput(item, inputNorm) && item.DOI) {
      try {
        const full = await crossrefByDOI(item.DOI, mailto, signal);
        if (full) { item = full; cov = titleCoverage(full, inputTokenSet); }
      } catch (_) { /* keep the search record */ }
    }
    return buildResult(raw, item, cov, inputNorm, inputYear);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return mk('error', 'Error', raw, null, 0, [{ code: 'error' }]);
  }
}

export async function checkAll(text, opts = {}) {
  const refs = splitReferences(text);
  const out = [];
  for (const r of refs) out.push(await checkReference(r, opts));
  return out;
}
