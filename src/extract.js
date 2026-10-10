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

  for (const clause of splitClauses(text)) {
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

    // Bind each value to its nearest predicate occurrence. ONE value per
    // occurrence per TYPE, and a value is never discarded merely because
    // another was closer: several values under one predicate is AMBIGUITY,
    // which the gate reads as UNRESOLVED, and dropping one is how an agreeing
    // value vanished before comparison.
    const byOccurrence = new Map();
    for (const num of numbers) {
      const key = `${num.predAt}|${num.type}`;
      const prev = byOccurrence.get(key);
      // Keep both when they are equally near. The gate handles multiplicity.
      if (prev && prev.dist < num.dist) continue;
      if (prev && prev.dist === num.dist && prev.at !== num.at) {
        prev.alsoNear = num;
        continue;
      }
      const owner = preds.find((p) => p.at === num.predAt);
      const dist = num.at > owner.end ? num.at - owner.end : owner.at - (num.at + num.len);
      byOccurrence.set(key, { ...num, dist, owner });
    }

    for (const entry of byOccurrence.values()) {
      const owner = entry.owner;
      const qualifierSet = readQualifiers(clause);

      const prop = {
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
      };
      out.push(prop);

      // A second value equally near the same predicate is a separate
      // proposition, not a replacement. Keep it.
      if (entry.alsoNear) {
        out.push({
          ...prop,
          object: {
            value: entry.alsoNear.value,
            type: entry.alsoNear.type,
            unit: entry.alsoNear.unit,
            raw: entry.alsoNear.raw,
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
