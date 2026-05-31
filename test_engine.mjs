// Live smoke test against the real scholarly APIs (Crossref, OpenAlex, etc.).
// Run: node test_engine.mjs
// Exits non-zero on a real failure; SKIPS (exit 0) when there is no network, so
// it stays meaningful in a sandbox with outbound access blocked.
import { splitReferences, checkReference } from './engine.js';

const OPTS = { mailto: 'refcheck-demo@example.com' };
let failed = false;
const ok = (cond, label) => { if (!cond) failed = true; return cond ? 'PASS ✅' : 'FAIL ❌'; };

const SAMPLE = `
1. Watson JD, Crick FHC. Molecular structure of nucleic acids: a structure for deoxyribose nucleic acid. Nature. 1953;171(4356):737-738.
2. Wakefield AJ, Murch SH, Anthony A, et al. Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet. 1998;351(9103):637-641.
3. Zhang L, Smith JR, Patel A. Quantum entanglement effects on photosynthetic efficiency in mammalian cortical neurons. Journal of Advanced Cellular Biophysics. 2021;14(3):221-238.
4. Fisher RA. The correlation between relatives on the supposition of Mendelian inheritance. Nature. 1925;52:399-433.
`;
const EXPECT = ['verified', 'retracted', 'notfound', 'check'];

const refs = splitReferences(SAMPLE);
console.log(`Split into ${refs.length} references.\n`);

const results = [];
for (let i = 0; i < refs.length; i++) {
  const r = await checkReference(refs[i], OPTS);
  results.push(r);
  await new Promise(res => setTimeout(res, 300)); // be polite
}

// No-network guard: if every lookup errored, the APIs are unreachable. Skip.
if (results.every(r => r.status === 'error')) {
  console.log('SKIP: all lookups returned "error" (no network access in this environment).');
  console.log('The engine correctly reported "could not verify" rather than "not found".');
  process.exit(0);
}

let pass = 0;
for (let i = 0; i < refs.length; i++) {
  const r = results[i];
  const good = r.status === EXPECT[i];
  if (good) pass++; else failed = true;
  console.log(`[${i + 1}] expected=${EXPECT[i]}  got=${r.status.toUpperCase()}  ${good ? 'PASS ✅' : 'DIFF ⚠️'}`);
  if (r.matched) console.log(`    match : ${r.matched.title.slice(0, 64)} | ${r.matched.journal} ${r.matched.year}`);
  if (r.notes.length) console.log(`    notes : ${r.notes.map(n => n.code + (n.you ? `(${n.you}->${n.record})` : '')).join(' / ')}`);
}
console.log(`\n=== ${pass}/${refs.length} matched rough expectation ===`);

console.log('\n--- federation + hardening invariants ---');

const datacite = await checkReference('GBIF.org. Occurrence Download. 2020. https://doi.org/10.15468/dl.zv4r9n', OPTS);
console.log(`real DataCite DOI not flagged fake : ${datacite.status.toUpperCase()}  ${ok(datacite.status !== 'notfound', '')}`);

const book = await checkReference('Kuhn TS. The structure of scientific revolutions. University of Chicago Press; 1962.', OPTS);
console.log(`non-DOI book found                 : ${book.status.toUpperCase()}  ${ok(book.status !== 'notfound', '')}`);

const fake = await checkReference('Zhang L, Patel A. Quantum entanglement effects on photosynthetic efficiency in mammalian neurons. J Adv Cell Biophys. 2021;14:221-238.', OPTS);
console.log(`fabricated still caught            : ${fake.status.toUpperCase()}  ${ok(fake.status === 'notfound', '')}`);

const wakefield = await checkReference('Wakefield AJ, et al. Ileal-lymphoid-nodular hyperplasia. Lancet 1998. https://doi.org/10.1016/S0140-6736(97)11096-0', OPTS);
console.log(`retracted DOI flagged              : ${wakefield.status.toUpperCase()}  ${ok(wakefield.status === 'retracted', '')}`);

console.log(failed ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
process.exitCode = failed ? 1 : 0;
