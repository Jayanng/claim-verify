'use strict';

/**
 * Phase 3 invariants: the contradiction gate.
 *
 * This is the only module that decides. Every assertion below guards a false
 * contradiction an external review actually produced, and every one asserts
 * the SAFE direction: a true claim is never CONTRADICTED.
 */

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/compare');

const subj = (s) => ({ surface: s, tokens: s.toLowerCase().split(/\s+/) });
const pred = (c, w) => ({ canonical: c, semantic_category: 'x', words: w || [] });
const obj = (v, t, u) => ({ value: v, type: t, unit: u || null, raw: String(v) });
function mk(s, can, v, t, sentence, unit, words) {
  return {
    subject: subj(s), predicate: pred(can, words), object: obj(v, t, unit),
    qualifiers: { polarity: 'affirmative', modality: 'asserted' },
    provenance: { sentence },
  };
}
const safe = (name, claim, ev, quote) => {
  const r = C.evaluate(claim, ev, { quote });
  assert.notEqual(r.verdict, 'CONTRADICTED',
    `${name} must not contradict, got ${r.verdict}: ${r.reason}`);
};
const contradicts = (name, claim, ev, quote) => {
  const r = C.evaluate(claim, ev, { quote });
  assert.equal(r.verdict, 'CONTRADICTED', `${name}: ${r.reason}`);
};

test('an agreeing quote never contradicts', () => {
  const q = 'Acme Corp was founded in 1999 and again in 2001.';
  safe('agreeing quote',
    mk('Acme Corp', 'founding', 2001, 'calendar_year', null, null, ['founded']),
    [mk('Acme Corp', 'founding', 1999, 'calendar_year', q, null, ['founded']),
     mk('Acme Corp', 'founding', 2001, 'calendar_year', q, null, ['founded'])], q);
});

test('a different predicate never contradicts', () => {
  safe('founded vs launched',
    mk('Acme Corp', 'launch', 2004, 'calendar_year', null, null, ['launched']),
    [mk('Acme Corp', 'founding', 1999, 'calendar_year', 'Acme Corp was founded in 1999.', null, ['founded'])],
    'Acme Corp was founded in 1999.');
});

test('attachment ambiguity blocks', () => {
  safe('two entities one clause',
    mk('John Smith', 'birth', 1980, 'calendar_year', null, null, ['born']),
    [mk('Jane Doe', 'birth', 1970, 'calendar_year', 'John Smith, Jane Doe was born in 1970.', null, ['born'])],
    'John Smith, Jane Doe was born in 1970.');
});

test('a single shared token can never contradict', () => {
  safe('Mercury',
    mk('Mercury', 'founding', 1990, 'calendar_year', null, null, ['founded']),
    [mk('Mercury', 'founding', 1980, 'calendar_year', 'Mercury was founded in 1980.', null, ['founded'])],
    'Mercury was founded in 1980.');
});

test('units must match exactly', () => {
  safe('meters vs feet',
    mk('Tower', 'height', 2020, 'length', null, 'meters', ['height']),
    [mk('Tower', 'height', 2021, 'length', 'The tower height is 2021 feet.', 'feet', ['height'])],
    'The tower height is 2021 feet.');
});

test('an unknown value type refuses', () => {
  safe('unknown type',
    mk('Tower', 'height', 2020, 'unknown', null, null, ['height']),
    [mk('Tower', 'height', 1500, 'unknown', 'The tower height is 1500.', null, ['height'])],
    'The tower height is 1500.');
});

test('negated evidence refuses', () => {
  safe('negation',
    mk('Acme Corp', 'founding', 2001, 'calendar_year', null, null, ['founded']),
    [Object.assign(mk('Acme Corp', 'founding', 1999, 'calendar_year', 'Acme Corp was not founded in 1999.', null, ['founded']),
      { qualifiers: { polarity: 'negated', modality: 'asserted' } })],
    'Acme Corp was not founded in 1999.');
});

test('the quote must ESTABLISH the proposition, not merely exist', () => {
  const claim = mk('Acme Corp', 'founding', 1999, 'calendar_year', null, null, ['founded']);
  const ev = [mk('Acme Corp', 'founding', 2001, 'calendar_year', 'Acme Corp was founded in 2001.', null, ['founded'])];
  safe('a pointer quote', claim, ev, 'See page 4');
  safe('an irrelevant quote', claim, ev, 'Further details are available.');
  contradicts('a quote that carries it', claim, ev, 'Acme Corp was founded in 2001.');
});

test('an object absorbed into another subject never contradicts', () => {
  safe('Mercury owns Acme Corp',
    mk('Acme Corp', 'founding', 1990, 'calendar_year', null, null, ['founded']),
    [mk('Mercury', 'founding', 1980, 'calendar_year', 'Mercury owns Acme Corp and was founded in 1980.', null, ['founded'])],
    'Mercury owns Acme Corp and was founded in 1980.');
});

test('a real contradiction still fires', () => {
  contradicts('two shared tokens',
    mk('Albert Einstein', 'birth', 1879, 'calendar_year', null, null, ['born']),
    [mk('Albert Einstein', 'birth', 1971, 'calendar_year', 'Albert Einstein was born in 1971.', null, ['born'])],
    'Albert Einstein was born in 1971.');
  contradicts('unambiguous subject',
    mk('Acme Corp', 'founding', 1990, 'calendar_year', null, null, ['founded']),
    [mk('Acme Corp', 'founding', 1980, 'calendar_year', 'Acme Corp was founded in 1980.', null, ['founded'])],
    'Acme Corp was founded in 1980.');
});

test('every refusal names its reason', () => {
  const r = C.evaluate(
    mk('Mercury', 'founding', 1990, 'calendar_year', null, null, ['founded']),
    [mk('Mercury', 'founding', 1980, 'calendar_year', 'Mercury was founded in 1980.', null, ['founded'])],
    { quote: 'Mercury was founded in 1980.' });
  assert.equal(r.verdict, 'UNRESOLVED');
  assert.ok(r.reason && r.reason.length > 10, 'a refusal must say why');
});
