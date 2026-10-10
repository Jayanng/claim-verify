'use strict';

/**
 * THE REGRESSION SUITE.
 *
 * Every case here is a false contradiction that was really produced by an
 * earlier version of this service, found either by my own adversarial testing
 * or by an external review. Each is a PERMANENT INVARIANT: if any of them
 * ever reports CONTRADICTED again, the service has regressed and must not
 * ship.
 *
 * The paired cases matter just as much. A service that never contradicts
 * anything is safe and useless, so every safe case sits beside one that MUST
 * still be caught.
 *
 * Run through the full pipeline: extract.js parses, compare.js gates. That is
 * what the live service does, so that is what is tested.
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractPropositions } = require('../src/extract');
const gate = require('../src/compare');

/** The verdict the live service would give for a claim against one quotation. */
function verdict(claim, quote) {
  const claimProps = extractPropositions(claim);
  const evProps = extractPropositions(quote);
  let v = 'UNRESOLVED';
  for (const cp of claimProps) {
    const r = gate.evaluate(cp, evProps, { quote });
    if (r.verdict === 'CONTRADICTED') return 'CONTRADICTED';
    if (gate.canSupport(cp, evProps)) v = 'SUPPORTED';
  }
  return v;
}

// name, claim, quotation, and what must happen
const INVARIANTS = [
  // ---- false contradictions actually produced, all must stay safe ----
  ['date fragments leaked as numbers',
    'Barack Obama was born 4 Aug. 1961.',
    'Barack Obama born in 1961-08-04 (Wikidata P569)'],
  ['ISO date month and day leaked as signed numbers',
    'Barack Obama was born in 1961.',
    'Barack Obama born in 1961-08-04 (Wikidata P569)'],
  ['anchor family collapse, founded vs launched',
    'The company was founded in 1999 and launched in 2004.',
    'The company was founded in 1999.'],
  ['cross-family with a single surface word',
    'Acme Corp launched in 2004.',
    'Acme Corp was founded in 1999.'],
  ['generational suffix one-sided gate, Jr vs Sr',
    'Martin Luther King Jr. was born in 1929.',
    'Martin Luther King Sr. was born in 1899.'],
  ['ordinal suffix, Elizabeth II vs I',
    'Elizabeth II was born in 1926.',
    'Elizabeth I born in 1533.'],
  ['suffix on the quote only',
    'Barack Obama was born in 1961.',
    'Barack Obama Sr. born in 1934-06-18.'],
  ['substring subject matching, John vs Johnson',
    'John was born in 1961.',
    'Johnson was born in 1932 and wrote dictionaries.'],
  ['units dropped so meters and feet collided',
    'Burj Khalifa height is 828 meters.',
    'Burj Khalifa height is 2717 feet.'],
  ['currency units dropped',
    'The price is 100 dollars.',
    'The price is 85 euros.'],
  ['Wikidata property id read as a quantity',
    'Albert Einstein was born in 1879.',
    'Albert Einstein born in 1879 (Wikidata P569)'],
  ['property collapse, area rendered as height',
    'The hall has a height of 300.',
    'The hall height is 20000 (Wikidata P2046); The hall height is 300 (Wikidata P2048)'],
  ['an agreeing quote was contradicted by a sibling value',
    'Amazon.com was founded in 1994.',
    'Amazon.com was founded in 1994. Amazon.com was incorporated in 1996 in Delaware.'],
  ['a source with two recorded values is ambiguous',
    'The town was founded in 1901.',
    'The town founded in 1899 (Wikidata P571); The town founded in 1901 (Wikidata P571)'],
  ['pre-1900 citation year bound to a title anchor',
    'Encyclopaedia was founded in 1768.',
    'Encyclopaedia founding (1776) — Smith, Journal.'],
  ['trailing pre-1900 citation year',
    'The town was founded in 1802.',
    'The town founding — Smith, Journal, 1859.'],
  ['multi-value extraction dropped the agreeing value',
    'Acme Corp was founded in 2001.',
    'Acme Corp was founded in 1999 and founded again in 2001.'],
  ['coordinated values split across clauses',
    'Alex population was 200.',
    'Alex population was 100 people in 2020 and 200 people in 2021.'],
  ['comma separated entities, attachment unresolved',
    'John Smith was born in 1980.',
    'John Smith, Jane Doe was born in 1970.'],
  ['comma entities, variant wording',
    'John Smith was born in 1980.',
    'John Smith, Jane Doe was born in 1970'],
  ['single shared token is name only',
    'Mercury was founded in 1990.',
    'Mercury was founded in 1980.'],
  ['object absorbed into the subject',
    'Acme Corp was founded in 1990.',
    'Mercury founded Acme Corp in 1980.'],
  ['object absorbed, unlisted verb',
    'Acme Corp was founded in 1990.',
    'Mercury owns Acme Corp and was founded in 1980.'],
  ['a four digit measurement read as a year',
    'The tower height is 2020 meters.',
    'The tower height is 2021 feet.'],
  ['bare count typed as a year',
    'The author published 10 books.',
    'The author published 1999 books.'],
  ['modal negation read as an assertion',
    'Paris population is 100.',
    'Paris cannot have a population of 100.'],
  ['lexical negation, lacks',
    'Paris population is 200.',
    'Paris lacks a population of 100.'],
  ['negation phrased with without',
    'Paris population is 200.',
    'Paris is without 100 residents.'],
  ['negation scope, a denial beside an affirmation',
    'Acme Corp was founded in 1999.',
    'Acme Corp was founded in 1999, not 2001.'],
  ['a pointer quote establishes nothing',
    'Acme Corp was founded in 1999.',
    'See page 4'],
  ['an irrelevant quote establishes nothing',
    'Acme Corp was founded in 1999.',
    'Further details are available.'],
  ['a generic type word is not a name',
    'The company was founded in 1999.',
    'A rival company was founded in 2001 and grew rapidly.'],
  ['hypothetical claim is not an assertion',
    'If Acme Corp were founded in 1999 it would be old.',
    'Acme Corp was founded in 1980.'],
];

// Claim, quotation, and the verdict that must still be produced.
const MUST_DETECT = [
  ['a genuine birth year falsehood',
    'Albert Einstein was born in 1879.', 'Albert Einstein was born in 1971.', 'CONTRADICTED'],
  ['a genuine founding falsehood, unambiguous subject',
    'Acme Corp was founded in 1990.', 'Acme Corp was founded in 1980.', 'CONTRADICTED'],
  ['a genuine falsehood about a well known person',
    'Barack Obama was born in 1961.', 'Barack Obama was born in 1955.', 'CONTRADICTED'],
  ['agreement is still reported',
    'Albert Einstein was born in 1879.', 'Albert Einstein was born in 1879.', 'SUPPORTED'],
];

test('no true claim is ever reported CONTRADICTED', () => {
  const failures = [];
  for (const [name, claim, quote] of INVARIANTS) {
    const v = verdict(claim, quote);
    if (v === 'CONTRADICTED') failures.push(`${name}: "${claim}" vs "${quote}"`);
  }
  assert.deepEqual(failures, [],
    `FALSE CONTRADICTION REGRESSION:\n  ${failures.join('\n  ')}`);
});

test('every one of these still yields a verdict, not a crash', () => {
  for (const [name, claim, quote] of INVARIANTS) {
    const v = verdict(claim, quote);
    assert.ok(['CONTRADICTED', 'SUPPORTED', 'UNRESOLVED'].includes(v),
      `${name} produced an unrecognised verdict ${v}`);
  }
});

test('genuine falsehoods are still caught', () => {
  for (const [name, claim, quote, want] of MUST_DETECT) {
    assert.equal(verdict(claim, quote), want, `${name} must be ${want}`);
  }
});

test('the invariant count is what we expect', () => {
  // Guards against the suite silently losing cases to a bad edit.
  assert.ok(INVARIANTS.length >= 30, `expected at least 30 invariants, got ${INVARIANTS.length}`);
  assert.ok(MUST_DETECT.length >= 4, `expected at least 4 detection cases, got ${MUST_DETECT.length}`);
});
