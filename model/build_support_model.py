#!/usr/bin/env python3
"""
Step 3 of the Phase 3 targeting model: estimate per-ED Bores support (and the
persuadable/undecided share) from the poll crosstabs + per-ED demographics,
then validate against the actual Bores/Lasher primary results.

Method (poststratification-lite / "MRP without the regression"):
  1. From each poll, get Bores support within each demographic group, expressed
     as a LEAN = group_support / that_poll's_topline. Pool the two polls per
     group, weighted by group sample size.
  2. For each ED, for each dimension (gender/race/education/age), take the
     demographic-weighted average lean using the ED's composition. Combine the
     four dimensions with a geometric mean (conservative; avoids the
     over-multiplication you'd get from treating correlated traits as
     independent).
  3. Scale by the topline and calibrate so the electorate-weighted average
     equals the topline. Same for the undecided/persuadable share (poll 1).
  4. Validate: correlate the estimate with the real per-ED Bores share.

Inputs:  model/data/polls_long.csv, model/data/demographics_by_ed.csv,
         data/bores_lasher_results.geojson, data/districts.geojson
Output:  model/data/ed_support_estimates.csv

Run:  ~/bores-scheduling/scripts/venv/bin/python build_support_model.py
"""

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MAP_DATA = os.path.abspath(os.path.join(HERE, "..", "data"))

# Map each poll's group label -> (dimension, canonical group). Poll 2's
# "Asian/Other" maps to BOTH asian and other (same value applied to each).
POLL_GROUP_MAP = {
    "Male": [("gender", "male")], "Female": [("gender", "female")],
    "White or Caucasian": [("race", "white")], "White": [("race", "white")],
    "Black or African American": [("race", "black")], "Black": [("race", "black")],
    "Asian": [("race", "asian")], "Asian/Other": [("race", "asian"), ("race", "other")],
    "Hispanic or Latino of any race": [("race", "hispanic")], "Hispanic": [("race", "hispanic")],
    "Other or multiple races": [("race", "other")],
    "College graduate": [("education", "college")], "Postgraduate or higher": [("education", "college")],
    "College": [("education", "college")],
    "High school or less": [("education", "no_college")],
    "Vocational/technical school": [("education", "no_college")],
    "Associate Degree/some college": [("education", "no_college")],
    "No College": [("education", "no_college")],
    "18-39 years": [("age", "age_18_39")], "40-49 years": [("age", "age_40_49")],
    "50-59 years": [("age", "age_50_59")], "60-69 years": [("age", "age_60_69")],
    "70 or more years": [("age", "age_70plus")],
}
# ED demographic share column for each (dimension, canonical group).
SHARE_COL = {
    ("gender", "male"): "pct_male", ("gender", "female"): "pct_female",
    ("race", "white"): "pct_white", ("race", "black"): "pct_black",
    ("race", "asian"): "pct_asian", ("race", "hispanic"): "pct_hispanic",
    ("race", "other"): "pct_other",
    ("education", "college"): "pct_college", ("education", "no_college"): "pct_no_college",
    ("age", "age_18_39"): "pct_age_18_39", ("age", "age_40_49"): "pct_age_40_49",
    ("age", "age_50_59"): "pct_age_50_59", ("age", "age_60_69"): "pct_age_60_69",
    ("age", "age_70plus"): "pct_age_70plus",
}
DIMENSIONS = ["gender", "race", "education", "age"]


def load_polls():
    rows = list(csv.DictReader(open(os.path.join(DATA, "polls_long.csv"))))
    polls = sorted({r["poll"] for r in rows})
    # poll topline for a candidate = sample-size-weighted avg over the race rows.
    def topline(poll, cand):
        sel = [r for r in rows if r["poll"] == poll and r["candidate"] == cand and r["dimension"] == "race"]
        num = sum(float(r["group_n"]) * float(r["support_pct"]) for r in sel)
        den = sum(float(r["group_n"]) for r in sel)
        return num / den if den else 0.0
    return rows, polls, topline


def pooled_leans(rows, polls, topline, candidate):
    """Return {(dimension, canon_group): pooled_lean} for a candidate.
    Poll-1 education levels are first collapsed to college/no_college by n."""
    # accumulate weighted support per (poll, dim, canon) with sample size
    acc = {}  # (poll, dim, canon) -> [sum n*supp, sum n]
    for r in rows:
        if r["candidate"] != candidate:
            continue
        for dim, canon in POLL_GROUP_MAP.get(r["group"], []):
            n = float(r["group_n"]) if r["group_n"] not in ("", None) else 0.0
            if n <= 0:
                continue
            a = acc.setdefault((r["poll"], dim, canon), [0.0, 0.0])
            a[0] += n * float(r["support_pct"]); a[1] += n
    # group support per (poll,dim,canon), then lean vs that poll's topline
    leans = {}  # (dim, canon) -> [sum n*lean, sum n]
    tl = {p: topline(p, candidate) for p in polls}
    for (poll, dim, canon), (wsum, n) in acc.items():
        if n <= 0 or tl[poll] <= 0:
            continue
        supp = wsum / n
        lean = supp / tl[poll]
        L = leans.setdefault((dim, canon), [0.0, 0.0])
        L[0] += n * lean; L[1] += n
    return {k: v[0] / v[1] for k, v in leans.items() if v[1] > 0}, tl


def ed_estimate(demo_rows, leans):
    """Per-ED combined lean via geometric mean over available dimensions."""
    out = {}
    for r in demo_rows:
        dim_leans = []
        for dim in DIMENSIONS:
            num = den = 0.0
            for (d, canon), col in SHARE_COL.items():
                if d != dim:
                    continue
                if (d, canon) in leans:
                    share = float(r.get(col, 0) or 0)
                    num += share * leans[(d, canon)]; den += share
            if den > 0:
                dim_leans.append(num / den)
        if dim_leans:
            geo = math.exp(sum(math.log(x) for x in dim_leans) / len(dim_leans))
            out[str(r["elect_dist"])] = geo
    return out


def calibrate(est, weights, target):
    wsum = sum(weights.get(k, 0) for k in est)
    if wsum <= 0:
        return est
    mean = sum(est[k] * weights.get(k, 0) for k in est) / wsum
    if mean <= 0:
        return est
    factor = target / mean
    return {k: v * factor for k, v in est.items()}


def corr(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        i = 0
        while i < len(v):
            j = i
            while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0
            for k in range(i, j + 1):
                rk[order[k]] = avg
            i = j + 1
        return rk
    return corr(ranks(xs), ranks(ys))


def main():
    rows, polls, topline = load_polls()
    demo_rows = list(csv.DictReader(open(os.path.join(DATA, "demographics_by_ed.csv"))))

    bores_leans, tl_b = pooled_leans(rows, polls, topline, "Alex Bores")
    und_leans, tl_u = pooled_leans(rows, polls, topline, "Undecided")  # poll 1 only

    print("Pooled Bores leans by group (1.0 = district average):")
    for k in sorted(bores_leans):
        print("  %-22s %.2f" % ("/".join(k), bores_leans[k]))

    # toplines (sample-size weighted across polls that have them)
    def pooled_topline(tl):
        ns = {"poll1": 425, "poll2_ny12": 910}
        num = sum(tl.get(p, 0) * ns.get(p, 0) for p in tl)
        den = sum(ns.get(p, 0) for p in tl if tl.get(p, 0) > 0)
        return num / den if den else 0.0
    base_b = pooled_topline(tl_b) / 100.0
    base_u = (tl_u.get("poll1", 0)) / 100.0  # undecided: poll 1 only

    est_b = ed_estimate(demo_rows, bores_leans)
    est_u = ed_estimate(demo_rows, und_leans)

    # electorate weight + ground truth
    districts = json.load(open(os.path.join(MAP_DATA, "districts.geojson")))
    regdem = {str(f["properties"]["elect_dist"]): float(f["properties"].get("reg_dem_2024", 0) or 0)
              for f in districts["features"]}
    bl = json.load(open(os.path.join(MAP_DATA, "bores_lasher_results.geojson")))
    actual = {str(f["properties"]["elect_dist"]): f["properties"]
              for f in bl["features"]}

    est_b = calibrate(est_b, regdem, base_b)
    est_u = calibrate(est_u, regdem, base_u)

    out_path = os.path.join(DATA, "ed_support_estimates.csv")
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["elect_dist", "bores_lean", "est_bores_support", "est_undecided",
                    "actual_bores_share", "actual_total_votes"])
        for ed in sorted(est_b):
            a = actual.get(ed, {})
            w.writerow([ed, round(est_b[ed] / base_b, 3) if base_b else "",
                        round(est_b[ed], 4), round(est_u.get(ed, 0), 4),
                        round(float(a.get("bores_share", 0) or 0), 4),
                        int(a.get("total_votes", 0) or 0)])
    print("\nWrote %s (%d EDs)" % (out_path, len(est_b)))
    print("Calibrated toplines -> Bores %.1f%%, Undecided %.1f%%" % (100 * base_b, 100 * base_u))

    # ---- validation vs actual Bores/Lasher per-ED share ----
    pairs = [(est_b[ed], float(actual[ed]["bores_share"]))
             for ed in est_b
             if ed in actual and float(actual[ed].get("total_votes", 0) or 0) >= 10]
    xs = [p[0] for p in pairs]; ys = [p[1] for p in pairs]
    print("\n=== Validation vs actual Bores/Lasher results (%d EDs, >=10 votes) ===" % len(pairs))
    print("  Pearson  r = %.3f" % corr(xs, ys))
    print("  Spearman r = %.3f" % spearman(xs, ys))

    # how do raw past-result proxies correlate, for comparison?
    def prox(field):
        p = [(float(f["properties"].get(field, 0) or 0), float(actual[str(f["properties"]["elect_dist"])]["bores_share"]))
             for f in districts["features"]
             if str(f["properties"]["elect_dist"]) in actual
             and float(actual[str(f["properties"]["elect_dist"])].get("total_votes", 0) or 0) >= 10]
        return corr([a for a, _ in p], [b for _, b in p]), len(p)
    for field in ("top_mayor_rank1_share", "top_candidate_share_2022"):
        r, n = prox(field)
        print("  (reference) %-26s Pearson r = %.3f (n=%d)" % (field, r, n))


if __name__ == "__main__":
    main()
