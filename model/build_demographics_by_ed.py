#!/usr/bin/env python3
"""
Build per-election-district demographic profiles from Census ACS, for the
Phase 3 targeting model.

Approach (a data join, reusing the existing block->ED crosswalk):
  1. Pull ACS 5-year demographics at the BLOCK GROUP level for Manhattan
     (race, education, sex, age).
  2. Pull 2020 Census block populations (to split block groups across EDs,
     since a block group can straddle more than one ED).
  3. For each block in field_coverage/ny12_turnout_inputs/block_ed_crosswalk.csv:
       weight = block_pop / (total pop of all blocks in that block group)
       add weight * (block group's ACS counts) to the block's ED.
  4. Convert ED totals to shares and write model/data/demographics_by_ed.csv.

Dimensions (match the poll crosstabs):
  race      : white / black / asian / hispanic / other
  education : college (bachelor's+) vs no_college   (universe: age 25+)
  gender    : male / female
  age       : 18-39 / 40-49 / 50-59 / 60-69 / 70plus (universe: 18+)

Needs a free Census API key (https://api.census.gov/data/key_signup.html).
Provide it via env CENSUS_API_KEY or a one-line file model/data/.census_key.

Run:  ~/bores-scheduling/scripts/venv/bin/python build_demographics_by_ed.py
"""

import csv
import json
import os
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CROSSWALK = os.path.expanduser(
    "~/bores-scheduling/field_coverage/ny12_turnout_inputs/block_ed_crosswalk.csv"
)
STATE, COUNTY = "36", "061"          # New York State, New York County (Manhattan)
ACS_YEAR = os.environ.get("ACS_YEAR", "2022")  # ACS 5-year vintage

# ---- ACS variable maps -------------------------------------------------------
# Race / ethnicity (B03002: Hispanic or Latino by race; non-Hispanic categories)
RACE_VARS = {
    "race_total": "B03002_001E",
    "white": "B03002_003E",
    "black": "B03002_004E",
    "asian": "B03002_006E",
    "hispanic": "B03002_012E",
}
# Education (B15003: educational attainment, universe age 25+)
EDU_VARS = {
    "edu_total": "B15003_001E",
    "bachelors": "B15003_022E",
    "masters": "B15003_023E",
    "professional": "B15003_024E",
    "doctorate": "B15003_025E",
}
# Sex + age (B01001: sex by age). Cells (no E suffix; added below).
MALE_TOTAL, FEMALE_TOTAL = "B01001_002", "B01001_026"
AGE_CELLS = {  # bucket -> (male cell numbers, female cell numbers)
    "age_18_39": (range(7, 14), range(31, 38)),
    "age_40_49": (range(14, 16), range(38, 40)),
    "age_50_59": (range(16, 18), range(40, 42)),
    "age_60_69": (range(18, 22), range(42, 46)),
    "age_70plus": (range(22, 26), range(46, 50)),
}


def census_key():
    key = os.environ.get("CENSUS_API_KEY", "").strip()
    if not key:
        kf = os.path.join(DATA, ".census_key")
        if os.path.isfile(kf):
            with open(kf) as f:
                key = f.read().strip()
    if not key:
        raise SystemExit(
            "No Census API key. Get a free one at "
            "https://api.census.gov/data/key_signup.html and either set "
            "CENSUS_API_KEY or save it to model/data/.census_key"
        )
    return key


def fetch(dataset, variables, geo_for, geo_in, key):
    """Return list of dict rows from the Census API for the given variables."""
    params = {
        "get": ",".join(variables),
        "for": geo_for,
        "in": geo_in,
        "key": key,
    }
    url = "https://api.census.gov/data/%s?%s" % (dataset, urllib.parse.urlencode(params))
    with urllib.request.urlopen(url, timeout=120) as r:
        rows = json.loads(r.read())
    header, data = rows[0], rows[1:]
    return [dict(zip(header, row)) for row in data]


def bg_geoid(row):
    return row["state"] + row["county"] + row["tract"] + row["block group"]


def block_geoid(row):
    return row["state"] + row["county"] + row["tract"] + row["block"]


def num(v):
    try:
        x = float(v)
        return x if x >= 0 else 0.0  # ACS uses negatives as annotation flags
    except (TypeError, ValueError):
        return 0.0


def main():
    key = census_key()
    geo_in = "state:%s county:%s tract:*" % (STATE, COUNTY)

    print("Fetching ACS block-group demographics (%s ACS 5-yr)..." % ACS_YEAR)
    race = {bg_geoid(r): r for r in fetch("%s/acs/acs5" % ACS_YEAR, list(RACE_VARS.values()), "block group:*", geo_in, key)}
    edu = {bg_geoid(r): r for r in fetch("%s/acs/acs5" % ACS_YEAR, list(EDU_VARS.values()), "block group:*", geo_in, key)}
    age_vars = [MALE_TOTAL + "E", FEMALE_TOTAL + "E"]
    for m, f in AGE_CELLS.values():
        age_vars += ["B01001_%03dE" % i for i in m] + ["B01001_%03dE" % i for i in f]
    sexage = {bg_geoid(r): r for r in fetch("%s/acs/acs5" % ACS_YEAR, age_vars, "block group:*", geo_in, key)}

    print("Fetching 2020 Census block populations (for weighting)...")
    blocks = fetch("2020/dec/pl", ["P1_001N"], "block:*", geo_in, key)
    block_pop = {block_geoid(r): num(r["P1_001N"]) for r in blocks}
    bg_pop = {}
    for gid, p in block_pop.items():
        bg_pop[gid[:12]] = bg_pop.get(gid[:12], 0.0) + p

    # Build per-block-group demographic count vectors.
    def bg_counts(bg):
        r, e, s = race.get(bg), edu.get(bg), sexage.get(bg)
        if not (r and e and s):
            return None
        c = {}
        c["white"] = num(r[RACE_VARS["white"]])
        c["black"] = num(r[RACE_VARS["black"]])
        c["asian"] = num(r[RACE_VARS["asian"]])
        c["hispanic"] = num(r[RACE_VARS["hispanic"]])
        c["race_total"] = num(r[RACE_VARS["race_total"]])
        c["other"] = max(0.0, c["race_total"] - (c["white"] + c["black"] + c["asian"] + c["hispanic"]))
        college = sum(num(e[EDU_VARS[k]]) for k in ("bachelors", "masters", "professional", "doctorate"))
        c["college"] = college
        c["edu_total"] = num(e[EDU_VARS["edu_total"]])
        c["no_college"] = max(0.0, c["edu_total"] - college)
        c["male"] = num(s[MALE_TOTAL + "E"])
        c["female"] = num(s[FEMALE_TOTAL + "E"])
        for bucket, (mc, fc) in AGE_CELLS.items():
            c[bucket] = sum(num(s["B01001_%03dE" % i]) for i in mc) + sum(num(s["B01001_%03dE" % i]) for i in fc)
        c["adult_total"] = sum(c[b] for b in AGE_CELLS)
        return c

    # Roll up to EDs through the crosswalk.
    ed = {}  # elect_dist -> count vector
    fields = ["white", "black", "asian", "hispanic", "other", "race_total",
              "college", "no_college", "edu_total", "male", "female",
              "adult_total"] + list(AGE_CELLS)
    missing_bg = set()
    with open(CROSSWALK) as f:
        for row in csv.DictReader(f):
            gid = row["geoid20"]
            bg = gid[:12]
            counts = bg_counts(bg)
            if counts is None:
                missing_bg.add(bg)
                continue
            denom = bg_pop.get(bg, 0.0)
            w = (block_pop.get(gid, 0.0) / denom) if denom > 0 else 0.0
            if w == 0:
                continue
            edist = row["elect_dist"]
            acc = ed.setdefault(edist, {k: 0.0 for k in fields})
            for k in fields:
                acc[k] += w * counts[k]

    # Write shares.
    out_path = os.path.join(DATA, "demographics_by_ed.csv")
    cols = ["elect_dist", "est_pop",
            "pct_white", "pct_black", "pct_asian", "pct_hispanic", "pct_other",
            "pct_college", "pct_no_college",
            "pct_male", "pct_female",
            "pct_age_18_39", "pct_age_40_49", "pct_age_50_59", "pct_age_60_69", "pct_age_70plus"]

    def share(part, whole):
        return round(part / whole, 4) if whole > 0 else 0.0

    rows_out = []
    for edist, c in sorted(ed.items()):
        rt, et, at = c["race_total"], c["edu_total"], c["adult_total"]
        sx = c["male"] + c["female"]
        rows_out.append({
            "elect_dist": edist, "est_pop": round(rt),
            "pct_white": share(c["white"], rt), "pct_black": share(c["black"], rt),
            "pct_asian": share(c["asian"], rt), "pct_hispanic": share(c["hispanic"], rt),
            "pct_other": share(c["other"], rt),
            "pct_college": share(c["college"], et), "pct_no_college": share(c["no_college"], et),
            "pct_male": share(c["male"], sx), "pct_female": share(c["female"], sx),
            "pct_age_18_39": share(c["age_18_39"], at), "pct_age_40_49": share(c["age_40_49"], at),
            "pct_age_50_59": share(c["age_50_59"], at), "pct_age_60_69": share(c["age_60_69"], at),
            "pct_age_70plus": share(c["age_70plus"], at),
        })
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows_out)

    print("\nWrote %s  (%d EDs)" % (out_path, len(rows_out)))
    if missing_bg:
        print("  note: %d block group(s) had no ACS row (likely zero-pop)" % len(missing_bg))

    # District-wide sanity check (population-weighted) vs the poll sample mix.
    tot = {k: sum(c[k] for c in ed.values()) for k in fields}
    print("\nDistrict-wide aggregate (sanity check vs poll composition):")
    print("  race   : White %.0f%%  Hispanic %.0f%%  Black %.0f%%  Asian %.0f%%  Other %.0f%%" % (
        100 * share(tot["white"], tot["race_total"]), 100 * share(tot["hispanic"], tot["race_total"]),
        100 * share(tot["black"], tot["race_total"]), 100 * share(tot["asian"], tot["race_total"]),
        100 * share(tot["other"], tot["race_total"])))
    print("  edu    : College %.0f%%  No college %.0f%%" % (
        100 * share(tot["college"], tot["edu_total"]), 100 * share(tot["no_college"], tot["edu_total"])))
    print("  gender : Male %.0f%%  Female %.0f%%" % (
        100 * share(tot["male"], tot["male"] + tot["female"]),
        100 * share(tot["female"], tot["male"] + tot["female"])))
    print("  age    : 18-39 %.0f%%  40-49 %.0f%%  50-59 %.0f%%  60-69 %.0f%%  70+ %.0f%%" % tuple(
        100 * share(tot[b], tot["adult_total"]) for b in AGE_CELLS))


if __name__ == "__main__":
    main()
