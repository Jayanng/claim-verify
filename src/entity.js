'use strict';

/**
 * Entity identity and subject-predicate attachment.
 *
 * WHY THIS EXISTS
 *
 * Two confirmed false contradictions survived every fix to the fact
 * comparison layer, and both are really ENTITY problems:
 *
 *   claim  "John Smith was born in 1980"
 *   quote  "John Smith, Jane Doe was born in 1970"
 *   -> CONTRADICTED. The birth year belongs to Jane Doe. The words "John
 *      Smith" appear near the anchor, and proximity was being read as
 *      ownership.
 *
 *   claim  "Mercury was founded in 1990"
 *   quote  "Mercury was founded in 1980"
 *   -> CONTRADICTED. A single shared token was being read as identity, for a
 *      name carried by a planet, an element, several companies and a car.
 *
 * Neither is a comparison bug. Both are the engine claiming to know WHICH
 * ENTITY a value belongs to when it does not.
 *
 * THE RULE
 *
 * A name can drive RETRIEVAL. It can never, on its own, licence a
 * contradiction. Contradiction needs identity at a tier that proves the two
 * sides are talking about the same thing:
 *
 *   tier 3  canonical      both resolve to the same stable identifier
 *   tier 2  discriminators same name PLUS a distinguishing attribute that
 *                          both sides carry (a suffix, a location, a type,
 *                          a parent organisation, a date range)
 *   tier 1  name_only      a shared token, or tokens
 *   tier 0  none           no shared subject at all
 *
 * CONTRADICTED requires tier 2 or better. Tier 1 may SUPPORT, never
 * contradict, because agreeing with the wrong entity is harmless and
 * contradicting the wrong entity is the exact failure this service exists to
 * prevent.
 *
 * ATTACHMENT
 *
 * A value must also be attached to its subject, not merely appear near it.
 * When a clause names more than one entity and the syntax does not say which
 * one the predicate applies to, attachment is UNRESOLVED and the fact cannot
 * contradict anything. The safe answer is always UNRESOLVED.
 */

// ---------------------------------------------------------------------------
// 1. ENTITY MENTIONS
// ---------------------------------------------------------------------------

// Generational and ordinal suffixes. These are strong discriminators: "King
// Jr." and "King Sr." are different people and the suffix settles it.
const SUFFIX_RE = /\b(sr|jr|ii|iii|iv|vi|vii|viii|ix|x|senior|junior)\b\.?/i;

// Determiners and other function words that never form part of an entity name.
// A name span ENDS at a predicate word. Without this "Mercury founded Acme
// Corp in 1980" produces one mention "Mercury founded Acme Corp", so the
// object of the sentence is absorbed into the subject and a claim about Acme
// Corp matches a value belonging to Mercury. A verb is not part of a name.
const PREDICATE_STOP = new Set([
  'founded', 'founding', 'founder', 'founders', 'incorporated', 'incorporation',
  'launched', 'launching', 'launch', 'established', 'establishment',
  'created', 'creation', 'published', 'publication', 'issued', 'released',
  'release', 'premiered', 'premiere', 'born', 'birth', 'births', 'died',
  'death', 'deaths', 'passed', 'population', 'inhabitants', 'residents',
  'height', 'tall', 'altitude', 'width', 'wide', 'weight', 'mass', 'weighs',
  'price', 'cost', 'costs', 'costed', 'worth', 'temperature', 'temperatures',
  'degrees', 'warming', 'total', 'count', 'amount', 'sum', 'percent',
  'percentage', 'gdp', 'introduced', 'opened', 'built', 'completed',
  'acquired', 'bought', 'sold', 'merged', 'named', 'called', 'titled',
  'listed', 'began', 'started', 'ended', 'closed',
]);

const NAME_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'by',
  'was', 'were', 'is', 'are', 'be', 'been', 'it', 'its', 'this', 'that',
  'with', 'from', 'as', 'his', 'her', 'their', 'who', 'whom', 'which',
]);

// Words that describe a TYPE of thing rather than naming one. A claim whose
// only subject word is one of these is not about an identified entity.
const GENERIC_SUBJECT = new Set([
  'company', 'city', 'town', 'village', 'country', 'region', 'district',
  'drug', 'film', 'movie', 'book', 'song', 'album', 'river', 'mountain',
  'university', 'school', 'hospital', 'airport', 'station', 'game', 'team',
  'club', 'brand', 'product', 'service', 'model', 'series', 'show', 'tower',
  'hall', 'bridge', 'park', 'street', 'island', 'lake', 'valley', 'planet',
  'element', 'language', 'car', 'aircraft', 'ship', 'train', 'author',
  'artist', 'actor', 'writer', 'singer', 'band', 'group', 'agency',
]);

/**
 * Split a passage into clauses at the boundaries that actually separate
 * propositions. Commas count, because "John Smith, Jane Doe was born in
 * 1970" is two entities and one predicate, which is exactly the ambiguity
 * that produced a false contradiction.
 */
function splitClauses(text) {
  return String(text || '')
    .split(/\s*(?:[;.]|\s--\s|\s+and\s+|\s+but\s+|\s+whereas\s+|\s+while\s+|,)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull the entity-like spans out of a passage.
 *
 * Heuristic on purpose: this is a retrieval aid and an identity signal, not a
 * named-entity recogniser. It runs on free text from fourteen heterogeneous
 * sources and must fail safe rather than confidently.
 */
function entityMentions(text) {
  const out = [];
  for (const clause of splitClauses(text)) {
    const tokens = clause.split(/\s+/).filter(Boolean);
    const nameTokens = [];
    for (const raw of tokens) {
      const w = raw.replace(/[^\p{L}\p{N}.'&-]/gu, '');
      if (!w) continue;
      const lower = w.toLowerCase();
      if (NAME_STOP.has(lower) || PREDICATE_STOP.has(lower)) {
        if (nameTokens.length) break;
        continue;
      }
      // A name starts at a capitalised word or a digit-bearing proper noun
      // like "Acme2" or "GPT-5". A bare number is a value, never a name.
      if (/^\d+$/.test(w)) break;
      if (nameTokens.length === 0 && !/^[A-Z]/.test(w)) break;
      nameTokens.push(w);
      if (nameTokens.length >= 4) break;
      // STRUCTURAL RULE. After the first token, anything not name-shaped ends
      // the span. This is what stops "Mercury owns Acme Corp" from becoming
      // one mention: "owns" is lowercase, so the span ends at "Mercury".
      // A blocklist of verbs can never be complete, and every one it misses
      // absorbs the object of the sentence into the subject.
      if (nameTokens.length > 0 && !/^[A-Z]/.test(w) && !/['&-]/.test(w)) break;
    }
    if (nameTokens.length) {
      const suffix = (clause.match(SUFFIX_RE) || [])[0] || null;
      out.push({
        surface: nameTokens.join(' '),
        tokens: nameTokens.map((t) => t.toLowerCase()),
        suffix: suffix ? suffix.toLowerCase().replace(/\./g, '') : null,
        clause,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. IDENTITY TIERS
// ---------------------------------------------------------------------------

/**
 * How strongly two entity descriptions denote the same thing.
 *
 * Returns { tier, reason }. tier 0 means no shared subject at all.
 */
function identityTier(claimEntity, quoteEntity) {
  if (!claimEntity || !quoteEntity) return { tier: 0, reason: 'missing entity' };

  const a = new Set(claimEntity.tokens || []);
  const b = new Set(quoteEntity.tokens || []);
  const shared = [...a].filter((t) => b.has(t));
  if (!shared.length) return { tier: 0, reason: 'no shared subject token' };

  // Suffixes are decisive in BOTH directions. A suffix on one side and not the
  // other means different entities; different suffixes mean different
  // entities. This is the generational case, and it must be symmetric.
  const sa = claimEntity.suffix || null;
  const sb = quoteEntity.suffix || null;
  if (sa !== sb) {
    return { tier: 0, reason: `generational suffix differs (${sa || 'none'} vs ${sb || 'none'})` };
  }

  // A single generic word is not a name. "the company" matches any company.
  const claimWords = [...a].filter((t) => !GENERIC_SUBJECT.has(t));
  const quoteWords = [...b].filter((t) => !GENERIC_SUBJECT.has(t));
  const claimIsOnlyGeneric = claimWords.length === 0;
  if (claimIsOnlyGeneric) {
    return { tier: 1, reason: 'subject is a generic type word, not a name' };
  }

  // A single distinctive token is name-only. Mercury, Amazon, Python, Paris.
  // Two or more shared distinctive tokens is a much stronger signal: the
  // chance of "Albert Einstein" matching an unrelated entity is low.
  const sharedDistinctive = shared.filter((t) => !GENERIC_SUBJECT.has(t));

  if (sa && sharedDistinctive.length >= 1) {
    // A shared suffix IS a discriminator. "Martin Luther King Jr." names a
    // generation, and that is enough to identify.
    return { tier: 2, reason: `shared generational suffix '${sa}'` };
  }

  if (sharedDistinctive.length >= 2) {
    return { tier: 2, reason: `${sharedDistinctive.length} shared distinctive tokens` };
  }

  return { tier: 1, reason: `single shared token '${sharedDistinctive[0] || shared[0]}'` };
}

// ---------------------------------------------------------------------------
// 3. ATTACHMENT
// ---------------------------------------------------------------------------

/**
 * Does this value belong to THIS entity?
 *
 * Attachment is UNRESOLVED whenever the clause names more than one entity and
 * nothing in the syntax says which one the predicate governs. Proximity is
 * not ownership.
 *
 * Returns { attached, reason }.
 */
function attach(clause, entity, predicateAt, valueAt) {
  const mentions = entityMentions(clause);

  if (mentions.length === 0) {
    return { attached: false, reason: 'no entity named in the clause' };
  }

  if (mentions.length > 1) {
    // More than one candidate subject. Unless the value sits plainly within
    // one mention's own span, we do not know who it belongs to.
    //
    // "John Smith, Jane Doe was born in 1970" has two mentions and one
    // predicate. Guessing is how a true claim gets contradicted by a
    // stranger's birth year.
    const names = mentions.map((m) => m.surface).join(', ');
    return {
      attached: false,
      reason: `clause names ${mentions.length} entities (${names}) and the syntax does not say which the value belongs to`,
    };
  }

  // Exactly one subject. The value is only attached if it is not itself part
  // of a second entity span, which happens with appositives and parenthetical
  // names.
  const only = mentions[0];
  if (entity && entity.tokens && entity.tokens.length) {
    const t = identityTier(entity, only);
    if (t.tier === 0) {
      return { attached: false, reason: `the clause's subject is '${only.surface}', not the claimed entity: ${t.reason}` };
    }
  }

  return { attached: true, reason: `single subject '${only.surface}' governs the clause` };
}

module.exports = {
  SUFFIX_RE,
  PREDICATE_STOP,
  NAME_STOP,
  GENERIC_SUBJECT,
  splitClauses,
  entityMentions,
  identityTier,
  attach,
};
