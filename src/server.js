'use strict';

/**
 * claim-verify - a Pocket Network service.
 *
 * POCKET SERVICE CONTRACT (docs.pocket.network)
 *   1. Every response is a JSON object. Never bare text, never a bare array.
 *   2. All inputs arrive in the body. No path params, no query params, no auth.
 *   3. No caller authentication of any kind.
 *   4. Respond within the session. Budget 900s; this targets well under 30s.
 *   5. Serve identity and probe endpoints.
 *
 * HONESTY CONTRACT
 *   A missing value is reported as missing and is never filled in,
 *   interpolated, back-filled or coerced to zero. A verdict is only ever
 *   produced by the deterministic stage. A model opinion, if requested, is
 *   carried separately and can never alter the verdict.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { verifyClaim, SCHEMA, buildMethod, extractTerms } = require('./verify');

const SERVICE_ID = 'claim-verify';
const SERVICE_VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';

const OPENAPI_PATH = path.join(__dirname, '..', 'openapi.json');

// Upstream budget. Eleven sources, bounded three at a time.
const VERIFY_TIMEOUT_MS = 45_000;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-service-id': SERVICE_ID,
    'x-service-schema': SCHEMA,
  });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limitBytes) {
        over = true;
        // DO NOT destroy the socket here.
        //
        // req.destroy() tears the connection down before the 413 body written by
        // sendJson can flush, so the client gets an empty reply and no JSON at
        // all. That breaks the rule that every response is a JSON object, and it
        // was verified live: a 100KB POST returned "Empty reply from server".
        //
        // Drain instead. Stop buffering, keep the request flowing to completion,
        // and let the caller answer with the JSON rejection once the promise
        // settles.
        chunks.length = 0;
        reject(new Error('request body exceeds 64 KiB'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? '' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function badRequest(reason, details) {
  return {
    schema: SCHEMA,
    status: 'REJECTED',
    verdict: 'UNRESOLVED',
    reason,
    details: details || null,
    generated_at_utc: new Date().toISOString(),
  };
}

const ALLOWED = ['claim', 'include_model', 'terms'];

function parseRequest(raw) {
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'Request body is empty. All inputs must arrive in the JSON body.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Request body is not valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const unknown = Object.keys(parsed).filter((k) => !ALLOWED.includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unrecognised field(s): ${unknown.join(', ')}. Allowed fields are ${ALLOWED.join(', ')}.`,
    };
  }

  const { claim } = parsed;
  if (typeof claim !== 'string' || !claim.trim()) {
    return { ok: false, error: 'claim must be a non-empty string.' };
  }
  if (claim.length > 2000) {
    return { ok: false, error: 'claim must be at most 2000 characters.' };
  }

  const includeModel = parsed.include_model === true;
  let terms = null;
  if (parsed.terms !== undefined) {
    if (!Array.isArray(parsed.terms) || parsed.terms.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'terms must be an array of strings.' };
    }
    terms = parsed.terms.slice(0, 12);
  }

  return { ok: true, value: { claim: claim.trim(), includeModel, terms } };
}

// ---------------------------------------------------------------------------
// identity and probe
// ---------------------------------------------------------------------------

function identityPayload() {
  return {
    schema: SCHEMA,
    status: 'OK',
    service: {
      id: SERVICE_ID,
      version: SERVICE_VERSION,
      display_name: 'Claim Verification With Source Citations',
      network: 'pocket-beta',
      chain_id: 'pocket-lego-testnet',
      owner_address: 'pokt1hs0p9ceh2dkw4h5lk555cjgjjft8ya45uamt7g',
    },
    contract: {
      transport: 'REST',
      response_is_json_object: true,
      inputs_in_body: true,
      requires_authentication: false,
      deterministic_aggregation: true,
    },
    evidence_sources: [
      'wikipedia', 'crossref', 'sec-edgar', 'arxiv', 'wikidata',
      'world-bank', 'europepmc', 'openalex', 'openlibrary', 'musicbrainz', 'usgs',
    ],
    verdicts: ['CONTRADICTED', 'SUPPORTED', 'UNRESOLVED', 'INSUFFICIENT_EVIDENCE'],
    probes: {
      identity: '/v1/identity',
      functional: '/v1/probe',
      liveness: '/healthz',
      specification: '/openapi.json',
    },
    generated_at_utc: new Date().toISOString(),
  };
}

/**
 * Functional probe. Runs a REAL verification against a claim whose answer we
 * know, and asserts the service reached the right conclusion. A probe that only
 * checks a response shape cannot tell you the reasoning is sound.
 */
async function functionalProbe() {
  const started = Date.now();

  // A claim that is true and widely documented.
  const TRUE_CLAIM = 'Albert Einstein was born in 1879.';
  // And the same claim with a false value, which MUST be contradicted.
  const FALSE_CLAIM = 'Albert Einstein was born in 1900.';

  let trueResult;
  let falseResult;
  try {
    trueResult = await verifyClaim(TRUE_CLAIM);
    falseResult = await verifyClaim(FALSE_CLAIM);
  } catch (err) {
    return {
      schema: SCHEMA,
      status: 'FAILED',
      probe: 'functional',
      reason: `verification threw ${err.name || 'error'}`,
      checks: [{ name: 'execution', pass: false }],
      generated_at_utc: new Date().toISOString(),
    };
  }

  const checks = [
    { name: 'schema_is_v1', pass: trueResult.schema === SCHEMA },
    { name: 'true_claim_not_contradicted', pass: trueResult.verdict !== 'CONTRADICTED' },
    { name: 'false_claim_is_contradicted', pass: falseResult.verdict === 'CONTRADICTED' },
    {
      name: 'contradiction_carries_both_quotes',
      pass: (falseResult.analysis && falseResult.analysis.contradictions || []).every(
        (c) => typeof c.claim_quote === 'string' && c.claim_quote.length > 0
          && typeof c.evidence_quote === 'string' && c.evidence_quote.length > 0
      ),
    },
    {
      name: 'every_citation_is_bound_to_text',
      pass: trueResult.evidence.citations.every((c) => typeof c.quote === 'string' && c.quote.length > 0),
    },
    {
      name: 'verdict_is_never_model_derived',
      pass: trueResult.model_assessment === null
        || trueResult.model_assessment.can_change_verdict === false,
    },
    {
      name: 'refusal_states_are_documented',
      pass: !!buildMethod().what_it_never_does
        && buildMethod().what_it_never_does.length >= 3,
    },
    { name: 'latency_within_session', pass: (Date.now() - started) < 900_000 },
  ];

  return {
    schema: SCHEMA,
    status: checks.every((c) => c.pass) ? 'OK' : 'FAILED',
    probe: 'functional',
    description:
      'Runs two real verifications: a claim known to be true, which must not be ' +
      'contradicted, and the same claim with a false value, which must be. This ' +
      'tests the reasoning, not just the response shape.',
    latency_ms: Date.now() - started,
    true_claim: { claim: TRUE_CLAIM, verdict: trueResult.verdict },
    false_claim: { claim: FALSE_CLAIM, verdict: falseResult.verdict },
    sources_seen: (trueResult.evidence && trueResult.evidence.sources_queried || []).length,
    checks,
    generated_at_utc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  try {
    if (req.method === 'GET' && (url === '/healthz' || url === '/health')) {
      // Liveness ONLY. No service name, no schema. Identity is at /v1/identity.
      return sendJson(res, 200, {
        status: 'ok',
        generated_at_utc: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url === '/v1/identity') {
      return sendJson(res, 200, identityPayload());
    }

    if (req.method === 'GET' && url === '/openapi.json') {
      // Serve the file BYTES verbatim. The service card publishes a sha256 of
      // this document, so re-serialising it would make that hash unverifiable.
      let raw;
      try {
        raw = fs.readFileSync(OPENAPI_PATH);
        JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 503, {
          schema: SCHEMA,
          status: 'UNAVAILABLE',
          reason: 'The machine-readable specification is not present on this deployment.',
        });
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': raw.length,
        'cache-control': 'no-store',
      });
      return res.end(raw);
    }

    if (req.method === 'GET' && url === '/v1/probe') {
      const probe = await functionalProbe();
      return sendJson(res, probe.status === 'OK' ? 200 : 503, probe);
    }

    if (req.method === 'GET' && url === '/') {
      return sendJson(res, 200, {
        schema: SCHEMA,
        status: 'OK',
        service: {
          id: SERVICE_ID,
          name: 'Claim Verification With Source Citations',
          version: SERVICE_VERSION,
        },
        what_it_does:
          'Takes a claim, retrieves evidence from eleven free sources, binds every ' +
          'citation to the exact text it cites, and reports whether the evidence ' +
          'contradicts the claim, agrees with it, or says nothing about it. ' +
          'Absence of contradiction is never treated as truth.',
        verdicts: {
          CONTRADICTED: 'The cited evidence states a different value for an attribute the claim asserts. Both sides are quoted.',
          SUPPORTED: 'The cited evidence states the same value. This is agreement with the source, NOT proof the claim is true.',
          UNRESOLVED: 'The evidence does not speak to the claim. This is the default and the honest answer.',
          INSUFFICIENT_EVIDENCE: 'Nothing usable was retrieved. No verdict is given.',
        },
        evidence_sources: [
          'wikipedia', 'crossref', 'sec-edgar', 'arxiv', 'wikidata',
          'world-bank', 'europepmc', 'openalex', 'openlibrary', 'musicbrainz', 'usgs',
        ],
        readable_here: {
          '/openapi.json': 'the machine readable contract',
          '/v1/identity': 'identity probe, pins the service id',
          '/v1/probe': 'functional probe, runs two real verifications',
          '/healthz': 'liveness only',
        },
        calls_are_relayed: {
          target: 'POST /v1/verify',
          why:
            'This is a Pocket Network service. Verification is a metered relay, so it ' +
            'must arrive as a signed Pocket RelayRequest. A plain browser request cannot ' +
            'make it, and that rejection is the network working as designed.',
          example:
            'pocket-ap call --config pocket-ap.yaml --network beta --service claim-verify ' +
            '--rpc-type rest -X POST --path /v1/verify ' +
            "--data '{\"claim\":\"Albert Einstein was born in 1879.\"}'",
          signing_reference:
            'https://github.com/pokt-network/pocket-relay-miner/tree/main/examples/relay-signing',
        },
        network: 'pocket-beta',
        chain_id: 'pocket-lego-testnet',
        repository: 'https://github.com/Jayanng/pocket-hackathon',
        generated_at_utc: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && (url === '/v1/verify' || url === '/')) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        return sendJson(res, 413, badRequest(err.message));
      }
      const parsed = parseRequest(raw);
      if (!parsed.ok) {
        return sendJson(res, 400, badRequest('The request payload is not acceptable.', parsed.error));
      }

      let result;
      try {
        result = await verifyClaim(parsed.value.claim, {
          includeModel: parsed.value.includeModel,
          terms: parsed.value.terms,
        });
      } catch (err) {
        // A thrown error is still a JSON object on the wire, and it is a
        // refusal rather than a fabricated verdict.
        return sendJson(res, 500, {
          schema: SCHEMA,
          status: 'UNAVAILABLE',
          verdict: 'UNRESOLVED',
          reason: 'The service could not complete this verification.',
          detail: String(err && err.message ? err.message : err).slice(0, 300),
          generated_at_utc: new Date().toISOString(),
        });
      }
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, {
      schema: SCHEMA,
      status: 'REJECTED',
      verdict: 'UNRESOLVED',
      reason: `No route matches ${req.method} ${url}.`,
      routes: {
        'POST /v1/verify': 'verify a claim; all inputs in the JSON body',
        'GET /v1/identity': 'identity probe, pins the service id',
        'GET /v1/probe': 'functional probe, runs two real verifications',
        'GET /openapi.json': 'machine-readable OpenAPI 3.x specification',
        'GET /healthz': 'liveness',
      },
    });
  } catch (err) {
    return sendJson(res, 500, {
      schema: SCHEMA,
      status: 'UNAVAILABLE',
      verdict: 'UNRESOLVED',
      reason: 'The service could not complete this request.',
      detail: String(err && err.message ? err.message : err).slice(0, 300),
      generated_at_utc: new Date().toISOString(),
    });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`${SERVICE_ID} ${SERVICE_VERSION} listening on http://${HOST}:${PORT}\n`);
  });
}

module.exports = {
  server, parseRequest, functionalProbe, identityPayload, SERVICE_ID, SCHEMA,
};
