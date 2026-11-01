import test from 'node:test';
import assert from 'node:assert/strict';
import { topicYearMatrix, groupTopicMatrix, louvain, modularity, collaborationGroups, frequentlyCited, frequentlyRelated, rankCiting } from '../site/js/insights-data.js';
import { oaRecord } from '../site/js/links.js';

const T = (name, subfield, field) => ({ id: 'T' + name, name, subfield, field });
const A = (id, inst, country) => ({ id, name: id.toUpperCase(), inst: [{ id: 'I' + inst, name: inst, country }] });
const P = (id, year, topic, authors, extra = {}) => ({ id, openalex_id: 'W' + id, oa_meta: { year, topics: [topic], authors, related: [] }, refs: [], tags: [], ...extra });

const onc = T('Tumour evolution', 'Oncology', 'Medicine');
const img = T('Spatial omics', 'Molecular Biology', 'Biochemistry');

test('topic × year matrix: counts, gaps, timeline ordering', () => {
  const ps = [P('1', 2018, onc, []), P('2', 2018, onc, []), P('3', 2020, img, []), P('4', 2021, img, []), P('5', 2021, onc, [])];
  const m = topicYearMatrix(ps, { level: 'topic' });
  assert.deepEqual(m.years, [2018, 2019, 2020, 2021]);
  assert.deepEqual(m.yearTotals, [2, 0, 1, 2]);
  assert.equal(m.rows[0].label, 'Tumour evolution');            // older centre of mass first
  assert.deepEqual(m.rows[0].counts, [2, 0, 0, 1]);
  assert.deepEqual(m.rows[1].counts, [0, 0, 1, 1]);
  assert.equal(topicYearMatrix(ps, { level: 'field' }).rows.length, 2);
});

test('country × field matrix uses whole counting per paper', () => {
  const ps = [
    P('1', 2020, onc, [A('a', 'Cambridge', 'GB'), A('b', 'Oxford', 'GB'), A('c', 'MIT', 'US')]),
    P('2', 2021, img, [A('a', 'Cambridge', 'GB')]),
  ];
  const m = groupTopicMatrix(ps, { by: 'country', level: 'field' });
  const gb = m.rows.findIndex((r) => r.key === 'GB');
  assert.equal(m.rows[gb].total, 2);                        // paper 1 counted once for GB despite 2 GB authors
  assert.equal(m.values[gb][m.cols.findIndex((c) => c.label === 'Medicine')], 1);
  const byInst = groupTopicMatrix(ps, { by: 'institution', level: 'field' });
  assert.equal(byInst.rows[0].label, 'Cambridge');
});

test('louvain separates two cliques joined by one weak edge', () => {
  const E = (a, b, weight = 3) => ({ a, b, weight });
  const edges = [E('a', 'b'), E('a', 'c'), E('b', 'c'), E('d', 'e'), E('d', 'f'), E('e', 'f'), E('c', 'd', 1)];
  const comm = louvain(['a', 'b', 'c', 'd', 'e', 'f'], edges);
  assert.equal(comm.get('a'), comm.get('c'));
  assert.equal(comm.get('d'), comm.get('f'));
  assert.notEqual(comm.get('a'), comm.get('d'));
  assert.ok(modularity(edges, comm) > 0.3);
});

test('collaboration groups ignore consortium papers for edges', () => {
  const lab1 = [A('a', 'Cambridge', 'GB'), A('b', 'Cambridge', 'GB')];
  const lab2 = [A('x', 'MIT', 'US'), A('y', 'MIT', 'US')];
  const big = Array.from({ length: 40 }, (_, i) => A('z' + i, 'Broad', 'US'));
  const ps = [
    P('1', 2019, onc, lab1), P('2', 2020, onc, lab1),
    P('3', 2020, img, lab2), P('4', 2022, img, lab2),
    P('5', 2022, onc, [...lab1, ...lab2, ...big], { oa_meta: { year: 2022, n_authors: 44, topics: [onc], authors: [...lab1, ...lab2, ...big], related: [] } }),
  ];
  const r = collaborationGroups(ps, { minPapers: 2 });
  assert.equal(r.groups.length, 2);
  assert.ok(r.groups.every((g) => g.members.length === 2));
  assert.deepEqual(r.groups.find((g) => g.members.some((m) => m.id === 'a')).institutions[0], ['Cambridge', 6]);
});

test('works not in library', () => {
  const ps = [P('1', 2020, onc, [], { refs: ['W9', 'W8', 'W2'] }), P('2', 2021, onc, [], { refs: ['W9', 'W8'] }), P('3', 2022, onc, [], { refs: ['W9'] })];
  ps[0].oa_meta.related = ['W77', 'W1']; ps[1].oa_meta.related = ['W77'];
  assert.deepEqual(frequentlyCited(ps), [{ id: 'W9', count: 3 }, { id: 'W8', count: 2 }]);   // W2 is in the library
  assert.deepEqual(frequentlyRelated(ps), [{ id: 'W77', count: 2 }]);
  const citing = rankCiting([{ id: 'W50', refs: ['W1', 'W2'], year: 2025 }, { id: 'W51', refs: ['W1'], year: 2026 }, { id: 'W1', refs: ['W2', 'W3'] }], ps);
  assert.deepEqual(citing.map((w) => w.id), ['W50']);
});

test('oaRecord compacts OpenAlex work', () => {
  const auth = (i) => ({ author: { id: 'https://openalex.org/A' + i, display_name: 'Au ' + i }, author_position: 'middle',
    institutions: [{ id: 'https://openalex.org/I1', display_name: 'Uni', country_code: 'GB' }], countries: ['GB'] });
  const w = { id: 'https://openalex.org/W1', publication_year: 2024, referenced_works: ['https://openalex.org/W2'], related_works: [],
    topics: [{ id: 'https://openalex.org/T5', display_name: 'X', score: 0.9, subfield: { display_name: 'S' }, field: { display_name: 'F' }, domain: { display_name: 'D' } }],
    authorships: Array.from({ length: 100 }, (_, i) => auth(i)) };
  const r = oaRecord(w);
  assert.equal(r.openalex_id, 'W1');
  assert.deepEqual(r.refs, ['W2']);
  assert.equal(r.oa_meta.authors.length, 30);
  assert.equal(r.oa_meta.authors.at(-1).id, 'A99');            // last author (PI) kept
  assert.equal(r.oa_meta.n_authors, 100);
  assert.deepEqual(r.oa_meta.topics[0], { id: 'T5', name: 'X', score: 0.9, subfield: 'S', field: 'F', domain: 'D' });
});
