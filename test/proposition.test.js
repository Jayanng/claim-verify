'use strict';

/**
 * Phase 1 invariants: typed propositions.
 *
 * Every assertion here is a permanent guard against a false contradiction that
 * an external review actually found. Green tests were giving false confidence
 * before, so these are written as invariants rather than examples.
 */

const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/proposition');

test('five organisational verbs are five distinct predicates', () => {
  // One shared anchor name was the licence for 'Acme launched in 2004' being
  // contradicted by 'Acme was founded in 1999'.
  const cans = ['founded', 'launched', 'incorporated', 'established', 'created']
    .map((w) => P.WORD_TO_PREDICATE.get(w).canonical);
  assert.equal(new Set(cans).size, 5, `got ${JSON.stringify(cans)}`);
});

test('semantic_category is never a comparison key', () => {
  const f = P.PREDICATES.find((p) => p.canonical === 'founding');
  const e = P.PREDICATES.find((p) => p.canonical === 'establishment');
  assert.equal(f.semantic_category, e.semantic_category);
  assert.notEqual(f.canonical, e.canonical);
  assert.equal(f.type, undefined, 'the comparable-looking field must not exist');
});

test('a unit is never also a year', () => {
  const v = P.readValue('2020 meters', { predicateCanonical: 'height' });
  assert.equal(v.type, 'length');
  assert.equal(v.unit, 'meters');
});

test('a bare number inherits its predicate type or stays unknown', () => {
  assert.equal(P.readValue('2020', { predicateCanonical: 'height' }).type, 'length');
  assert.equal(P.readValue('2020', {}).type, 'unknown', 'never guess');
});

test('a date predicate needs date context before a number becomes a year', () => {
  assert.equal(P.readValue('2001', { predicateCanonical: 'founding', nearDateContext: true }).type, 'calendar_year');
  assert.equal(P.readValue('2001', { predicateCanonical: 'founding', nearDateContext: false }).type, 'unknown');
});

test('ambiguous predicates do not inherit calendar_year', () => {
  // 'The author published 10 books in 1999' carries a count and a date under
  // one predicate. Typing the 10 as a year lets a comparator pit it against
  // a real date.
  for (const pred of ['publication', 'release', 'creation']) {
    assert.equal(P.readValue('10', { predicateCanonical: pred, nearDateContext: false }).type,
      'unknown', `${pred} must not type a bare count as a year`);
    assert.equal(P.readValue('1999', { predicateCanonical: pred, nearDateContext: true }).type,
      'calendar_year', `${pred} with date context is a year`);
  }
});

test('an ambiguous unit is left unknown rather than guessed', () => {
  // 'pounds' is both mass and currency. Map ordering silently picked one.
  assert.equal(P.UNIT_TO_TYPE.get('pounds'), undefined);
  assert.equal(P.UNIT_TO_TYPE.get('lbs'), 'mass');
});

test('dates reduce to a bare year and citation dates are stripped', () => {
  assert.equal(P.normaliseDates('born 4 Aug. 1961'), 'born 1961');
  assert.equal(P.normaliseDates('1961-08-04'), '1961');
  assert.equal(P.normaliseDates('released 8/4/1961'), 'released 1961');
  assert.ok(!P.normaliseDates('founding (1776) — Smith').includes('1776'),
    'a parenthesised citation year is not an assertion');
});

test('the predicate regex is not shared state', () => {
  assert.notEqual(P.predicateRe(), P.predicateRe(),
    'a shared /g/ regex carries lastIndex and silently skips matches');
});

test('scale words multiply and keep their meaning', () => {
  const v = P.readValue('42 million', { predicateCanonical: 'population' });
  assert.equal(v.value, 42000000);
  assert.equal(v.type, 'cardinal_number');
});
