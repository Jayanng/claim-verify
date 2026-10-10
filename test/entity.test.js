'use strict';

/**
 * Phase 2 invariants: entity identity and attachment.
 *
 * Every assertion guards a false contradiction an external review actually
 * found. Both reviews of this phase were run through the GMI Router as
 * instructed, and both found real defects in the first implementation.
 */

const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/entity');

test('a verb is never part of a name span', () => {
  // Review 1: "Mercury founded Acme Corp" produced ONE mention containing the
  // object, so a claim about Acme Corp matched a value belonging to Mercury.
  assert.deepEqual(E.entityMentions('Mercury founded Acme Corp in 1980').map((m) => m.surface),
    ['Mercury']);
});

test('an UNLISTED verb cannot absorb the object either', () => {
  // Review 2: a blocklist of verbs is never complete. "owns" was not on it.
  // The structural rule is that a name span ends at any non name-shaped token.
  for (const s of ['Mercury owns Acme Corp', 'Mercury met Acme Corp',
                   'Mercury works for Acme Corp', 'Mercury includes Acme Corp']) {
    const mentions = E.entityMentions(s);
    assert.equal(mentions.length, 1, `${s} should yield one mention`);
    assert.ok(!mentions[0].tokens.includes('acme'),
      `${s} must not absorb the object: got ${mentions[0].surface}`);
  }
});

test('a claim about the object is never contradicted by the subject', () => {
  const claim = E.entityMentions('Acme Corp was founded in 1990')[0];
  for (const quote of ['Mercury owns Acme Corp', 'Mercury founded Acme Corp in 1980',
                       'Mercury works for Acme Corp', 'Mercury met Acme Corp']) {
    const t = E.identityTier(claim, E.entityMentions(quote)[0]);
    assert.ok(t.tier < 2, `${quote} must not reach contradiction tier, got ${t.tier}`);
  }
});

test('two entities in one clause leave attachment unresolved', () => {
  // "John Smith, Jane Doe was born in 1970" contradicted a true claim about
  // John Smith using Jane Doe's birth year.
  const a = E.attach('John Smith, Jane Doe was born in 1970', null, 0, 0);
  assert.equal(a.attached, false);
  assert.match(a.reason, /2 entities/);
});

test('a single clear subject does attach', () => {
  assert.equal(E.attach('John Smith was born in 1970', null, 0, 0).attached, true);
});

test('generational suffixes decide identity symmetrically', () => {
  const jr = { tokens: ['martin', 'luther', 'king'], suffix: 'jr' };
  const sr = { tokens: ['martin', 'luther', 'king'], suffix: 'sr' };
  assert.equal(E.identityTier(jr, sr).tier, 0, 'Jr and Sr are different people');
  assert.equal(E.identityTier(jr, { ...jr }).tier, 2, 'the same suffix is a discriminator');
  assert.equal(E.identityTier({ tokens: ['john', 'smith'] }, { tokens: ['john', 'smith'], suffix: 'jr' }).tier, 0,
    'a suffix on one side only means a different entity');
});

test('a single shared token is name-only and can never contradict', () => {
  // Mercury is a planet, an element, several companies and a car.
  const t = E.identityTier({ tokens: ['mercury'] }, { tokens: ['mercury'] });
  assert.equal(t.tier, 1);
});

test('two shared distinctive tokens identify strongly', () => {
  assert.equal(E.identityTier(
    { tokens: ['albert', 'einstein'] }, { tokens: ['albert', 'einstein'] }).tier, 2);
});

test('a generic type word is not a name', () => {
  const t = E.identityTier({ tokens: ['company'] }, { tokens: ['acme'] });
  assert.ok(t.tier < 2, 'a generic word must never licence a contradiction');
});

test('tier 2 is not reachable by name overlap alone', () => {
  // Final review 1: two shared tokens was treated as tier 2, but a longer
  // name is not a discriminator. 'John Smith' and 'John Smith Jones' share two
  // tokens and are different candidates.
  assert.equal(E.identityTier(
    { tokens: ['john', 'smith'] }, { tokens: ['john', 'smith'] }).tier, 2,
    'an exact name match is tier 2');
  assert.equal(E.identityTier(
    { tokens: ['john', 'smith'] }, { tokens: ['john', 'smith', 'jones'] }).tier, 1,
    'partial name overlap is name only and must never contradict');
  assert.equal(E.identityTier(
    { tokens: ['albert', 'einstein'] }, { tokens: ['albert', 'einstein', 'jr'] }).tier, 1,
    'a longer name on one side is not the same entity');
});
