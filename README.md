# claim-verify

**Claim verification with bound source citations.**

A [Pocket Network](https://docs.pocket.network/) agentic service. You give it a
claim. It retrieves evidence from eleven free sources, binds every citation to
the exact text it cites, and tells you whether the evidence contradicts the
claim, agrees with it, or says nothing about it.

---

## Why this exists

Agents assert things. Most of the time nothing checks them.

The tempting fix is a "truth oracle", a service that answers true or false. That
service cannot exist. There is no ground truth authority to consult, and a
system that answers `true` when it merely found no disagreement is inventing
evidence. It is worse than no check at all, because it looks like proof.

So this service does something narrower and actually defensible. It reports what
the evidence shows, quotes both sides, and refuses when the evidence is silent.

## The four verdicts

| Verdict | What it means |
|---|---|
| `CONTRADICTED` | The cited evidence states a different value for an attribute the claim asserts. Both sides are quoted. |
| `SUPPORTED` | The cited evidence states the same value. Agreement with the source, **not** proof the claim is true. |
| `UNRESOLVED` | The evidence does not speak to the claim. This is the default and the most common answer. |
| `INSUFFICIENT_EVIDENCE` | Nothing usable was retrieved. No verdict is given at all. |

`UNRESOLVED` is the honest answer most of the time. **Absence of contradiction
is not evidence of truth**, and this service never treats it as such.

---

## What it returns

```json
{ "claim": "Barack Obama was born in 1955." }
```

```
verdict: CONTRADICTED

CONTRADICTION [wikidata] anchor=born
  claim    : 1955
  evidence : 1961
  ev quote : Barack Obama born in 1961-08-04 (Wikidata P569)
```

Every citation carries the verbatim text it was taken from, where it came from,
and when it was retrieved. A citation that is only a URL is a pointer, not
evidence.

---

## How a contradiction is established

A contradiction is **provable, not probable**. Both of these must hold:

1. The claim and the evidence assert values for the **same attribute**, and the
   values differ.
2. The evidence is about the **same subject** as the claim.

The second condition matters more than it looks. Without it, a document that
merely mentions a name supplies a competing value from an unrelated context. One
early build reported *"Barack Obama Sr. born in 1934"* as contradicting a true
claim about his son, because both appeared in the same citation.

Facts are compared only within an attribute, values bind to their nearest
anchor, generational suffixes such as `Sr.` and `Jr.` disambiguate different
people, and a citation about something else cannot contradict anything.

## The eleven sources

All free, none requiring an API key.

| Source | Covers |
|---|---|
| Wikipedia | general reference |
| Wikidata | structured facts with exact values |
| CrossRef | academic citations |
| OpenAlex | academic works |
| Europe PMC | biomedical literature |
| SEC EDGAR | company and financial filings |
| arXiv | preprints |
| World Bank | development indicators |
| Open Library | books |
| MusicBrainz | music releases |
| USGS | seismic events |

Wikidata is the most valuable. It returns structured values, so a date of birth
is an exact value rather than a sentence to interpret.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/verify` | Verify a claim |
| `GET` | `/v1/probe` | Functional probe that runs two real verifications |
| `GET` | `/v1/identity` | Service identity and contract |
| `GET` | `/openapi.json` | Machine-readable contract |
| `GET` | `/healthz` | Liveness |

**Run directly** with `node src/server.js`, every path answers plain HTTP. **On
Pocket Network**, `/v1/verify` is a metered relay and must arrive as a signed
`RelayRequest`. A plain request cannot make it, and that rejection is the
network working as designed.

```bash
pocket-ap call --config pocket-ap.yaml --network beta \
  --service claim-verify --rpc-type rest \
  -X POST --path /v1/verify \
  --data '{"claim":"Albert Einstein was born in 1879."}'
```

---

## Running it

No dependencies beyond Node.js 22.

```bash
node src/server.js        # listens on PORT, default 8788
npm test                  # 15 tests
```

---

## What a model may and may not do

If you ask for a model assessment it is returned in `model_assessment`, marked
`derived: "model"`, with `can_change_verdict: false`.

**It can never change the verdict.** A model reading two texts and saying "this
follows" is reporting a learned association, not a fact about the world. If that
could move the verdict, the service would publish a confident answer that is
really a guess.

---

## Honest limits

- **It verifies against sources, not against reality.** If every source is
  wrong in the same way, the claim will look supported.
- **The covered attributes are narrow.** Dates, quantities, prices, populations
  and similar values. Qualitative claims return `UNRESOLVED`.
- **`SUPPORTED` does not mean true.** It means the cited source agrees.
- **Some claims are out of reach of free sources.** Recent events, private
  matters and opinion return `UNRESOLVED`, which is the correct answer.

---

## License

MIT.
