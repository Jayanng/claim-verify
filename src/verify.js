'use strict';

/**
 * Verdict assembly for claim-verify.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * `verdict` is produced ONLY by the deterministic stage. A model assessment, if
 * one is requested, is carried in a separate field and is explicitly marked as
 * model-derived. It can never upgrade UNRESOLVED to SUPPORTED or to
 * CONTRADICTED.
 *
 * The reason is precise. A model that reads two texts and says "this follows"
 * is reporting its own learned association, not a fact about the world. If that
 * output could move the verdict, the service would be publishing a confident
 * answer that is really a guess wearing the costume of evidence. That is the
 * failure this entire service exists to prevent.
 *
 * VERDICTS
 * --------
 *   CONTRADICTED            the evidence states a different value for the same
 *                           fact. Both sides are quoted. Provable.
 *   SUPPORTED               the evidence states the same value for the same
 *                           fact. Quoted. This is agreement with the cited
 *                           source, NOT proof that the claim is true.
 *   UNRESOLVED              the evidence does not speak to the claim's facts.
 *                           This is the honest default and the most common.
 *   INSUFFICIENT_EVIDENCE   no usable evidence was retrieved at all. A refusal.
 *
 * SUPPORTED means "the sources we found agree". It does not mean true, and the
 * response says so in its own method block.
 */

const { gatherEvidence, extractTerms } = require('./evidence');
const { deterministicVerdict } = require('./contradict');

const SCHEMA = 'claim-verify/v1';

/**
 * Verify a claim against retrieved evidence.
 *
 * @param {string} claim
 * @param {object} opts
 * @param {boolean} opts.includeModel  request the optional model assessment
 * @param {string[]} opts.terms        override the retrieval terms
 */
async function verifyClaim(claim, opts = {}) {
  const requestedAtUtc = new Date().toISOString();

  if (!claim || !String(claim).trim()) {
    return {
      schema: SCHEMA,
      status: 'REJECTED',
      verdict: 'UNRESOLVED',
      reason: 'A claim must be a non-empty string.',
      generated_at_utc: requestedAtUtc,
    };
  }

  const text = String(claim).trim();
  const evidence = await gatherEvidence(text, { terms: opts.terms });

  // No evidence is a refusal, not a verdict of any kind.
  if (!evidence.citations.length) {
    return {
      schema: SCHEMA,
      status: 'INSUFFICIENT_EVIDENCE',
      verdict: 'UNRESOLVED',
      claim: text,
      reason:
        'No usable evidence was retrieved from any source, so no verdict is possible. ' +
        'Absence of contradiction is not evidence of truth.',
      evidence,
      analysis: null,
      model_assessment: null,
      method: buildMethod(),
      generated_at_utc: requestedAtUtc,
    };
  }

  const analysis = deterministicVerdict(text, evidence.citations, {
    claimTerms: evidence.terms,
  });

  // The model stage is optional and CANNOT touch `verdict`.
  const model_assessment = opts.includeModel
    ? await modelAssess(text, evidence, analysis)
    : null;

  return {
    schema: SCHEMA,
    status: analysis.verdict === 'CONTRADICTED' ? 'CONTRADICTED' : 'OK',
    verdict: analysis.verdict,
    claim: text,
    reason: reasonFor(analysis, evidence),
    evidence,
    analysis,
    model_assessment,
    method: buildMethod(),
    generated_at_utc: requestedAtUtc,
  };
}

function reasonFor(analysis, evidence) {
  switch (analysis.verdict) {
    case 'CONTRADICTED':
      return (
        `${new Set(analysis.contradictions.map((c) => c.source)).size} cited source(s) state a different value ` +
        `for an attribute the claim asserts. Both sides are quoted under ` +
        `analysis.contradictions.`
      );
    case 'SUPPORTED':
      return (
        `${analysis.supports.length} cited source(s) state the same value for an ` +
        `attribute the claim asserts. This is agreement with the cited source, not ` +
        `proof that the claim is true.`
      );
    default:
      return (
        `The ${evidence.citations.length} retrieved citation(s) do not state a ` +
        `comparable value for any attribute the claim asserts, so no verdict is ` +
        `possible. This is not a judgement either way.`
      );
  }
}

/**
 * OPTIONAL model-derived assessment.
 *
 * Deliberately structured so it cannot be mistaken for a verdict:
 *   - it lives in its own field
 *   - `derived` is always the string 'model', never absent
 *   - `can_change_verdict` is always false and stated outright
 *   - when no model is configured it returns an explicit refusal, never a guess
 */
async function modelAssess(claim, evidence, analysis) {
  const provider = process.env.CLAIM_VERIFY_MODEL_ENDPOINT || null;
  if (!provider) {
    return {
      derived: 'model',
      available: false,
      can_change_verdict: false,
      assessment: null,
      reason:
        'No model endpoint is configured. The deterministic verdict stands alone. ' +
        'This service does not substitute a guess for a missing model.',
    };
  }
  try {
    const res = await fetch(provider, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claim-verify/1.0' },
      body: JSON.stringify({
        claim,
        evidence: evidence.citations.map((c) => ({ source: c.source, quote: c.quote })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return {
      derived: 'model',
      available: true,
      can_change_verdict: false,
      assessment: d.assessment ?? d.label ?? null,
      // Whatever the model says, the verdict is unchanged and we say so.
      verdict_unaffected: analysis.verdict,
      reason:
        'Model output is reported as an opinion about the relationship between the ' +
        'texts. It is not evidence and does not alter the verdict.',
    };
  } catch (e) {
    return {
      derived: 'model',
      available: false,
      can_change_verdict: false,
      assessment: null,
      reason: `Model assessment unavailable: ${e.name || 'error'}. The deterministic verdict stands alone.`,
    };
  }
}

function buildMethod() {
  return {
    description:
      'Retrieves evidence from eleven free sources (Wikipedia, Wikidata, CrossRef, ' +
      'OpenAlex, Europe PMC, SEC EDGAR, arXiv, World Bank, Open Library, MusicBrainz ' +
      'and USGS), binds every citation to the exact text it cites, extracts explicit ' +
      'facts from the claim and from each quotation, and compares them by attribute.',
    what_verdict_means: {
      CONTRADICTED:
        'The cited evidence states a different value for an attribute the claim asserts. ' +
        'Both sides are quoted. This is checkable.',
      SUPPORTED:
        'The cited evidence states the same value for an attribute the claim asserts. ' +
        'This is agreement with the source, NOT proof that the claim is true.',
      UNRESOLVED:
        'The evidence does not speak to the claim. Absence of contradiction is not ' +
        'evidence of truth. This is the default.',
      INSUFFICIENT_EVIDENCE:
        'Nothing usable was retrieved. No verdict is possible and none is given.',
    },
    what_it_never_does: [
      'It never infers truth from the absence of contradiction.',
      'It never upgrades UNRESOLVED using a model opinion.',
      'It never paraphrases a source into a quote it did not say.',
      'It never presents a rendered value as though the source phrased it: ' +
        'citations built from structured metadata carry quote_kind \"structured\" ' +
        'and their fields, and only genuine source text carries quote_kind \"text\".',
      'It never returns a verdict when no evidence was retrieved.',
    ],
    quote_kind:
      'quote_kind is \"text\" when the quote is a span the source actually wrote, ' +
      'and \"structured\" when the service rendered it from metadata fields such as ' +
      'a Wikidata property value. Rendered citations are still bound to real retrieved ' +
      'data and the source is named, but the wording is ours, so it is marked.',
    model_role:
      'If requested, a model assessment is returned in model_assessment and is marked ' +
      'derived: "model" with can_change_verdict: false. It can never alter the verdict.',
    deterministic_aggregation: true,
  };
}

module.exports = { verifyClaim, SCHEMA, buildMethod, extractTerms };
