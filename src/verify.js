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
const { extractPropositions } = require('./extract');
const gate = require('./compare');

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

  // The retrieval-term override must not also be the subject-matching
  // vocabulary. A caller passing terms: ['company'] would otherwise collapse
  // subject matching to the single generic word path for ANY claim and widen
  // the window in which a citation about a different entity contradicts it.
  // Retrieval can be steered; the safety check cannot be weakened.
  const claimDerivedTerms = extractTerms(text);

  // THE TYPED-PROPOSITION GATE IS AUTHORITATIVE.
  //
  // Phase 1 to Phase 3 rebuilt the representation and the decision rule
  // because the old anchor-plus-number engine produced nine distinct false
  // contradictions. The verdict now comes from extract.js and compare.js.
  // The legacy engine still runs and is reported alongside as a cross-check,
  // so a divergence is visible rather than silent.
  const claimProps = extractPropositions(text);
  const gateContradictions = [];
  const gateSupports = [];
  const gateRefusals = [];
  // ONE SCOPE ACROSS ALL CITATIONS.
  //
  // The gate's condition 13 says no compatible proposition anywhere in the
  // evaluated scope may exist before a contradiction is reported. Running the
  // gate once per citation made the scope ONE citation, so citation A saying
  // 1999 contradicted the claim even when citation B stated the claim's own
  // 2000. Agreement anywhere must neutralise, so every proposition from every
  // citation is gathered first and the gate sees them all.
  const allEvProps = [];
  for (const cit of evidence.citations) {
    for (const ep of extractPropositions(cit.quote || '')) {
      allEvProps.push({ ...ep, _citation: cit });
    }
  }

  for (const cp of claimProps) {
    // The scope-wide agreement check runs on EVERYTHING first.
    const scope = gate.evaluate(cp, allEvProps, {
      quote: (evidence.citations.map((c) => c.quote).filter(Boolean).join(' ')).slice(0, 4000),
    });
    if (scope.verdict !== 'CONTRADICTED') {
      if (gate.canSupport(cp, allEvProps)) {
        gateSupports.push({
          anchor: cp.predicate.canonical,
          claim_value: cp.object.raw,
          evidence_quote: scope.detail || (evidence.citations[0] && evidence.citations[0].quote),
          evidence_quote_kind: (evidence.citations[0] && evidence.citations[0].quote_kind) || 'structured',
          source: (evidence.citations[0] && evidence.citations[0].source) || null,
          url: (evidence.citations[0] && evidence.citations[0].url) || null,
          title: (evidence.citations[0] && evidence.citations[0].title) || null,
        });
      } else {
        gateRefusals.push({ anchor: cp.predicate.canonical, source: 'all', reason: scope.reason });
      }
      continue;
    }

    for (const cit of evidence.citations) {
      const evProps = allEvProps.filter((e) => e._citation === cit);
      const r = gate.evaluate(cp, evProps, { quote: cit.quote || '' });
      if (r.verdict === 'CONTRADICTED') {
        gateContradictions.push({
          anchor: cp.predicate.canonical,
          surface: cp.predicate.surface,
          claim_value: cp.object.raw,
          evidence_value: (evProps.find((e) => e.predicate.canonical === cp.predicate.canonical) || {}).object
            ? (evProps.find((e) => e.predicate.canonical === cp.predicate.canonical).object.raw) : null,
          claim_quote: (cp.provenance && cp.provenance.quote) || text,
          evidence_quote: cit.quote,
          evidence_quote_kind: cit.quote_kind || 'structured',
          source: cit.source || null,
          url: cit.url || null,
          title: cit.title || null,
          kind: 'value_conflict',
        });
      } else if (r.reason) {
        gateRefusals.push({ anchor: cp.predicate.canonical, source: cit.source, reason: r.reason });
      }
      if (gate.canSupport(cp, evProps)) {
        gateSupports.push({
          anchor: cp.predicate.canonical,
          claim_value: cp.object.raw,
          evidence_quote: cit.quote,
          evidence_quote_kind: cit.quote_kind || 'structured',
          source: cit.source || null,
          url: cit.url || null,
          title: cit.title || null,
        });
      }
    }
  }
  const gateVerdict = gateContradictions.length ? 'CONTRADICTED'
    : gateSupports.length ? 'SUPPORTED' : 'UNRESOLVED';

  const analysis = deterministicVerdict(text, evidence.citations, {
    claimTerms: claimDerivedTerms, // NEVER the caller override: see below
  });

  // The model stage is optional and CANNOT touch `verdict`.
  const model_assessment = opts.includeModel
    ? await modelAssess(text, evidence, analysis)
    : null;

  return {
    schema: SCHEMA,
    // Transport status, never a truth signal. 'OK' beside an UNRESOLVED verdict
    // reads like a positive judgement on a claim the service is explicitly
    // refusing to judge. A verdict was computed, so say COMPLETED.
    status: gateVerdict === 'CONTRADICTED' ? 'CONTRADICTED' : 'COMPLETED',
    // THE GATE DECIDES. The legacy engine's answer is reported separately so
    // a divergence is visible rather than silent.
    verdict: gateVerdict,
    claim: text,
    reason: reasonFor(analysis, evidence),
    evidence,
    analysis: {
      stage: 'typed-proposition-gate',
      verdict: gateVerdict,
      claim_facts: claimProps.map((p) => ({
        anchor: p.predicate.canonical,
        surface: p.predicate.surface,
        kind: p.object.type,
        value: p.object.raw,
      })),
      contradictions: gateContradictions,
      supports: gateSupports,
      gate_refusals: gateRefusals.slice(0, 12),
      excluded_off_subject: gateRefusals.filter((r) => /identity|attach/i.test(r.reason || '')).length,
      // The pre-rebuild engine still runs. Its answer is reported so a
      // divergence between the two is visible rather than silent.
      legacy_cross_check: {
        verdict: analysis.verdict,
        agrees: analysis.verdict === gateVerdict,
        note: 'the typed-proposition gate is authoritative',
      },
      method:
        'A claim and each quotation are parsed into typed propositions: an ' +
        'entity, a canonical predicate, a typed value, and polarity and ' +
        'modality. A proposition is contradicted only when the subject is ' +
        'unambiguous at identity tier 2 or better, the predicate is the same ' +
        'canonical predicate, the value types and units are compatible, the ' +
        'evidence asserts a different value rather than denying one, the ' +
        'value is attached to its own subject, and nothing anywhere in the ' +
        'scope agrees. Any failure gives UNRESOLVED.',
    },
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
        `${new Set(analysis.supports.map((s) => s.source)).size} cited source(s) state the same value for an ` +
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
      'Retrieves evidence from fourteen free sources (Wikipedia, Wikidata, CrossRef, ' +
      'OpenAlex, Europe PMC, SEC EDGAR, arXiv, World Bank, Open Library, MusicBrainz ' +
      'USGS, Project Gutenberg, Internet Archive and Wikinews), binds every citation to the exact text it cites, extracts explicit ' +
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
