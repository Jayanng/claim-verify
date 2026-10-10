'use strict';

/**
 * Deterministic contradiction detection.
 *
 * WHAT THIS DOES AND DOES NOT DO
 * ------------------------------
 * This stage compares EXPLICIT FACTS in a claim against explicit facts stated
 * in retrieved evidence. A contradiction here is provable: both texts assert
 * values for the same attribute and the values differ. That is a checkable
 * claim, not a probability.
 *
 * It deliberately does NOT decide whether a claim is "true". Truth is not
 * observable from text. What is observable is:
 *
 *   CONTRADICTED           the evidence states a different value for the same
 *                          fact, and we quote both sides
 *   SUPPORTED              the evidence states the same value for the same fact
 *   UNRESOLVED             the evidence does not speak to the claim's facts
 *
 * UNRESOLVED is the default and the most common answer. It must never be
 * upgraded to SUPPORTED because "nothing disagrees". Absence of contradiction
 * is not evidence of truth, and this is the exact failure mode that makes
 * fact-checking systems dangerous.
 *
 * Matching is conservative on purpose. A number only counts as a competing
 * value when it sits near the same ANCHOR as the claim's number, so that
 * "founded in 1999" is not contradicted by an unrelated "1999 employees".
 */

const { squash, extractTerms } = require('./evidence');

/**
 * Anchors are the attributes a claim can assert a value for. Two facts only
 * compete if they share an anchor. This is what keeps the comparison from
 * producing nonsense contradictions.
 */
const ANCHORS = [
  // Comparison is by SURFACE WORD, not by anchor family. Earlier every member
  // of a family produced the same anchor name, so "founded in 1999 and launched
  // in 2004" put 2004 under the founded anchor and a true claim contradicted
  // itself against evidence that correctly said 1999. Founded and launched are
  // different attributes and must never compete. The `name` groups related
  // words for reporting; `surface` is what is compared.
  { name: 'founded', re: /\b(found(?:ed|ing)?|establish(?:ed|ment)?|created|launched|incorporated)\b/gi, surface: true },
  { name: 'born', re: /\b(born|birth)\b/gi, surface: true },
  { name: 'died', re: /\b(died|death|passed away)\b/gi, surface: true },
  { name: 'population', re: /\b(population|inhabitants|residents)\b/gi, surface: true },
  { name: 'height', re: /\b(height|tall|altitude)\b/gi, surface: true },
  { name: 'weight', re: /\b(weight|mass|weighs)\b/gi, surface: true },
  { name: 'price', re: /\b(price|cost(?:s|ed)?|worth|value|valued)\b/gi, surface: true },
  { name: 'released', re: /\b(releas(?:ed|e)|premier(?:ed|e)|publish(?:ed|)|issued|released on)\b/gi, surface: true },
  { name: 'gdp', re: /\b(gdp|gross domestic product)\b/gi, surface: true },
  { name: 'temperature', re: /\b(temperatur(?:e|es)|warming|degrees)\b/gi, surface: true },
  { name: 'percentage', re: /\b(percent|percentage|per cent|%)\b/gi, surface: true },
  { name: 'count', re: /\b(total|number of|count|amount|sum)\b/gi, surface: true },
];

// A numeric value, optionally with thousands separators, a sign, a unit or a
// percentage. Deliberately strict so a stray digit is not read as a quantity.
//
// The trailing \s* was dropped from the match. It made "1999 " a five character
// match that was not contained in the four character year span, so the number
// and year dedup never fired and one token became BOTH a number fact and a
// year fact. That duplicate is what the day-of-month false contradiction fed
// on: "born 4 Aug. 1961" produced a number 4 competing with a year 1961.
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?(?:\s*(?:%|percent|per cent|million|billion|trillion|thousand|[kKmM]\b|[a-z]{2,12}\b))?/gi;

// Measurement and currency units. Without these "828 meters" and "2717 feet"
// both canonicalised to unit null, the unit equality gate passed, and two true
// statements of the same height contradicted each other.
const UNIT_RE = /(?:%|percent|per cent|million|billion|trillion|thousand|[kKmM]|meters?|metres?|feet|foot|ft|inches?|inch|cm|mm|km|kilometers?|kilometres?|miles?|kg|kilograms?|grams?|pounds?|lbs?|tonnes?|tons?|liters?|litres?|gallons?|usd|eur|gbp|jpy|dollars?|euros?|yen|cents?)\s*$/i;

// Dates in the forms people actually write.
const DATE_RE = /\b(\d{4})\b|\b(\d{1,2}\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2},?\s+)?(\d{4})\b/gi;

// ISO and slash dates are ONE date, not a year plus stray numbers.
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,4}\/\d{1,2}\/\d{1,4}\b/g;

/**
 * Replace ISO, slash and day-month dates with their bare year BEFORE any number
 * is collected. Otherwise the month and day segments leak out as signed numbers
 * ("-08" becomes the number -8) and compare against a day-of-month elsewhere,
 * which reports a true claim as contradicted.
 */
function normaliseDates(text) {
  let out = text;
  // CITATION METADATA IS NOT AN ASSERTION.
  //
  // A paper title carrying an anchor word binds its own publication date to
  // that word: "Company founding and survival in emerging markets (2017)" put
  // 2017 under the founding anchor and reported a true 1999 founding as
  // contradicted. A parenthesised year is a citation date and cannot speak to
  // the claim, so it is removed before any fact is extracted.
  out = out.replace(/\((?:1[0-9]|20)\d{2}(?:\s*[-–]\s*(?:1[0-9]|20)\d{2})?\)/g, '');
  // Likewise a trailing ", 2017." at the end of a rendered citation.
  out = out.replace(/,\s*(?:1[0-9]|20)\d{2}\.?\s*$/g, '');
  out = out.replace(ISO_DATE_RE, (m) => m.slice(0, 4));
  out = out.replace(SLASH_DATE_RE, (m) => {
    const parts = m.split('/');
    const year = parts.find((p) => p.length === 4);
    return year || m;
  });
  out = out.replace(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+(\d{4})\b/gi, '$3');
  out = out.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi, '$3');
  return out;
}

/** Canonicalise a numeric token so 1,227 and 1227 compare equal. */
function canonNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const unit = (s.match(UNIT_RE) || [])[0] || '';
  // Strip ANY trailing alphabetic run before reading the number. A trailing
  // word is only ever a unit candidate: "1,227,000 people" must still yield
  // 1227000 rather than null, or the fact disappears entirely.
  const numStr = s.replace(/[,\s]/g, '').replace(/[a-z%]+$/i, '');
  // At least one digit must survive, or "not a number" would canonicalise to 0.
  if (!/\d/.test(numStr)) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  let scale = 1;
  switch (unit.toLowerCase()) {
    case 'k': scale = 1e3; break;
    case 'm': scale = 1e6; break;
    case 'thousand': scale = 1e3; break;
    case 'million': scale = 1e6; break;
    case 'billion': scale = 1e9; break;
    case 'trillion': scale = 1e12; break;
    default: break;
  }
  return { value: n * scale, unit: unit.toLowerCase() || null, raw: s };
}

/**
 * Extract anchored facts from a passage.
 * Returns [{ anchor, number, date, quote }]
 *
 * Each value binds to its NEAREST anchor, not to every anchor within earshot.
 * An earlier version used a wide window and took every value in it, so the
 * sentence "founded in 1999 and listed in 2004" produced TWO facts under the
 * "founded" anchor and contradicted itself. That is precisely the false
 * contradiction this service exists to avoid.
 */
/**
 * Reduce an anchor's surface word to its stem so "founded", "founding" and
 * "found" compare as ONE attribute, while "launched" stays distinct. Without
 * this the surface split is too fine and a claim phrased with a different
 * inflection would never be compared at all.
 */
function stemSurface(word) {
  return String(word)
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/e$/, (m, _o, s) => (s.length > 4 ? '' : 'e'));
}

function extractFacts(passage) {
  const text = normaliseDates(squash(passage));
  const facts = [];
  if (!text) return facts;

  // Collect every candidate value once, with its position.
  const candidates = [];

  NUMBER_RE.lastIndex = 0;
  let n;
  while ((n = NUMBER_RE.exec(text)) !== null) {
    const c = canonNumber(n[0]);
    if (c) candidates.push({ kind: 'number', at: n.index, len: n[0].length, value: c.value, unit: c.unit, raw: c.raw });
  }

  DATE_RE.lastIndex = 0;
  let d;
  while ((d = DATE_RE.exec(text)) !== null) {
    const year = d[1] || d[5];
    if (year) candidates.push({ kind: 'year', at: d.index, len: d[0].length, value: Number(year), unit: 'year', raw: String(year) });
  }

  // A bare four digit year is ALSO matched by NUMBER_RE. Without this, the
  // claim "born in 1961" yields a year 1961 and a number 1961, while the
  // evidence "born 4 Aug. 1961" yields a number 4 and a year 1961. The number
  // comparison then pits 1961 against 4 and reports a contradiction that does
  // not exist. Where a date span covers a number span, the date reading wins
  // and the duplicate number is discarded.
  const deduped = candidates.filter((c) => {
    if (c.kind !== 'number') return true;
    return !candidates.some((dt) =>
      dt.kind === 'year' && c.at >= dt.at && c.at + c.len <= dt.at + dt.len);
  });
  candidates.length = 0;
  candidates.push(...deduped);

  if (!candidates.length) return facts;

  // Anchor occurrences, with their positions.
  const anchors = [];
  for (const a of ANCHORS) {
    a.re.lastIndex = 0;
    let m;
    while ((m = a.re.exec(text)) !== null) {
      anchors.push({ name: a.name, surface: stemSurface(m[0]), at: m.index, len: m[0].length });
    }
  }
  if (!anchors.length) return facts;

  const MAX_RADIUS = 45;

  // Each value is claimed by its CLOSEST anchor occurrence only.
  const claimedBy = new Map(); // anchorOccurrenceIndex -> { kind -> {dist, fact} }

  candidates.forEach((cand, ci) => {
    let bestIdx = -1;
    let bestDist = Infinity;
    anchors.forEach((an, ai) => {
      const dist = cand.at > an.at + an.len
        ? cand.at - (an.at + an.len)
        : an.at - (cand.at + cand.len);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = ai;
      }
    });
    if (bestIdx < 0 || bestDist > MAX_RADIUS) return;

    if (!claimedBy.has(bestIdx)) claimedBy.set(bestIdx, {});
    const byKind = claimedBy.get(bestIdx);
    const prev = byKind[cand.kind];
    // ONE value per anchor occurrence per kind. Anything further away than the
    // value already bound to this occurrence belongs to some other clause and
    // must not compete with it.
    if (prev && prev.dist <= bestDist) return;
    byKind[cand.kind] = { dist: bestDist, cand, ci };
  });

  for (const [ai, byKind] of claimedBy.entries()) {
    const an = anchors[ai];
    for (const kind of Object.keys(byKind)) {
      const { cand } = byKind[kind];
      const start = Math.max(0, an.at - 25);
      const end = Math.min(text.length, cand.at + cand.len + 25);
      facts.push({
        anchor: an.name,
        // The exact word that fired the anchor. Comparison is by this, not by
        // the anchor family, so "founded" and "launched" never compete.
        surface: an.surface || an.name,
        kind: cand.kind,
        value: cand.value,
        unit: cand.unit,
        raw: cand.raw,
        quote: text.slice(start, end),
      });
    }
  }

  return facts;
}

/**
 * Does this citation actually speak about the same subject as the claim?
 *
 * WITHOUT THIS CHECK THE ENGINE PRODUCES FALSE CONTRADICTIONS. A claim about
 * when Barack Obama was born will be "contradicted" by any retrieved document
 * that mentions a different year under a "born" anchor, even though the
 * document is about somebody else entirely. Different documents about
 * different subjects are not disagreements.
 *
 * A contradiction therefore requires BOTH:
 *   - the same attribute with a different value, and
 *   - genuine subject overlap between the claim and the citation
 *
 * Overlap is measured on the content words of the claim, ignoring the
 * attribute words themselves, so that matching on the word "founded" does not
 * make every document about a founding relevant.
 */
function sharesSubject(claimTerms, quote) {
  const q = String(quote || '').toLowerCase();
  if (!q) return false;

  // Attribute words are excluded: matching on "born" or "price" says nothing
  // about whether two passages are about the same thing.
  const ATTR = new Set([
    'founded', 'founding', 'found', 'established', 'establishment', 'created',
    'launched', 'incorporated', 'born', 'birth', 'died', 'death', 'population',
    'inhabitants', 'residents', 'height', 'tall', 'altitude', 'weight', 'mass',
    'weighs', 'price', 'cost', 'costs', 'costed', 'worth', 'value', 'valued',
    'released', 'release', 'premiered', 'premiere', 'published', 'publish',
    'issued', 'gdp', 'temperature', 'temperatures', 'warming', 'degrees',
    'percent', 'percentage', 'total', 'number', 'count', 'amount', 'sum',
  ]);

  const content = claimTerms
    .map((t) => String(t).toLowerCase().replace(/['"]/g, ''))
    // Length 4 or more: short words like "new", "born", "year" are too generic
    // to identify a subject and would make almost anything match.
    .filter((t) => t.length >= 4 && !ATTR.has(t))
    // AND NOT PURELY NUMERIC. A year or quantity is a VALUE, not a subject.
    // Requiring it in the evidence breaks the whole comparison, because
    // evidence that states a DIFFERENT value will never contain the claim's
    // number. "Founded in 1999" is contradicted by "founded in 2001", which
    // naturally does not mention 1999. Subject words only.
    .filter((t) => !/^\d+$/.test(t));

  if (!content.length) return false;

  // MATCH AS WHOLE TOKENS, never as substrings.
  //
  // "John" is a substring of "Johnson", so a claim about John was contradicted
  // by a document about Johnson. Word boundaries close that.
  const matches = content.filter((t) =>
    new RegExp(`\\b${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)
  );

  // STRONG ENOUGH TO BE ABOUT THE SAME THING.
  //
  // One matching word is not evidence of shared subject. A MusicBrainz record
  // titled "Python" by an unrelated artist matched a claim about the Python
  // programming language purely on the word "Python", and its 2019 release date
  // was then reported as contradicting the true claim that Python appeared in
  // 1991.
  //
  // When the claim offers two or more distinctive words, at least two must
  // appear. With only one distinctive word available, one match is accepted,
  // because there is nothing better to require.
  const strongEnough = content.length >= 2 ? matches.length >= 2 : matches.length >= 1;
  if (!strongEnough) return false;

  // GENERATIONAL DISAMBIGUATION, and it must be SYMMETRIC.
  //
  // An earlier version only rejected a quote that carried a suffix when the
  // claim carried none. If the claim named ANY suffix the whole gate was
  // switched off, so a true claim about one generation was contradicted by
  // another: "Martin Luther King Jr. was born in 1929" against "King Sr. was
  // born in 1899", and "Elizabeth II was born in 1926" against "Elizabeth I
  // born in 1533". Both returned CONTRADICTED.
  //
  // Now both sides are compared as entity keys. Different suffixes mean
  // different entities. One side having a suffix the other lacks also means
  // different entities. Only a match on both, or an absence on both, is the
  // same entity.
  const SUFFIX = /\b(sr|jr|ii|iii|iv|vi|vii|viii|ix|x|senior|junior)\b\.?/i;
  const claimSuffix = (String(claimTerms.join(' ')).match(SUFFIX) || [])[0] || null;
  const quoteSuffix = (q.match(SUFFIX) || [])[0] || null;
  const normSuffix = (s) => (s ? s.toLowerCase().replace(/\./g, '') : null);
  const cs = normSuffix(claimSuffix);
  const qs = normSuffix(quoteSuffix);
  if (cs !== qs) return false;

  return true;
}

/**
 * Compare a claim's facts against evidence facts.
 *
 * Returns contradictions and supports. Anything not matched is UNRESOLVED.
 */
function compareFacts(claimFacts, evidenceFacts, { subjectOk = true } = {}) {
  const contradictions = [];
  const supports = [];

  // A citation about a different subject can neither support nor contradict.
  if (!subjectOk) return { contradictions, supports };

  for (const cf of claimFacts) {
    // COMPARE BY ANCHOR FAMILY, but never let two different attributes of the
    // SAME claim compete with one another.
    //
    // "founded in 1999 and launched in 2004" gives two facts under the founded
    // anchor with different surface words. Comparing both against evidence that
    // says "founded in 1999" reports the true claim as contradicted by its own
    // launch year. So when the claim offers more than one surface word for this
    // anchor, only the fact whose surface matches the evidence may be compared.
    //
    // When the claim offers a single surface word, cross-family comparison
    // still happens, because "founded in 1999" and "Incorporated in 2001" are
    // the same attribute and SHOULD contradict.
    const surfaceSet = new Set(
      claimFacts.filter((f) => f.anchor === cf.anchor && f.kind === cf.kind).map((f) => f.surface)
    );
    const claimIsMultiSurface = surfaceSet.size > 1;

    const rivals = evidenceFacts.filter((ef) => {
      if (ef.anchor !== cf.anchor || ef.kind !== cf.kind) return false;
      if (claimIsMultiSurface && ef.surface !== cf.surface) return false;
      return true;
    });

    // AN AGREEING QUOTE MUST NEVER CONTRADICT.
    //
    // If any rival states the same value as the claim, the source AGREES with
    // the claim on this attribute. Whatever else the same quote contains is
    // either a second recorded value or a different property, and neither is
    // a contradiction.
    //
    // Verified failures before this rule:
    //   "founded in 1994. incorporated in 1996"  vs "founded in 1994" -> CONTRADICTED
    //   "height is 20000 (P2046); height is 300 (P2048)" vs "height 300" -> CONTRADICTED
    //   "founded in 1899; founded in 1901"       vs "founded in 1901" -> CONTRADICTED
    // Each quote AGREED with the claim and was still reported as disproving it.
    //
    // A source holding several values is AMBIGUOUS, not contradictory. That
    // means UNRESOLVED, never CONTRADICTED.
    const valueEqual = (a, b) =>
      a.kind === 'year'
        ? a.value === b.value
        : Math.abs(a.value - b.value) <= Math.max(1e-9, Math.abs(a.value) * 0.005);

    const anyRivalAgrees = rivals.some((ef) => valueEqual(cf, ef));

    for (const ef of rivals) {
      const same = valueEqual(cf, ef);

      if (same) {
        supports.push({
          anchor: cf.anchor,
          surface: cf.surface,
          claim_value: cf.raw,
          evidence_value: ef.raw,
          claim_quote: cf.quote,
          evidence_quote: ef.quote,
          evidence_quote_kind: ef.quote_kind || 'structured',
          source: ef.source || null,
          url: ef.url || null,
          title: ef.title || null,
        });
      } else if (!anyRivalAgrees && (cf.unit === ef.unit || cf.kind === 'year')) {
        // Same attribute, same unit, different value, and NOTHING in this
        // quote agrees with the claim. Only then is it a provable
        // contradiction rather than a judgement.
        contradictions.push({
          anchor: cf.anchor,
          surface: cf.surface,
          claim_value: cf.raw,
          evidence_value: ef.raw,
          claim_quote: cf.quote,
          evidence_quote: ef.quote,
          evidence_quote_kind: ef.quote_kind || 'structured',
          kind: 'value_conflict',
          source: ef.source || null,
          url: ef.url || null,
          title: ef.title || null,
        });
      }
    }
  }

  return { contradictions, supports };
}

/**
 * Run the deterministic stage over a claim and its evidence.
 */
function deterministicVerdict(claim, citations, { claimTerms = null } = {}) {
  const claimFacts = extractFacts(claim);
  // Default to the claim's own content words so callers need not thread terms
  // through, and so the subject check is never accidentally skipped.
  const terms = claimTerms || extractTerms(claim);

  const contradictions = [];
  const supports = [];
  const considered = [];
  const excluded_off_subject = [];

  for (const cit of citations) {
    // Subject check FIRST. A citation about something else is not evidence
    // about this claim and must not be allowed to contradict it.
    const subjectOk = sharesSubject(terms, cit.quote || '');
    if (!subjectOk) {
      excluded_off_subject.push({ source: cit.source, url: cit.url });
      continue;
    }

    const evFacts = extractFacts(cit.quote || '');
    if (!evFacts.length) continue;

    // SUBJECT CHECK AT FACT LEVEL, NOT DOCUMENT LEVEL.
    //
    // Checking the whole citation was too weak: a paper that mentions "Obama"
    // in passing still passes, and then a different year under a "born" anchor
    // in that same paper reads as a contradiction of his birth year. That is
    // how true claims were being flagged as CONTRADICTED.
    //
    // The check now runs against the fact's OWN local span, the text
    // immediately around the anchor. If that span does not name the claim's
    // subject, the value belongs to somebody or something else and cannot
    // contradict this claim.
    const onSubjectFacts = evFacts.filter((f) => sharesSubject(terms, f.quote));
    if (!onSubjectFacts.length) {
      excluded_off_subject.push({ source: cit.source, url: cit.url });
      continue;
    }

    considered.push({ source: cit.source, url: cit.url, facts_found: onSubjectFacts.length });

    const r = compareFacts(claimFacts, onSubjectFacts, { subjectOk: true });
    for (const c of r.contradictions) {
      contradictions.push({ ...c, source: cit.source, url: cit.url, title: cit.title });
    }
    for (const s of r.supports) {
      supports.push({ ...s, source: cit.source, url: cit.url, title: cit.title });
    }
  }

  let verdict;
  if (contradictions.length) verdict = 'CONTRADICTED';
  else if (supports.length && !contradictions.length) verdict = 'SUPPORTED';
  else verdict = 'UNRESOLVED';

  return {
    stage: 'deterministic',
    verdict,
    claim_facts: claimFacts.map((f) => ({ anchor: f.anchor, kind: f.kind, value: f.raw })),
    contradictions,
    supports,
    citations_considered: considered,
    // Citations dropped for being about a different subject. Reported so the
    // decision to ignore them is visible rather than silent.
    excluded_off_subject: excluded_off_subject.length,
    method:
      'Facts are extracted from the claim and from each quoted citation, matched by ' +
      'attribute, and compared as values. A contradiction requires the same attribute ' +
      'and unit with different values, AND that the citation is about the same subject ' +
      'as the claim. Citations about other subjects cannot contradict. No comparable ' +
      'fact in the on-subject evidence means UNRESOLVED, never a verdict.',
  };
}

module.exports = {
  extractFacts,
  compareFacts,
  deterministicVerdict,
  canonNumber,
  sharesSubject,
  ANCHORS,
};
