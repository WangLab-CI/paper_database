import test from 'node:test';
import assert from 'node:assert/strict';
import { planImport, mergePatch } from '../site/js/importplan.js';

const existing = [
  { id: 'e1', doi: '10.1000/a', title: 'Alpha paper', tags: ['old'], abstract: null, pmid: null, journal: 'Nature' },
  { id: 'e2', doi: null, pmid: '123', title: 'Beta paper', tags: [] },
  { id: 'e3', doi: null, title: 'Gamma: a study!', tags: [] },
];

test('plan: match by DOI, PMID, title; repeats within file; new', () => {
  const recs = [
    { title: 'Alpha paper (preprint title)', doi: '10.1000/a' },
    { title: 'Something', pmid: '123' },
    { title: 'GAMMA a study' },
    { title: 'Brand new', doi: '10.2000/new' },
    { title: 'Brand new again', doi: '10.2000/new' },
    { title: 'brand new' },
  ];
  const plan = planImport(recs, existing);
  assert.deepEqual(plan.map((p) => p.status), ['existing', 'existing', 'existing', 'new', 'repeat', 'repeat']);
  assert.deepEqual(plan.slice(0, 3).map((p) => [p.existing.id, p.matchedBy]), [['e1', 'doi'], ['e2', 'pmid'], ['e3', 'title']]);
  assert.equal(plan[4].firstIndex, 3);
});

test('merge patch: adds tags, fills only empty fields, never overwrites', () => {
  const rec = { title: 'x', abstract: 'New abstract', pmid: '999', journal: 'Cell', tags: ['kw1'] };
  assert.deepEqual(mergePatch(existing[0], rec, { extraTags: ['zotero', 'old'] }),
    { tags: ['old', 'zotero'], abstract: 'New abstract', pmid: '999' });
  assert.deepEqual(mergePatch(existing[0], rec, { fileTags: true, fill: false }), { tags: ['old', 'kw1'] });
  assert.equal(mergePatch({ ...existing[0], abstract: 'a', pmid: '1' }, { title: 'x' }, {}), null);
});
