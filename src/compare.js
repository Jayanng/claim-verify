'use strict';

/**
 * The contradiction gate.
 *
 * ONE RULE, ENFORCED IN ONE PLACE
 *
 * Everything in Phase 1 and Phase 2 is representation. This is the only
 * module that decides, and it decides by refusing: CONTRADICTED is emitted
 * only when every condition below holds. If any one fails, the answer is
 * UNRESOLVED.
 *
 * The asymmetry is deliberate and is the whole design:
 *
 *   false negative   ->  UNRESOLVED instead of CONTRADICTED
 *   false positive   ->  a true claim declared disproved
 *
 * Those are not symmetric errors. The second destroys the service's only
 * claim to credibility. So recall is traded away freely and precision is not.
 *
 * CONDITIONS FOR CONTRADICTED
 *
 *   claim side
 *     1  a complete atomic proposition: subject, predicate, value
 *     2  subject unambiguous, identity tier 2 or better against the evidence
 *     3  predicate canonicalised to one specific event or attribute
 *     4  value has a known semantic type
 *     5  polarity affirmative and modality asserted
 *
 *   evidence side
 *     6  an explicit proposition, not a number near a word
 *     7  subject unambiguous and attached to its own value
 *     8  identity tier 2 or better against the claim
 *     9  the SAME canonical predicate, never a related one
 *    10  value type compatible with the claim's
 *    11  units equal, or both absent
 *    12  explicit counter-assertion, not negation, condition or attribution
 *
 *   across both
 *    13  NO compatible proposition anywhere in the evaluated scope
 *    14  the quote is complete enough to establish the proposition
 *
 * This is Boolean on purpose. A weighted score would let high extraction
 * confidence compensate for weak entity identity, which is precisely the
 * trade that produced nine false contradictions.
 */

const { identityTier, attach, entityMentions, splitClauses } = require('./entity');

// Threshold. Tier 2 or better may contradict. Tier 1 may only support.
const CONTRADICTION_IDENTITY_TIER = 2;

/**
 * Why a candidate pair was refused. Every refusal is reported so the decision
 * to stay UNRESOLVED is visible rather than silent.
 */
function refuse(reason, detail) {
  return { verdict: 'UNRESOLVED', reason, detail: detail || null };
}

function pass() {
  return { verdict: 'CONTRADICTED', reason: null, detail: null };
}

// ---------------------------------------------------------------------------
// VALUE COMPARISON
// ---------------------------------------------------------------------------

function valuesCompatible(a, b) {
  if (!a || !b) return false;
  // A value must be a real finite number. NaN compares unequal to everything,
  // so an unparseable value would look like a contradiction.
  if (typeof a.value !== 'number' || !Number.isFinite(a.value)) return false;
  if (typeof b.value !== 'number' || !Number.isFinite(b.value)) return false;
  // Different semantic types are not comparable at all. A height is not a
  // year, and treating them as one is how "2020 meters" became a date.
  if (a.type !== b.type) return false;
  if (a.type === 'unknown') return false;
  // Units must match exactly, or both be absent. Conversion is deliberately
  // out of scope: an unconverted comparison is not a contradiction.
  const ua = a.unit || null;
  const ub = b.unit || null;
  if (ua !== ub) return false;
  return true;
}

function valuesEqual(a, b) {
  if (!valuesCompatible(a, b)) return false;
  if (a.type === 'calendar_year') return a.value === b.value;
  return Math.abs(a.value - b.value) <= Math.max(1e-9, Math.abs(a.value) * 0.005);
}

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

/**
 * Compare ONE claim proposition against the propositions extracted from ONE
 * citation.
 *
 * Returns { verdict, reason, detail } where verdict is CONTRADICTED or
 * UNRESOLVED. SUPPORTED is decided separately by the caller, because
 * agreement has a much lower bar than disagreement and must not be gated by
 * the contradiction rules.
 */
function evaluate(claimProp, evidenceProps, citation) {
  try {
    return evaluateInner(claimProp, evidenceProps, citation);
  } catch (err) {
    return refuse(`the comparison could not be completed safely: ${String(err && err.message || err)}`);
  }
}

function evaluateInner(claimProp, evidenceProps, citation) {
  if (!Array.isArray(evidenceProps)) evidenceProps = [];
  // 1. A complete claim proposition.
  if (!claimProp || !claimProp.subject || !claimProp.predicate || !claimProp.object) {
    return refuse('the claim does not resolve to a complete proposition');
  }

  // 3. A canonicalised predicate.
  if (!claimProp.predicate.canonical) {
    return refuse('the claim predicate is not canonicalised');
  }

  // 4. A known value type.
  if (!claimProp.object.type || claimProp.object.type === 'unknown') {
    return refuse(`the claim value has no known semantic type (${claimProp.object.raw})`);
  }

  // 5. Affirmative and asserted. A negated or hypothetical claim is not a
  //    claim we can contradict.
  const q = claimProp.qualifiers || {};
  if (q.polarity !== 'affirmative') {
    return refuse(`the claim is ${q.polarity || 'of unknown polarity'}, not an affirmative assertion`);
  }
  if (q.modality && q.modality !== 'asserted') {
    return refuse(`the claim is ${q.modality}, not asserted`);
  }

  // 2. An unambiguous claim subject.
  const claimMentions = entityMentions(claimProp.subject.surface || '');
  if (claimMentions.length !== 1) {
    return refuse(`the claim subject is ambiguous (${claimMentions.length} candidate names)`);
  }

  // 13. NOTHING IN THE SCOPE MAY AGREE. This is the rule that ended the
  //     'founded in 1999 and founded again in 2001' failure and the
  //     'height is 20000 (P2046); height is 300 (P2048)' failure. A quote
  //     that states the claim's own value AGREES with the claim, whatever
  //     else it holds.
  const compatible = evidenceProps.filter(
    (ep) => ep.predicate && ep.predicate.canonical === claimProp.predicate.canonical
      && valuesCompatible(claimProp.object, ep.object)
  );
  if (compatible.some((ep) => valuesEqual(claimProp.object, ep.object))) {
    return refuse('the evidence states the claim value somewhere in this scope, so it agrees');
  }

  let sawCandidate = false;

  for (const ep of evidenceProps) {
    // 6. An explicit proposition.
    if (!ep || !ep.predicate || !ep.object) continue;

    // 9. The SAME canonical predicate. Never a related one.
    if (ep.predicate.canonical !== claimProp.predicate.canonical) continue;

    sawCandidate = true;

    // 4 and 10. A known, compatible value type.
    if (!valuesCompatible(claimProp.object, ep.object)) {
      return refuse(
        `value types or units are not comparable (${claimProp.object.type}/${claimProp.object.unit || 'none'} vs ${ep.object.type}/${ep.object.unit || 'none'})`
      );
    }

    // 12. The evidence must ASSERT the incompatible value.
    const eq = ep.qualifiers || {};
    if (eq.polarity !== 'affirmative') {
      return refuse(`the evidence is ${eq.polarity || 'of unknown polarity'}, not an affirmative assertion`);
    }
    if (eq.modality && eq.modality !== 'asserted') {
      return refuse(`the evidence is ${eq.modality}, not asserted`);
    }

    // 7. The evidence value must be ATTACHED to its own subject.
    const clause = ep.provenance && ep.provenance.sentence
      ? ep.provenance.sentence
      : (citation && citation.quote) || '';
    // Checked against the EVIDENCE proposition's own subject and value.
    // Checking the claim subject here only ever asks whether the claim is
    // about itself, which is trivially true and proves nothing.
    const at = attach(clause, ep.subject, 0, 0);
    if (!at.attached) {
      return refuse(`attachment unresolved: ${at.reason}`);
    }

    // 8. Identity tier 2 or better.
    const tier = identityTier(claimProp.subject, ep.subject);
    if (tier.tier < CONTRADICTION_IDENTITY_TIER) {
      return refuse(`entity identity is tier ${tier.tier}, below the tier ${CONTRADICTION_IDENTITY_TIER} needed to contradict: ${tier.reason}`);
    }

    // 14. The quote must ESTABLISH the proposition, not merely exist.
    //
    // A length check is not enough: "See page 4" and "Further details are
    // available" are long enough and establish nothing. The quoted span must
    // itself carry the subject, the predicate word and the value, otherwise a
    // citation is contradicting a claim on text nobody can see.
    const quote = String((citation && citation.quote) || '').trim();
    if (quote.length < 8) {
      return refuse('the quoted span is too short to establish a proposition');
    }
    const quoteLower = quote.toLowerCase();
    const surfaceWords = (claimProp.predicate.surface
      ? [claimProp.predicate.surface]
      : (claimProp.predicate.words || []));
    const hasPredicate = surfaceWords.length
      ? surfaceWords.some((w) => quoteLower.includes(String(w).toLowerCase()))
      : quoteLower.includes(String(claimProp.predicate.canonical).toLowerCase());
    const hasSubject = String(ep.subject && ep.subject.surface || '')
      .toLowerCase().split(/\s+/).filter(Boolean)
      .some((t) => quoteLower.includes(t));
    const valueToken = String(ep.object.raw || ep.object.value);
    const hasValue = new RegExp('\\b' + valueToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(quote);
    if (!hasPredicate || !hasSubject || !hasValue) {
      return refuse(
        `the quoted span does not establish the proposition (predicate in quote: ${hasPredicate}, subject: ${hasSubject}, value: ${hasValue})`
      );
    }

    // Only now is a differing value a provable contradiction.
    if (!valuesEqual(claimProp.object, ep.object)) {
      return pass();
    }
  }

  if (!sawCandidate) {
    return refuse(`the evidence states no proposition under the predicate '${claimProp.predicate.canonical}'`);
  }

  return refuse('the evidence carries the predicate but never asserts a different value');
}

/**
 * Agreement is decided separately and much more loosely, because agreeing
 * with the wrong entity is harmless and contradicting the wrong entity is the
 * exact failure this service exists to prevent.
 *
 * Tier 1 identity may SUPPORT. Tier 0 may not.
 */
function canSupport(claimProp, evidenceProps) {
  if (!claimProp || !claimProp.object) return false;
  return evidenceProps.some((ep) => {
    if (!ep || !ep.predicate || !ep.object) return false;
    if (ep.predicate.canonical !== claimProp.predicate.canonical) return false;
    if (!valuesEqual(claimProp.object, ep.object)) return false;
    const tier = identityTier(claimProp.subject, ep.subject);
    return tier.tier >= 1;
  });
}

module.exports = {
  CONTRADICTION_IDENTITY_TIER,
  valuesCompatible,
  valuesEqual,
  evaluate,
  canSupport,
};
