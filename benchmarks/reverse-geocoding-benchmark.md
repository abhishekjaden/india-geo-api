# Design note — reverse geocoding: exact spatial join vs. nearest-centroid (KNN)

**Question.** Reverse geocoding ("which district contains this coordinate?") has an
exact answer: the district whose polygon *contains* the point. A tempting shortcut is
to treat it as a machine-learning problem — assign each point to the district whose
**centroid** is nearest (1-nearest-neighbour). Before shipping, I measured whether that
approximation is actually competitive with the exact spatial join.

**Method.** Over the 641 Census-2011 district polygons, I drew 40,000 uniformly random
points from India's bounding box and kept the 13,013 that fall inside some district. For
each, the exact point-in-polygon result (what PostGIS `ST_Contains` computes) is the
ground truth, compared against the district returned by a 1-NN query over district
centroids. Latency was measured per lookup in-process.

**Results.**

| Approach | Accuracy vs. exact | Latency / lookup |
|---|---|---|
| Exact point-in-polygon (production) | 100% (by definition) | ~46 µs |
| KNN nearest-centroid (k=1) | **74.8%** | ~28 µs |

**Interpretation.** Nearest-centroid is wrong on ~25% of points — it fails on large or
concave districts and near irregular borders, where the geometrically-containing district
is not the one with the closest centroid. Its only edge is a microsecond-scale latency
saving, which is meaningless here for two reasons: the production lookup runs in PostGIS
on a GiST spatial index (sub-millisecond), and every one of these times is dwarfed by
network round-trip latency (tens of milliseconds). The "optimization" targets something
that was never the bottleneck.

**Decision.** Use the exact spatial join (`ST_Contains` over a GiST index). It is correct
by construction and already fast enough; the ML approximation trades a quarter of its
accuracy for a speed advantage that does not matter. The broader lesson: don't reach for
an ML approximation when an exact method exists, and don't optimize a non-bottleneck.

*(Reproduce with `reverse_geocode_benchmark.py`; requires the DataMeet 2011 district
GeoJSON and `shapely`, `scipy`, `numpy`.)*
