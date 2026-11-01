import test from 'node:test';
import assert from 'node:assert/strict';
import { citationLinks, couplingLinks, textSimilarity, tokenize, computeLinks } from '../site/js/links.js';

const P = (id, o = {}) => ({ id, title: '', abstract: '', ...o });

test('citations only within library, directed', () => {
  const ps = [P('a', { openalex_id: 'W1', refs: ['W2', 'W9'] }), P('b', { openalex_id: 'W2', refs: [] }), P('c', { openalex_id: 'W3', refs: ['W1', 'W3'] })];
  assert.deepEqual(citationLinks(ps).map((l) => `${l.source_id}->${l.target_id}`).sort(), ['a->b', 'c->a']);
});

test('bibliographic coupling threshold and score', () => {
  const ps = [
    P('a', { refs: ['R1', 'R2', 'R3', 'R4'] }),
    P('b', { refs: ['R1', 'R2', 'R3', 'R5'] }),
    P('c', { refs: ['R1', 'R6', 'R7', 'R8'] }),
  ];
  const ls = couplingLinks(ps, { minShared: 3 });
  assert.equal(ls.length, 1);
  assert.equal(ls[0].shared, 3);
  assert.equal(ls[0].score, +(3 / 4).toFixed(3));
  assert.equal(couplingLinks(ps, { minShared: 1 }).length, 3);
});

test('tokenizer keeps gene/variant symbols, drops stopwords', () => {
  const t = tokenize('KRAS G12D mutant organoids show TP53-dependent single-cell resistance in 2024');
  for (const w of ['kras', 'g12d', 'organoids', 'tp53-dependent', 'single-cell', 'resistance']) assert.ok(t.includes(w), w);
  assert.ok(!t.includes('show') && !t.includes('2024'));
});

test('text similarity links topical neighbours, not unrelated papers', () => {
  const ps = [
    P('a', { title: 'KRAS G12D drives pancreatic tumour organoid growth', abstract: 'pancreatic ductal adenocarcinoma organoids KRAS signalling MAPK' }),
    P('b', { title: 'MAPK signalling in KRAS mutant pancreatic organoids', abstract: 'pancreatic adenocarcinoma organoid KRAS inhibitor response' }),
    P('c', { title: 'Deep learning for retinal fundus images', abstract: 'convolutional networks diabetic retinopathy screening images' }),
    P('d', { title: 'Retinal image screening with convolutional networks', abstract: 'diabetic retinopathy deep learning fundus' }),
    P('e', { title: 'Soil microbiome nitrogen cycling', abstract: 'bacteria nitrogen fixation soil samples metagenomics' }),
  ];
  const pairs = textSimilarity(ps, { minScore: 0.2 }).map((x) => x.a + x.b).sort();
  assert.ok(pairs.includes('ab'), 'pancreatic pair');
  assert.ok(pairs.includes('cd'), 'retina pair');
  assert.ok(!pairs.some((p) => p.includes('e')), 'unrelated paper unlinked');
  assert.ok(!pairs.includes('ac'));
});

test('computeLinks combines kinds', () => {
  const ps = [P('a', { openalex_id: 'W1', refs: ['W2'] }), P('b', { openalex_id: 'W2', refs: [] })];
  assert.deepEqual(computeLinks(ps).map((l) => l.kind), ['cites']);
});
