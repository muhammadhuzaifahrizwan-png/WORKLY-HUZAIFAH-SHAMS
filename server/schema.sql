-- WORKLY — academic management platform schema (SQLite)
-- All identifiers are declared explicitly so migrations never rely on implicit state.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────── accounts & auth ────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active_role   TEXT NOT NULL CHECK (active_role IN ('student','teacher')),
  source        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('student','teacher')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  form_level   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  teacher_type TEXT NOT NULL DEFAULT 'ordinary' CHECK (teacher_type IN ('ordinary','class')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────── school structure ───────────────────────────
CREATE TABLE IF NOT EXISTS academic_years (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  year      INTEGER NOT NULL UNIQUE,
  starts_on TEXT NOT NULL,
  ends_on   TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_year_current ON academic_years(is_current) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS classes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  form_level   INTEGER NOT NULL CHECK (form_level BETWEEN 1 AND 5),
  name         TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  UNIQUE (form_level, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'KSSM'
);

CREATE TABLE IF NOT EXISTS class_subjects (
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS class_memberships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  left_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_active
  ON class_memberships(class_id, student_user_id, academic_year_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_membership_student ON class_memberships(student_user_id, status);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_assignment_unique
  ON teacher_assignments(teacher_user_id, class_id, subject_id, academic_year_id);
CREATE INDEX IF NOT EXISTS idx_teacher_assignment_teacher ON teacher_assignments(teacher_user_id);

CREATE TABLE IF NOT EXISTS class_teacher_roles (
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, teacher_user_id, academic_year_id)
);

-- ─────────────────────────── assignments ────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  instructions    TEXT,
  marking_criteria TEXT,
  accepted_formats TEXT NOT NULL DEFAULT 'pdf,jpg,jpeg,png',
  allow_video     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),
  published_at    TEXT,
  deadline_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_user_id, status);

CREATE TABLE IF NOT EXISTS assignment_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT,
  attempt        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('submitted','approved','rejected','completed')),
  timing         TEXT CHECK (timing IN ('early','on_time','late')),
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at    TEXT,
  rejected_at    TEXT,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_user_id, status);

CREATE TABLE IF NOT EXISTS submission_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teacher_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision      TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  feedback      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submission_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  actor_user_id INTEGER,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────── verification codes ─────────────────────────────
CREATE TABLE IF NOT EXISTS verification_codes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash      TEXT NOT NULL UNIQUE,
  code_sealed    TEXT NOT NULL,          -- AES-256-GCM sealed copy, revealed only to the owning student
  code_hint      TEXT NOT NULL,          -- last 4 characters, for support display
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  revoked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_codes_student ON verification_codes(student_user_id, used_at);
CREATE INDEX IF NOT EXISTS idx_codes_assignment ON verification_codes(assignment_id);

-- ─────────────────────────── notifications ──────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,
  assignment_id INTEGER,
  submission_id INTEGER,
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);

-- ─────────────────────── academic marks / learning ──────────────────────
CREATE TABLE IF NOT EXISTS academic_marks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  assessment     TEXT NOT NULL,
  score          REAL NOT NULL,
  max_score      REAL NOT NULL CHECK (max_score > 0),
  recorded_by    INTEGER REFERENCES users(id),
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marks_student ON academic_marks(student_user_id, subject_id);

CREATE TABLE IF NOT EXISTS notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id     INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_student ON notes(student_user_id, updated_at);

CREATE TABLE IF NOT EXISTS study_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id     INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  scheduled_for  TEXT NOT NULL,
  duration_min   INTEGER NOT NULL DEFAULT 60,
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','missed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_student ON study_plans(student_user_id, scheduled_for);

CREATE TABLE IF NOT EXISTS revision_topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  form_level INTEGER NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  questions  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_topics_subject ON revision_topics(subject_id, form_level);

CREATE TABLE IF NOT EXISTS revision_progress (
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id       INTEGER NOT NULL REFERENCES revision_topics(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','revised')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_user_id, topic_id)
);

CREATE TABLE IF NOT EXISTS portfolio_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('certificate','achievement','milestone','project')),
  title          TEXT NOT NULL,
  description    TEXT,
  achieved_on    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portfolio_student ON portfolio_items(student_user_id);

-- ───────────────────── Formula One driver database ──────────────────────
CREATE TABLE IF NOT EXISTS countries (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  demonym TEXT
);

CREATE TABLE IF NOT EXISTS constructors (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  full_name  TEXT,
  country_id TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  full_name        TEXT,
  first_name       TEXT,
  last_name        TEXT,
  abbreviation     TEXT,
  permanent_number TEXT,
  gender           TEXT,
  date_of_birth    TEXT,
  date_of_death    TEXT,
  place_of_birth   TEXT,
  country_id       TEXT REFERENCES countries(id),
  first_season     INTEGER,
  last_season      INTEGER,
  eras             TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_drivers_name ON drivers(name);
CREATE INDEX IF NOT EXISTS idx_drivers_last ON drivers(last_season);

CREATE TABLE IF NOT EXISTS driver_seasons (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id             TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  season                INTEGER NOT NULL,
  championship_position INTEGER,
  points                REAL NOT NULL DEFAULT 0,
  wins                  INTEGER NOT NULL DEFAULT 0,
  constructor_ids       TEXT NOT NULL DEFAULT '[]',
  numbers               TEXT NOT NULL DEFAULT '[]',
  chassis               TEXT NOT NULL DEFAULT '[]',
  teammate_ids          TEXT NOT NULL DEFAULT '[]',
  UNIQUE (driver_id, season)
);
CREATE INDEX IF NOT EXISTS idx_seasons_driver ON driver_seasons(driver_id, season);

CREATE TABLE IF NOT EXISTS driver_statistics (
  driver_id        TEXT PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  entries          INTEGER NOT NULL DEFAULT 0,
  starts           INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  podiums          INTEGER NOT NULL DEFAULT 0,
  poles            INTEGER NOT NULL DEFAULT 0,
  fastest_laps     INTEGER NOT NULL DEFAULT 0,
  career_points    REAL NOT NULL DEFAULT 0,
  titles           INTEGER NOT NULL DEFAULT 0,
  best_position    INTEGER,
  championship_years TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_stats_wins ON driver_statistics(wins);
CREATE INDEX IF NOT EXISTS idx_stats_titles ON driver_statistics(titles);

CREATE TABLE IF NOT EXISTS featured_drivers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id       TEXT NOT NULL UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  featured_number TEXT NOT NULL,
  featured_team   TEXT NOT NULL,
  nickname        TEXT NOT NULL,
  position        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_images (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id      TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  source_page_url TEXT,
  image_url      TEXT NOT NULL,
  thumb_url      TEXT,
  license_name   TEXT,
  license_url    TEXT,
  photographer   TEXT,
  attribution    TEXT,
  verified       INTEGER NOT NULL DEFAULT 0,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (driver_id, image_url)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_portrait
  ON driver_images(driver_id) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS student_driver_selections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id       INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  driver_id      TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  released_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_driver
  ON student_driver_selections(class_id, driver_id, academic_year_id) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_student
  ON student_driver_selections(class_id, student_user_id, academic_year_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_selection_lookup ON student_driver_selections(class_id, active);

CREATE TABLE IF NOT EXISTS car_customisations (
  student_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  primary_color   TEXT NOT NULL DEFAULT '#101010',
  accent_color    TEXT NOT NULL DEFAULT '#D6C19A',
  front_wing      TEXT NOT NULL DEFAULT 'standard',
  rear_wing       TEXT NOT NULL DEFAULT 'standard',
  rims            TEXT NOT NULL DEFAULT 'gold',
  sponsor_text    TEXT,
  sponsor_placement TEXT NOT NULL DEFAULT 'sidepod',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS car_presets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  config         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_user_id, name)
);

-- ─────────────────── F1 Knowledge Championship (quiz) ───────────────────
CREATE TABLE IF NOT EXISTS quiz_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  era           TEXT NOT NULL,
  topic         TEXT NOT NULL,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL,
  correct_index INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  points        INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id       INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  driver_id      TEXT REFERENCES drivers(id),
  driver_snapshot TEXT NOT NULL,
  era            TEXT,
  score          INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  points         INTEGER NOT NULL,
  completed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_class ON quiz_attempts(class_id, points);

CREATE TABLE IF NOT EXISTS import_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at     TEXT NOT NULL DEFAULT (datetime('now')),
  source     TEXT NOT NULL,
  counts     TEXT NOT NULL,
  warnings   TEXT NOT NULL DEFAULT '[]'
);
