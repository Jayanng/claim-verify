'use strict';

/**
 * Proposition extraction: text in, typed propositions out.
 *
 * This is the bridge between free text and the Phase 3 gate. It deliberately
 * keeps MORE than it used to and binds LESS eagerly, because a dropped value
 * costs an UNRESOLVED while a mis-bound value costs a false contradiction.
 *
 * Rules inherited from the phases before:
 *
 *   - every predicate word is its own canonical predicate, never a family
 *   - a value's type comes from context and units, never from digit count
 *   - a value binds to its NEAREST predicate occurrence, one per occurrence
 *   - values are never discarded because another was closer
 *   - a name span ends at any non name-shaped token
 *   - a clause naming several entities leaves attachment unresolved
 *
 * A proposition that cannot be completed is returned with the missing part
 * absent, so the gate refuses it rather than guessing.
 */

const {
  PREDICATES, WORD_TO_PREDICATE, predicateRe, normaliseDates, readValue, DATE_CONTEXT,
} = require('./proposition');
const { entityMentions, splitClauses } = require('./entity');

const MAX_RADIUS = 60;

/**
 * Extract propositions from a passage.
 *
 * Returns a list of { subject, predicate, object, qualifiers, provenance }.
 * Subject is the single entity governing the clause, or absent when the
 * clause names several and the syntax does not say which owns the value.
 */
function extractPropositions(passage) {
  const text = normaliseDates(String(passage || ''));
  const out = [];
  if (!text.trim()) return out;

  // COORDINATED VALUES.
  //
  // splitClauses cuts on 'and', so "population was 100 people in 2020 and 200
  // people in 2021" becomes two clauses and the second has no predicate word.
  // It then produces nothing, and an agreeing value is deleted before the
  // gate can see it. That is the exact shape of the bug this phase is meant to
  // close, arriving one layer earlier.
  //
  // A clause with no predicate of its own is a CONTINUATION of the one before
  // it. Join them rather than dropping the values.
  const rawClauses = splitClauses(text);
  const clauses = [];
  for (const raw of rawClauses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const hasPredicate = predicateRe().test(trimmed);
    if (hasPredicate || clauses.length === 0) {
      clauses.push(trimmed);
    } else {
      clauses[clauses.length - 1] = clauses[clauses.length - 1] + ' and ' + trimmed;
    }
  }

  for (const clause of clauses) {
    if (!clause.trim()) continue;

    const mentions = entityMentions(clause);
    // ATTACHMENT. Several candidates and no syntax to choose between them
    // means we do not know who the value belongs to. That is the
    // "John Smith, Jane Doe was born in 1970" case, and guessing is how a
    // true claim gets contradicted by a stranger's birth year.
    const subject = mentions.length === 1 ? mentions[0] : null;
    const attachmentNote = mentions.length === 0
      ? 'no entity named in the clause'
      : mentions.length > 1
        ? `clause names ${mentions.length} entities and the syntax does not say which the value belongs to`
        : null;

    // Predicate occurrences in THIS clause.
    const re = predicateRe();
    const preds = [];
    let m;
    while ((m = re.exec(clause)) !== null) {
      const word = m[1].toLowerCase();
      const def = WORD_TO_PREDICATE.get(word);
      if (!def) continue;
      preds.push({
        at: m.index,
        len: m[0].length,
        surface: word,
        canonical: def.canonical,
        semantic_category: def.semantic_category,
        end: m.index + m[0].length,
      });
    }
    if (!preds.length) continue;

    // Numbers in THIS clause, each typed by the context it sits in.
    const numRe = /\b\d[\d,]*(?:\.\d+)?(?:\s*(?:%|percent|per cent|million|billion|trillion|thousand|[kKmM]\b|[a-z]{2,12}\b))?/gi;
    const numbers = [];
    let n;
    while ((n = numRe.exec(clause)) !== null) {
      // The predicate this number is closest to decides its type.
      let best = null;
      let bestDist = Infinity;
      for (const pr of preds) {
        const dist = n.index > pr.end ? n.index - pr.end : pr.at - (n.index + n[0].length);
        if (dist < bestDist) { bestDist = dist; best = pr; }
      }
      if (!best || bestDist > MAX_RADIUS) continue;

      const nearDateContext = DATE_CONTEXT.test(
        clause.slice(Math.max(0, n.index - 18), n.index)
      );
      const v = readValue(n[0], {
        predicateCanonical: best.canonical,
        nearDateContext,
      });
      if (!v) continue;
      numbers.push({
        at: n.index, len: n[0].length, value: v.value,
        type: v.type, unit: v.unit, raw: v.raw, predAt: best.at,
      });
    }
    if (!numbers.length) continue;

    // EVERY VALUE SURVIVES. Nothing is discarded because another was closer.
    //
    // The first implementation keyed on { occurrence, type } and replaced the
    // earlier entry, keeping at most two when they were exactly equidistant.
    // So "population was 100 people in 2020 and 200 people in 2021" emitted
    // only the 100, and a claim about the later 200 was contradicted by the
    // 100 even though the agreeing value was right there in the text.
    //
    // The comment claimed the gate would read multiplicity as ambiguity. The
    // gate cannot detect multiplicity that extraction has already deleted.
    //
    // So: group values by the predicate occurrence they belong to, and emit
    // one proposition per value. The gate decides what to do with several.
    const groups = new Map();
    for (const num of numbers) {
      const owner = preds.find((p) => p.at === num.predAt);
      if (!owner) continue;
      if (!groups.has(owner.at)) groups.set(owner.at, { owner, values: [] });
      groups.get(owner.at).values.push(num);
    }

    for (const { owner, values } of groups.values()) {
      const qualifierSet = readQualifiers(clause);
      for (const entry of values) {
        out.push({
          subject: subject
            ? { surface: subject.surface, tokens: subject.tokens, suffix: subject.suffix }
            : { surface: '', tokens: [] },
          predicate: {
            canonical: owner.canonical,
            surface: owner.surface,
            words: [owner.surface],
            semantic_category: owner.semantic_category,
          },
          object: {
            value: entry.value,
            type: entry.type,
            unit: entry.unit,
            raw: entry.raw,
          },
          qualifiers: qualifierSet,
          provenance: {
            sentence: clause,
            attachment: attachmentNote,
            span: [Math.max(0, owner.at - 25), Math.min(clause.length, entry.at + entry.len + 25)],
            quote: clause.slice(Math.max(0, owner.at - 25), Math.min(clause.length, entry.at + entry.len + 25)),
          },
        });
      }
    }
  }

  return out;
}

/**
 * Polarity, modality and attribution. A proposition that is not plainly an
 * affirmative assertion cannot contradict anything, so getting this wrong is
 * a false contradiction waiting to happen.
 */
const NEGATION = /\b(not|never|no|n't|denies|denied|false|incorrect|wrong|myth|misconception)\b/i;
const HEDGING = /\b(may|might|could|possibly|perhaps|alleged|allegedly|reported|rumoured|rumored|seems|appears|likely|unlikely|speculated|claimed)\b/i;
const CONDITIONAL = /\b(if|would|should|were|had been|unless|suppose|assuming|in the event)\b/i;
const ATTRIBUTION = /\b(according to|said|says|stated|claimed|reported|wrote|argued|believed|estimates|estimated)\b/i;

function readQualifiers(clause) {
  const c = String(clause || '');
  if (CONDITIONAL.test(c)) {
    return { polarity: 'affirmative', modality: 'conditional', attribution: ATTRIBUTION.test(c) ? 'attributed' : null };
  }
  if (HEDGING.test(c)) {
    return { polarity: 'affirmative', modality: 'hedged', attribution: ATTRIBUTION.test(c) ? 'attributed' : null };
  }
  return {
    polarity: NEGATION.test(c) ? 'negated' : 'affirmative',
    modality: 'asserted',
    attribution: ATTRIBUTION.test(c) ? 'attributed' : null,
  };
}

module.exports = {
  extractPropositions,
  readQualifiers,
  MAX_RADIUS,
};
