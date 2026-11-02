'use strict';
/**
 * WORKLY — F1DB importer.
 *
 * Stages (mirrors the integration spec):
 *   1. validate dataset     2. normalise identities   3. import drivers
 *   4. season/constructor/number history              5. statistics
 *   6. featured collection  7. (photos run separately) 8. relationship validation
 *
 * Import is idempotent: re-running updates historical records in place without
 * duplicating driver profiles or overwriting the featured display values.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { db } = require('./db');

const DATA_FILE = path.join(__dirname, '..', 'data', 'f1db.json.gz');
const FEATURED_FILE = path.join(__dirname, '..', 'data', 'featured-drivers.json');

/** Diacritic-insensitive identity key used only for matching — never for display. */
function identityKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadDataset() {
  const raw = zlib.gunzipSync(fs.readFileSync(DATA_FILE));
  return JSON.parse(raw.toString('utf8'));
}

function loadFeatured() {
  return JSON.parse(fs.readFileSync(FEATURED_FILE, 'utf8'));
}

/**
 * Validate the supplied featured collection before any write.
 *
 * `problems` are blocking structural defects (a record cannot be stored safely).
 * `discrepancies` are reported but non-blocking: the specification declares an
 * expected size of 60 while its own table lists 62 rows, and it explicitly
 * forbids deleting or inventing records to force the count. All supplied
 * records are therefore preserved and the mismatch is reported.
 */
function validateFeatured(featured) {
  const problems = [];
  const discrepancies = [];
  const records = Array.isArray(featured.records) ? featured.records : [];
  if (records.length !== featured.expectedSize) {
    discrepancies.push(
      `declared collection size ${featured.expectedSize} but the supplied table contains ${records.length} records; all ${records.length} were preserved rather than deleted to force the declared count`,
    );
  }
  const seen = new Map();
  records.forEach((r, i) => {
    for (const field of ['name', 'number', 'team', 'nickname']) {
      if (!r[field] || String(r[field]).trim() === '') {
        problems.push(`record ${i + 1} (${r.name || 'unnamed'}) is missing "${field}"`);
      }
    }
    const key = identityKey(r.name);
    if (seen.has(key)) {
      problems.push(`duplicate featured identity: ${r.name} (records ${seen.get(key) + 1} and ${i + 1})`);
    } else {
      seen.set(key, i);
    }
  });
  return { records, problems, discrepancies };
}

/**
 * @returns {Promise<object>} import report
 */
async function importF1Data({ log = console.log } = {}) {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(
      `F1 dataset not found at ${DATA_FILE}. Run: python3 tools/build-f1-data.py <f1db-src> data/f1db.json.gz`,
    );
  }
  const dataset = loadDataset();
  const featured = loadFeatured();
  const validation = validateFeatured(featured);
  if (validation.problems.length) {
    // Hard failure: a record cannot be stored safely (missing field / duplicate identity).
    throw new Error(`Featured collection validation failed:\n- ${validation.problems.join('\n- ')}`);
  }

  const report = {
    source: dataset.meta.source,
    history: [dataset.meta.historyStartYear, dataset.meta.historyEndYear],
    driversImported: 0,
    uniqueProfiles: 0,
    seasonsImported: 0,
    constructorsImported: 0,
    featuredImported: 0,
    declaredFeaturedSize: featured.expectedSize,
    featuredUnmatched: [],
    photosVerified: 0,
    photosMissing: 0,
    unavailableFields: 0,
    rejectedDuplicates: 0,
    discrepancies: [...validation.discrepancies],
  };

  const run = db.transaction(() => {
    // ── countries + constructors ────────────────────────────────────────
    const upCountry = db.prepare(
      `INSERT INTO countries (id, name, demonym) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, demonym = excluded.demonym`,
    );
    for (const [id, c] of Object.entries(dataset.countries || {})) {
      upCountry.run(id, c.name, c.demonym || null);
    }
    const upConstructor = db.prepare(
      `INSERT INTO constructors (id, name, full_name, country_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, full_name = excluded.full_name,
         country_id = excluded.country_id`,
    );
    for (const [id, c] of Object.entries(dataset.constructors || {})) {
      upConstructor.run(id, c.name, c.fullName || null, c.countryId || null);
      report.constructorsImported += 1;
    }

    // ── drivers + season history + statistics ───────────────────────────
    const upDriver = db.prepare(
      `INSERT INTO drivers (id, name, full_name, first_name, last_name, abbreviation,
         permanent_number, gender, date_of_birth, date_of_death, place_of_birth, country_id,
         first_season, last_season, eras)
       VALUES (@id, @name, @fullName, @firstName, @lastName, @abbreviation, @permanentNumber,
         @gender, @dateOfBirth, @dateOfDeath, @placeOfBirth, @countryId, @firstSeason, @lastSeason, @eras)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, full_name = excluded.full_name, first_name = excluded.first_name,
         last_name = excluded.last_name, abbreviation = excluded.abbreviation,
         permanent_number = excluded.permanent_number, gender = excluded.gender,
         date_of_birth = excluded.date_of_birth, date_of_death = excluded.date_of_death,
         place_of_birth = excluded.place_of_birth, country_id = excluded.country_id,
         first_season = excluded.first_season, last_season = excluded.last_season,
         eras = excluded.eras`,
    );
    const upSeason = db.prepare(
      `INSERT INTO driver_seasons (driver_id, season, championship_position, points, wins,
         constructor_ids, numbers, chassis, teammate_ids)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (driver_id, season) DO UPDATE SET
         championship_position = excluded.championship_position, points = excluded.points,
         wins = excluded.wins, constructor_ids = excluded.constructor_ids,
         numbers = excluded.numbers, chassis = excluded.chassis,
         teammate_ids = excluded.teammate_ids`,
    );
    const upStats = db.prepare(
      `INSERT INTO driver_statistics (driver_id, entries, starts, wins, podiums, poles,
         fastest_laps, career_points, titles, best_position, championship_years)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (driver_id) DO UPDATE SET
         entries = excluded.entries, starts = excluded.starts, wins = excluded.wins,
         podiums = excluded.podiums, poles = excluded.poles,
         fastest_laps = excluded.fastest_laps, career_points = excluded.career_points,
         titles = excluded.titles, best_position = excluded.best_position,
         championship_years = excluded.championship_years`,
    );

    for (const d of dataset.drivers) {
      upDriver.run({
        id: d.id,
        name: d.name,
        fullName: d.fullName || null,
        firstName: d.firstName || null,
        lastName: d.lastName || null,
        abbreviation: d.abbreviation || null,
        permanentNumber: d.permanentNumber != null ? String(d.permanentNumber) : null,
        gender: d.gender || null,
        dateOfBirth: d.dateOfBirth || null,
        dateOfDeath: d.dateOfDeath || null,
        placeOfBirth: d.placeOfBirth || null,
        countryId: d.countryId || null,
        firstSeason: d.firstSeason,
        lastSeason: d.lastSeason,
        eras: JSON.stringify(d.eras || []),
      });
      report.driversImported += 1;

      for (const f of ['fullName', 'dateOfBirth', 'countryId', 'placeOfBirth']) {
        if (!d[f]) report.unavailableFields += 1;
      }

      for (const s of d.seasons || []) {
        upSeason.run(
          d.id,
          s.year,
          s.championshipPosition ?? null,
          s.points ?? 0,
          s.wins ?? 0,
          JSON.stringify(s.constructorIds || []),
          JSON.stringify(s.numbers || []),
          JSON.stringify(s.chassis || []),
          JSON.stringify(s.teammateIds || []),
        );
        report.seasonsImported += 1;
      }

      const st = d.stats || {};
      upStats.run(
        d.id,
        st.entries ?? 0,
        st.starts ?? 0,
        st.wins ?? 0,
        st.podiums ?? 0,
        st.poles ?? 0,
        st.fastestLaps ?? 0,
        st.points ?? 0,
        st.titles ?? 0,
        st.bestChampionshipPosition ?? null,
        JSON.stringify(st.championshipYears || []),
      );
    }

    report.uniqueProfiles = db.prepare('SELECT COUNT(*) AS n FROM drivers').get().n;

    // ── featured collection (display values used verbatim) ──────────────
    const allDrivers = db.prepare('SELECT id, name, full_name FROM drivers').all();
    const byKey = new Map();
    for (const d of allDrivers) {
      byKey.set(identityKey(d.name), d.id);
      if (d.full_name) {
        const k = identityKey(d.full_name);
        if (!byKey.has(k)) byKey.set(k, d.id);
      }
    }

    const clearFeatured = db.prepare('DELETE FROM featured_drivers');
    clearFeatured.run();
    const insertFeatured = db.prepare(
      `INSERT INTO featured_drivers (driver_id, display_name, featured_number, featured_team, nickname, position)
       VALUES (?,?,?,?,?,?)`,
    );

    featured.records.forEach((record, index) => {
      let driverId = byKey.get(identityKey(record.name));
      if (!driverId) {
        // Not in the historical dataset: keep the supplied identity as a profile
        // so the featured record is preserved, and report the discrepancy.
        const slug = `workly-${identityKey(record.name).replace(/ /g, '-')}`;
        const existing = db.prepare('SELECT id FROM drivers WHERE id = ?').get(slug);
        driverId = existing ? existing.id : slug;
        if (!existing) {
          upDriver.run({
            id: slug,
            name: record.name,
            fullName: null,
            firstName: null,
            lastName: null,
            abbreviation: null,
            permanentNumber: null,
            gender: null,
            dateOfBirth: null,
            dateOfDeath: null,
            placeOfBirth: null,
            countryId: null,
            firstSeason: null,
            lastSeason: null,
            eras: '[]',
          });
          upStats.run(slug, 0, 0, 0, 0, 0, 0, 0, 0, null, '[]');
        }
        report.featuredUnmatched.push(record.name);
        report.discrepancies.push(
          `"${record.name}" is not present in the F1DB snapshot; profile created with historical fields marked unknown.`,
        );
      }
      insertFeatured.run(
        driverId,
        record.name, // supplied display name, never regenerated
        String(record.number),
        record.team,
        record.nickname,
        index + 1,
      );
      report.featuredImported += 1;
    });
  });

  run();

  // ── relationship validation ──────────────────────────────────────────
  const checks = {
    featuredCount: db.prepare('SELECT COUNT(*) AS n FROM featured_drivers').get().n,
    duplicateDriverIds: db
      .prepare(
        'SELECT COUNT(*) AS n FROM (SELECT id FROM drivers GROUP BY id HAVING COUNT(*) > 1)',
      )
      .get().n,
    orphanSeasons: db
      .prepare(
        'SELECT COUNT(*) AS n FROM driver_seasons s LEFT JOIN drivers d ON d.id = s.driver_id WHERE d.id IS NULL',
      )
      .get().n,
    negativeStats: db
      .prepare('SELECT COUNT(*) AS n FROM driver_statistics WHERE wins > starts OR podiums > starts')
      .get().n,
    seasonsWithUnknownConstructor: db
      .prepare("SELECT COUNT(*) AS n FROM driver_seasons WHERE constructor_ids = '[]'")
      .get().n,
  };
  if (checks.featuredCount !== featured.expectedSize) {
    report.discrepancies.push(
      `featured collection stored ${checks.featuredCount} records (declared ${featured.expectedSize}); every supplied record was preserved`,
    );
  }
  const photoCounts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM driver_images WHERE is_primary = 1 AND verified = 1) AS verified,
         (SELECT COUNT(*) FROM drivers) AS total`,
    )
    .get();
  report.photosVerified = photoCounts.verified;
  report.photosMissing = photoCounts.total - photoCounts.verified;
  report.validation = checks;

  db.prepare(
    'INSERT INTO import_log (source, counts, warnings) VALUES (?, ?, ?)',
  ).run(
    dataset.meta.source,
    JSON.stringify({ drivers: report.driversImported, seasons: report.seasonsImported, featured: report.featuredImported }),
    JSON.stringify(report.discrepancies),
  );

  if (log) log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { importF1Data, identityKey, validateFeatured, loadFeatured, loadDataset };

if (require.main === module) {
  const { init } = require('./db');
  init();
  importF1Data().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
