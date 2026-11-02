'use strict';
/**
 * WORKLY — academic API.
 *
 * Every state transition in the assignment lifecycle is produced by a real
 * backend event, never by a client-supplied status. Verification codes exist
 * only after a teacher approval, are valid for exactly seven days and can be
 * used once.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const {
  db,
  nowTs,
  addDays,
  ts,
  hashCode,
  sealCode,
  unsealCode,
  UPLOAD_DIR,
} = require('./db');
const { requireAuth, requireRole, currentYear, classMembership } = require('./auth');

const router = express.Router();

// Official strings from the specification — never reworded.
const MESSAGES = {
  submitted: 'Your teacher will check this work and you will receive a code.',
  codeWarning:
    'WARNING: This verification code is valid for 7 days only. Please enter and submit your code before it expires.',
  emptyDashboard: 'Breath for a while Exam is Dunya the real Exam is Akhirat.',
};

const CODE_TTL_DAYS = 7;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 5;

const DEFAULT_FORMATS = ['pdf', 'jpg', 'jpeg', 'png'];
const VIDEO_FORMATS = ['mp4', 'mov', 'webm'];

// ─────────────────────────────── helpers ────────────────────────────────
function notify(userId, { kind, title, body, link, assignmentId, submissionId }) {
  db.prepare(
    `INSERT INTO notifications (user_id, kind, title, body, link, assignment_id, submission_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    userId,
    kind,
    title,
    body || null,
    link || null,
    assignmentId || null,
    submissionId || null,
  );
}

function audit(submissionId, event, actorUserId, detail) {
  db.prepare(
    'INSERT INTO submission_events (submission_id, event, actor_user_id, detail) VALUES (?,?,?,?)',
  ).run(submissionId, event, actorUserId || null, detail || null);
}

function teacherTypeOf(userId) {
  const row = db.prepare('SELECT teacher_type FROM teacher_profiles WHERE user_id = ?').get(userId);
  return row ? row.teacher_type : null;
}

function isClassTeacherOf(userId, classId, yearId) {
  return !!db
    .prepare(
      'SELECT 1 AS ok FROM class_teacher_roles WHERE teacher_user_id = ? AND class_id = ? AND academic_year_id = ?',
    )
    .get(userId, classId, yearId);
}

function teachesClassSubject(userId, classId, subjectId, yearId) {
  return !!db
    .prepare(
      `SELECT 1 AS ok FROM teacher_assignments
        WHERE teacher_user_id = ? AND class_id = ? AND subject_id = ? AND academic_year_id = ?`,
    )
    .get(userId, classId, subjectId, yearId);
}

/** A teacher may act on an assignment when it is theirs, or it belongs to a class they lead. */
function teacherCanAccessAssignment(userId, assignment) {
  if (assignment.teacher_user_id === userId) return true;
  if (isClassTeacherOf(userId, assignment.class_id, assignment.academic_year_id)) return true;
  return teachesClassSubject(
    userId,
    assignment.class_id,
    assignment.subject_id,
    assignment.academic_year_id,
  );
}

function studentIsInClass(studentId, classId, yearId) {
  return !!db
    .prepare(
      `SELECT 1 AS ok FROM class_memberships
        WHERE student_user_id = ? AND class_id = ? AND academic_year_id = ? AND status = 'active'`,
    )
    .get(studentId, classId, yearId);
}

function activeCodeFor(submissionId) {
  return db
    .prepare('SELECT * FROM verification_codes WHERE submission_id = ? ORDER BY id DESC LIMIT 1')
    .get(submissionId);
}

function isExpired(expiresAt) {
  return new Date(String(expiresAt).replace(' ', 'T') + 'Z') <= new Date();
}

/**
 * Derive the student-facing lifecycle status from stored events.
 *
 * The specification lists nine statuses; "Submitted for Teacher Review" and
 * "Waiting for Teacher Review" describe the same backend state (`submitted`)
 * and are labelled per viewer — the teacher sees "Waiting for Teacher Review",
 * the student sees "Submitted for Teacher Review".
 */
function derivedStatus(assignment, submission) {
  if (assignment.status === 'draft') return 'draft';
  if (assignment.status === 'archived') return 'archived';
  if (!submission) return 'published';

  if (submission.status === 'completed') return 'completed';
  if (submission.status === 'rejected') return 'rejected';
  if (submission.status === 'approved') {
    const code = activeCodeFor(submission.id);
    if (!code) return 'approved';
    if (code.used_at) return 'completed';
    if (code.revoked_at) return 'rejected';
    if (isExpired(code.expires_at)) return 'code_expired';
    return 'awaiting_code';
  }
  return 'submitted';
}

const STATUS_LABELS = {
  draft: { student: 'Draft', teacher: 'Draft' },
  archived: { student: 'Archived', teacher: 'Archived' },
  published: { student: 'Published', teacher: 'Published' },
  submitted: {
    student: 'Submitted for Teacher Review',
    teacher: 'Waiting for Teacher Review',
  },
  rejected: { student: 'Rejected', teacher: 'Rejected' },
  approved: { student: 'Approved — Code Sent', teacher: 'Approved — Code Sent' },
  awaiting_code: { student: 'Awaiting Student Code', teacher: 'Awaiting Student Code' },
  code_expired: { student: 'Code Expired', teacher: 'Code Expired' },
  completed: { student: 'Submitted — Completed', teacher: 'Submitted — Completed' },
};

function labelsFor(status) {
  return STATUS_LABELS[status] || { student: status, teacher: status };
}

function assignmentRow(id) {
  return db
    .prepare(
      `SELECT a.*, s.name AS subject_name, s.code AS subject_code,
              c.name AS class_name, c.form_level
         FROM assignments a
         JOIN subjects s ON s.id = a.subject_id
         JOIN classes c ON c.id = a.class_id
        WHERE a.id = ?`,
    )
    .get(id);
}

function latestSubmission(assignmentId, studentId) {
  return db
    .prepare(
      'SELECT * FROM submissions WHERE assignment_id = ? AND student_user_id = ? ORDER BY attempt DESC, id DESC LIMIT 1',
    )
    .get(assignmentId, studentId);
}

function filesForSubmission(submissionId) {
  return db
    .prepare('SELECT id, original_name, mime_type, size_bytes, created_at FROM submission_files WHERE submission_id = ? ORDER BY id')
    .all(submissionId);
}

function attachmentsForAssignment(assignmentId) {
  return db
    .prepare('SELECT id, original_name, mime_type, size_bytes FROM assignment_attachments WHERE assignment_id = ? ORDER BY id')
    .all(assignmentId);
}

// ────────────────────────────── uploads ─────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_DIR, 'submissions');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.A-Za-z0-9]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const rejectUnsafe = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const allowed = [...DEFAULT_FORMATS, ...(req.allowedVideo ? VIDEO_FORMATS : [])];
  const mimeOk = /^(application\/pdf|image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/.test(
    file.mimetype,
  );
  if (!allowed.includes(ext) || !mimeOk) {
    return cb(new Error(`File type .${ext || '?'} is not accepted for this assignment.`));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: rejectUnsafe,
});

// ═════════════════════════════ SCHOOL STRUCTURE ════════════════════════
router.get('/school/structure', requireAuth, (req, res) => {
  const year = currentYear();
  res.json({
    academicYear: year || null,
    forms: [1, 2, 3, 4, 5],
    classNames: ['Ikram', 'Ikhlas', 'Ihsan', 'Islah', 'Irsyad'],
    classes: db
      .prepare('SELECT id, form_level, name, display_order FROM classes ORDER BY form_level, display_order')
      .all(),
    subjects: db.prepare('SELECT id, code, name, category FROM subjects ORDER BY id').all(),
  });
});

router.get('/school/classes/:id/subjects', requireAuth, (req, res) => {
  const classId = Number(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  const subjects = db
    .prepare(
      `SELECT s.id, s.code, s.name, s.category FROM class_subjects cs
         JOIN subjects s ON s.id = cs.subject_id WHERE cs.class_id = ? ORDER BY s.id`,
    )
    .all(classId);
  res.json({ class: cls, subjects });
});

// ═════════════════════════ TEACHER: TEACHING SETUP ═════════════════════
router.get('/teacher/teaching', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No current academic year is configured.' });
  const rows = db
    .prepare(
      `SELECT ta.id, ta.class_id, ta.subject_id, c.name AS class_name, c.form_level,
              s.name AS subject_name, s.code AS subject_code
         FROM teacher_assignments ta
         JOIN classes c ON c.id = ta.class_id
         JOIN subjects s ON s.id = ta.subject_id
        WHERE ta.teacher_user_id = ? AND ta.academic_year_id = ?
        ORDER BY c.form_level, c.display_order, s.id`,
    )
    .all(req.user.id, year.id);
  const classRoles = db
    .prepare(
      `SELECT ctr.class_id, c.name AS class_name, c.form_level
         FROM class_teacher_roles ctr JOIN classes c ON c.id = ctr.class_id
        WHERE ctr.teacher_user_id = ? AND ctr.academic_year_id = ?`,
    )
    .all(req.user.id, year.id);
  res.json({ academicYear: year, teaching: rows, classTeacherOf: classRoles });
});

router.post('/teacher/teaching', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No current academic year is configured.' });
  const classId = Number((req.body || {}).classId);
  const subjectId = Number((req.body || {}).subjectId);

  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!cls || !subject) return res.status(404).json({ error: 'Unknown class or subject.' });

  const offered = db
    .prepare('SELECT 1 AS ok FROM class_subjects WHERE class_id = ? AND subject_id = ?')
    .get(classId, subjectId);
  if (!offered) {
    return res
      .status(400)
      .json({ error: `${subject.name} is not offered in ${cls.name}. Add it to the class first.` });
  }

  db.prepare(
    `INSERT OR IGNORE INTO teacher_assignments (teacher_user_id, class_id, subject_id, academic_year_id)
     VALUES (?,?,?,?)`,
  ).run(req.user.id, classId, subjectId, year.id);
  res.status(201).json({ message: `Teaching ${subject.name} in ${cls.name}.` });
});

router.delete('/teacher/teaching/:id', requireRole('teacher'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM teacher_assignments WHERE id = ? AND teacher_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Teaching assignment not found.' });
  const inUse = db
    .prepare(
      `SELECT COUNT(*) AS n FROM assignments
        WHERE class_id = ? AND subject_id = ? AND academic_year_id = ? AND status = 'published'`,
    )
    .get(row.class_id, row.subject_id, row.academic_year_id).n;
  if (inUse > 0) {
    return res.status(409).json({
      error: 'This class and subject still has published assignments. Archive them before removing it.',
    });
  }
  db.prepare('DELETE FROM teacher_assignments WHERE id = ?').run(row.id);
  res.json({ message: 'Teaching assignment removed.' });
});

/** Teacher adds or removes a subject for a class they lead or teach. */
router.post('/teacher/class-subjects', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const classId = Number((req.body || {}).classId);
  const subjectId = Number((req.body || {}).subjectId);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  if (!isClassTeacherOf(req.user.id, classId, year?.id)) {
    return res.status(403).json({ error: 'Only the class teacher can change a class subject list.' });
  }
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) return res.status(404).json({ error: 'Subject not found.' });

  // The Irsyad rule: ASK replaces RBT for every form.
  if (cls.name === 'Irsyad' && subject.code === 'RBT') {
    return res.status(400).json({ error: 'Irsyad uses ASK instead of RBT for every form.' });
  }
  db.prepare('INSERT OR IGNORE INTO class_subjects (class_id, subject_id) VALUES (?,?)').run(
    classId,
    subjectId,
  );
  res.status(201).json({ message: `${subject.name} added to ${cls.name}.` });
});

router.delete('/teacher/class-subjects', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const classId = Number(req.query.classId);
  const subjectId = Number(req.query.subjectId);
  if (!isClassTeacherOf(req.user.id, classId, year?.id)) {
    return res.status(403).json({ error: 'Only the class teacher can change a class subject list.' });
  }
  db.prepare('DELETE FROM class_subjects WHERE class_id = ? AND subject_id = ?').run(
    classId,
    subjectId,
  );
  res.json({ message: 'Subject removed from the class.' });
});

// ══════════════════════════ TEACHER: ASSIGNMENTS ═══════════════════════
function validateAssignmentInput(body) {
  const errors = [];
  if (!String(body.title || '').trim()) errors.push('Assignment title is required.');
  if (!Number(body.subjectId)) errors.push('Choose a subject.');
  if (!Number(body.classId)) errors.push('Choose a class.');
  if (!String(body.deadlineAt || '').trim()) errors.push('A deadline is required.');
  if (body.deadlineAt && Number.isNaN(new Date(body.deadlineAt).getTime())) {
    errors.push('Deadline is not a valid date and time.');
  }
  return errors;
}

function normaliseFormats(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || '')
        .split(',')
        .map((s) => s.trim());
  const cleaned = [...new Set(list.map((s) => String(s).toLowerCase().replace(/^\./, '')))]
    .filter((s) => /^[a-z0-9]{2,5}$/.test(s));
  return cleaned.length ? cleaned : DEFAULT_FORMATS;
}

router.get('/teacher/assignments', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const rows = db
    .prepare(
      `SELECT a.*, s.name AS subject_name, c.name AS class_name, c.form_level,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id) AS submission_count,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id AND sub.status = 'submitted') AS pending_count
         FROM assignments a
         JOIN subjects s ON s.id = a.subject_id
         JOIN classes c ON c.id = a.class_id
        WHERE a.teacher_user_id = ? AND a.academic_year_id = ?
        ORDER BY a.created_at DESC`,
    )
    .all(req.user.id, year?.id || 0);
  res.json({ assignments: rows });
});

router.post('/teacher/assignments', requireRole('teacher'), (req, res) => {
  const body = req.body || {};
  const errors = validateAssignmentInput(body);
  if (errors.length) return res.status(400).json({ error: errors.join(' '), errors });

  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No current academic year is configured.' });

  const classId = Number(body.classId);
  const subjectId = Number(body.subjectId);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!cls || !subject) return res.status(404).json({ error: 'Unknown class or subject.' });
  if (cls.name === 'Irsyad' && subject.code === 'RBT') {
    return res.status(400).json({ error: 'Irsyad uses ASK instead of RBT for every form.' });
  }

  // A teacher asserting they set work for a class/subject registers that teaching role.
  db.prepare(
    `INSERT OR IGNORE INTO teacher_assignments (teacher_user_id, class_id, subject_id, academic_year_id)
     VALUES (?,?,?,?)`,
  ).run(req.user.id, classId, subjectId, year.id);

  const publish = body.publish === true;
  const info = db
    .prepare(
      `INSERT INTO assignments (teacher_user_id, class_id, subject_id, academic_year_id, title,
         description, instructions, marking_criteria, accepted_formats, allow_video, status,
         published_at, deadline_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      req.user.id,
      classId,
      subjectId,
      year.id,
      String(body.title).trim(),
      String(body.description || '').trim() || null,
      String(body.instructions || '').trim() || null,
      String(body.markingCriteria || '').trim() || null,
      normaliseFormats(body.acceptedFormats).join(','),
      body.allowVideo ? 1 : 0,
      publish ? 'published' : 'draft',
      publish ? nowTs() : null,
      ts(new Date(body.deadlineAt)),
      nowTs(),
      nowTs(),
    );

  const assignmentId = Number(info.lastInsertRowid);
  if (publish) notifyClassOfAssignment(assignmentId);

  res.status(201).json({
    message: publish ? 'Assignment published.' : 'Draft saved.',
    assignment: assignmentRow(assignmentId),
  });
});

function notifyClassOfAssignment(assignmentId) {
  const a = assignmentRow(assignmentId);
  const students = db
    .prepare(
      `SELECT student_user_id FROM class_memberships
        WHERE class_id = ? AND academic_year_id = ? AND status = 'active'`,
    )
    .all(a.class_id, a.academic_year_id);
  for (const s of students) {
    notify(s.student_user_id, {
      kind: 'assignment_published',
      title: `New assignment: ${a.title}`,
      body: `${a.subject_name} — due ${a.deadline_at} UTC.`,
      link: `/student/assignments/${a.id}`,
      assignmentId: a.id,
    });
  }
}

router.get('/teacher/assignments/:id', requireRole('teacher'), (req, res) => {
  const a = assignmentRow(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!teacherCanAccessAssignment(req.user.id, a)) {
    return res.status(403).json({ error: 'You do not teach this assignment.' });
  }
  const submissions = db
    .prepare(
      `SELECT sub.*, sp.display_name AS student_name, u.email,
              (SELECT COUNT(*) FROM submission_files f WHERE f.submission_id = sub.id) AS file_count
         FROM submissions sub
         JOIN users u ON u.id = sub.student_user_id
         LEFT JOIN student_profiles sp ON sp.user_id = sub.student_user_id
        WHERE sub.assignment_id = ?
        ORDER BY sub.submitted_at DESC`,
    )
    .all(a.id);
  res.json({ assignment: a, attachments: attachmentsForAssignment(a.id), submissions });
});

router.patch('/teacher/assignments/:id', requireRole('teacher'), (req, res) => {
  const a = db
    .prepare('SELECT * FROM assignments WHERE id = ? AND teacher_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (a.status === 'archived') {
    return res.status(409).json({ error: 'Archived assignments cannot be edited.' });
  }
  const body = req.body || {};
  const deadline = body.deadlineAt ? ts(new Date(body.deadlineAt)) : a.deadline_at;
  db.prepare(
    `UPDATE assignments SET title = ?, description = ?, instructions = ?, marking_criteria = ?,
       accepted_formats = ?, allow_video = ?, deadline_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    body.title ? String(body.title).trim() : a.title,
    body.description != null ? String(body.description) : a.description,
    body.instructions != null ? String(body.instructions) : a.instructions,
    body.markingCriteria != null ? String(body.markingCriteria) : a.marking_criteria,
    body.acceptedFormats ? normaliseFormats(body.acceptedFormats).join(',') : a.accepted_formats,
    body.allowVideo != null ? (body.allowVideo ? 1 : 0) : a.allow_video,
    deadline,
    nowTs(),
    a.id,
  );
  res.json({ message: 'Assignment updated.', assignment: assignmentRow(a.id) });
});

router.post('/teacher/assignments/:id/publish', requireRole('teacher'), (req, res) => {
  const a = db
    .prepare('SELECT * FROM assignments WHERE id = ? AND teacher_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (a.status === 'published') return res.status(409).json({ error: 'Assignment is already published.' });
  db.prepare(
    "UPDATE assignments SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?",
  ).run(nowTs(), nowTs(), a.id);
  notifyClassOfAssignment(a.id);
  res.json({ message: 'Assignment published.', assignment: assignmentRow(a.id) });
});

router.post('/teacher/assignments/:id/archive', requireRole('teacher'), (req, res) => {
  const a = db
    .prepare('SELECT * FROM assignments WHERE id = ? AND teacher_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  // Archiving hides the work but never deletes submissions or codes.
  db.prepare("UPDATE assignments SET status = 'archived', updated_at = ? WHERE id = ?").run(
    nowTs(),
    a.id,
  );
  res.json({ message: 'Assignment archived. Student work is preserved.' });
});

// ══════════════════════════ TEACHER: REVIEW ════════════════════════════
router.get('/teacher/reviews', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const rows = db
    .prepare(
      `SELECT sub.id, sub.status, sub.attempt, sub.timing, sub.submitted_at, sub.body,
              a.id AS assignment_id, a.title AS assignment_title, a.deadline_at,
              s.name AS subject_name, c.name AS class_name, c.form_level,
              sp.display_name AS student_name, sp.user_id AS student_user_id,
              (SELECT COUNT(*) FROM submission_files f WHERE f.submission_id = sub.id) AS file_count
         FROM submissions sub
         JOIN assignments a ON a.id = sub.assignment_id
         JOIN subjects s ON s.id = a.subject_id
         JOIN classes c ON c.id = a.class_id
         LEFT JOIN student_profiles sp ON sp.user_id = sub.student_user_id
        WHERE a.academic_year_id = ?
          AND (
            a.teacher_user_id = ?
            OR EXISTS (SELECT 1 FROM class_teacher_roles ctr
                        WHERE ctr.teacher_user_id = ? AND ctr.class_id = a.class_id
                          AND ctr.academic_year_id = a.academic_year_id)
            OR EXISTS (SELECT 1 FROM teacher_assignments ta
                        WHERE ta.teacher_user_id = ? AND ta.class_id = a.class_id
                          AND ta.subject_id = a.subject_id AND ta.academic_year_id = a.academic_year_id)
          )
        ORDER BY CASE sub.status WHEN 'submitted' THEN 0 ELSE 1 END, sub.submitted_at DESC`,
    )
    .all(year?.id || 0, req.user.id, req.user.id, req.user.id);
  res.json({ reviews: rows, pending: rows.filter((r) => r.status === 'submitted').length });
});

router.get('/teacher/submissions/:id', requireRole('teacher'), (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  const a = assignmentRow(sub.assignment_id);
  if (!a || !teacherCanAccessAssignment(req.user.id, a)) {
    return res.status(403).json({ error: 'You do not teach this submission.' });
  }
  const student = db
    .prepare(
      `SELECT u.id, u.email, sp.display_name, sp.form_level FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = ?`,
    )
    .get(sub.student_user_id);
  const code = activeCodeFor(sub.id);
  res.json({
    submission: sub,
    assignment: a,
    student,
    files: filesForSubmission(sub.id),
    events: db
      .prepare('SELECT * FROM submission_events WHERE submission_id = ? ORDER BY id')
      .all(sub.id),
    review: db
      .prepare('SELECT * FROM teacher_reviews WHERE submission_id = ? ORDER BY id DESC LIMIT 1')
      .get(sub.id) || null,
    code: code
      ? {
          hint: code.code_hint,
          createdAt: code.created_at,
          expiresAt: code.expires_at,
          usedAt: code.used_at,
          revokedAt: code.revoked_at,
          expired: isExpired(code.expires_at),
        }
      : null,
  });
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function issueCode(submission, assignment) {
  // Revoke any superseded but still unused code for the same submission.
  db.prepare(
    "UPDATE verification_codes SET revoked_at = ? WHERE submission_id = ? AND used_at IS NULL AND revoked_at IS NULL",
  ).run(nowTs(), submission.id);

  let code = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateCode();
    if (!db.prepare('SELECT 1 FROM verification_codes WHERE code_hash = ?').get(hashCode(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error('Could not allocate a unique verification code.');

  const expiresAt = ts(addDays(new Date(), CODE_TTL_DAYS));
  db.prepare(
    `INSERT INTO verification_codes (code_hash, code_sealed, code_hint, student_user_id,
       assignment_id, submission_id, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    hashCode(code),
    sealCode(code),
    code.slice(-4),
    submission.student_user_id,
    assignment.id,
    submission.id,
    nowTs(),
    expiresAt,
  );
  return { code, expiresAt };
}

router.post('/teacher/submissions/:id/review', requireRole('teacher'), (req, res) => {
  const submissionId = Number(req.params.id);
  const body = req.body || {};
  const decision = String(body.decision || '').toLowerCase();
  const feedback = String(body.feedback || '').trim();

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approve or reject.' });
  }

  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  const a = assignmentRow(sub.assignment_id);
  if (!a || !teacherCanAccessAssignment(req.user.id, a)) {
    return res.status(403).json({ error: 'You do not teach this submission.' });
  }
  if (sub.status === 'completed') {
    return res.status(409).json({ error: 'This work is already completed and cannot be re-reviewed.' });
  }
  if (sub.status === 'approved') {
    return res.status(409).json({ error: 'This submission is already approved.' });
  }

  try {
    if (decision === 'approve') {
      const issued = db.transaction(() => {
        db.prepare(
          "UPDATE submissions SET status = 'approved', approved_at = ? WHERE id = ?",
        ).run(nowTs(), sub.id);
        db.prepare(
          "INSERT INTO teacher_reviews (submission_id, teacher_user_id, decision, feedback) VALUES (?,?, 'approve', ?)",
        ).run(sub.id, req.user.id, feedback || null);
        audit(sub.id, 'approved', req.user.id, feedback || null);
        const result = issueCode(sub, a);
        notify(sub.student_user_id, {
          kind: 'submission_approved',
          title: `Work approved: ${a.title}`,
          body: 'Your submission was approved. A verification code has been delivered to your Inbox.',
          link: '/student/inbox',
          assignmentId: a.id,
          submissionId: sub.id,
        });
        notify(sub.student_user_id, {
          kind: 'verification_code',
          title: `Verification code for ${a.title}`,
          body: `Your code expires on ${result.expiresAt} UTC. ${MESSAGES.codeWarning}`,
          link: '/student/inbox',
          assignmentId: a.id,
          submissionId: sub.id,
        });
        if (feedback) {
          notify(sub.student_user_id, {
            kind: 'teacher_feedback',
            title: `Feedback on ${a.title}`,
            body: feedback,
            link: `/student/assignments/${a.id}`,
            assignmentId: a.id,
            submissionId: sub.id,
          });
        }
        return result;
      })();

      return res.json({
        message: 'Submission approved and verification code issued.',
        decision: 'approve',
        expiresAt: issued.expiresAt,
        codeHint: issued.code.slice(-4),
        // The full code is delivered to the student's Inbox, not to the teacher view.
        deliveredTo: 'student_inbox',
      });
    }

    db.transaction(() => {
      db.prepare("UPDATE submissions SET status = 'rejected', rejected_at = ? WHERE id = ?").run(
        nowTs(),
        sub.id,
      );
      db.prepare(
        "INSERT INTO teacher_reviews (submission_id, teacher_user_id, decision, feedback) VALUES (?,?, 'reject', ?)",
      ).run(sub.id, req.user.id, feedback || null);
      audit(sub.id, 'rejected', req.user.id, feedback || null);
      // A rejection never generates a verification code.
      db.prepare(
        "UPDATE verification_codes SET revoked_at = ? WHERE submission_id = ? AND used_at IS NULL AND revoked_at IS NULL",
      ).run(nowTs(), sub.id);
      notify(sub.student_user_id, {
        kind: 'submission_rejected',
        title: `Work rejected: ${a.title}`,
        body: feedback || 'Your teacher asked you to submit this work again.',
        link: `/student/assignments/${a.id}`,
        assignmentId: a.id,
        submissionId: sub.id,
      });
      if (feedback) {
        notify(sub.student_user_id, {
          kind: 'teacher_feedback',
          title: `Feedback on ${a.title}`,
          body: feedback,
          link: `/student/assignments/${a.id}`,
          assignmentId: a.id,
          submissionId: sub.id,
        });
      }
    })();

    return res.json({
      message: 'Submission rejected. The student has been notified and no code was generated.',
      decision: 'reject',
    });
  } catch (err) {
    return res.status(500).json({ error: 'The review could not be saved. Please try again.' });
  }
});

// ══════════════════════════ STUDENT: ASSIGNMENTS ═══════════════════════
router.get('/student/assignments', requireRole('student'), (req, res) => {
  const year = currentYear();
  const membership = classMembership(req.user.id);
  if (!year || !membership) {
    return res.json({ assignments: [], membership: null, academicYear: year || null });
  }
  const rows = db
    .prepare(
      `SELECT a.*, s.name AS subject_name, s.code AS subject_code,
              c.name AS class_name, c.form_level,
              tp.display_name AS teacher_name
         FROM assignments a
         JOIN subjects s ON s.id = a.subject_id
         JOIN classes c ON c.id = a.class_id
         LEFT JOIN teacher_profiles tp ON tp.user_id = a.teacher_user_id
        WHERE a.class_id = ? AND a.academic_year_id = ? AND a.status = 'published'
        ORDER BY a.deadline_at ASC`,
    )
    .all(membership.class_id, year.id);

  const assignments = rows.map((a) => {
    const sub = latestSubmission(a.id, req.user.id);
    const status = derivedStatus(a, sub);
    const code = sub ? activeCodeFor(sub.id) : null;
    const overdue = !sub && new Date(a.deadline_at.replace(' ', 'T') + 'Z') < new Date();
    return {
      id: a.id,
      title: a.title,
      subject: { id: a.subject_id, name: a.subject_name, code: a.subject_code },
      className: a.class_name,
      formLevel: a.form_level,
      teacherName: a.teacher_name,
      deadlineAt: a.deadline_at,
      publishedAt: a.published_at,
      status,
      statusLabel: labelsFor(status).student,
      missedDeadline: overdue,
      submission: sub
        ? {
            id: sub.id,
            attempt: sub.attempt,
            timing: sub.timing,
            submittedAt: sub.submitted_at,
            files: filesForSubmission(sub.id).length,
          }
        : null,
      code: code
        ? { expiresAt: code.expires_at, usedAt: code.used_at, expired: isExpired(code.expires_at) }
        : null,
    };
  });

  res.json({ assignments, membership, academicYear: year });
});

router.get('/student/assignments/:id', requireRole('student'), (req, res) => {
  const a = assignmentRow(Number(req.params.id));
  if (!a || a.status === 'draft') return res.status(404).json({ error: 'Assignment not found.' });
  if (!studentIsInClass(req.user.id, a.class_id, a.academic_year_id)) {
    return res.status(403).json({ error: 'This assignment is not for your class.' });
  }
  const sub = latestSubmission(a.id, req.user.id);
  const status = derivedStatus(a, sub);
  const code = sub ? activeCodeFor(sub.id) : null;

  res.json({
    assignment: {
      id: a.id,
      title: a.title,
      description: a.description,
      instructions: a.instructions,
      markingCriteria: a.marking_criteria,
      subject: { id: a.subject_id, name: a.subject_name, code: a.subject_code },
      className: a.class_name,
      deadlineAt: a.deadline_at,
      acceptedFormats: a.accepted_formats.split(','),
      allowVideo: !!a.allow_video,
    },
    attachments: attachmentsForAssignment(a.id),
    status,
    statusLabel: labelsFor(status).student,
    submission: sub
      ? {
          id: sub.id,
          body: sub.body,
          attempt: sub.attempt,
          timing: sub.timing,
          submittedAt: sub.submitted_at,
          status: sub.status,
          files: filesForSubmission(sub.id),
        }
      : null,
    code: code
      ? {
          hint: code.code_hint,
          expiresAt: code.expires_at,
          usedAt: code.used_at,
          expired: isExpired(code.expires_at),
          warning: MESSAGES.codeWarning,
        }
      : null,
    canSubmit: ['published', 'rejected'].includes(status) || (status === 'submitted' && false),
    messages: MESSAGES,
  });
});

function computeTiming(deadlineAt) {
  const deadline = new Date(deadlineAt.replace(' ', 'T') + 'Z');
  const diffMs = deadline - new Date();
  if (diffMs < 0) return 'late';
  if (diffMs > 86400000) return 'early';
  return 'on_time';
}

router.post(
  '/student/assignments/:id/submit',
  requireRole('student'),
  (req, res, next) => {
    const a = assignmentRow(Number(req.params.id));
    req.allowedVideo = !!(a && a.allow_video);
    next();
  },
  upload.array('files', MAX_FILES),
  (req, res) => {
    const assignmentId = Number(req.params.id);
    const a = assignmentRow(assignmentId);
    if (!a || a.status !== 'published') {
      return res.status(404).json({ error: 'This assignment is not open for submission.' });
    }
    if (!studentIsInClass(req.user.id, a.class_id, a.academic_year_id)) {
      return res.status(403).json({ error: 'This assignment is not for your class.' });
    }

    const body = String((req.body || {}).body || '').trim();
    const files = req.files || [];
    if (!body && files.length === 0) {
      return res.status(400).json({ error: 'Write your answer or attach at least one file.' });
    }

    const previous = latestSubmission(assignmentId, req.user.id);
    if (previous && previous.status === 'submitted') {
      return res.status(409).json({ error: 'Your work is already waiting for teacher review.' });
    }
    if (previous && previous.status === 'completed') {
      return res.status(409).json({ error: 'This assignment is already completed.' });
    }

    try {
      const timing = computeTiming(a.deadline_at);
      const created = db.transaction(() => {
        // A superseded attempt stays in the database: history is never deleted.
        const attempt = (previous ? previous.attempt : 0) + 1;
        const info = db
          .prepare(
            `INSERT INTO submissions (assignment_id, student_user_id, body, attempt, status, timing, submitted_at)
             VALUES (?,?,?,?, 'submitted', ?, ?)`,
          )
          .run(assignmentId, req.user.id, body || null, attempt, timing, nowTs());
        const submissionId = Number(info.lastInsertRowid);

        const insertFile = db.prepare(
          `INSERT INTO submission_files (submission_id, stored_name, original_name, mime_type, size_bytes)
           VALUES (?,?,?,?,?)`,
        );
        for (const f of files) {
          insertFile.run(submissionId, f.filename, f.originalname, f.mimetype, f.size);
        }
        audit(submissionId, 'submitted', req.user.id, `attempt ${attempt} (${timing})`);

        notify(req.user.id, {
          kind: 'submission_received',
          title: `Work submitted: ${a.title}`,
          body: MESSAGES.submitted,
          link: `/student/assignments/${a.id}`,
          assignmentId: a.id,
          submissionId,
        });
        notify(a.teacher_user_id, {
          kind: 'submission_waiting',
          title: `New submission: ${a.title}`,
          body: 'A student submitted work and it is waiting for your review.',
          link: `/teacher/reviews/${submissionId}`,
          assignmentId: a.id,
          submissionId,
        });
        return { submissionId, attempt };
      })();

      res.status(201).json({
        message: MESSAGES.submitted,
        submissionId: created.submissionId,
        attempt: created.attempt,
        timing,
        status: 'submitted',
        statusLabel: labelsFor('submitted').student,
      });
    } catch (err) {
      res.status(500).json({ error: 'Your work could not be saved. Please try again.' });
    }
  },
);

/** Final verification: the backend re-checks every condition itself. */
router.post('/student/assignments/:id/verify', requireRole('student'), (req, res) => {
  const assignmentId = Number(req.params.id);
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter your verification code.' });

  const a = assignmentRow(assignmentId);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (!studentIsInClass(req.user.id, a.class_id, a.academic_year_id)) {
    return res.status(403).json({ error: 'This assignment is not for your class.' });
  }

  const row = db.prepare('SELECT * FROM verification_codes WHERE code_hash = ?').get(hashCode(code));
  if (!row) {
    return res.status(400).json({ error: 'That code is not valid. Check the code in your Inbox.' });
  }
  if (row.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'That code does not belong to your account.' });
  }
  if (row.assignment_id !== assignmentId) {
    return res.status(400).json({ error: 'That code is for a different assignment.' });
  }
  if (row.revoked_at) {
    return res.status(400).json({ error: 'That code was revoked. Ask your teacher to approve your work again.' });
  }
  if (row.used_at) {
    return res.status(409).json({ error: 'That code has already been used.' });
  }
  if (isExpired(row.expires_at)) {
    return res.status(410).json({
      error: `That code expired on ${row.expires_at} UTC. Ask your teacher to approve your work again.`,
      expiredAt: row.expires_at,
    });
  }

  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(row.submission_id);
  if (!sub || sub.student_user_id !== req.user.id) {
    return res.status(400).json({ error: 'There is no approved submission for that code.' });
  }
  if (!['approved', 'completed'].includes(sub.status)) {
    return res.status(400).json({ error: 'Your submission is not approved yet.' });
  }

  try {
    db.transaction(() => {
      db.prepare('UPDATE verification_codes SET used_at = ? WHERE id = ?').run(nowTs(), row.id);
      db.prepare(
        "UPDATE submissions SET status = 'completed', completed_at = ? WHERE id = ?",
      ).run(nowTs(), sub.id);
      audit(sub.id, 'completed', req.user.id, 'verification code accepted');

      notify(req.user.id, {
        kind: 'assignment_completed',
        title: `Assignment completed: ${a.title}`,
        body: 'Your verification code was accepted and this assignment is complete.',
        link: `/student/assignments/${a.id}`,
        assignmentId: a.id,
        submissionId: sub.id,
      });
      notify(a.teacher_user_id, {
        kind: 'assignment_completed',
        title: `Completed by student: ${a.title}`,
        body: 'A student completed final code verification.',
        link: `/teacher/reviews/${sub.id}`,
        assignmentId: a.id,
        submissionId: sub.id,
      });
    })();

    res.json({
      message: 'Code verified. Assignment completed.',
      status: 'completed',
      statusLabel: labelsFor('completed').student,
      completedAt: nowTs(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Verification could not be completed. Please try again.' });
  }
});

// ══════════════════════════ STUDENT: CLASS ═════════════════════════════
router.post('/student/class/leave', requireRole('student'), (req, res) => {
  const year = currentYear();
  const membership = classMembership(req.user.id);
  if (!year || !membership) return res.status(404).json({ error: 'You are not in a class.' });
  db.prepare(
    "UPDATE class_memberships SET status = 'left', left_at = ? WHERE id = ?",
  ).run(nowTs(), membership.id);
  res.json({ message: `You left ${membership.name}. You can rejoin another class.` });
});

router.post('/student/class/join', requireRole('student'), (req, res) => {
  const year = currentYear();
  if (!year) return res.status(409).json({ error: 'No current academic year is configured.' });
  const classId = Number((req.body || {}).classId);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  try {
    db.transaction(() => {
      const existing = classMembership(req.user.id);
      if (existing && existing.class_id === classId) {
        throw Object.assign(new Error('You are already in this class.'), { status: 409 });
      }
      if (existing) {
        db.prepare("UPDATE class_memberships SET status = 'left', left_at = ? WHERE id = ?").run(
          nowTs(),
          existing.id,
        );
      }
      db.prepare(
        `INSERT INTO class_memberships (student_user_id, class_id, academic_year_id, status)
         VALUES (?,?,?, 'active')`,
      ).run(req.user.id, classId, year.id);
    })();
    res.status(201).json({ message: `You joined ${cls.name}.`, membership: classMembership(req.user.id) });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'You could not join that class. Please try again.',
    });
  }
});

// ═══════════════════════════ NOTIFICATIONS ═════════════════════════════
function expiryWarnings(userId) {
  // Flag codes approaching expiry without mutating the notification history.
  const soon = ts(addDays(new Date(), 2));
  return db
    .prepare(
      `SELECT vc.id, vc.expires_at, a.title
         FROM verification_codes vc JOIN assignments a ON a.id = vc.assignment_id
        WHERE vc.student_user_id = ? AND vc.used_at IS NULL AND vc.revoked_at IS NULL
          AND vc.expires_at <= ? AND vc.expires_at > ?`,
    )
    .all(userId, soon, nowTs());
}

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    .all(req.user.id);
  res.json({
    notifications: rows,
    unread: rows.filter((r) => !r.is_read).length,
    expiryWarnings: req.user.role === 'student' ? expiryWarnings(req.user.id) : [],
  });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const info = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ message: 'Marked as read.' });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'All notifications marked as read.' });
});

/** Inbox: notification history plus the owning student's own codes. */
router.get('/inbox', requireRole('student'), (req, res) => {
  const codes = db
    .prepare(
      `SELECT vc.id, vc.code_sealed, vc.code_hint, vc.created_at, vc.expires_at, vc.used_at, vc.revoked_at,
              a.id AS assignment_id, a.title AS assignment_title, s.name AS subject_name
         FROM verification_codes vc
         JOIN assignments a ON a.id = vc.assignment_id
         JOIN subjects s ON s.id = a.subject_id
        WHERE vc.student_user_id = ?
        ORDER BY vc.created_at DESC`,
    )
    .all(req.user.id)
    .map((c) => ({
      id: c.id,
      // Decrypted for the owning student only; the plaintext is never stored.
      code: c.revoked_at ? null : unsealCode(c.code_sealed),
      codeHint: c.code_hint,
      createdAt: c.created_at,
      expiresAt: c.expires_at,
      usedAt: c.used_at,
      revokedAt: c.revoked_at,
      expired: isExpired(c.expires_at),
      assignment: { id: c.assignment_id, title: c.assignment_title, subject: c.subject_name },
      warning: MESSAGES.codeWarning,
    }));

  res.json({
    codes,
    messages: db
      .prepare(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
      )
      .all(req.user.id),
    unread: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id).n,
  });
});

// ═════════════════════════════ ANALYTICS ═══════════════════════════════
/**
 * Deterministic analytics computed only from stored records. No mark is
 * invented: when no marks exist the subject score is null, not zero.
 */
function studentAnalytics(studentId) {
  const membership = classMembership(studentId);
  const year = currentYear();
  if (!year) {
    return { hasActivity: false, emptyMessage: MESSAGES.emptyDashboard, academicYear: null };
  }

  const published = membership
    ? db
        .prepare(
          `SELECT a.id, a.title, a.deadline_at, s.name AS subject_name, s.id AS subject_id
             FROM assignments a JOIN subjects s ON s.id = a.subject_id
            WHERE a.class_id = ? AND a.academic_year_id = ? AND a.status = 'published'`,
        )
        .all(membership.class_id, year.id)
    : [];

  const rows = published.map((a) => {
    const sub = latestSubmission(a.id, studentId);
    return { ...a, status: derivedStatus(a, sub), submission: sub || null };
  });

  const completed = rows.filter((r) => r.status === 'completed');
  const pendingReview = rows.filter((r) => r.status === 'submitted');
  const rejected = rows.filter((r) => r.status === 'rejected');
  const awaitingCode = rows.filter((r) => r.status === 'awaiting_code' || r.status === 'approved');
  const expiredCodes = rows.filter((r) => r.status === 'code_expired');
  const submitted = rows.filter((r) => r.submission);
  const missed = rows.filter(
    (r) => !r.submission && new Date(r.deadline_at.replace(' ', 'T') + 'Z') < new Date(),
  );

  const bySubject = new Map();
  for (const r of rows) {
    const key = r.subject_id;
    if (!bySubject.has(key)) {
      bySubject.set(key, {
        subjectId: key,
        subject: r.subject_name,
        total: 0,
        completed: 0,
        submitted: 0,
        rejected: 0,
        missed: 0,
      });
    }
    const s = bySubject.get(key);
    s.total += 1;
    if (r.status === 'completed') s.completed += 1;
    if (r.submission) s.submitted += 1;
    if (r.status === 'rejected') s.rejected += 1;
    if (missed.includes(r)) s.missed += 1;
  }

  const marks = db
    .prepare(
      `SELECT m.score, m.max_score, s.name AS subject_name, s.id AS subject_id, m.assessment
         FROM academic_marks m JOIN subjects s ON s.id = m.subject_id
        WHERE m.student_user_id = ?`,
    )
    .all(studentId);

  const markBySubject = new Map();
  for (const m of marks) {
    const entry = markBySubject.get(m.subject_id) || {
      subject: m.subject_name,
      score: 0,
      max: 0,
      assessments: 0,
    };
    entry.score += m.score;
    entry.max += m.max_score;
    entry.assessments += 1;
    markBySubject.set(m.subject_id, entry);
  }

  const subjectPerformance = [...bySubject.values()].map((s) => {
    const mark = markBySubject.get(s.subjectId);
    return {
      ...s,
      completionRate: s.total ? Math.round((s.completed / s.total) * 100) : null,
      // Marks and submission counts are separate facts and are never blended.
      markPercent: mark && mark.max > 0 ? Math.round((mark.score / mark.max) * 100) : null,
      gradedAssessments: mark ? mark.assessments : 0,
    };
  });

  const totalMarkScore = marks.reduce((a, m) => a + m.score, 0);
  const totalMarkMax = marks.reduce((a, m) => a + m.max_score, 0);

  const completedAssignments = completed.map((r) => ({
    id: r.id,
    title: r.title,
    subject: r.subject_name,
    completedAt: r.submission.completed_at,
  }));

  const hasActivity = rows.length > 0 || submitted.length > 0;

  return {
    hasActivity,
    emptyMessage: hasActivity ? null : MESSAGES.emptyDashboard,
    academicYear: year,
    membership,
    totals: {
      totalAssignments: rows.length,
      completed: completed.length,
      approved: rows.filter((r) => r.submission && ['approved', 'completed'].includes(r.submission.status)).length,
      pendingReview: pendingReview.length,
      rejected: rejected.length,
      awaitingCode: awaitingCode.length,
      expiredCodes: expiredCodes.length,
      early: submitted.filter((r) => r.submission.timing === 'early').length,
      onTime: submitted.filter((r) => r.submission.timing === 'on_time').length,
      late: submitted.filter((r) => r.submission.timing === 'late').length,
      missedDeadlines: missed.length,
    },
    completionRate: rows.length ? Math.round((completed.length / rows.length) * 100) : null,
    subjectPerformance,
    graded: {
      assessments: marks.length,
      markPercent: totalMarkMax > 0 ? Math.round((totalMarkScore / totalMarkMax) * 100) : null,
    },
    completedAssignments,
    upcoming: rows
      .filter((r) => !r.submission && new Date(r.deadline_at.replace(' ', 'T') + 'Z') >= new Date())
      .sort((a, b) => (a.deadline_at < b.deadline_at ? -1 : 1))
      .slice(0, 5)
      .map((r) => ({ id: r.id, title: r.title, subject: r.subject_name, deadlineAt: r.deadline_at })),
  };
}

/**
 * Deterministic study insights. No external AI service is configured, so the
 * response states plainly that these are rule-based calculations.
 */
function deterministicInsights(analytics) {
  const priorities = [...analytics.subjectPerformance]
    .filter((s) => s.total > 0)
    .sort((a, b) => {
      const aRate = a.completionRate ?? 0;
      const bRate = b.completionRate ?? 0;
      if (aRate !== bRate) return aRate - bRate;
      return b.missed - a.missed;
    })
    .slice(0, 3)
    .map((s) => ({
      subject: s.subject,
      reason:
        s.missed > 0
          ? `${s.missed} missed deadline${s.missed === 1 ? '' : 's'} in this subject.`
          : `${s.completionRate}% of assignments completed (${s.completed}/${s.total}).`,
      recommendation: `Schedule a revision session for ${s.subject} this week.`,
    }));

  return {
    aiUsed: false,
    method: 'deterministic',
    disclaimer:
      'These insights are calculated from your own stored records. No external AI service was used.',
    priorities,
    completionPattern:
      analytics.totals.totalAssignments === 0
        ? 'No assignments yet, so no pattern can be calculated.'
        : `${analytics.totals.completed} of ${analytics.totals.totalAssignments} assignments completed (${analytics.completionRate}%).`,
  };
}

router.get('/student/analytics', requireRole('student'), (req, res) => {
  const analytics = studentAnalytics(req.user.id);
  res.json({ ...analytics, insights: deterministicInsights(analytics) });
});

router.get('/student/dashboard', requireRole('student'), (req, res) => {
  const analytics = studentAnalytics(req.user.id);
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
  const feedback = db
    .prepare(
      `SELECT tr.id, tr.decision, tr.feedback, tr.created_at, a.title, s.name AS subject_name,
              tp.display_name AS teacher_name
         FROM teacher_reviews tr
         JOIN submissions sub ON sub.id = tr.submission_id
         JOIN assignments a ON a.id = sub.assignment_id
         JOIN subjects s ON s.id = a.subject_id
         LEFT JOIN teacher_profiles tp ON tp.user_id = tr.teacher_user_id
        WHERE sub.student_user_id = ? AND tr.feedback IS NOT NULL
        ORDER BY tr.created_at DESC LIMIT 5`,
    )
    .all(req.user.id);

  res.json({
    profile,
    academicYear: analytics.academicYear,
    membership: analytics.membership,
    analytics,
    insights: deterministicInsights(analytics),
    recentFeedback: feedback,
    recentNotifications: db
      .prepare(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6',
      )
      .all(req.user.id),
    unreadNotifications: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id).n,
    motivation: {
      arabic: '(إِن يَنصُرْكُمُ اللهُ فَلا غالِبَ لَكُم )',
      english: 'If Allah helps you, none can defeat you.',
      reference: 'Quran 3:160',
    },
    messages: MESSAGES,
  });
});

// ══════════════════════════ TEACHER ANALYTICS ══════════════════════════
router.get('/teacher/dashboard', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const profile = db.prepare('SELECT * FROM teacher_profiles WHERE user_id = ?').get(req.user.id);
  const teacherType = teacherTypeOf(req.user.id);
  const teaching = db
    .prepare(
      `SELECT c.id AS class_id, c.name AS class_name, c.form_level, s.id AS subject_id,
              s.name AS subject_name, s.code AS subject_code
         FROM teacher_assignments ta
         JOIN classes c ON c.id = ta.class_id
         JOIN subjects s ON s.id = ta.subject_id
        WHERE ta.teacher_user_id = ? AND ta.academic_year_id = ?
        ORDER BY c.form_level, c.display_order, s.id`,
    )
    .all(req.user.id, year?.id || 0);

  const classRoles = db
    .prepare(
      `SELECT c.id AS class_id, c.name AS class_name, c.form_level
         FROM class_teacher_roles ctr JOIN classes c ON c.id = ctr.class_id
        WHERE ctr.teacher_user_id = ? AND ctr.academic_year_id = ?`,
    )
    .all(req.user.id, year?.id || 0);

  const assignmentStats = db
    .prepare(
      `SELECT a.id, a.title, a.status, a.deadline_at, s.name AS subject_name, c.name AS class_name,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id) AS submissions,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id AND sub.status = 'submitted') AS waiting,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id AND sub.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM class_memberships m WHERE m.class_id = a.class_id
                 AND m.academic_year_id = a.academic_year_id AND m.status = 'active') AS class_size
         FROM assignments a
         JOIN subjects s ON s.id = a.subject_id
         JOIN classes c ON c.id = a.class_id
        WHERE a.teacher_user_id = ? AND a.academic_year_id = ?
        ORDER BY a.created_at DESC LIMIT 12`,
    )
    .all(req.user.id, year?.id || 0);

  res.json({
    profile,
    teacherType,
    isClassTeacher: teacherType === 'class' || classRoles.length > 0,
    academicYear: year || null,
    teaching,
    classTeacherOf: classRoles,
    assignments: assignmentStats,
    waitingReviews: db
      .prepare(
        `SELECT COUNT(*) AS n FROM submissions sub
           JOIN assignments a ON a.id = sub.assignment_id
          WHERE sub.status = 'submitted' AND a.teacher_user_id = ?`,
      )
      .get(req.user.id).n,
    unreadNotifications: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id).n,
  });
});

/** Class Teacher only: consolidated class performance. */
router.get('/teacher/class-analytics/:classId', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const classId = Number(req.params.classId);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  const leads = isClassTeacherOf(req.user.id, classId, year?.id);
  const teaches = db
    .prepare(
      'SELECT 1 AS ok FROM teacher_assignments WHERE teacher_user_id = ? AND class_id = ? AND academic_year_id = ?',
    )
    .get(req.user.id, classId, year?.id);

  if (!leads && !teaches) {
    return res.status(403).json({ error: 'You are not assigned to this class.' });
  }
  if (!leads) {
    return res.status(403).json({
      error: 'Consolidated class analytics are available to the Class Teacher of this class.',
    });
  }

  const students = db
    .prepare(
      `SELECT u.id, sp.display_name, sp.form_level, u.email
         FROM class_memberships m
         JOIN users u ON u.id = m.student_user_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE m.class_id = ? AND m.academic_year_id = ? AND m.status = 'active'
        ORDER BY sp.display_name`,
    )
    .all(classId, year.id);

  const assignments = db
    .prepare(
      `SELECT a.id, a.title, s.name AS subject_name,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id AND sub.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM submissions sub WHERE sub.assignment_id = a.id) AS submitted
         FROM assignments a JOIN subjects s ON s.id = a.subject_id
        WHERE a.class_id = ? AND a.academic_year_id = ? AND a.status = 'published'`,
    )
    .all(classId, year.id);

  const perStudent = students.map((s) => {
    const analytics = studentAnalytics(s.id);
    return {
      studentId: s.id,
      name: s.display_name || s.email,
      completed: analytics.totals ? analytics.totals.completed : 0,
      pendingReview: analytics.totals ? analytics.totals.pendingReview : 0,
      rejected: analytics.totals ? analytics.totals.rejected : 0,
      missed: analytics.totals ? analytics.totals.missedDeadlines : 0,
      completionRate: analytics.completionRate,
    };
  });

  res.json({
    class: cls,
    academicYear: year,
    classSize: students.length,
    assignments,
    students: perStudent,
    averageCompletionRate: perStudent.filter((s) => s.completionRate != null).length
      ? Math.round(
          perStudent
            .filter((s) => s.completionRate != null)
            .reduce((a, s) => a + s.completionRate, 0) /
            perStudent.filter((s) => s.completionRate != null).length,
        )
      : null,
  });
});

/** Student profile visible to teachers who teach them. */
router.get('/teacher/students/:id', requireRole('teacher'), (req, res) => {
  const studentId = Number(req.params.id);
  const year = currentYear();
  const student = db
    .prepare(
      `SELECT u.id, u.email, sp.display_name, sp.form_level FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = ?`,
    )
    .get(studentId);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const membership = classMembership(studentId);
  const related = db
    .prepare(
      `SELECT COUNT(*) AS n FROM class_memberships m
        WHERE m.student_user_id = ? AND m.academic_year_id = ?
          AND (m.class_id IN (SELECT class_id FROM teacher_assignments WHERE teacher_user_id = ? AND academic_year_id = ?)
            OR m.class_id IN (SELECT class_id FROM class_teacher_roles WHERE teacher_user_id = ? AND academic_year_id = ?))`,
    )
    .get(studentId, year?.id || 0, req.user.id, year?.id || 0, req.user.id, year?.id || 0).n;

  if (!related) {
    return res.status(403).json({ error: 'This student is not in a class you teach.' });
  }

  const analytics = studentAnalytics(studentId);
  res.json({ student, membership, analytics });
});

router.get('/teacher/students', requireRole('teacher'), (req, res) => {
  const year = currentYear();
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id, u.email, sp.display_name, sp.form_level, c.name AS class_name, c.id AS class_id
         FROM class_memberships m
         JOIN users u ON u.id = m.student_user_id
         JOIN classes c ON c.id = m.class_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE m.academic_year_id = ? AND m.status = 'active'
          AND (m.class_id IN (SELECT class_id FROM teacher_assignments WHERE teacher_user_id = ? AND academic_year_id = ?)
            OR m.class_id IN (SELECT class_id FROM class_teacher_roles WHERE teacher_user_id = ? AND academic_year_id = ?))
        ORDER BY c.form_level, c.display_order, sp.display_name`,
    )
    .all(year?.id || 0, req.user.id, year?.id || 0, req.user.id, year?.id || 0);
  res.json({ students: rows });
});

// ═══════════════════════════ LEARNING MODULES ══════════════════════════
router.get('/student/revision', requireRole('student'), (req, res) => {
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
  const formLevel = profile ? profile.form_level : 1;
  const topics = db
    .prepare(
      `SELECT t.id, t.form_level, t.title, t.summary, t.questions, s.name AS subject_name,
              s.id AS subject_id, s.code AS subject_code,
              COALESCE(rp.status, 'not_started') AS progress
         FROM revision_topics t
         JOIN subjects s ON s.id = t.subject_id
         LEFT JOIN revision_progress rp ON rp.topic_id = t.id AND rp.student_user_id = ?
        WHERE t.form_level = ?
        ORDER BY s.id, t.id`,
    )
    .all(req.user.id, formLevel)
    .map((t) => ({ ...t, questions: JSON.parse(t.questions || '[]') }));
  res.json({ formLevel, topics });
});

router.post('/student/revision/:topicId', requireRole('student'), (req, res) => {
  const topicId = Number(req.params.topicId);
  const status = (req.body || {}).status === 'revised' ? 'revised' : 'in_progress';
  const topic = db.prepare('SELECT id FROM revision_topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Revision topic not found.' });
  db.prepare(
    `INSERT INTO revision_progress (student_user_id, topic_id, status, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (student_user_id, topic_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(req.user.id, topicId, status, nowTs());
  res.json({ message: status === 'revised' ? 'Marked as revised.' : 'Progress saved.', status });
});

router.get('/student/notes', requireRole('student'), (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db
        .prepare(
          `SELECT n.*, s.name AS subject_name FROM notes n
             LEFT JOIN subjects s ON s.id = n.subject_id
            WHERE n.student_user_id = ? AND (n.title LIKE ? OR n.body LIKE ?)
            ORDER BY n.updated_at DESC`,
        )
        .all(req.user.id, `%${q}%`, `%${q}%`)
    : db
        .prepare(
          `SELECT n.*, s.name AS subject_name FROM notes n
             LEFT JOIN subjects s ON s.id = n.subject_id
            WHERE n.student_user_id = ? ORDER BY n.updated_at DESC`,
        )
        .all(req.user.id);
  res.json({ notes: rows });
});

router.post('/student/notes', requireRole('student'), (req, res) => {
  const body = req.body || {};
  if (!String(body.title || '').trim()) return res.status(400).json({ error: 'A note title is required.' });
  const info = db
    .prepare(
      'INSERT INTO notes (student_user_id, subject_id, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      req.user.id,
      body.subjectId ? Number(body.subjectId) : null,
      String(body.title).trim(),
      String(body.body || ''),
      nowTs(),
      nowTs(),
    );
  res.status(201).json({ message: 'Note saved.', id: Number(info.lastInsertRowid) });
});

router.patch('/student/notes/:id', requireRole('student'), (req, res) => {
  const note = db
    .prepare('SELECT * FROM notes WHERE id = ? AND student_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  const body = req.body || {};
  db.prepare('UPDATE notes SET title = ?, body = ?, subject_id = ?, updated_at = ? WHERE id = ?').run(
    body.title != null ? String(body.title) : note.title,
    body.body != null ? String(body.body) : note.body,
    body.subjectId != null ? Number(body.subjectId) : note.subject_id,
    nowTs(),
    note.id,
  );
  res.json({ message: 'Note updated.' });
});

router.delete('/student/notes/:id', requireRole('student'), (req, res) => {
  const info = db
    .prepare('DELETE FROM notes WHERE id = ? AND student_user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Note not found.' });
  res.json({ message: 'Note deleted.' });
});

router.get('/student/planner', requireRole('student'), (req, res) => {
  const plans = db
    .prepare(
      `SELECT p.*, s.name AS subject_name FROM study_plans p
         LEFT JOIN subjects s ON s.id = p.subject_id
        WHERE p.student_user_id = ? ORDER BY p.scheduled_for ASC`,
    )
    .all(req.user.id);
  res.json({
    plans,
    upcoming: plans.filter((p) => p.status === 'planned'),
    done: plans.filter((p) => p.status === 'done').length,
  });
});

router.post('/student/planner', requireRole('student'), (req, res) => {
  const body = req.body || {};
  if (!String(body.title || '').trim()) return res.status(400).json({ error: 'A study task title is required.' });
  if (!body.scheduledFor || Number.isNaN(new Date(body.scheduledFor).getTime())) {
    return res.status(400).json({ error: 'Choose a valid date and time.' });
  }
  const info = db
    .prepare(
      'INSERT INTO study_plans (student_user_id, subject_id, title, scheduled_for, duration_min) VALUES (?,?,?,?,?)',
    )
    .run(
      req.user.id,
      body.subjectId ? Number(body.subjectId) : null,
      String(body.title).trim(),
      ts(new Date(body.scheduledFor)),
      Number(body.durationMin) || 60,
    );
  res.status(201).json({ message: 'Study session planned.', id: Number(info.lastInsertRowid) });
});

router.patch('/student/planner/:id', requireRole('student'), (req, res) => {
  const plan = db
    .prepare('SELECT * FROM study_plans WHERE id = ? AND student_user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!plan) return res.status(404).json({ error: 'Study plan not found.' });
  const status = ['planned', 'done', 'missed'].includes((req.body || {}).status)
    ? req.body.status
    : plan.status;
  db.prepare('UPDATE study_plans SET status = ? WHERE id = ?').run(status, plan.id);
  res.json({ message: 'Study plan updated.', status });
});

router.delete('/student/planner/:id', requireRole('student'), (req, res) => {
  const info = db
    .prepare('DELETE FROM study_plans WHERE id = ? AND student_user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Study plan not found.' });
  res.json({ message: 'Study plan removed.' });
});

router.get('/student/portfolio', requireRole('student'), (req, res) => {
  const analytics = studentAnalytics(req.user.id);
  res.json({
    items: db
      .prepare('SELECT * FROM portfolio_items WHERE student_user_id = ? ORDER BY created_at DESC')
      .all(req.user.id),
    completedAssignments: analytics.completedAssignments || [],
  });
});

router.post('/student/portfolio', requireRole('student'), (req, res) => {
  const body = req.body || {};
  const kinds = ['certificate', 'achievement', 'milestone', 'project'];
  if (!kinds.includes(body.kind)) {
    return res.status(400).json({ error: `Entry type must be one of: ${kinds.join(', ')}.` });
  }
  if (!String(body.title || '').trim()) return res.status(400).json({ error: 'A title is required.' });
  const info = db
    .prepare(
      'INSERT INTO portfolio_items (student_user_id, kind, title, description, achieved_on) VALUES (?,?,?,?,?)',
    )
    .run(
      req.user.id,
      body.kind,
      String(body.title).trim(),
      String(body.description || '').trim() || null,
      body.achievedOn || null,
    );
  res.status(201).json({ message: 'Portfolio entry added.', id: Number(info.lastInsertRowid) });
});

router.delete('/student/portfolio/:id', requireRole('student'), (req, res) => {
  const info = db
    .prepare('DELETE FROM portfolio_items WHERE id = ? AND student_user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Portfolio entry not found.' });
  res.json({ message: 'Portfolio entry removed.' });
});

/** Academic Passport: verified milestones only, from stored records. */
router.get('/student/passport', requireRole('student'), (req, res) => {
  const analytics = studentAnalytics(req.user.id);
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
  const year = currentYear();
  const subjectCount = analytics.subjectPerformance.length;
  res.json({
    student: profile,
    academicYear: year,
    subjects: analytics.subjectPerformance,
    milestones: (analytics.completedAssignments || []).map((c) => ({
      kind: 'assignment_completed',
      title: c.title,
      subject: c.subject,
      achievedOn: c.completedAt,
      verified: true,
    })),
    summary: {
      subjectsActive: subjectCount,
      assignmentsCompleted: analytics.totals ? analytics.totals.completed : 0,
      completionRate: analytics.completionRate,
      gradedAssessments: analytics.graded ? analytics.graded.assessments : 0,
    },
  });
});

router.get('/student/exam-prep', requireRole('student'), (req, res) => {
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
  const formLevel = profile ? profile.form_level : 1;
  const topics = db
    .prepare(
      `SELECT t.id, t.title, t.summary, t.questions, s.name AS subject_name,
              COALESCE(rp.status, 'not_started') AS progress
         FROM revision_topics t JOIN subjects s ON s.id = t.subject_id
         LEFT JOIN revision_progress rp ON rp.topic_id = t.id AND rp.student_user_id = ?
        WHERE t.form_level = ?`,
    )
    .all(req.user.id, formLevel)
    .map((t) => ({ ...t, questions: JSON.parse(t.questions || '[]') }));

  const revised = topics.filter((t) => t.progress === 'revised').length;
  res.json({
    formLevel,
    topics,
    readiness: {
      revised,
      total: topics.length,
      percent: topics.length ? Math.round((revised / topics.length) * 100) : 0,
    },
  });
});

router.get('/student/feedback', requireRole('student'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT tr.id, tr.decision, tr.feedback, tr.created_at, a.id AS assignment_id,
              a.title AS assignment_title, s.name AS subject_name,
              tp.display_name AS teacher_name
         FROM teacher_reviews tr
         JOIN submissions sub ON sub.id = tr.submission_id
         JOIN assignments a ON a.id = sub.assignment_id
         JOIN subjects s ON s.id = a.subject_id
         LEFT JOIN teacher_profiles tp ON tp.user_id = tr.teacher_user_id
        WHERE sub.student_user_id = ?
        ORDER BY tr.created_at DESC`,
    )
    .all(req.user.id);

  const grouped = {};
  for (const r of rows) {
    const key = r.subject_name || 'Other';
    grouped[key] = grouped[key] || [];
    grouped[key].push(r);
  }
  res.json({ feedback: rows, bySubject: grouped });
});

// ═════════════════════════ FILE ACCESS CONTROL ═════════════════════════
function canReadSubmission(user, submission) {
  if (user.role === 'student') return submission.student_user_id === user.id;
  const a = assignmentRow(submission.assignment_id);
  return !!(a && teacherCanAccessAssignment(user.id, a));
}

router.get('/files/submission/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM submission_files WHERE id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(file.submission_id);
  if (!submission || !canReadSubmission(req.user, submission)) {
    return res.status(403).json({ error: 'You cannot access this file.' });
  }
  const full = path.join(UPLOAD_DIR, 'submissions', path.basename(file.stored_name));
  if (!fs.existsSync(full)) return res.status(410).json({ error: 'This file is no longer stored.' });
  res.setHeader('Content-Disposition', `inline; filename="${file.original_name.replace(/"/g, '')}"`);
  res.sendFile(full);
});

router.get('/files/assignment/:id', requireAuth, (req, res) => {
  const file = db
    .prepare('SELECT * FROM assignment_attachments WHERE id = ?')
    .get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const a = assignmentRow(file.assignment_id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  const allowed =
    req.user.role === 'teacher'
      ? teacherCanAccessAssignment(req.user.id, a)
      : studentIsInClass(req.user.id, a.class_id, a.academic_year_id);
  if (!allowed) return res.status(403).json({ error: 'You cannot access this file.' });
  const full = path.join(UPLOAD_DIR, 'assignments', path.basename(file.stored_name));
  if (!fs.existsSync(full)) return res.status(410).json({ error: 'This file is no longer stored.' });
  res.sendFile(full);
});

module.exports = {
  router,
  MESSAGES,
  derivedStatus,
  labelsFor,
  studentAnalytics,
  deterministicInsights,
  computeTiming,
  issueCode,
  activeCodeFor,
  isExpired,
  teacherCanAccessAssignment,
  studentIsInClass,
  assignmentRow,
  CODE_TTL_DAYS,
};
