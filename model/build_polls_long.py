#!/usr/bin/env python3
"""
Normalize the NY-12 primary polls into one tidy long table for the targeting
model: one row per (poll, demographic group, candidate) with the candidate's
support % within that group, plus the group's sample size.

Inputs (in model/data/):
  - poll1_crosstabs.xlsx           (n=425; age/race/education/gender)
  - poll2_ny12_crosstabs_20260511.pdf (n=910 likely voters; race/education/gender)

Output: model/data/polls_long.csv

Run:  ~/bores-scheduling/scripts/venv/bin/python build_polls_long.py
"""

import csv
import os

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

CONGRESS_Q = "If the Democratic Primary election for Congress were held today, for whom would you vote?"
# Demographic question text -> our normalized dimension name.
DEMO_QS = {
    "What is your age range?": "age",
    "For statistical purposes only, can you please tell me your ethnicity?": "race",
    "What is the highest level of education you have attained?": "education",
    "Can you please tell me your gender?": "gender",
}


def parse_poll1():
    """Parse the Emerson-style crosstab xlsx ('crosstabs' tab)."""
    wb = openpyxl.load_workbook(os.path.join(DATA, "poll1_crosstabs.xlsx"))
    ws = wb["crosstabs"]
    rows = [[c.value for c in r] for r in ws.iter_rows()]
    q_row, sub_row = rows[0], rows[1]  # row0 = questions, row1 = sub-column labels

    # Find the column span of the congressional question.
    start = next(i for i, v in enumerate(q_row) if v == CONGRESS_Q)
    end = next((i for i in range(start + 1, len(q_row)) if q_row[i]), len(q_row))
    # Within that span, sub_row labels are candidate names; each candidate has a
    # Count col then a "Row N %" col. Map candidate -> percent column index.
    cand_pct = {}
    total_count_col = None
    for i in range(start, end):
        label = sub_row[i]
        if not label:
            continue
        pct_col = i + 1  # the "Row N %" column right after the Count column
        if label == "Total":
            total_count_col = i
        else:
            cand_pct[label] = pct_col

    out = []
    cur_q = None
    for r in rows[3:]:
        qcell = (r[0] or "").strip() if isinstance(r[0], str) else r[0]
        if qcell in DEMO_QS:
            cur_q = DEMO_QS[qcell]
        elif qcell:  # a different question starts -> stop collecting
            cur_q = None
        if not cur_q:
            continue
        group = r[1]
        if not group or str(group).strip() == "Total":
            continue
        group_n = r[total_count_col]
        for cand, pcol in cand_pct.items():
            pct = r[pcol]
            if pct is None:
                continue
            out.append({
                "poll": "poll1", "field_date": "unknown", "n_total": 425,
                "dimension": cur_q, "group": str(group).strip(),
                "group_n": round(float(group_n)) if group_n is not None else "",
                # poll1 percentages are stored as fractions (0.209) -> x100
                "candidate": cand, "support_pct": round(float(pct) * 100, 1),
            })
    return out


def poll2_rows():
    """Poll 2 vote crosstab (PDF p.27), hand-encoded from the published table.
    Columns carry no age breakdown on the vote question."""
    # group -> (group_n, {candidate: support_pct})
    cols = {
        ("overall", "All"):       (879, {"Micah Lasher": 16, "Alex Bores": 20, "Jack Schlossberg": 17, "George Conway": 9}),
        ("gender", "Male"):       (431, {"Micah Lasher": 19, "Alex Bores": 27, "Jack Schlossberg": 13, "George Conway": 9}),
        ("gender", "Female"):     (448, {"Micah Lasher": 14, "Alex Bores": 15, "Jack Schlossberg": 20, "George Conway": 10}),
        ("race", "White"):        (696, {"Micah Lasher": 15, "Alex Bores": 22, "Jack Schlossberg": 17, "George Conway": 10}),
        ("race", "Hispanic"):     (66,  {"Micah Lasher": 22, "Alex Bores": 16, "Jack Schlossberg": 18, "George Conway": 4}),
        ("race", "Black"):        (39,  {"Micah Lasher": 9,  "Alex Bores": 16, "Jack Schlossberg": 14, "George Conway": 18}),
        ("race", "Asian/Other"):  (78,  {"Micah Lasher": 19, "Alex Bores": 14, "Jack Schlossberg": 14, "George Conway": 5}),
        ("education", "College"): (748, {"Micah Lasher": 17, "Alex Bores": 20, "Jack Schlossberg": 16, "George Conway": 10}),
        ("education", "No College"): (131, {"Micah Lasher": 10, "Alex Bores": 22, "Jack Schlossberg": 24, "George Conway": 7}),
    }
    out = []
    for (dim, group), (gn, cands) in cols.items():
        for cand, pct in cands.items():
            out.append({
                "poll": "poll2_ny12", "field_date": "2026-05-13", "n_total": 910,
                "dimension": dim, "group": group, "group_n": gn,
                "candidate": cand, "support_pct": float(pct),
            })
    return out


def main():
    rows = parse_poll1() + poll2_rows()
    out_path = os.path.join(DATA, "polls_long.csv")
    cols = ["poll", "field_date", "n_total", "dimension", "group", "group_n", "candidate", "support_pct"]
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {out_path}  ({len(rows)} rows)")
    # quick sanity print: Bores support by group
    print("\nBores support by group:")
    for r in rows:
        if r["candidate"] == "Alex Bores":
            print(f"  {r['poll']:14} {r['dimension']:9} {r['group']:28} n={str(r['group_n']):>4}  {r['support_pct']}%")


if __name__ == "__main__":
    main()
