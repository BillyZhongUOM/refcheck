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

// Generic English function words only. We deliberately keep domain words
// (clinical, trial, quantum, cancer …) because those carry the matching signal.
const STOPWORDS = new Set(`a an the and or of to in on for with from by as at is are was were be been
that this these those it its we our their his her which who whom but not no nor so than then into onto
over under between among during after before via about against upon within without per also can may
using used based study studies report reports review article paper`.split(/\s+/));

// ---------------------------------------------------------------- text utils
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
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
  const m = (s || '').match(/10\.\d{4,9}\/[^\s"<>)]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;)]+$/, '');
}

// ---------------------------------------------------------- reference splitter
export function splitReferences(text) {
  const raw = (text || '').replace(/\r/g, '').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  const markerRe = /^\s*(\[\d{1,3}\]|\(?\d{1,3}[.)])\s+/;
  const markered = lines.filter(l => markerRe.test(l)).length;

  let parts;
  if (markered >= 2) {
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
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// Fetch JSON with retry + backoff. Transient failures (network drop, 429 rate
// limit, 5xx) are retried rather than surfaced as an error to the user.
async function fetchJSON(url, signal, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (res.status === 404) return { status: 404, data: null };
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Crossref ${res.status}`);
        await delay(500 * (attempt + 1), signal);
        continue;
      }
      if (!res.ok) throw new Error(`Crossref ${res.status}`);
      return { status: res.status, data: await res.json() };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      await delay(500 * (attempt + 1), signal);
    }
  }
  throw lastErr || new Error('Crossref request failed');
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
  const ub = item['updated-by'] || [];
  for (const u of ub) {
    const t = (u.type || '').toLowerCase();
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

  if (yearConflict) notes.push({ code: 'year', you: inputYear, record: myear });
  if (hasAuthors && !authorMatched) notes.push({ code: 'authors', authors: formatAuthors(item) });

  // Retraction / concern override, only trusted on a confident match.
  if (rinfo.retracted && cov >= 0.5)
    return mk('retracted', 'Retracted', raw, matched, cov, [{ code: 'retracted' }, ...notes]);
  if (rinfo.concern && cov >= 0.5)
    return mk('check', 'Expression of Concern', raw, matched, cov, [{ code: 'concern' }, ...notes]);

  const corrob = (authorMatched ? 1 : 0) + (yearCorrob ? 1 : 0);

  if (cov >= 0.6 && authorMatched && (yearCorrob || !yearGiven))
    return mk('verified', 'Verified', raw, matched, cov, notes);
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
    // 1) If the citation carries a DOI, that is the strongest signal.
    if (doi) {
      const item = await crossrefByDOI(doi, mailto, signal);
      if (!item) return mk('notfound', 'Fake DOI', raw, null, 0, [{ code: 'fakedoi', doi }]);
      const cov = titleCoverage(item, inputTokenSet);
      const r = buildResult(raw, item, cov, inputNorm, inputYear);
      if (cov < 0.35) r.notes.unshift({ code: 'doimismatch' });
      return r;
    }

    // 2) Otherwise do a bibliographic search. Pick the best record by a
    //    composite of title overlap + author corroboration + year agreement,
    //    not title overlap alone (same-title letters/replies otherwise win).
    const items = await crossrefQuery(raw, mailto, signal);
    if (!items.length) return mk('notfound', 'No match', raw, null, 0, [{ code: 'notfound' }]);

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
