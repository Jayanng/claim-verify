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
  { name: 'founded', re: /\b(found(?:ed|ing)?|establish(?:ed|ment)?|created|launched|incorporated)\b/gi },
  { name: 'born', re: /\b(born|birth)\b/gi },
  { name: 'died', re: /\b(died|death|passed away)\b/gi },
  { name: 'population', re: /\b(population|inhabitants|residents)\b/gi },
  { name: 'height', re: /\b(height|tall|altitude)\b/gi },
  { name: 'weight', re: /\b(weight|mass|weighs)\b/gi },
  { name: 'price', re: /\b(price|cost(?:s|ed)?|worth|value|valued)\b/gi },
  { name: 'released', re: /\b(releas(?:ed|e)|premier(?:ed|e)|publish(?:ed|)|issued|released on)\b/gi },
  { name: 'gdp', re: /\b(gdp|gross domestic product)\b/gi },
  { name: 'temperature', re: /\b(temperatur(?:e|es)|warming|degrees)\b/gi },
  { name: 'percentage', re: /\b(percent|percentage|per cent|%)\b/gi },
  { name: 'count', re: /\b(total|number of|count|amount|sum)\b/gi },
];

// A numeric value, optionally with thousands separators, a sign, a unit or a
// percentage. Deliberately strict so a stray digit is not read as a quantity.
const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?\s*(?:%|percent|per cent|million|billion|trillion|thousand|[kKmM]\b)?/g;

// Dates in the forms people actually write.
const DATE_RE = /\b(\d{4})\b|\b(\d{1,2}\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2},?\s+)?(\d{4})\b/gi;

/** Canonicalise a numeric token so 1,227 and 1227 compare equal. */
function canonNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const unit = (s.match(/(million|billion|trillion|thousand|%|percent|per cent|[kKmM])\s*$/) || [])[1] || '';
  const numStr = s.replace(/[,\s]/g, '').replace(/(million|billion|trillion|thousand|%|percent|per cent|[kKmM])\s*$/i, '');
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
function extractFacts(passage) {
  const text = squash(passage);
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
      anchors.push({ name: a.name, at: m.index, len: m[0].length });
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

  const matches = content.filter((t) => q.includes(t));

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

  // GENERATIONAL DISAMBIGUATION.
  //
  // A Wikidata citation lists several people. "Barack Obama Sr. born in
  // 1934-06-18" sits next to "Barack Obama born in 1961-08-04" and shares every
  // content word with a claim about the son, so it passed the subject check and
  // reported a true claim as contradicted.
  //
  // If the span names a generational suffix the claim does not use, it is a
  // different entity and cannot speak to this claim.
  const SUFFIX = /\b(sr|jr|ii|iii|iv|v|senior|junior)\b\.?/i;
  const claimHasSuffix = SUFFIX.test(String(claimTerms.join(' ')));
  if (!claimHasSuffix && SUFFIX.test(q)) return false;

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
    // Only compare within the same anchor, so different attributes never
    // produce a false contradiction.
    const rivals = evidenceFacts.filter((ef) => ef.anchor === cf.anchor && ef.kind === cf.kind);

    for (const ef of rivals) {
      const same =
        cf.kind === 'year'
          ? cf.value === ef.value
          : Math.abs(cf.value - ef.value) <= Math.max(1e-9, Math.abs(cf.value) * 0.005);

      if (same) {
        supports.push({
          anchor: cf.anchor,
          claim_value: cf.raw,
          evidence_value: ef.raw,
          claim_quote: cf.quote,
          evidence_quote: ef.quote,
        });
      } else if (cf.unit === ef.unit || cf.kind === 'year') {
        // Same attribute, same unit, different value. This is a PROVABLE
        // contradiction, not a judgement.
        contradictions.push({
          anchor: cf.anchor,
          claim_value: cf.raw,
          evidence_value: ef.raw,
          claim_quote: cf.quote,
          evidence_quote: ef.quote,
          kind: 'value_conflict',
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
