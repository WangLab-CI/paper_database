import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleUrl, extractCitationMeta, resolveUrl, cleanDoi } from '../site/js/urlresolve.js';

const cases = [
  ['https://doi.org/10.1038/s41586-024-07000-1', 'doi', '10.1038/s41586-024-07000-1'],
  ['https://www.nature.com/articles/s41586-024-07000-1', 'doi', '10.1038/s41586-024-07000-1'],
  ['https://www.nature.com/articles/s41588-023-01234-5.pdf', 'doi', '10.1038/s41588-023-01234-5'],
  ['https://www.biorxiv.org/content/10.1101/2024.01.15.575678v2.full', 'doi', '10.1101/2024.01.15.575678'],
  ['https://www.medrxiv.org/content/10.1101/2023.11.02.23297935v1.full-text', 'doi', '10.1101/2023.11.02.23297935'],
  ['https://www.science.org/doi/10.1126/science.adf1234', 'doi', '10.1126/science.adf1234'],
  ['https://www.pnas.org/doi/full/10.1073/pnas.2301234120', 'doi', '10.1073/pnas.2301234120'],
  ['https://onlinelibrary.wiley.com/doi/epdf/10.1002/ijc.34567', 'doi', '10.1002/ijc.34567'],
  ['https://link.springer.com/article/10.1007/s00018-023-04800-1', 'doi', '10.1007/s00018-023-04800-1'],
  ['https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0281234', 'doi', '10.1371/journal.pone.0281234'],
  ['https://aacrjournals.org/cancerdiscovery/article/13/4/890/123/Title?doi=10.1158/2159-8290.CD-22-1234', 'doi', '10.1158/2159-8290.cd-22-1234'],
  ['https://pubmed.ncbi.nlm.nih.gov/38123456/', 'pmid', '38123456'],
  ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10812345/', 'pmcid', 'PMC10812345'],
  ['https://pmc.ncbi.nlm.nih.gov/articles/PMC10812345/', 'pmcid', 'PMC10812345'],
  ['https://europepmc.org/article/MED/38123456', 'pmid', '38123456'],
  ['https://arxiv.org/abs/2401.01234v3', 'arxiv', '2401.01234'],
  ['https://www.sciencedirect.com/science/article/pii/S0092867424001234', 'pii', 'S0092867424001234'],
  ['https://www.cell.com/cell/fulltext/S0092-8674(24)00123-4', 'pii', 'S0092867424001234'],
  ['https://www.thelancet.com/journals/lanonc/article/PIIS1470-2045(23)00456-7/fulltext', 'pii', 'S1470204523004567'],
];

test('identifier extracted from publisher URLs', () => {
  for (const [url, type, id] of cases) assert.deepEqual(parseArticleUrl(url), { type, id }, url);
});

test('unknown URLs keep slug words for search; non-URLs rejected', () => {
  const r = parseArticleUrl('https://academic.oup.com/nar/article/52/1/123/7654321/telomere-length-dynamics-in-human-cancer');
  assert.equal(r.type, 'unknown');
  assert.equal(r.slug, 'telomere length dynamics in human cancer');
  assert.equal(parseArticleUrl('not a url'), null);
  assert.equal(parseArticleUrl('ftp://x.org/a'), null);
  assert.equal(cleanDoi('10.1000/abc).'), '10.1000/abc');
});

test('citation meta tags → record', () => {
  const m = extractCitationMeta([
    ['citation_title', 'Telomere crisis in cancer'], ['citation_author', 'Wang, Guiping'], ['citation_author', 'Ann B. Smith'],
    ['citation_journal_title', 'Nucleic Acids Research'], ['citation_publication_date', '2024/01/15'], ['citation_doi', 'doi:10.1093/NAR/gkad1234'],
    ['og:title', 'ignored'], ['description', 'An abstract.'],
  ]);
  assert.deepEqual(m, { doi: '10.1093/nar/gkad1234', pmid: null, title: 'Telomere crisis in cancer', authors: 'Wang, Guiping; Smith, Ann B.',
    journal: 'Nucleic Acids Research', year: 2024, abstract: 'An abstract.', pdf_url: null });
});

test('resolve chain: DOI in link, then page reader, then candidates', async () => {
  const fetchers = { doi: async (d) => ({ title: 'T for ' + d, doi: d }), pmid: async (p) => ({ title: 'P ' + p }), pmcid: async () => ({}), arxiv: async () => ({}) };
  const a = await resolveUrl('https://www.nature.com/articles/s41586-024-07000-1', { fetchers });
  assert.equal(a.rec.doi, '10.1038/s41586-024-07000-1');
  assert.equal(a.rec.url, 'https://www.nature.com/articles/s41586-024-07000-1');
  const sb = { functions: { invoke: async () => ({ data: { meta: [['citation_doi', '10.1093/nar/gkad1']] }, error: null }) } };
  const b = await resolveUrl('https://academic.oup.com/nar/article/52/1/1/2/some-title-here', { fetchers, sb });
  assert.equal(b.rec.title, 'T for 10.1093/nar/gkad1');
  assert.equal(b.via, 'page citation tags → DOI');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ message: { items: [{ DOI: '10.1/X', title: ['Telomere length dynamics'], issued: { 'date-parts': [[2024]] } }] } }) });
  try {
    const noFn = { functions: { invoke: async () => ({ data: null, error: new Error('Function not found') }) } };
    const c = await resolveUrl('https://academic.oup.com/nar/article/52/1/1/2/telomere-length-dynamics-in-cancer', { fetchers, sb: noFn });
    assert.equal(c.candidates[0].doi, '10.1/x');
  } finally { globalThis.fetch = realFetch; }
});
