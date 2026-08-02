# Design note — ranking cross-script search results

## The problem

Searching the hierarchy in a non-Latin script produced visibly wrong ordering: a
Devanagari query for कुड्डलोर returned three villages (Kudaluru, Kadaluru,
Kathaluru) above the district actually being asked for, Cuddalore.

## First hypothesis: the ranking formula — wrong

The obvious explanation was that ranking sorted on exact-match before hierarchy
level, so any exact village match beat a non-exact district. Five candidate
orderings were measured against a labelled set of six real queries. **Every one
failed the Cuddalore case**, which ruled the formula out as the cause.

## Actual cause: a key mismatch upstream

Indic scripts carry an inherent final vowel that English romanisation drops.
कुड्डलोर transliterates to "kuddalora", but the census spells the place
"Cuddalore". Folded, these became `katalara` and `katalari` — one character
apart. The query therefore matched *Kudaluru* exactly and Cuddalore only
approximately. No ordering can recover from that.

**Fix (v3):** strip the trailing vowel from the phonetic key. Both become
`katalar`. Several previous near-misses (Mangalore / Mangalur) also became exact.

## Then choosing the formula, with the keys fixed

| Strategy | Score |
|---|---|
| A — exact, then level, then similarity (original) | 4/6 → 5/6 |
| B — level-weighted product | 5/6 → 5/6 |
| **C — blended 0.55 phonetic + 0.30 name + 0.15 level** | **6/6** |
| D — name-weighted blend | 6/6 |
| E — level-weighted with name tie-break | 6/6 |

With correct keys, A and B began to *over*-correct: searching the exact village
name "Kudaluru" returned the district Cuddalore instead. Only the blended
formulas satisfied every case, because raw name similarity counterbalances the
hierarchy weight.

**Chosen: C**, for being the most interpretable of the three that scored 6/6.

## Lesson

The visible symptom (bad ordering) pointed at the ranking layer, but the defect
was two layers upstream in key generation. Measuring candidate fixes against
labelled data — rather than reasoning from the symptom — is what surfaced it.

*(Reproduce with `rank_eval.js` against a seeded database.)*
