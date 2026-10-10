'use strict';

/**
 * Typed propositions: the representation layer.
 *
 * WHY THIS EXISTS
 *
 * The previous engine represented a fact as "anchor name + nearest number".
 * That throws away the semantics a contradiction actually depends on: which
 * entity, which predicate, which scope, which value type. Nine rounds of
 * patching that representation each closed one false contradiction and left
 * the layer beneath it exposed, and two independent external reviews kept
 * finding more in the same place.
 *
 * The conclusion, which an outside model reached independently and I agree
 * with after being inside the code: you cannot recover semantics after
 * discarding them. So this module keeps them.
 *
 * A proposition is:
 *
 *   subject    { surface, tokens, type, discriminators }
 *   predicate  { canonical, event_type }
 *   object     { value, type, unit }
 *   qualifiers { polarity, modality, attribution, temporal, conjunction }
 *   provenance { span, sentence, confidence }
 *
 * The engine downstream may only emit CONTRADICTED when two propositions
 * share an entity identity at a high enough tier, share a canonical predicate,
 * carry compatible value types, and disagree with no unresolved ambiguity.
 *
 * DESIGN RULE: this module never decides. It only represents. All verdict
 * logic lives in compare.js, where it can be read and tested as one rule.
 */

// ---------------------------------------------------------------------------
// 1. PREDICATE ONTOLOGY
//
// founded, launched, incorporated and established are DIFFERENT events. The
// old engine gave them one anchor name and let their values compete, so
// "Acme launched in 2004" was contradicted by "Acme was founded in 1999".
//
// A surface word maps to exactly one canonical predicate. There is no family
// grouping, because a family is exactly the licence that bug needed.
// ---------------------------------------------------------------------------

const PREDICATES = [
  // Life events.
  { canonical: 'birth', semantic_category: 'person',
    words: ['born', 'birth', 'births'] },
  { canonical: 'death', semantic_category: 'person',
    words: ['died', 'death', 'deaths', 'passed away'] },

  // Organisational events. Deliberately separate.
  { canonical: 'founding', semantic_category: 'organisation',
    words: ['founded', 'founding', 'founder', 'founders'] },
  { canonical: 'incorporation', semantic_category: 'organisation',
    words: ['incorporated', 'incorporation'] },
  { canonical: 'launch', semantic_category: 'product',
    words: ['launched', 'launching', 'launch'] },
  { canonical: 'establishment', semantic_category: 'organisation',
    words: ['established', 'establishment'] },
  { canonical: 'creation', semantic_category: 'artifact',
    words: ['created', 'creation'] },

  // Publication and release.
  { canonical: 'publication', semantic_category: 'publication',
    words: ['published', 'publication', 'issued'] },
  { canonical: 'release', semantic_category: 'release',
    words: ['released', 'release', 'premiered', 'premiere'] },

  // Measurements and quantities.
  { canonical: 'population', semantic_category: 'measurement',
    words: ['population', 'inhabitants', 'residents'] },
  { canonical: 'height', semantic_category: 'measurement',
    words: ['height', 'tall', 'altitude'] },
  { canonical: 'width', semantic_category: 'measurement',
    words: ['width', 'wide'] },
  { canonical: 'weight', semantic_category: 'measurement',
    words: ['weight', 'mass', 'weighs'] },
  { canonical: 'price', semantic_category: 'measurement',
    words: ['price', 'cost', 'costs', 'costed', 'worth'] },
  { canonical: 'temperature', semantic_category: 'measurement',
    words: ['temperature', 'temperatures', 'degrees', 'warming'] },
  { canonical: 'count', semantic_category: 'measurement',
    words: ['total', 'number of', 'count', 'amount', 'sum'] },
  { canonical: 'percentage', semantic_category: 'measurement',
    words: ['percent', 'percentage', 'per cent'] },
  { canonical: 'gdp', semantic_category: 'measurement',
    words: ['gdp', 'gross domestic product'] },
];

// Surface word -> canonical predicate. Built once.
const WORD_TO_PREDICATE = new Map();
for (const p of PREDICATES) {
  for (const w of p.words) WORD_TO_PREDICATE.set(w.toLowerCase(), p);
}

// Regex source that finds any predicate word, longest first so "number of"
// beats "of". Kept as a STRING and compiled per call: a shared /g/ regex
// carries lastIndex across calls and silently skips matches.
const PREDICATE_RE_SOURCE =
  '\\b(' + PREDICATES.flatMap((p) => p.words).sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b';

function predicateRe() {
  return new RegExp(PREDICATE_RE_SOURCE, 'gi');
}

// ---------------------------------------------------------------------------
// 2. VALUE TYPES
//
// "The tower height is 2020 meters" used to extract as kind year / unit year,
// because any bare four digit token was read as a date. A value's type comes
// from its CONTEXT, never from how many digits it has.
// ---------------------------------------------------------------------------

const UNIT_TYPES = {
  length: ['meters', 'metres', 'meter', 'metre', 'feet', 'foot', 'ft', 'inches', 'inch', 'cm', 'mm', 'km', 'kilometers', 'kilometres', 'miles', 'mile'],
  // 'pounds' is deliberately absent: it is both a mass and a currency, and a
  // map entry cannot carry that ambiguity. It stays on the unknown path.
  mass: ['kg', 'kilograms', 'kilogram', 'grams', 'gram', 'lbs', 'lb', 'tonnes', 'tonne', 'tons', 'ton'],
  volume: ['liters', 'litres', 'liter', 'litre', 'gallons', 'gallon'],
  currency: ['usd', 'eur', 'gbp', 'jpy', 'dollars', 'dollar', 'euros', 'euro', 'yen', 'cents', 'cent'],
  ratio: ['%', 'percent', 'percentage', 'per cent'],
  scale: ['million', 'billion', 'trillion', 'thousand', 'k', 'm'],
  temperature: ['c', 'f', 'celsius', 'fahrenheit', 'kelvin'],
};

const UNIT_TO_TYPE = new Map();
for (const [type, units] of Object.entries(UNIT_TYPES)) {
  for (const u of units) UNIT_TO_TYPE.set(u.toLowerCase(), type);
}

// A unit word immediately following a number.
const UNIT_RE = new RegExp(
  '\\s*(' + [...UNIT_TO_TYPE.keys()].sort((a, b) => b.length - a.length)
    .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*$',
  'i'
);

// Dates, in the forms people actually write. Reduced to a bare year first.
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,4}\/\d{1,2}\/\d{1,4}\b/g;
const DAY_MONTH_YEAR =
  /\b(\d{1,2})\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+(\d{4})\b/gi;
const MONTH_DAY_YEAR =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;

// What type each predicate EXPECTS. A unitless value inherits this rather
// than being called cardinal_number, which is not a neutral label: a
// comparator may treat it as comparable and pit a height against a count.
const PREDICATE_VALUE_TYPES = {
  population: 'cardinal_number', height: 'length', width: 'length',
  weight: 'mass', price: 'currency', temperature: 'temperature',
  percentage: 'ratio', gdp: 'currency', count: 'cardinal_number',
  birth: 'calendar_year', death: 'calendar_year', founding: 'calendar_year',
  incorporation: 'calendar_year', launch: 'calendar_year',
  establishment: 'calendar_year', creation: 'calendar_year',
  publication: 'calendar_year', release: 'calendar_year',
};

// A four digit token is a YEAR only with date context. This set is the context.
const DATE_PREDICATES = new Set(['birth', 'death', 'founding', 'incorporation', 'launch', 'establishment', 'creation', 'publication', 'release']);
const DATE_CONTEXT = /\b(in|on|since|until|from|by|after|before|during|year|dated?)\b/i;

/**
 * Reduce dates to their bare year before any number is collected, so ISO,
 * slash and day-month forms cannot leak month and day fragments as numbers.
 *
 * Citation metadata is NOT an assertion. A parenthesised or trailing year in a
 * rendered citation is a publication date and cannot speak to the claim, so it
 * is removed. This is deliberately aggressive: losing a real date costs an
 * UNRESOLVED, keeping a citation date costs a false contradiction.
 */
function normaliseDates(text) {
  let out = text;
  out = out.replace(/\((?:1[0-9]|20)\d{2}(?:\s*[-–]\s*(?:1[0-9]|20)\d{2})?\)/g, '');
  out = out.replace(/,\s*(?:1[0-9]|20)\d{2}\.?\s*$/g, '');
  out = out.replace(ISO_DATE_RE, (m) => m.slice(0, 4));
  out = out.replace(SLASH_DATE_RE, (m) => {
    const parts = m.split('/');
    const year = parts.find((p) => p.length === 4);
    return year || m;
  });
  out = out.replace(DAY_MONTH_YEAR, '$2');
  out = out.replace(MONTH_DAY_YEAR, '$2');
  return out;
}

/**
 * Read a number token and decide what kind of value it is.
 *
 * Returns null when there is no number there. Never guesses: a four digit
 * token without unit or date context is a cardinal_number, not a year, and a
 * number carrying a unit is never also a year.
 */
function readValue(raw, { predicateCanonical = null, nearDateContext = false } = {}) {
  if (!raw) return null;
  const s = String(raw).trim();
  const unitMatch = s.match(UNIT_RE);
  const unit = unitMatch ? unitMatch[1].toLowerCase() : null;
  const numStr = s.replace(/[,\s]/g, '').replace(/[a-z%]+$/i, '');
  if (!/\d/.test(numStr)) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;

  // Scale words multiply. Everything else is a plain measure.
  let value = n;
  let scaleUnit = null;
  if (unit && UNIT_TYPES.scale.includes(unit)) {
    scaleUnit = unit;
    const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, billion: 1e9, trillion: 1e12 }[unit] || 1;
    value = n * scale;
  }

  // TYPE COMES FROM CONTEXT, NOT DIGIT COUNT.
  //
  // A unit wins outright: "2020 meters" is a length, never a year.
  // Then a date predicate plus date context: "founded in 2001" is a year.
  // Everything else is a cardinal_number.
  let type;
  if (unit && UNIT_TO_TYPE.has(unit) && UNIT_TO_TYPE.get(unit) !== 'scale') {
    type = UNIT_TO_TYPE.get(unit);
  } else if (scaleUnit) {
    type = 'cardinal_number';
  } else if (predicateCanonical && DATE_PREDICATES.has(predicateCanonical) && nearDateContext) {
    type = 'calendar_year';
  } else if (nearDateContext && /^\d{4}$/.test(numStr)) {
    type = 'calendar_year';
  } else {
    // INHERIT the predicate's expected type, or stay UNKNOWN. Never guess.
    // Date predicates need date context before a bare number becomes a year,
    // so the inheritance is conditional for them too.
    const expected = predicateCanonical && PREDICATE_VALUE_TYPES[predicateCanonical];
    type = (expected && !(expected === 'calendar_year' && !nearDateContext)) ? expected : 'unknown';
  }

  return { value, type, unit: scaleUnit || unit || null, raw: s };
}

module.exports = {
  PREDICATES,
  WORD_TO_PREDICATE,
  PREDICATE_RE_SOURCE,
  predicateRe,
  PREDICATE_VALUE_TYPES,
  UNIT_TYPES,
  UNIT_TO_TYPE,
  UNIT_RE,
  DATE_PREDICATES,
  DATE_CONTEXT,
  normaliseDates,
  readValue,
};
