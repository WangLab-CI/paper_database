// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBibtex, parseRis, toBibtex, delatex } from '../site/js/bibtex.js';
import { parseIdentifier } from '../site/js/metadata.js';
import { diffWords } from '../site/js/diff.js';

const BIB = String.raw`
@string{nat = "Nature"}
@comment{ignore me}
@article{smith2020,
  title = {{CRISPR} screens reveal {\it TP53}-dependent fitness in {M\"uller} organoids},
  author = {Smith, John A. and M{\"u}ller, Anna and Jos\'e Garc\'{i}a},
  journal = nat # " Genetics",
  year = 2020,
  doi = {https://doi.org/10.1038/S41588-020-0001-X},
  keywords = {crispr; TP53, organoids},
  note = {PMID: 32000001},
  abstract = {We show that 50\% of cells {die}.}
}
@misc{doe2023, title="A transformer for spatial omics", author="Doe, Jane", eprint={2301.01234v2}, archivePrefix={arXiv}, year={2023}}
@inproceedings{x, title={Braces {nested {deeply}} ok}, booktitle={ISMB}, year={2019}}
`;

test('bibtex parse', () => {
  const [a, b, c] = parseBibtex(BIB);
  assert.equal(a.title, 'CRISPR screens reveal TP53-dependent fitness in Müller organoids');
  assert.equal(a.authors, 'Smith, John A.; Müller, Anna; García, José');
  assert.equal(a.journal, 'Nature Genetics');
  assert.equal(a.year, 2020);
  assert.equal(a.doi, '10.1038/s41588-020-0001-x');
  assert.equal(a.pmid, '32000001');
  assert.deepEqual(a.tags, ['crispr', 'tp53', 'organoids']);
  assert.equal(a.abstract, 'We show that 50% of cells die.');
  assert.equal(b.arxiv_id, '2301.01234');
  assert.equal(b.entry_type, 'misc');
  assert.equal(c.title, 'Braces nested deeply ok');
  assert.equal(c.journal, 'ISMB');
});

test('bibtex round trip', () => {
  const ps = parseBibtex(BIB);
  const again = parseBibtex(toBibtex(ps));
  assert.equal(again.length, 3);
  for (const k of ['title', 'authors', 'year', 'doi', 'arxiv_id', 'pmid']) assert.deepEqual(again.map((p) => p[k]), ps.map((p) => p[k]), k);
  assert.equal(again[0].abstract, ps[0].abstract);
});

test('ris parse', () => {
  const ris = `TY  - JOUR
TI  - Spatial transcriptomics of
  pancreatic cancer
AU  - Lee, K.
AU  - Wang, G.
T2  - Cell
PY  - 2024/05/01
DO  - 10.1016/j.cell.2024.01.001
KW  - Spatial
KW  - PDAC
N1  - PMID: 38000000
AB  - Abstract text.
ER  -
TY  - UNPB
TI  - Preprint
UR  - https://arxiv.org/abs/2405.00001
ER  - `;
  const [a, b] = parseRis(ris);
  assert.equal(a.title, 'Spatial transcriptomics of pancreatic cancer');
  assert.equal(a.authors, 'Lee, K.; Wang, G.');
  assert.equal(a.year, 2024);
  assert.equal(a.pmid, '38000000');
  assert.deepEqual(a.tags, ['spatial', 'pdac']);
  assert.equal(b.arxiv_id, '2405.00001');
  assert.equal(b.entry_type, 'unpublished');
});

test('identifiers', () => {
  assert.deepEqual(parseIdentifier('https://doi.org/10.1038/nature12373'), { type: 'doi', id: '10.1038/nature12373' });
  assert.deepEqual(parseIdentifier('PMID: 23903748'), { type: 'pmid', id: '23903748' });
  assert.deepEqual(parseIdentifier('https://pubmed.ncbi.nlm.nih.gov/23903748/'), { type: 'pmid', id: '23903748' });
  assert.deepEqual(parseIdentifier('arXiv:2301.01234v2'), { type: 'arxiv', id: '2301.01234' });
  assert.deepEqual(parseIdentifier('2301.01234'), { type: 'arxiv', id: '2301.01234' });
  assert.deepEqual(parseIdentifier('PMC3864000'), { type: 'pmcid', id: 'PMC3864000' });
  assert.equal(parseIdentifier('tumour evolution').type, 'query');
});

test('diff', () => {
  assert.equal(diffWords('a b c', 'a x c'), 'a <del>b</del><ins>x</ins> c');
  assert.equal(diffWords('<b>', '<b>'), '&lt;b&gt;');
});

test('delatex', () => assert.equal(delatex('{\\"o}ber \\& --'), 'öber & –'));
