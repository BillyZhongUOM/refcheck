// Live smoke test against the real Crossref API.
// Run: node test_engine.mjs
import { splitReferences, checkReference } from './engine.js';

const SAMPLE = `
1. Watson JD, Crick FHC. Molecular structure of nucleic acids: a structure for deoxyribose nucleic acid. Nature. 1953;171(4356):737-738.
2. Wakefield AJ, Murch SH, Anthony A, et al. Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet. 1998;351(9103):637-641.
3. Zhang L, Smith JR, Patel A. Quantum entanglement effects on photosynthetic efficiency in mammalian cortical neurons. Journal of Advanced Cellular Biophysics. 2021;14(3):221-238.
4. Fisher RA. The correlation between relatives on the supposition of Mendelian inheritance. Nature. 1925;52:399-433.
`;

const EXPECT = ['verified', 'retracted', 'notfound', 'check']; // rough expectation per line

const refs = splitReferences(SAMPLE);
console.log(`Split into ${refs.length} references.\n`);

let pass = 0;
for (let i = 0; i < refs.length; i++) {
  const r = await checkReference(refs[i], { mailto: 'refcheck-demo@example.com' });
  const ok = r.status === EXPECT[i];
  if (ok) pass++;
  console.log(`[${i + 1}] expected=${EXPECT[i]}  got=${r.status.toUpperCase()} (${r.label})  ${ok ? 'PASS ✅' : 'DIFF ⚠️'}`);
  console.log(`    input : ${refs[i].slice(0, 70)}...`);
  if (r.matched) console.log(`    match : ${r.matched.title.slice(0, 70)} | ${r.matched.journal} ${r.matched.year} | doi:${r.matched.doi}`);
  console.log(`    conf  : ${r.confidence}`);
  if (r.notes.length) console.log(`    notes : ${r.notes.join(' / ')}`);
  console.log('');
  await new Promise(res => setTimeout(res, 300)); // be polite to the API
}

console.log(`\n=== ${pass}/${refs.length} matched rough expectation ===`);
