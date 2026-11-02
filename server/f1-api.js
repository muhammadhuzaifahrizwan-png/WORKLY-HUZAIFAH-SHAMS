'use strict';
/**
 * WORKLY — Formula One driver database API.
 *
 * Separation rules enforced here (PART L):
 *   - `featured_drivers` holds the user-supplied display identity (name, number,
 *     team, nickname). It is never overwritten by historical F1DB data.
 *   - `driver_seasons` / `driver_statistics` hold the historical record.
 *     The two identities are always returned as distinct objects.
 *   - driver selection is scoped to one class per academic year and enforced by
 *     partial unique indexes, so concurrent requests cannot double-book a driver.
 *   - completed quiz attempts keep a driver snapshot, so changing a selection
 *     never rewrites past results.
 */
const express = require('express');
const {
  db,
  nowTs,
} = require('./db');
const { requireAuth, requireRole, currentYear, classMembership } = require('./auth');
const { primaryImage, imagesFor } = require('./photos');

const router = express.Router();

const ERAS = [
  { key: '1950s', label: '1950s', title: 'The Pioneering Era', from: 1950, to: 1959 },
  { key: '1960s', label: '1960s', title: 'The Classic Racing Era', from: 1960, to: 1969 },
  { key: '1970s', label: '1970s', title: 'Ground Effect and Innovation', from: 1970, to: 1979 },
  { key: '1980s', label: '1980s', title: 'The Turbo Era', from: 1980, to: 1989 },
  { key: '1990s', label: '1990s', title: 'The Modern Racing Era', from: 1990, to: 1999 },
  { key: '2000s', label: '2000s', title: 'V10 and V8 Era', from: 2000, to: 2009 },
  { key: '2010s', label: '2010s', title: 'The Hybrid Era', from: 2010, to: 2019 },
  { key: '2020s', label: '2020–2026', title: 'Modern Ground Effect Era', from: 2020, to: 2026 },
];

const SORTS = {
  name: 'd.name COLLATE NOCASE ASC',
  chronological: 'd.first_season ASC, d.name COLLATE NOCASE ASC',
  titles: 'COALESCE(s.titles, 0) DESC, COALESCE(s.wins, 0) DESC, d.name COLLATE NOCASE ASC',
  wins: 'COALESCE(s.wins, 0) DESC, COALESCE(s.podiums, 0) DESC, d.name COLLATE NOCASE ASC',
  podiums: 'COALESCE(s.podiums, 0) DESC, COALESCE(s.wins, 0) DESC, d.name COLLATE NOCASE ASC',
  poles: 'COALESCE(s.poles, 0) DESC, COALESCE(s.wins, 0) DESC, d.name COLLATE NOCASE ASC',
  points: 'COALESCE(s.career_points, 0) DESC, COALESCE(s.wins, 0) DESC, d.name COLLATE NOCASE ASC',
};

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function like(value) {
  return `%${String(value).replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** Featured display identity, or null when the driver is not in the collection. */
function featuredFor(driverId) {
  return (
    db
      .prepare('SELECT * FROM featured_drivers WHERE driver_id = ?')
      .get(driverId) || null
  );
}

function imagePayload(driverId) {
  const primary = primaryImage(driverId);
  const all = imagesFor(driverId);
  return {
    primary: primary
      ? {
          imageUrl: primary.image_url,
          thumbUrl: primary.thumb_url || primary.image_url,
          source: primary.source,
          sourcePageUrl: primary.source_page_url,
          licenseName: primary.license_name,
          licenseUrl: primary.license_url,
          photographer: primary.photographer,
          attribution: primary.attribution,
          verified: !!primary.verified,
        }
      : null,
    gallery: all.map((img) => ({
      imageUrl: img.image_url,
      thumbUrl: img.thumb_url || img.image_url,
      source: img.source,
      sourcePageUrl: img.source_page_url,
      licenseName: img.license_name,
      photographer: img.photographer,
      verified: !!img.verified,
    })),
  };
}

/** Drivers already taken (by another student) in a class for the current year. */
function takenInClass(classId, yearId) {
  if (!classId || !yearId) return new Set();
  const rows = db
    .prepare(
      `SELECT driver_id, student_user_id FROM student_driver_selections
        WHERE class_id = ? AND academic_year_id = ? AND active = 1`,
    )
    .all(classId, yearId);
  return new Map(rows.map((r) => [r.driver_id, r.student_user_id]));
}

function selectionFor(studentUserId) {
  const year = currentYear();
  if (!year) return null;
  return (
    db
      .prepare(
        `SELECT sel.*, c.name AS class_name, c.form_level
           FROM student_driver_selections sel
           JOIN classes c ON c.id = sel.class_id
          WHERE sel.student_user_id = ? AND sel.academic_year_id = ? AND sel.active = 1`,
      )
      .get(studentUserId, year.id) || null
  );
}

// ─────────────────────────────── reference ──────────────────────────────
router.get('/eras', (req, res) => {
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drivers WHERE last_season >= ? AND first_season <= ?`,
    );
  res.json({
    eras: ERAS.map((era) => ({
      ...era,
      driverCount: counts.get(era.from, era.to).n,
    })),
  });
});

router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    drivers: one('SELECT COUNT(*) AS n FROM drivers'),
    constructors: one('SELECT COUNT(*) AS n FROM constructors'),
    seasons: one('SELECT COUNT(DISTINCT season) AS n FROM driver_seasons'),
    featured: one('SELECT COUNT(*) AS n FROM featured_drivers'),
    seasonRecords: one('SELECT COUNT(*) AS n FROM driver_seasons'),
    photos: one('SELECT COUNT(*) AS n FROM driver_images'),
    from: one('SELECT MIN(first_season) AS n FROM drivers'),
    to: one('SELECT MAX(last_season) AS n FROM drivers'),
  });
});

router.get('/constructors', (req, res) => {
  const rows = db
    .prepare(
      `SELECT co.id, co.name, co.full_name, co.country_id
         FROM constructors co
        WHERE EXISTS (SELECT 1 FROM driver_seasons ds WHERE ds.constructor_ids LIKE '%' || co.id || '%')
        ORDER BY co.name COLLATE NOCASE`,
    )
    .all();
  res.json({ constructors: rows });
});

router.get('/countries', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.demonym, COUNT(d.id) AS drivers
         FROM countries c JOIN drivers d ON d.country_id = c.id
        GROUP BY c.id ORDER BY c.name COLLATE NOCASE`,
    )
    .all();
  res.json({ countries: rows });
});

// ─────────────────────────── featured collection ────────────────────────
router.get('/featured', (req, res) => {
  const rows = db
    .prepare(
      `SELECT f.*, d.name AS legal_name, d.country_id, d.first_season, d.last_season,
              COALESCE(s.titles, 0) AS titles, COALESCE(s.wins, 0) AS wins,
              COALESCE(s.podiums, 0) AS podiums, COALESCE(s.poles, 0) AS poles
         FROM featured_drivers f
         JOIN drivers d ON d.id = f.driver_id
    LEFT JOIN driver_statistics s ON s.driver_id = d.id
        ORDER BY f.position`,
    )
    .all();

  res.json({
    collection: 'WORKLY FEATURED DRIVER COLLECTION',
    count: rows.length,
    drivers: rows.map((row) => ({
      driverId: row.driver_id,
      name: row.display_name,
      number: row.featured_number,
      team: row.featured_team,
      nickname: row.nickname,
      position: row.position,
      legalName: row.legal_name,
      countryId: row.country_id,
      firstSeason: row.first_season,
      lastSeason: row.last_season,
      titles: row.titles,
      wins: row.wins,
      podiums: row.podiums,
      poles: row.poles,
      image: imagePayload(row.driver_id),
    })),
  });
});

// ──────────────────────────── driver listing ────────────────────────────
router.get('/drivers', (req, res) => {
  const q = String(req.query.q || '').trim();
  const era = String(req.query.era || '').trim();
  const decade = String(req.query.decade || '').trim();
  const country = String(req.query.country || '').trim();
  const constructor = String(req.query.constructor || '').trim();
  const titles = req.query.titles != null && req.query.titles !== '';
  const raceWinner = req.query.winner === '1' || req.query.winner === 'true';
  const podiumFinisher = req.query.podium === '1' || req.query.podium === 'true';
  const active = String(req.query.active || '').trim();
  const number = String(req.query.number || '').trim();
  const nickname = String(req.query.nickname || '').trim();
  const sortKey = SORTS[req.query.sort] ? req.query.sort : 'name';
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [];
  const params = {};

  if (q) {
    where.push(
      `(d.name LIKE @q ESCAPE '\\' OR d.full_name LIKE @q ESCAPE '\\'
        OR d.abbreviation LIKE @q ESCAPE '\\' OR f.nickname LIKE @q ESCAPE '\\'
        OR f.featured_team LIKE @q ESCAPE '\\' OR ct.name LIKE @q ESCAPE '\\'
        OR f.featured_number = @exact)`,
    );
    params.q = like(q);
    params.exact = q;
  }
  if (era) {
    const found = ERAS.find((e) => e.key === era || e.label === era);
    if (found) {
      where.push('d.last_season >= @eraFrom AND d.first_season <= @eraTo');
      params.eraFrom = found.from;
      params.eraTo = found.to;
    }
  }
  if (decade && /^\d{4}$/.test(decade)) {
    where.push('d.last_season >= @decadeFrom AND d.first_season <= @decadeTo');
    params.decadeFrom = Number(decade);
    params.decadeTo = Number(decade) + 9;
  }
  if (country) {
    where.push('d.country_id = @country');
    params.country = country;
  }
  if (constructor) {
    where.push(
      `EXISTS (SELECT 1 FROM driver_seasons ds
                WHERE ds.driver_id = d.id AND ds.constructor_ids LIKE @ctor)`,
    );
    params.ctor = `%${constructor}%`;
  }
  if (titles) where.push('COALESCE(s.titles, 0) > 0');
  if (raceWinner) where.push('COALESCE(s.wins, 0) > 0');
  if (podiumFinisher) where.push('COALESCE(s.podiums, 0) > 0');
  if (active === 'active') where.push('d.last_season >= @thisYear');
  if (active === 'retired') where.push('d.last_season < @thisYear');
  params.thisYear = new Date().getUTCFullYear();
  if (number) {
    where.push(
      `(f.featured_number = @number
        OR EXISTS (SELECT 1 FROM driver_seasons ds2
                    WHERE ds2.driver_id = d.id AND ds2.numbers LIKE @numberLike))`,
    );
    params.number = number;
    params.numberLike = `%${number}%`;
  }
  if (nickname) {
    where.push(`f.nickname LIKE @nickname ESCAPE '\\'`);
    params.nickname = like(nickname);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `
      FROM drivers d
 LEFT JOIN driver_statistics s ON s.driver_id = d.id
 LEFT JOIN featured_drivers f ON f.driver_id = d.id
 LEFT JOIN countries ct ON ct.id = d.country_id
    ${whereSql}`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.abbreviation, d.country_id, d.first_season, d.last_season,
              ct.name AS country_name, ct.demonym,
              f.display_name AS featured_name, f.featured_number, f.featured_team, f.nickname,
              COALESCE(s.titles, 0) AS titles, COALESCE(s.wins, 0) AS wins,
              COALESCE(s.podiums, 0) AS podiums, COALESCE(s.poles, 0) AS poles,
              COALESCE(s.entries, 0) AS entries, COALESCE(s.career_points, 0) AS career_points
         ${base}
       ORDER BY ${SORTS[sortKey]}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  // Selection availability is class-scoped; it is only meaningful for students.
  let taken = new Map();
  let mine = null;
  if (req.user && req.user.role === 'student') {
    const membership = classMembership(req.user.id);
    const year = currentYear();
    if (membership && year) {
      taken = takenInClass(membership.class_id, year.id);
      mine = selectionFor(req.user.id);
    }
  }

  res.json({
    total,
    limit,
    offset,
    sort: sortKey,
    drivers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      abbreviation: row.abbreviation,
      country: row.country_name || null,
      nationality: row.demonym || row.country_name || null,
      firstSeason: row.first_season,
      lastSeason: row.last_season,
      featured: row.featured_number
        ? { number: row.featured_number, team: row.featured_team, nickname: row.nickname }
        : null,
      stats: {
        titles: row.titles,
        wins: row.wins,
        podiums: row.podiums,
        poles: row.poles,
        entries: row.entries,
        careerPoints: row.career_points,
      },
      image: imagePayload(row.id).primary,
      selectedByMe: !!(mine && mine.driver_id === row.id),
      available:
        req.user && req.user.role === 'student'
          ? !taken.has(row.id) || !!(mine && mine.driver_id === row.id)
          : null,
    })),
  });
});

// ───────────────────────────── driver profile ───────────────────────────
router.get('/drivers/:id', (req, res) => {
  const driver = db
    .prepare(
      `SELECT d.*, ct.name AS country_name, ct.demonym
         FROM drivers d LEFT JOIN countries ct ON ct.id = d.country_id
        WHERE d.id = ?`,
    )
    .get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });

  const stats =
    db.prepare('SELECT * FROM driver_statistics WHERE driver_id = ?').get(driver.id) || null;
  const featured = featuredFor(driver.id);

  const seasons = db
    .prepare(
      'SELECT * FROM driver_seasons WHERE driver_id = ? ORDER BY season',
    )
    .all(driver.id)
    .map((s) => {
      const constructorIds = parseJson(s.constructor_ids, []);
      const constructors = constructorIds.length
        ? db
            .prepare(
              `SELECT id, name FROM constructors WHERE id IN (${constructorIds
                .map(() => '?')
                .join(',')})`,
            )
            .all(...constructorIds)
        : [];
      const teammateIds = parseJson(s.teammate_ids, []);
      const teammates = teammateIds.length
        ? db
            .prepare(
              `SELECT id, name FROM drivers WHERE id IN (${teammateIds.map(() => '?').join(',')})`,
            )
            .all(...teammateIds)
        : [];
      return {
        season: s.season,
        championshipPosition: s.championship_position,
        points: s.points,
        wins: s.wins,
        numbers: parseJson(s.numbers, []),
        chassis: parseJson(s.chassis, []),
        constructors,
        teammateIds,
        teammates,
        constructorIds,
      };
    });

  const constructorIds = [...new Set(seasons.flatMap((s) => s.constructorIds))];
  const numberTimeline = seasons
    .filter((s) => s.numbers.length)
    .map((s) => ({ season: s.season, numbers: s.numbers }));

  const championships = parseJson(stats && stats.championship_years, []);

  const eraKeys = parseJson(driver.eras, []);
  const eras = ERAS.filter(
    (e) => eraKeys.includes(e.key) || (driver.last_season >= e.from && driver.first_season <= e.to),
  ).map((e) => ({ key: e.key, label: e.label, title: e.title }));

  let availability = null;
  if (req.user && req.user.role === 'student') {
    const membership = classMembership(req.user.id);
    const year = currentYear();
    if (membership && year) {
      const taken = takenInClass(membership.class_id, year.id);
      const holder = taken.get(driver.id);
      availability = {
        available: !holder || holder === req.user.id,
        selectedByMe: holder === req.user.id,
      };
    }
  }

  res.json({
    id: driver.id,
    identity: {
      name: driver.name,
      fullName: driver.full_name || driver.name,
      firstName: driver.first_name,
      lastName: driver.last_name,
      abbreviation: driver.abbreviation,
      nationality: driver.demonym || driver.country_name || null,
      country: driver.country_name || null,
      dateOfBirth: driver.date_of_birth,
      dateOfDeath: driver.date_of_death,
      placeOfBirth: driver.place_of_birth,
      firstSeason: driver.first_season,
      lastSeason: driver.last_season,
      eras,
      permanentNumber: driver.permanent_number,
    },
    featuredIdentity: featured
      ? {
          name: featured.display_name,
          number: featured.featured_number,
          team: featured.featured_team,
          nickname: featured.nickname,
          position: featured.position,
        }
      : null,
    historicalRecord: {
      seasons,
      numbers: numberTimeline,
      constructors: constructorIds.length
        ? db
            .prepare(
              `SELECT id, name FROM constructors WHERE id IN (${constructorIds
                .map(() => '?')
                .join(',')}) ORDER BY name`,
            )
            .all(...constructorIds)
        : [],
    },
    statistics: stats
      ? {
          entries: stats.entries,
          starts: stats.starts,
          wins: stats.wins,
          podiums: stats.podiums,
          poles: stats.poles,
          fastestLaps: stats.fastest_laps,
          careerPoints: stats.career_points,
          titles: stats.titles,
          bestPosition: stats.best_position,
          championshipYears: championships,
        }
      : null,
    images: imagePayload(driver.id),
    availability,
  });
});

// ───────────────────────── student driver selection ─────────────────────
router.get('/selection', requireRole('student'), (req, res) => {
  const mine = selectionFor(req.user.id);
  if (!mine) return res.json({ selection: null });
  const driver = db
    .prepare(
      `SELECT d.id, d.name, f.featured_number, f.featured_team, f.nickname
         FROM drivers d LEFT JOIN featured_drivers f ON f.driver_id = d.id
        WHERE d.id = ?`,
    )
    .get(mine.driver_id);
  res.json({
    selection: {
      driverId: mine.driver_id,
      classId: mine.class_id,
      className: mine.class_name,
      formLevel: mine.form_level,
      since: mine.created_at,
      driver,
      image: imagePayload(mine.driver_id).primary,
    },
  });
});

/**
 * Select or switch a driver.
 *
 * The whole operation is one transaction: release the student's previous active
 * selection, then insert the new one. If the insert fails (the driver was taken
 * between the check and the write) the transaction rolls back, so the student
 * keeps the driver they had. The partial unique index on
 * (class_id, driver_id, academic_year_id) WHERE active = 1 is the real guard.
 */
router.post('/selection', requireRole('student'), (req, res) => {
  const driverId = String((req.body || {}).driverId || '').trim();
  if (!driverId) return res.status(400).json({ error: 'Choose a driver.' });

  const membership = classMembership(req.user.id);
  if (!membership) {
    return res.status(409).json({ error: 'Join a class before selecting a driver.' });
  }
  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No active academic year.' });

  const driver = db.prepare('SELECT id, name FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });

  const current = selectionFor(req.user.id);
  if (current && current.driver_id === driverId) {
    return res.json({ message: 'You already have this driver.', driverId });
  }

  try {
    const result = db.transaction(() => {
      const holder = db
        .prepare(
          `SELECT student_user_id FROM student_driver_selections
            WHERE class_id = ? AND driver_id = ? AND academic_year_id = ? AND active = 1`,
        )
        .get(membership.class_id, driverId, year.id);
      if (holder && holder.student_user_id !== req.user.id) {
        const err = new Error('That driver has already been selected in your class.');
        err.status = 409;
        throw err;
      }

      db.prepare(
        `UPDATE student_driver_selections
            SET active = 0, released_at = ?
          WHERE student_user_id = ? AND academic_year_id = ? AND active = 1`,
      ).run(nowTs(), req.user.id, year.id);

      db.prepare(
        `INSERT INTO student_driver_selections
           (student_user_id, class_id, driver_id, academic_year_id, active)
         VALUES (?, ?, ?, ?, 1)`,
      ).run(req.user.id, membership.class_id, driverId, year.id);

      return { driverId, releasedDriverId: current ? current.driver_id : null };
    })();

    return res.status(201).json({
      message: `You selected ${driver.name}.`,
      ...result,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res
        .status(409)
        .json({ error: 'That driver was just selected by another student in your class.' });
    }
    return res.status(500).json({ error: 'The driver could not be selected.' });
  }
});

router.delete('/selection', requireRole('student'), (req, res) => {
  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No active academic year.' });
  const info = db
    .prepare(
      `UPDATE student_driver_selections SET active = 0, released_at = ?
        WHERE student_user_id = ? AND academic_year_id = ? AND active = 1`,
    )
    .run(nowTs(), req.user.id, year.id);
  if (!info.changes) return res.json({ message: 'You had no active driver.', released: null });
  res.json({ message: 'Driver released.', released: info.changes });
});

/** Who holds which driver in my class — published so the UI can show availability. */
router.get('/class-selections', requireRole('student'), (req, res) => {
  const membership = classMembership(req.user.id);
  const year = currentYear();
  if (!membership || !year) return res.json({ drivers: [] });
  const rows = db
    .prepare(
      `SELECT sel.driver_id, sel.student_user_id,
              COALESCE(sp.display_name, 'Student') AS student_name
         FROM student_driver_selections sel
    LEFT JOIN student_profiles sp ON sp.user_id = sel.student_user_id
        WHERE sel.class_id = ? AND sel.academic_year_id = ? AND sel.active = 1
        ORDER BY sel.created_at`,
    )
    .all(membership.class_id, year.id);
  res.json({
    classId: membership.class_id,
    drivers: rows.map((r) => ({
      driverId: r.driver_id,
      mine: r.student_user_id === req.user.id,
      studentId: r.student_user_id,
      studentName: r.student_name,
    })),
  });
});

// ──────────────────────────────── garage ────────────────────────────────
const WINGS = ['standard', 'high-downforce', 'low-drag', 'monaco'];
const RIMS = ['gold', 'black', 'silver', 'bronze'];
const PLACEMENTS = ['sidepod', 'nose', 'rear-wing', 'halo'];

function garageFor(studentUserId) {
  const row = db.prepare('SELECT * FROM car_customisations WHERE student_user_id = ?').get(studentUserId);
  return (
    row || {
      student_user_id: studentUserId,
      primary_color: '#101010',
      accent_color: '#D6C19A',
      front_wing: 'standard',
      rear_wing: 'standard',
      rims: 'gold',
      sponsor_text: null,
      sponsor_placement: 'sidepod',
      updated_at: null,
    }
  );
}

router.get('/garage', requireRole('student'), (req, res) => {
  const car = garageFor(req.user.id);
  const mine = selectionFor(req.user.id);
  const driver = mine
    ? db
        .prepare(
          `SELECT d.id, d.name, f.featured_number, f.featured_team, f.nickname
             FROM drivers d LEFT JOIN featured_drivers f ON f.driver_id = d.id
            WHERE d.id = ?`,
        )
        .get(mine.driver_id)
    : null;
  const presets = db
    .prepare('SELECT * FROM car_presets WHERE student_user_id = ? ORDER BY created_at DESC')
    .all(req.user.id)
    .map((p) => ({ id: p.id, name: p.name, config: parseJson(p.config, {}), createdAt: p.created_at }));

  res.json({
    car: {
      primaryColor: car.primary_color,
      accentColor: car.accent_color,
      frontWing: car.front_wing,
      rearWing: car.rear_wing,
      rims: car.rims,
      sponsorText: car.sponsor_text,
      sponsorPlacement: car.sponsor_placement,
      updatedAt: car.updated_at,
    },
    options: { wings: WINGS, rims: RIMS, placements: PLACEMENTS },
    driver: driver
      ? { ...driver, image: imagePayload(driver.id).primary }
      : null,
    presets,
  });
});

router.patch('/garage', requireRole('student'), (req, res) => {
  const body = req.body || {};
  const colour = (v, fallback) =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

  const current = garageFor(req.user.id);
  const next = {
    primary: colour(body.primaryColor, current.primary_color),
    accent: colour(body.accentColor, current.accent_color),
    front: pick(body.frontWing, WINGS, current.front_wing),
    rear: pick(body.rearWing, WINGS, current.rear_wing),
    rims: pick(body.rims, RIMS, current.rims),
    sponsor:
      body.sponsorText == null
        ? current.sponsor_text
        : String(body.sponsorText).trim().slice(0, 24) || null,
    placement: pick(body.sponsorPlacement, PLACEMENTS, current.sponsor_placement),
  };

  db.prepare(
    `INSERT INTO car_customisations
       (student_user_id, primary_color, accent_color, front_wing, rear_wing, rims,
        sponsor_text, sponsor_placement, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_user_id) DO UPDATE SET
       primary_color = excluded.primary_color,
       accent_color = excluded.accent_color,
       front_wing = excluded.front_wing,
       rear_wing = excluded.rear_wing,
       rims = excluded.rims,
       sponsor_text = excluded.sponsor_text,
       sponsor_placement = excluded.sponsor_placement,
       updated_at = excluded.updated_at`,
  ).run(
    req.user.id,
    next.primary,
    next.accent,
    next.front,
    next.rear,
    next.rims,
    next.sponsor,
    next.placement,
    nowTs(),
  );

  res.json({ message: 'Garage saved.', car: next });
});

router.post('/garage/presets', requireRole('student'), (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give the preset a name.' });
  const car = garageFor(req.user.id);
  const config = {
    primaryColor: car.primary_color,
    accentColor: car.accent_color,
    frontWing: car.front_wing,
    rearWing: car.rear_wing,
    rims: car.rims,
    sponsorText: car.sponsor_text,
    sponsorPlacement: car.sponsor_placement,
  };
  try {
    db.prepare('INSERT INTO car_presets (student_user_id, name, config) VALUES (?, ?, ?)').run(
      req.user.id,
      name,
      JSON.stringify(config),
    );
    res.status(201).json({ message: 'Preset saved.', name, config });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'You already have a preset with that name.' });
    }
    res.status(500).json({ error: 'The preset could not be saved.' });
  }
});

router.delete('/garage/presets/:id', requireRole('student'), (req, res) => {
  const info = db
    .prepare('DELETE FROM car_presets WHERE id = ? AND student_user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Preset not found.' });
  res.json({ message: 'Preset deleted.' });
});

// ──────────────────────── F1 Knowledge Championship ─────────────────────
router.get('/quiz', requireRole('student'), (req, res) => {
  const era = String(req.query.era || '').trim();
  const rows = era
    ? db.prepare('SELECT * FROM quiz_questions WHERE era = ? ORDER BY id').all(era)
    : db.prepare('SELECT * FROM quiz_questions ORDER BY id').all();

  const eras = db
    .prepare('SELECT era, COUNT(*) AS n FROM quiz_questions GROUP BY era ORDER BY era')
    .all();

  res.json({
    eras,
    questions: rows.map((q) => ({
      id: q.id,
      era: q.era,
      topic: q.topic,
      question: q.question,
      options: parseJson(q.options, []),
      points: q.points,
      // Never send correct_index: the answer is graded on the server.
    })),
  });
});

router.post('/quiz/attempt', requireRole('student'), (req, res) => {
  const body = req.body || {};
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers were submitted.' });

  const membership = classMembership(req.user.id);
  if (!membership) {
    return res.status(409).json({ error: 'Join a class before entering the championship.' });
  }

  const mine = selectionFor(req.user.id);
  const driverId = mine ? mine.driver_id : null;
  const driver = driverId
    ? db
        .prepare(
          `SELECT d.id, d.name, f.featured_number, f.featured_team, f.nickname
             FROM drivers d LEFT JOIN featured_drivers f ON f.driver_id = d.id
            WHERE d.id = ?`,
        )
        .get(driverId)
    : null;

  let score = 0;
  let points = 0;
  let total = 0;
  const graded = [];
  let era = null;

  const insert = db.prepare(
    `INSERT INTO quiz_attempts
       (student_user_id, class_id, driver_id, driver_snapshot, era, score, total, points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const record = db.transaction(() => {
    for (const answer of answers) {
      const q = db.prepare('SELECT * FROM quiz_questions WHERE id = ?').get(Number(answer.id));
      if (!q) continue;
      if (!era) era = q.era;
      total += 1;
      const correct = Number(answer.answer) === q.correct_index;
      if (correct) {
        score += 1;
        points += q.points;
      }
      graded.push({ id: q.id, correct, correctIndex: q.correct_index });
    }
    insert.run(
      req.user.id,
      membership.class_id,
      driverId,
      JSON.stringify(driver || null),
      era,
      score,
      total,
      points,
    );
    return { score, total, points };
  })();

  res.status(201).json({
    message: `You scored ${record.score} out of ${record.total}.`,
    ...record,
    graded,
    driver: driver || null,
  });
});

router.get('/championship', requireRole('student'), (req, res) => {
  const membership = classMembership(req.user.id);
  const year = currentYear();
  if (!membership || !year) return res.json({ standings: [], myPosition: null });

  const rows = db
    .prepare(
      `SELECT a.student_user_id,
              COALESCE(sp.display_name, 'Student') AS student_name,
              SUM(a.points) AS points,
              COUNT(*) AS attempts,
              MAX(a.completed_at) AS last_at
         FROM quiz_attempts a
    LEFT JOIN student_profiles sp ON sp.user_id = a.student_user_id
        WHERE a.class_id = ?
        GROUP BY a.student_user_id
        ORDER BY points DESC, attempts ASC, last_at ASC`,
    )
    .all(membership.class_id);

  const standings = rows.map((row, idx) => ({
    position: idx + 1,
    studentId: row.student_user_id,
    studentName: row.student_name,
    points: row.points,
    attempts: row.attempts,
    mine: row.student_user_id === req.user.id,
  }));

  const mine = standings.find((s) => s.mine) || null;
  res.json({
    className: membership.name,
    standings,
    myPosition: mine ? mine.position : null,
    myPoints: mine ? mine.points : 0,
  });
});

router.get('/my-attempts', requireRole('student'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM quiz_attempts WHERE student_user_id = ? ORDER BY completed_at DESC LIMIT 50`,
    )
    .all(req.user.id);
  res.json({
    attempts: rows.map((a) => ({
      id: a.id,
      era: a.era,
      score: a.score,
      total: a.total,
      points: a.points,
      completedAt: a.completed_at,
      driver: parseJson(a.driver_snapshot, null),
    })),
  });
});

router.get('/import-log', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM import_log ORDER BY run_at DESC LIMIT 20').all();
  res.json({
    runs: rows.map((r) => ({
      id: r.id,
      runAt: r.run_at,
      source: r.source,
      counts: parseJson(r.counts, {}),
      warnings: parseJson(r.warnings, []),
    })),
  });
});

module.exports = { router, ERAS, SORTS };
