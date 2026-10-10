'use strict';

/**
 * HTTP surface tests.
 *
 * These exist because a syntax error in src/server.js sat through a full run of
 * the contradiction suite with 22 of 22 passing. Nothing exercised the server,
 * so nothing noticed the service could not start. The same blind spot is why
 * the lax validation and the dropped 413 response went unnoticed.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseRequest, identityPayload, SERVICE_ID, SCHEMA } = require('../src/server');

test('server.js loads at all', () => {
  // A syntax error makes require throw, so this single assertion is the guard.
  assert.equal(typeof parseRequest, 'function');
});

test('parseRequest rejects an empty body', () => {
  const r = parseRequest('');
  assert.equal(r.ok, false);
});

test('parseRequest rejects non-JSON', () => {
  assert.equal(parseRequest('not json').ok, false);
});

test('parseRequest rejects a non-object body', () => {
  assert.equal(parseRequest('[]').ok, false);
  assert.equal(parseRequest('"a string"').ok, false);
});

test('parseRequest rejects unknown fields instead of ignoring them', () => {
  const r = parseRequest('{"claim":"x","bogus":1}');
  assert.equal(r.ok, false);
  assert.match(r.error, /bogus/);
});

test('parseRequest rejects a missing or empty claim', () => {
  assert.equal(parseRequest('{}').ok, false);
  assert.equal(parseRequest('{"claim":"  "}').ok, false);
  assert.equal(parseRequest('{"claim":123}').ok, false);
});

test('parseRequest rejects an over-long claim', () => {
  assert.equal(parseRequest(JSON.stringify({ claim: 'x'.repeat(2001) })).ok, false);
});

test('parseRequest REJECTS a wrongly typed include_model rather than coercing', () => {
  // include_model: "yes" used to be silently read as false. The published
  // schema says boolean, and the contract says values are never altered.
  for (const bad of ['"yes"', '1', '0', '"true"']) {
    const r = parseRequest(`{"claim":"x","include_model":${bad}}`);
    assert.equal(r.ok, false, `include_model ${bad} must be rejected, not coerced`);
  }
  assert.equal(parseRequest('{"claim":"x","include_model":true}').ok, true);
  assert.equal(parseRequest('{"claim":"x","include_model":false}').ok, true);
});

test('parseRequest REJECTS too many terms instead of truncating', () => {
  const terms = Array.from({ length: 15 }, (_, i) => `t${i}`);
  const r = parseRequest(JSON.stringify({ claim: 'x', terms }));
  assert.equal(r.ok, false, 'a 15 element terms array must be rejected, not cut to 12');
});

test('parseRequest rejects an over-long term', () => {
  const r = parseRequest(JSON.stringify({ claim: 'x', terms: ['x'.repeat(121)] }));
  assert.equal(r.ok, false);
});

test('parseRequest accepts a well formed request', () => {
  const r = parseRequest('{"claim":"Albert Einstein was born in 1879."}');
  assert.equal(r.ok, true);
  assert.equal(r.value.claim, 'Albert Einstein was born in 1879.');
  assert.equal(r.value.includeModel, false);
});

test('identity pins the service id and names all three Pocket roles', () => {
  const d = identityPayload();
  assert.equal(d.service.id, SERVICE_ID);
  assert.equal(d.schema, SCHEMA);
  for (const key of ['owner_address', 'supplier_operator_address', 'test_application_address']) {
    assert.match(String(d.service[key]), /^pokt1/, `${key} must be a pocket address`);
  }
  // The three roles are distinct accounts. Confusing them misdirects an auditor.
  const addrs = new Set([
    d.service.owner_address,
    d.service.supplier_operator_address,
    d.service.test_application_address,
  ]);
  assert.equal(addrs.size, 3, 'the three roles must be three different addresses');
});

test('identity lists eleven evidence sources', () => {
  const d = identityPayload();
  assert.equal(d.evidence_sources.length, 11);
});

test('the verdict vocabulary is exactly the four published values', () => {
  const d = identityPayload();
  assert.deepEqual(
    [...d.verdicts].sort(),
    ['CONTRADICTED', 'INSUFFICIENT_EVIDENCE', 'SUPPORTED', 'UNRESOLVED']
  );
});
