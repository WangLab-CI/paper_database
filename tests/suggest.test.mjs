import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestPapers } from '../site/js/suggest.js';

const lib = [
  { id: 'a', title: 'KRAS G12D organoids resist MEK inhibition', abstract: 'Pancreatic ductal adenocarcinoma organoids with KRAS mutation show MAPK rewiring.', tags: ['pdac'] },
  { id: 'b', title: 'Spatial transcriptomics of pancreatic tumour stroma', abstract: 'Cancer-associated fibroblasts form niches excluding T cells.', tags: [] },
  { id: 'c', title: 'Retinal imaging with deep learning', abstract: 'Diabetic retinopathy screening.', tags: [] },
  { id: 'd', title: 'Unrelated title', abstract: 'Nothing in common with anything.', tags: [], topics: [{ name: 'Pancreatic Cancer Research' }] },
  { id: 'e', title: 'Linked paper', abstract: '', tags: [] },
  { id: 'f', title: 'Some method paper', abstract: 'A generic protocol.', tags: [] },
];
const project = { title: 'CAF niches in pancreatic cancer', summary: 'Map cancer-associated fibroblast niches and T cell exclusion in PDAC using spatial transcriptomics.',
  hypothesis: '', rationale: '', aims: '', open_questions: '', next_steps: '', tags: ['pdac', 'pancreatic cancer'] };

test('ranks topical papers first, explains why, drops unrelated', () => {
  const s = suggestPapers(project, lib);
  assert.equal(s[0].paper.id, 'b');
  assert.ok(s[0].reasons[0].startsWith('text:') && /fibroblast|niches|spatial/.test(s[0].reasons[0]));
  assert.ok(s.some((x) => x.paper.id === 'a' && x.reasons.some((r) => r.includes('tags/topics: pdac'))));
  assert.ok(s.some((x) => x.paper.id === 'd' && x.reasons.some((r) => r.includes('pancreatic cancer'))), 'OpenAlex topic matches tag');
  assert.ok(!s.some((x) => x.paper.id === 'c'));
});

test('excludes linked and dismissed; network boost from linked papers', () => {
  const s = suggestPapers(project, lib, {
    linkedIds: new Set(['e']), dismissed: new Set(['a']),
    paperLinks: [{ source_id: 'f', target_id: 'e', kind: 'cites' }, { source_id: 'e', target_id: 'c', kind: 'similar' }],
  });
  const ids = s.map((x) => x.paper.id);
  assert.ok(!ids.includes('e') && !ids.includes('a'));
  const f = s.find((x) => x.paper.id === 'f');
  assert.ok(f && f.reasons.includes('cites 1 linked paper'));
  assert.ok(!ids.includes('c'), 'similar-wording links do not count as network evidence');
});
