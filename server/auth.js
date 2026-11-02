'use strict';
/**
 * WORKLY — authentication, sessions and server-side authorisation.
 *
 * Security rules implemented here:
 *   - passwords hashed with scrypt + per-user salt, compared in constant time
 *   - opaque session tokens; only their HMAC is stored, delivered via an
 *     httpOnly SameSite cookie
 *   - the active role is *derived from user_roles on every request*, never from
 *     the client, so a role switch can never grant a privilege the account lacks
 *   - no administrator approval step anywhere
 */
const crypto = require('node:crypto');
const express = require('express');
const {
  db,
  nowTs,
  addDays,
  ts,
  hashPassword,
  verifyPassword,
  hashCode,
} = require('./db');

const SESSION_TTL_DAYS = 30;
const COOKIE = 'workly_session';

// ─────────────────────────── session plumbing ───────────────────────────
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = addDays(new Date(), SESSION_TTL_DAYS);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashCode(token), userId, ts(expires));
  return { token, expiresAt: ts(expires) };
}

function sessionTokenFrom(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      SESSION_TTL_DAYS * 86400
    }${secure}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashCode(token));
}

/** Resolve the request's user from the cookie, refreshing active_role from DB. */
function attachUser(req, res, next) {
  req.user = null;
  const token = sessionTokenFrom(req);
  if (!token) return next();

  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.email, u.active_role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashCode(token));

  if (!row) return next();
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return next();
  }

  const roles = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(row.id)
    .map((r) => r.role);

  // A stored active_role the account no longer holds must not be honoured.
  const activeRole = roles.includes(row.active_role) ? row.active_role : roles[0];
  if (activeRole && activeRole !== row.active_role) {
    db.prepare('UPDATE users SET active_role = ?, updated_at = ? WHERE id = ?').run(
      activeRole,
      nowTs(),
      row.id,
    );
  }

  req.user = { id: row.id, email: row.email, roles, role: activeRole || null };
  req.sessionToken = token;
  next();
}

/** Require any authenticated account with a resolved role. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!req.user.role) {
    return res.status(403).json({ error: 'This account has no active role.' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (req.user.role !== role) {
      return res
        .status(403)
        .json({ error: `This action requires a ${role} account.` });
    }
    next();
  };
}

// ─────────────────────────────── profile ────────────────────────────────
function profileFor(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const roles = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(userId)
    .map((r) => r.role);
  const student = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(userId);
  const teacher = db.prepare('SELECT * FROM teacher_profiles WHERE user_id = ?').get(userId);
  return {
    id: user.id,
    email: user.email,
    role: user.active_role,
    roles,
    student: student || null,
    teacher: teacher || null,
    createdAt: user.created_at,
  };
}

function currentYear() {
  return db.prepare('SELECT * FROM academic_years WHERE is_current = 1').get();
}

function classMembership(studentUserId) {
  const year = currentYear();
  if (!year) return null;
  return (
    db
      .prepare(
        `SELECT m.id, m.joined_at, c.id AS class_id, c.name, c.form_level
           FROM class_memberships m JOIN classes c ON c.id = m.class_id
          WHERE m.student_user_id = ? AND m.academic_year_id = ? AND m.status = 'active'`,
      )
      .get(studentUserId, year.id) || null
  );
}

// ──────────────────────────────── router ────────────────────────────────
const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/register', (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = String(body.role || '').trim();
  const heardFrom = String(body.heardFrom || '').trim();
  const displayName = String(body.displayName || '').trim();
  const formLevel = body.formLevel != null ? Number(body.formLevel) : null;
  const classId = body.classId != null ? Number(body.classId) : null;
  const teacherType = body.teacherType === 'class' ? 'class' : 'ordinary';

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!['student', 'teacher'].includes(role)) {
    return res.status(400).json({ error: 'Choose the Student or Teacher role.' });
  }
  if (!displayName) {
    return res.status(400).json({ error: 'Enter your full name.' });
  }
  if (role === 'student' && !(formLevel >= 1 && formLevel <= 5)) {
    return res.status(400).json({ error: 'Choose your current form (Tingkatan 1–5).' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  try {
    const created = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO users (email, password_hash, active_role, source)
           VALUES (?, ?, ?, ?)`,
        )
        .run(email, hashPassword(password), role, heardFrom || null);
      const userId = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(userId, role);

      if (role === 'student') {
        db.prepare(
          'INSERT INTO student_profiles (user_id, display_name, form_level) VALUES (?, ?, ?)',
        ).run(userId, displayName, formLevel);

        // Enrol into the chosen class (or the first class of that form).
        const year = currentYear();
        if (year) {
          const cls =
            (classId &&
              db
                .prepare('SELECT * FROM classes WHERE id = ? AND form_level = ?')
                .get(classId, formLevel)) ||
            db
              .prepare('SELECT * FROM classes WHERE form_level = ? ORDER BY display_order LIMIT 1')
              .get(formLevel);
          if (cls) {
            db.prepare(
              `INSERT INTO class_memberships (student_user_id, class_id, academic_year_id, status)
               VALUES (?, ?, ?, 'active')`,
            ).run(userId, cls.id, year.id);
          }
        }
      } else {
        db.prepare(
          'INSERT INTO teacher_profiles (user_id, display_name, teacher_type) VALUES (?, ?, ?)',
        ).run(userId, displayName, teacherType);
      }
      return userId;
    })();

    const session = createSession(created);
    setSessionCookie(res, session.token);
    res.status(201).json({
      message: 'Registration complete.',
      profile: profileFor(created),
      membership: role === 'student' ? classMembership(created) : null,
      redirectTo: role === 'student' ? '/student/dashboard' : '/teacher/dashboard',
    });
  } catch (err) {
    res.status(500).json({ error: 'Registration could not be completed. Please try again.' });
  }
});

router.post('/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    // Same message for unknown email and wrong password.
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  const profile = profileFor(user.id);
  res.json({
    message: 'Signed in.',
    profile,
    membership: profile.role === 'student' ? classMembership(user.id) : null,
    redirectTo: profile.role === 'student' ? '/student/dashboard' : '/teacher/dashboard',
  });
});

router.post('/logout', (req, res) => {
  destroySession(sessionTokenFrom(req));
  clearSessionCookie(res);
  res.json({ message: 'Signed out.' });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  const profile = profileFor(req.user.id);
  res.json({
    profile,
    membership: profile.role === 'student' ? classMembership(req.user.id) : null,
    unreadNotifications: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id).n,
  });
});

/**
 * Switch the active role. The account must already hold the requested role —
 * a switch never creates a role, so it cannot grant new privileges.
 */
router.post('/role', requireAuth, (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!['student', 'teacher'].includes(role)) {
    return res.status(400).json({ error: 'Unknown role.' });
  }
  const holds = db
    .prepare('SELECT 1 AS ok FROM user_roles WHERE user_id = ? AND role = ?')
    .get(req.user.id, role);
  if (!holds) {
    return res
      .status(403)
      .json({ error: 'Your account does not hold that role. Contact your teacher.' });
  }
  db.prepare('UPDATE users SET active_role = ?, updated_at = ? WHERE id = ?').run(role, nowTs(), req.user.id);
  res.json({
    message: `Switched to ${role}.`,
    profile: profileFor(req.user.id),
    redirectTo: role === 'student' ? '/student/dashboard' : '/teacher/dashboard',
  });
});

router.patch('/profile', requireAuth, (req, res) => {
  const body = req.body || {};
  const displayName = String(body.displayName || '').trim();
  if (req.user.role === 'student') {
    const current = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
    if (!current) return res.status(404).json({ error: 'Student profile missing.' });
    const formLevel = body.formLevel != null ? Number(body.formLevel) : current.form_level;
    if (!(formLevel >= 1 && formLevel <= 5)) {
      return res.status(400).json({ error: 'Form must be between 1 and 5.' });
    }
    db.prepare('UPDATE student_profiles SET display_name = ?, form_level = ? WHERE user_id = ?').run(
      displayName || current.display_name,
      formLevel,
      req.user.id,
    );
  } else {
    const current = db.prepare('SELECT * FROM teacher_profiles WHERE user_id = ?').get(req.user.id);
    if (!current) return res.status(404).json({ error: 'Teacher profile missing.' });
    db.prepare('UPDATE teacher_profiles SET display_name = ? WHERE user_id = ?').run(
      displayName || current.display_name,
      req.user.id,
    );
  }
  res.json({ message: 'Profile updated.', profile: profileFor(req.user.id) });
});

/**
 * Password recovery foundation. No mail provider is configured, so this never
 * pretends a message was delivered: it records a request and reports that the
 * delivery channel still needs to be configured.
 */
router.post('/password/reset-request', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare(
      `INSERT INTO notifications (user_id, kind, title, body)
       VALUES (?, 'password_reset', 'Password reset requested', ?)`,
    ).run(
      user.id,
      'A password reset was requested for this account. Ask your school WORKLY coordinator to apply it — automatic email delivery is not configured.',
    );
    void token; // no delivery channel configured; nothing is emailed
  }
  res.json({
    message:
      'If that email has an account, a reset request has been recorded. Automatic email delivery is not configured yet.',
    emailDeliveryConfigured: false,
  });
});

module.exports = {
  router,
  attachUser,
  requireAuth,
  requireRole,
  profileFor,
  classMembership,
  currentYear,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  destroySession,
  sessionTokenFrom,
  COOKIE,
};
