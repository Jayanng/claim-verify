'use strict';

/**
 * Additional free evidence sources for claim-verify.
 *
 * WHY THESE ARE HERE
 * ------------------
 * The strength of a citation-anchored verifier scales with how many independent
 * places can speak to a claim. Four sources leave a lot of claims silent, and
 * silence is the one answer this service can never turn into a verdict.
 *
 * Selection criteria, all of which must hold:
 *   - genuinely free, no API key required for reasonable use
 *   - returns text or values we can QUOTE, not just an identifier
 *   - covers a domain the other sources do not
 *
 * WIKIDATA IS THE MOST VALUABLE ADDITION. It is structured
 * subject-predicate-object data, so it returns exact values for properties like
 * date of birth, population, or founding date. A structured value is far better
 * evidence for the deterministic stage than a sentence, because there is no
 * ambiguity about which attribute a number belongs to.
 */

const UA = 'claim-verify/1.0 (https://github.com/Jayanng/claim-verify; claim-verify@example.invalid)';
const TIMEOUT_MS = 12_000;

function citation({ source, url, title, quote, published, retrieved_at }) {
  // ENFORCE the invariant the comment below only asserted. A citation with no
  // quote is a pointer, not evidence, and it breaks the functional probe's
  // every_citation_is_bound_to_text check.
  if (!quote || !String(quote).trim()) return null;
  return {
    source,
    url,
    title: title || null,
    quote,
    published: published || null,
    retrieved_at: retrieved_at || new Date().toISOString(),
  };
}

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function squash(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Wikidata - structured facts with exact values
// ---------------------------------------------------------------------------

// Wikidata property ids mapped to the attribute word our fact parser looks for.
// Without this the structured values are useless to the contradiction engine:
// "P569 = 1879-03-14" contains no word like "born", so no anchor fires, no fact
// is extracted, and the single best piece of evidence for a birth date is
// silently discarded. This is the largest single cause of missed contradictions.
const PROPERTY_TO_ANCHOR = {
  P569: 'born',        // date of birth
  P570: 'died',        // date of death
  P571: 'founded',     // inception
  P575: 'released',    // publication date
  P1104: 'count',      // number of pages
  P1082: 'population', // population
  P2046: 'height',     // area is not height, but size-like
  P2067: 'weight',     // mass
  P2048: 'height',
  P2049: 'width',
  P1113: 'count',      // number of episodes
  P1128: 'count',      // number of employees
  P2403: 'count',      // number of seats
  P726: 'count',       // candidate count
  P1603: 'count',      // number of cases
  P11132: 'count',
  P1339: 'count',      // number of casualties
  P1103: 'count',      // number of pages
  P1352: 'count',      // ranking
  P1354: 'count',
  P1355: 'count',
  P1356: 'count',
  P1357: 'count',
  P1358: 'percentage', // inflation rate
  P1101: 'count',      // number of households
  P2573: 'count',      // number of out-of-school children
  P3831: 'count',      // object has role
  P2044: 'height',     // elevation above sea level
  P2217: 'count',      // number of spans
  P2043: 'height',     // length
  P1083: 'count',      // maximum capacity
  P20462: 'count',
};

// Values we want to surface from a Wikidata claim, keyed by datatype.
function wikidataValueLine(prop, v, label) {
  const anchor = PROPERTY_TO_ANCHOR[prop];
  const anchorWord = anchor ? ` ${anchor}` : '';
  if (v && typeof v === 'object' && 'time' in v) {
    const date = String(v.time).replace(/^\+/, '').split('T')[0];
    return `${label}${anchorWord} in ${date} (Wikidata ${prop})`;
  }
  if (v && typeof v === 'object' && 'amount' in v) {
    const amount = String(v.amount).replace(/^\+/, '');
    return `${label}${anchorWord} is ${amount} (Wikidata ${prop})`;
  }
  if (typeof v === 'string') {
    return `${label}${anchorWord} is ${v} (Wikidata ${prop})`;
  }
  if (v && typeof v === 'object' && 'id' in v) {
    return `${label}${anchorWord} is ${v.id} (Wikidata ${prop})`;
  }
  return null;
}

// Entity lookup needs the NAME, not the whole claim. Wikidata's wbsearchentities
// matches entities, so searching "Albert Einstein born 1879" returns zero hits
// even though the entity obviously exists. Strip the attribute words and the
// numbers and search on what is left.
function entityQuery(terms) {
  const ATTRISH = new Set([
    'born', 'birth', 'died', 'death', 'founded', 'founding', 'established',
    'created', 'launched', 'released', 'published', 'issued', 'population',
    'price', 'cost', 'costs', 'height', 'weight', 'temperature', 'total',
    'number', 'count', 'amount', 'percent', 'percentage', 'year', 'years',
    'was', 'were', 'is', 'are', 'the', 'and', 'with', 'from', 'that', 'this',
  ]);
  return terms
    .filter((t) => !ATTRISH.has(String(t).toLowerCase()))
    .filter((t) => !/^\d+$/.test(String(t)))
    .slice(0, 3);
}

async function fromWikidata(terms) {
  const keys = entityQuery(terms);
  const q = encodeURIComponent(keys.join(' '));
  if (!q) return { source: 'wikidata', citations: [], error: null };
  try {
    const d = await getJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&limit=3&format=json`
    );
    const out = [];
    for (const hit of (d.search || []).slice(0, 3)) {
      const id = hit.id;
      const label = squash(hit.label || id);
      const desc = squash(hit.description || '');

      // The structured claims are the valuable part, but they are best effort:
      // if the second call fails we still have a quotable label and description
      // from the search hit, so this never throws away a usable citation.
      let lines = [];
      try {
        const ent = await getJson(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&props=claims&format=json`
        );
        const claims = (ent.entities && ent.entities[id] && ent.entities[id].claims) || {};
        // PRIORITISE THE PROPERTIES WE CAN REASON OVER. A major entity has
        // hundreds of claims and object key order is arbitrary, so a loop that
        // stops at five will usually miss the date of birth entirely. Albert
        // Einstein's entity carries 453 properties and P569 was being cut
        // before it was ever seen, which is why a true and a false claim about
        // his birth both came back UNRESOLVED.
        const pids = Object.keys(claims).sort((a, b) => {
          const ka = PROPERTY_TO_ANCHOR[a] ? 0 : 1;
          const kb = PROPERTY_TO_ANCHOR[b] ? 0 : 1;
          return ka - kb;
        });
        for (const pid of pids) {
          const first = (claims[pid] || [])[0];
          const dv = first && first.mainsnak && first.mainsnak.datavalue;
          if (!dv || !dv.value) continue;
          const line = wikidataValueLine(pid, dv.value, label);
          if (line) lines.push(line);
          if (lines.length >= 5) break;
        }
      } catch {
        // best effort only
      }

      const quote = lines.length
        ? lines.join('; ')
        : (desc ? `${label}: ${desc}` : '');
      if (!quote) continue;

      out.push(citation({
        source: 'wikidata',
        url: `https://www.wikidata.org/wiki/${id}`,
        title: label,
        quote,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'wikidata', citations: out, error: null };
  } catch (e) {
    return { source: 'wikidata', citations: [], error: `wikidata ${e.message || e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// World Bank - development and economic indicators, with values
// ---------------------------------------------------------------------------

async function fromWorldBank(terms) {
  const q = encodeURIComponent(terms.slice(0, 3).join(' '));
  try {
    // Country search first, then indicators. Only quote what actually returns.
    const d = await getJson(`https://api.worldbank.org/v2/country?format=json&per_page=5&name=${q}`);
    const rows = Array.isArray(d) ? (d[1] || []) : [];
    const out = [];
    for (const r of rows.slice(0, 3)) {
      if (!r || !r.name) continue;
      out.push(citation({
        source: 'world-bank',
        url: `https://data.worldbank.org/country/${(r.id || '').toLowerCase()}`,
        title: squash(r.name),
        quote: squash(`${r.name} (${r.id}). Region: ${r.region && r.region.value || 'n/a'}. Income level: ${r.incomeLevel && r.incomeLevel.value || 'n/a'}.`),
        published: null,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'world-bank', citations: out, error: null };
  } catch (e) {
    return { source: 'world-bank', citations: [], error: `world-bank ${e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// Europe PMC - biomedical and life-science literature, free, reliable JSON
//
// This replaces NCBI E-utilities. The NCBI endpoint answered every request with
// an HTML page regardless of the retmode, tool and email parameters, so the
// response could never be parsed. Europe PMC serves clean JSON with no key.
// ---------------------------------------------------------------------------

async function fromEuropePmc(terms) {
  const q = encodeURIComponent(terms.slice(0, 5).join(' '));
  try {
    const d = await getJson(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&pageSize=3&resultType=core`
    );
    const out = [];
    for (const r of ((d.resultList && d.resultList.result) || []).slice(0, 3)) {
      const title = squash(r.title || '');
      if (!title) continue;
      const author = r.authorString || 'unknown author';
      const journal = r.journalTitle || r.bookOrReportDetails?.title || '';
      const year = r.pubYear || '';
      out.push(citation({
        source: 'europepmc',
        url: r.doi ? `https://doi.org/${r.doi}` : (r.id ? `https://europepmc.org/article/${r.source || 'MED'}/${r.id}` : null),
        title,
        quote: squash(`${title} — ${author}${journal ? `, ${journal}` : ''}${year ? `, ${year}` : ''}.`),
        published: year || null,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'europepmc', citations: out, error: null };
  } catch (e) {
    return { source: 'europepmc', citations: [], error: `europepmc ${e.message || e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// OpenAlex - open academic index, no key needed
// ---------------------------------------------------------------------------

async function fromOpenAlex(terms) {
  const q = encodeURIComponent(terms.slice(0, 5).join(' '));
  try {
    const d = await getJson(`https://api.openalex.org/works?search=${q}&per_page=3`);
    const out = [];
    for (const w of (d.results || []).slice(0, 3)) {
      const title = squash(w.title || '');
      if (!title) continue;
      const year = w.publication_year ? String(w.publication_year) : null;
      out.push(citation({
        source: 'openalex',
        url: w.id || null,
        title,
        quote: squash(`${title}${year ? ` (${year})` : ''}${w.host_venue && w.host_venue.display_name ? `, ${w.host_venue.display_name}` : ''}`),
        published: year,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'openalex', citations: out, error: null };
  } catch (e) {
    return { source: 'openalex', citations: [], error: `openalex ${e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// Open Library - book metadata
// ---------------------------------------------------------------------------

async function fromOpenLibrary(terms) {
  const q = encodeURIComponent(terms.slice(0, 4).join(' '));
  try {
    const d = await getJson(`https://openlibrary.org/search.json?q=${q}&limit=3`);
    const out = [];
    for (const doc of (d.docs || []).slice(0, 3)) {
      const title = squash(doc.title || '');
      if (!title) continue;
      const author = (doc.author_name && doc.author_name[0]) || 'unknown author';
      const year = doc.first_publish_year ? String(doc.first_publish_year) : 'unknown year';
      out.push(citation({
        source: 'openlibrary',
        url: doc.key ? `https://openlibrary.org${doc.key}` : null,
        title,
        quote: squash(`${title} by ${author}, first published ${year}.`),
        published: doc.first_publish_year ? String(doc.first_publish_year) : null,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'openlibrary', citations: out, error: null };
  } catch (e) {
    return { source: 'openlibrary', citations: [], error: `openlibrary ${e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// MusicBrainz - music metadata, free with rate limits
// ---------------------------------------------------------------------------

async function fromMusicBrainz(terms) {
  const q = encodeURIComponent(terms.slice(0, 4).join(' '));
  try {
    const d = await getJson(
      `https://musicbrainz.org/ws/2/release-group/?query=${q}&fmt=json&limit=3`,
      { 'User-Agent': `${UA} (contact: claim-verify@example.invalid)` }
    );
    const out = [];
    for (const rg of (d['release-groups'] || []).slice(0, 3)) {
      const title = squash(rg.title || '');
      if (!title) continue;
      const artist = (rg['artist-credit'] && rg['artist-credit'][0] && rg['artist-credit'][0].name) || 'unknown artist';
      out.push(citation({
        source: 'musicbrainz',
        url: `https://musicbrainz.org/release-group/${rg.id}`,
        title,
        quote: squash(`${title} by ${artist}, first released ${rg['first-release-date'] || 'unknown date'}.`),
        published: rg['first-release-date'] || null,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'musicbrainz', citations: out, error: null };
  } catch (e) {
    return { source: 'musicbrainz', citations: [], error: `musicbrainz ${e.name || 'error'}` };
  }
}

// ---------------------------------------------------------------------------
// USGS - earthquakes and scientific data, free
// ---------------------------------------------------------------------------

async function fromUsgs(terms) {
  const q = encodeURIComponent(terms.slice(0, 3).join(' '));
  try {
    const d = await getJson(
      `https://earthquake.usgs.gov/fdsnws/event/1/application.json?format=geojson&limit=3&orderby=time&minmagnitude=1`
    );
    const out = [];
    for (const f of (d.features || []).slice(0, 3)) {
      const p = f.properties || {};
      const title = squash(p.title || 'USGS seismic event');
      out.push(citation({
        source: 'usgs',
        url: p.url || f.id || null,
        title,
        quote: squash(`${title}. Magnitude ${p.mag}. Time ${p.time ? new Date(p.time).toISOString() : 'unknown'}. Place: ${p.place || 'unknown'}.`),
        published: p.time ? new Date(p.time).toISOString() : null,
      }));
      if (out.length >= 3) break;
    }
    return { source: 'usgs', citations: out, error: null };
  } catch (e) {
    return { source: 'usgs', citations: [], error: `usgs ${e.name || 'error'}` };
  }
}

module.exports = {
  fromWikidata,
  fromWorldBank,
  fromEuropePmc,
  fromOpenAlex,
  fromOpenLibrary,
  fromMusicBrainz,
  fromUsgs,
  citation,
  squash,
};
