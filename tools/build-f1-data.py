#!/usr/bin/env python3
"""
WORKLY — F1DB dataset builder.

Reads the upstream F1DB YAML tree (https://github.com/f1db/f1db) and emits a
compact, deterministic JSON snapshot consumed by the WORKLY backend importer.

Usage:
    python3 tools/build-f1-data.py /path/to/f1db/src/data data/f1db.json.gz

The output keeps EVENT-DERIVED historical facts only (entries, starts, wins,
podiums, poles, fastest laps, season numbers, constructors, standings).
Nothing is inferred or invented: fields absent upstream stay null.
"""
import sys, os, gzip, json, re
from collections import defaultdict

import yaml

ERA_DEFS = [
    ("1950s", "The Pioneering Era", 1950, 1959),
    ("1960s", "The Classic Racing Era", 1960, 1969),
    ("1970s", "Ground Effect and Innovation", 1970, 1979),
    ("1980s", "The Turbo Era", 1980, 1989),
    ("1990s", "The Modern Racing Era", 1990, 1999),
    ("2000s", "V10 and V8 Era", 2000, 2009),
    ("2010s", "The Hybrid Era", 2010, 2019),
    ("2020s", "Modern Ground Effect Era", 2020, 2026),
]

NON_START_REASONS = {
    "did not qualify",
    "did not pre-qualify",
    "did not start",
    "withdrew",
    "did not arrive",
}


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return default if data is None else data


def eras_for(years):
    out = []
    for key, label, lo, hi in ERA_DEFS:
        if any(lo <= y <= hi for y in years):
            out.append({"key": key, "label": label})
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, dest = sys.argv[1], sys.argv[2]

    raw_drivers = load(os.path.join(src, "drivers"), {})
    raw_constructors = load(os.path.join(src, "constructors"), {})
    raw_countries = load(os.path.join(src, "countries"), {})

    countries = {}
    for cid, c in raw_countries.items():
        countries[cid] = {"name": c.get("name") or cid, "demonym": c.get("demonym")}

    constructors = {}
    for cid, c in raw_constructors.items():
        constructors[cid] = {
            "name": c.get("name") or cid,
            "fullName": c.get("fullName") or c.get("name") or cid,
            "countryId": c.get("countryId"),
        }

    # ---- season by season event scan -------------------------------------
    per_driver = defaultdict(lambda: {
        "entries": 0, "starts": 0, "wins": 0, "podiums": 0, "poles": 0,
        "fastestLaps": 0, "points": 0.0, "seasons": defaultdict(lambda: {
            "constructorIds": set(), "numbers": set(), "positions": [],
            "points": 0.0, "wins": 0, "chassis": set(), "teammates": set(),
            "entered": False,
        }),
    })

    seasons_root = os.path.join(src, "seasons")
    years = sorted(
        int(d) for d in os.listdir(seasons_root)
        if d.isdigit() and os.path.isdir(os.path.join(seasons_root, d))
    )
    for year in years:
        ydir = os.path.join(seasons_root, str(year))

        # entrant declarations: constructors, chassis, teammates
        entrants = load(os.path.join(ydir, "entrants.yml"), []) or []
        for e in entrants:
            cons = e.get("constructorId")
            entrant_drivers = []
            if e.get("driverId"):
                entrant_drivers.append(e["driverId"])
            for d in (e.get("drivers") or []):
                if isinstance(d, dict) and d.get("driverId"):
                    entrant_drivers.append(d["driverId"])
            for did in entrant_drivers:
                s = per_driver[did]["seasons"][year]
                s["entered"] = True
                if cons:
                    s["constructorIds"].add(cons)
                if e.get("chassisId"):
                    s["chassis"].add(e["chassisId"])
                for other in entrant_drivers:
                    if other != did:
                        s["teammates"].add(other)

        # standings
        for row in (load(os.path.join(ydir, "driver-standings.yml"), []) or []):
            did = row.get("driverId")
            if not did:
                continue
            s = per_driver[did]["seasons"][year]
            if row.get("position"):
                s["positions"].append(row["position"])
            if row.get("points") is not None:
                s["points"] = float(row["points"])
                per_driver[did]["points"] += float(row["points"])

        races_dir = os.path.join(ydir, "races")
        if not os.path.isdir(races_dir):
            continue
        for race in sorted(os.listdir(races_dir)):
            rdir = os.path.join(races_dir, race)
            if not os.path.isdir(rdir):
                continue
            results = load(os.path.join(rdir, "race-results.yml"), []) or []
            for row in results:
                did = row.get("driverId")
                if not did:
                    continue
                d = per_driver[did]
                s = d["seasons"][year]
                s["entered"] = True
                d["entries"] += 1
                reason = (row.get("reasonRetired") or "").strip().lower()
                started = reason not in NON_START_REASONS and (row.get("laps") or 0) > 0
                if started:
                    d["starts"] += 1
                pos = row.get("position")
                if started and isinstance(pos, int):
                    if pos == 1:
                        d["wins"] += 1
                        s["wins"] += 1
                    if pos <= 3:
                        d["podiums"] += 1
                if row.get("constructorId"):
                    s["constructorIds"].add(row["constructorId"])
                num = row.get("driverNumber")
                if num is not None:
                    s["numbers"].add(str(num))

            for row in (load(os.path.join(rdir, "starting-grid-positions.yml"), []) or []):
                if row.get("position") == 1 and row.get("driverId"):
                    per_driver[row["driverId"]]["poles"] += 1
            for row in (load(os.path.join(rdir, "fastest-laps.yml"), []) or []):
                did = row.get("driverId")
                if did:
                    per_driver[did]["fastestLaps"] += 1

    # ---- driver records ---------------------------------------------------
    drivers = []
    seen_names = defaultdict(list)
    for did, raw in raw_drivers.items():
        ev = per_driver.get(did)
        year_map = {}
        if ev:
            for year, s in ev["seasons"].items():
                if not s["entered"] and not s["positions"]:
                    continue
                best = min(s["positions"]) if s["positions"] else None
                year_map[year] = {
                    "year": year,
                    "constructorIds": sorted(s["constructorIds"]),
                    "numbers": sorted(s["numbers"], key=lambda x: (len(x), x)),
                    "championshipPosition": best,
                    "points": round(s["points"], 2),
                    "wins": s["wins"],
                    "chassis": sorted(s["chassis"]),
                    "teammateIds": sorted(s["teammates"]),
                }
        season_list = [year_map[y] for y in sorted(year_map)]
        champion_years = [
            y for y in sorted(year_map)
            if year_map[y]["championshipPosition"] == 1
        ]
        best_pos = min(
            [year_map[y]["championshipPosition"] for y in year_map
             if year_map[y]["championshipPosition"]],
            default=None,
        )
        first = season_list[0]["year"] if season_list else None
        last = season_list[-1]["year"] if season_list else None

        rec = {
            "id": did,
            "name": raw.get("name") or did,
            "fullName": raw.get("fullName"),
            "firstName": raw.get("firstName"),
            "lastName": raw.get("lastName"),
            "abbreviation": raw.get("abbreviation"),
            "permanentNumber": raw.get("permanentNumber"),
            "gender": raw.get("gender"),
            "dateOfBirth": str(raw.get("dateOfBirth") or "") or None,
            "dateOfDeath": str(raw.get("dateOfDeath") or "") or None,
            "placeOfBirth": raw.get("placeOfBirth"),
            "countryId": raw.get("nationalityCountryId") or raw.get("countryOfBirthCountryId"),
            "seasons": season_list,
            "firstSeason": first,
            "lastSeason": last,
            "eras": [e["key"] for e in eras_for([int(y) for y in year_map])] if year_map else [],
            "stats": {
                "entries": ev["entries"] if ev else 0,
                "starts": ev["starts"] if ev else 0,
                "wins": ev["wins"] if ev else 0,
                "podiums": ev["podiums"] if ev else 0,
                "poles": ev["poles"] if ev else 0,
                "fastestLaps": ev["fastestLaps"] if ev else 0,
                "points": round(ev["points"], 2) if ev else 0,
                "titles": len(champion_years),
                "bestChampionshipPosition": best_pos,
                "championshipYears": champion_years,
            },
        }
        drivers.append(rec)
        seen_names[rec["name"].lower()].append(did)

    drivers.sort(key=lambda d: (d["lastSeason"] or "0000", d["name"]))

    duplicates = {k: v for k, v in seen_names.items() if len(v) > 1}

    payload = {
        "meta": {
            "source": "F1DB (https://github.com/f1db/f1db)",
            "license": "CC BY-SA 4.0 (upstream data)",
            "generatedFromSeasons": [years[0], years[-1]] if years else [],
            "driverCount": len(drivers),
            "historyStartYear": years[0] if years else None,
            "historyEndYear": years[-1] if years else None,
            "duplicateNameGroups": len(duplicates),
        },
        "eras": [{"key": k, "label": l, "from": lo, "to": hi} for k, l, lo, hi in ERA_DEFS],
        "countries": countries,
        "constructors": constructors,
        "drivers": drivers,
    }

    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with gzip.open(dest, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    print(json.dumps({
        "drivers": len(drivers),
        "seasons": len(years),
        "range": [years[0], years[-1]] if years else None,
        "constructors": len(constructors),
        "bytes": os.path.getsize(dest),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
