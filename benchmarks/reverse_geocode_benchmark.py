"""
Reverse-geocoding benchmark: exact point-in-polygon vs KNN-nearest-centroid.

Question: for "which district contains this coordinate?", is the ML-style
approximation (assign the point to the district whose CENTROID is nearest)
competitive with the exact spatial answer (which polygon actually contains it)?

Ground truth = exact point-in-polygon (what PostGIS ST_Contains computes).
Approximation = 1-nearest-neighbour over district centroids (a KDTree query).

Run: python reverse_geocode_benchmark.py
Requires: shapely, scipy, numpy  (pip install shapely scipy numpy)

Data: the DataMeet 2011 district GeoJSON (dists11.geojson). Set GEOJSON below
to wherever your copy lives.
"""

import json
import time
import numpy as np
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from scipy.spatial import cKDTree

GEOJSON = "dists11.geojson"   # path to the district boundary GeoJSON
N_SAMPLE = 40000              # random points to draw from India's bounding box
SEED = 42

rng = np.random.default_rng(SEED)

# ---- load district polygons -------------------------------------------------
feats = json.load(open(GEOJSON, encoding="utf-8"))["features"]
geoms, names = [], []
for f in feats:
    geoms.append(shape(f["geometry"]))
    p = f["properties"]
    names.append(f"{p['DISTRICT']}|{p['ST_NM']}")
names = np.array(names)
n_dist = len(geoms)

# exact: STRtree over polygons (mirrors a GiST spatial index: bbox prefilter
# then precise containment test on the few candidates)
tree = STRtree(geoms)

# approximation: KDTree over polygon centroids
centroids = np.array([[g.centroid.x, g.centroid.y] for g in geoms])
kdt = cKDTree(centroids)

# ---- sample points inside the country --------------------------------------
minx = min(g.bounds[0] for g in geoms); maxx = max(g.bounds[2] for g in geoms)
miny = min(g.bounds[1] for g in geoms); maxy = max(g.bounds[3] for g in geoms)

xs = rng.uniform(minx, maxx, N_SAMPLE)
ys = rng.uniform(miny, maxy, N_SAMPLE)

pts, truth_idx = [], []
for x, y in zip(xs, ys):
    p = Point(x, y)
    hit = None
    for cand in tree.query(p):                 # candidates by bbox
        gi = int(cand)
        if geoms[gi].contains(p):              # exact containment
            hit = gi
            break
    if hit is not None:
        pts.append((x, y))
        truth_idx.append(hit)

pts = np.array(pts)
truth_idx = np.array(truth_idx)
n_kept = len(pts)

# ---- accuracy of KNN-nearest-centroid --------------------------------------
_, knn_idx = kdt.query(pts, k=1)
accuracy = float(np.mean(knn_idx == truth_idx))

# ---- latency per query ------------------------------------------------------
M = min(5000, n_kept)
sample = pts[:M]

t0 = time.perf_counter()
for x, y in sample:
    p = Point(x, y)
    for cand in tree.query(p):
        gi = int(cand)
        if geoms[gi].contains(p):
            break
exact_us = (time.perf_counter() - t0) / M * 1e6

t0 = time.perf_counter()
kdt.query(sample, k=1)          # vectorised batch
knn_batch_us = (time.perf_counter() - t0) / M * 1e6

t0 = time.perf_counter()
for x, y in sample:
    kdt.query([x, y], k=1)
knn_loop_us = (time.perf_counter() - t0) / M * 1e6

# ---- report -----------------------------------------------------------------
print(f"districts (centroids)      : {n_dist}")
print(f"random points sampled      : {N_SAMPLE}")
print(f"points inside India (kept) : {n_kept}")
print()
print(f"KNN-nearest-centroid accuracy vs exact : {accuracy*100:.2f}%")
print(f"KNN misclassification rate             : {(1-accuracy)*100:.2f}%")
print()
print(f"latency / lookup  exact point-in-polygon : {exact_us:.1f} us")
print(f"latency / lookup  KNN (per-point loop)   : {knn_loop_us:.1f} us")
print(f"latency / lookup  KNN (batched)          : {knn_batch_us:.2f} us")
