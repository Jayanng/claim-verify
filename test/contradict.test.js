'use strict';

/**
 * Tests for the deterministic contradiction engine.
 *
 * This is the load-bearing component. If it produces a contradiction that is
 * not provable, the whole service is worse than useless, because it publishes
 * a confident answer that is really a guess. Every case below is about that.
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractFacts, compareFacts, deterministicVerdict, canonNumber } = require('../src/contradict');

// ---------------------------------------------------------------------------
// fact extraction
// ---------------------------------------------------------------------------

test('extracts an anchored year fact', () => {
  const facts = extractFacts('The company was founded in 1999 in London.');
  const founded = facts.filter((f) => f.anchor === 'founded');
  assert.ok(founded.length >= 1, 'the founded anchor must fire');
  assert.ok(founded.some((f) => f.kind === 'year' && f.value === 1999));
});

test('extracts a numeric fact with its unit', () => {
  const facts = extractFacts('The population is 1,227,000 people.');
  const pop = facts.filter((f) => f.anchor === 'population');
  assert.ok(pop.length >= 1);
  assert.ok(pop.some((f) => f.kind === 'number' && f.value === 1227000));
});

test('a number without an anchor is not reported as a fact', () => {
  // "1999" with no attribute is not a comparable fact.
  const facts = extractFacts('There were 42 of them, and then 17 more.');
  assert.equal(facts.length, 0, 'unanchored numbers must not become facts');
});

// ---------------------------------------------------------------------------
// the core safety property: different attributes never contradict
// ---------------------------------------------------------------------------

test('numbers under DIFFERENT anchors never contradict', () => {
  // This is the single most important test in the file. If this fails the
  // service will tell users that "founded in 1999" is contradicted by
  // "1999 employees", which is nonsense.
  const claimFacts = extractFacts('The company was founded in 1999.');
  const evFacts = extractFacts('The company employed 1,999 people in 2020.');

  const r = compareFacts(claimFacts, evFacts);
  assert.equal(r.contradictions.length, 0,
    'a founded date must not be contradicted by an employee count');
});

test('same anchor, different value IS a contradiction', () => {
  const claimFacts = extractFacts('The company was founded in 1999.');
  const evFacts = extractFacts('The company was founded in 2001.');

  const r = compareFacts(claimFacts, evFacts);
  assert.equal(r.contradictions.length, 1);
  assert.equal(r.contradictions[0].anchor, 'founded');
  assert.equal(r.contradictions[0].kind, 'value_conflict');
  // Both sides must be quotable.
  assert.ok(r.contradictions[0].claim_quote.includes('1999'));
  assert.ok(r.contradictions[0].evidence_quote.includes('2001'));
});

test('same anchor, same value is SUPPORT, not contradiction', () => {
  const claimFacts = extractFacts('The company was founded in 1999.');
  const evFacts = extractFacts('It was founded in 1999 and listed in 2004.');

  const r = compareFacts(claimFacts, evFacts);
  assert.equal(r.contradictions.length, 0);
  assert.ok(r.supports.length >= 1);
});

test('numbers differing by less than 0.5 percent are the same value', () => {
  const a = extractFacts('The price was 100 dollars.');
  const b = extractFacts('The price was 100.2 dollars.');
  const r = compareFacts(a, b);
  assert.equal(r.contradictions.length, 0);
  assert.ok(r.supports.length >= 1, 'rounding must not manufacture a contradiction');
});

test('a year is never compared against a plain number', () => {
  const a = extractFacts('It was founded in 1999.');
  const b = extractFacts('It was founded with 1999 employees.');
  const r = compareFacts(a, b);
  // Even though both sit under the "founded" anchor, one is a year and one is
  // a count. Mixing them would be a category error.
  assert.equal(r.contradictions.length, 0);
});

// ---------------------------------------------------------------------------
// numeric canonicalisation
// ---------------------------------------------------------------------------

test('thousands separators and scale words canonicalise correctly', () => {
  assert.equal(canonNumber('1,227').value, 1227);
  assert.equal(canonNumber('1227').value, 1227);
  assert.equal(canonNumber('1.5 million').value, 1500000);
  assert.equal(canonNumber('2 billion').value, 2e9);
  assert.equal(canonNumber('42%').value, 42);
  assert.equal(canonNumber('3k').value, 3000);
  assert.equal(canonNumber('not a number'), null);
});

// ---------------------------------------------------------------------------
// end-to-end verdict
// ---------------------------------------------------------------------------

function cit(source, quote) {
  return { source, url: 'https://example.test/1', title: 'T', quote };
}

test('CONTRADICTED when the evidence states a competing value', () => {
  const out = deterministicVerdict(
    'The company was founded in 1999.',
    [cit('wikipedia', 'The company was founded in 2001 by two engineers.')]
  );
  assert.equal(out.verdict, 'CONTRADICTED');
  assert.equal(out.contradictions.length, 1);
});

test('SUPPORTED when the evidence agrees', () => {
  const out = deterministicVerdict(
    'The company was founded in 1999.',
    [cit('wikipedia', 'The company was founded in 1999.')]
  );
  assert.equal(out.verdict, 'SUPPORTED');
});

test('UNRESOLVED is the default when evidence says nothing comparable', () => {
  const out = deterministicVerdict(
    'The company was founded in 1999.',
    [cit('wikipedia', 'The company is headquartered in Berlin and makes software.')]
  );
  assert.equal(out.verdict, 'UNRESOLVED',
    'silence from the evidence must never become a verdict');
  assert.equal(out.contradictions.length, 0);
  assert.equal(out.supports.length, 0);
});

test('UNRESOLVED when there is no evidence at all', () => {
  const out = deterministicVerdict('The company was founded in 1999.', []);
  assert.equal(out.verdict, 'UNRESOLVED');
});

test('a contradiction wins even when another source agrees', () => {
  const out = deterministicVerdict(
    'The company was founded in 1999.',
    [
      cit('wikipedia', 'The company was founded in 1999.'),
      cit('sec-edgar', 'Incorporated in 2001, the company filed its first report.'),
    ]
  );
  assert.equal(out.verdict, 'CONTRADICTED',
    'one contradicting source must not be outvoted by one agreeing source');
  assert.ok(out.supports.length >= 1, 'the agreement is still reported');
});

test('quotes are verbatim spans, not summaries', () => {
  const ev = 'The company was founded in 2001 by two engineers in a garage.';
  const out = deterministicVerdict('The company was founded in 1999.', [cit('wikipedia', ev)]);
  const c = out.contradictions[0];
  assert.ok(ev.includes(c.evidence_quote.trim()),
    'the evidence quote must appear character for character in the source text');
  assert.ok(c.claim_quote.includes('1999'),
    'the claim quote must contain the claim value');
});

// ---------------------------------------------------------------------------
// REGRESSION SUITE: a true claim must never be reported as CONTRADICTED.
//
// Every case here was reproduced live by an audit against this code. The 15
// tests above all passed while these seven vectors were broken, so green tests
// were giving false confidence. Each asserts the safe direction AND keeps a
// paired case proving the engine still catches a real falsehood.
// ---------------------------------------------------------------------------

// A plain assertion, NOT a test() call: node:test rejects registering a test
// from inside another test body.
const repro = (name, claim, quote) => {
  const out = deterministicVerdict(claim, [cit('test', quote)]);
  assert.notEqual(out.verdict, 'CONTRADICTED',
    `TRUE claim must not be CONTRADICTED (${name}), got ${out.verdict}`);
};

test('date fragments never leak as competing numbers', () => {
  // ISO dates and abbreviated months used to yield signed number facts, so
  // "4 Aug. 1961" produced a number 4 that contradicted Wikidata's 1961.
  repro('Obama 4 Aug 1961 vs ISO date',
    'Barack Obama was born 4 Aug. 1961.',
    'Barack Obama born in 1961-08-04 (Wikidata P569);');
  const f = extractFacts('Barack Obama was born 4 Aug. 1961.');
  assert.ok(f.every((x) => x.value !== 4 && x.value !== -8),
    'no day-of-month or month-index fact may be produced');
});

test('different attributes of one claim never compete', () => {
  // "founded in 1999 and launched in 2004" put 2004 under the founded anchor
  // and contradicted evidence that correctly said 1999.
  const out = deterministicVerdict(
    'The company was founded in 1999 and launched in 2004.',
    [cit('test', 'The company was founded in 1999.')]
  );
  assert.notEqual(out.verdict, 'CONTRADICTED');
  assert.ok(out.supports.length >= 1, 'the agreement is still reported');
});

test('generational suffixes are compared symmetrically', () => {
  // The gate used to switch off entirely once the claim named a suffix.
  repro('MLK Jr vs Sr',
    'Martin Luther King Jr. was born in 1929.',
    'Martin Luther King Sr. was born in 1899.');
  repro('Elizabeth II vs Elizabeth I',
    'Elizabeth II was born in 1926.',
    'Elizabeth I born in 1533.');
  repro('suffix-less claim vs suffixed quote',
    'Barack Obama was born in 1961.',
    'Barack Obama Sr. born in 1934-06-18.');
});

test('subject matching uses whole tokens', () => {
  repro('John vs Johnson',
    'John was born in 1961.',
    'Johnson was born in 1932 and wrote dictionaries.');
});

test('measurement units are captured and compared', () => {
  repro('meters vs feet',
    'Burj Khalifa height is 828 meters.',
    'Burj Khalifa height is 2717 feet.');
  repro('dollars vs euros',
    'The price is 100 dollars.',
    'The price is 85 euros.');
});

test('a property id is not a quantity', () => {
  // "P569" used to yield a number fact of 569 under the nearest anchor.
  const f = extractFacts('Albert Einstein born in 1879 (Wikidata P569)');
  assert.ok(f.every((x) => x.value !== 569),
    'the Wikidata property id must not become a value');
});

test('these regressions do not blunt real detection', () => {
  for (const [claim, quote] of [
    ['Barack Obama was born in 1955.', 'Barack Obama born in 1961-08-04 (Wikidata P569)'],
    ['The company was founded in 1999.', 'Incorporated in 2001, the company filed its first report.'],
  ]) {
    const out = deterministicVerdict(claim, [cit('test', quote)]);
    assert.equal(out.verdict, 'CONTRADICTED',
      `a genuine falsehood must still be caught: ${claim}`);
    assert.ok(out.contradictions[0].evidence_quote.length > 0,
      'every contradiction must quote the evidence verbatim');
  }
});

test('a fact binds to its own clause, not the whole quote window', () => {
  // Found by an external review. The fact's subject check read the entire
  // ±25 character window, so a citation naming two people put the WRONG
  // person's name inside it and a true claim was contradicted by another
  // entity's value.
  repro('two people in one citation',
    'John Smith was born in 1980',
    'John Smith; Jane Doe born in 1970');
  repro('two people in one clause',
    'John Smith was born in 1980',
    'John Smith and Jane Doe were born in 1970');
  repro('parent and subsidiary',
    'Acme Corp was founded in 1999.',
    'Acme Corp; Acme Holdings was founded in 2005.');
  // The subject word must still reach the fact when it IS about them.
  const out = deterministicVerdict(
    'John Smith was born in 1980',
    [cit('test', 'John Smith was born in 1971')]
  );
  assert.equal(out.verdict, 'CONTRADICTED',
    'a real falsehood about the right person must still be caught');
});
