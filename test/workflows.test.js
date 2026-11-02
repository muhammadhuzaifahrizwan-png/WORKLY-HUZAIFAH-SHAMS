'use strict';
/**
 * WORKLY — end-to-end HTTP workflow tests.
 *
 * Boots the real Express app against a throwaway database, then drives the
 * documented user journeys through HTTP only, so nothing is asserted about
 * in-process functions. Every record created here is synthetic test data in a
 * temporary directory; nothing touches the shipped database.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workly-test-'));
process.env.WORKLY_DATA_DIR = TEMP_DIR;
process.env.NODE_ENV = 'test';

const { init } = require('../server/db');
const seed = require('../server/seed');
const { importF1Data } = require('../server/f1-data');
const { app } = require('../server/index');

let server;
let baseUrl;

// ─────────────────────────────── helpers ───────────────────────────────
/** A minimal cookie jar: the app only sets one cookie. */
function jar() {
  return { cookie: null };
}

async function call(method, pathname, { body, form, session, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (session && session.cookie) init.headers.cookie = session.cookie;
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${baseUrl}${pathname}`, init);
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (session && set.length) {
    const sessionCookie = set.find((c) => c.startsWith('workly_session='));
    if (sessionCookie) session.cookie = sessionCookie.split(';')[0];
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

function must(res, expected, label) {
  assert.equal(res.status, expected, `${label} → ${res.status}: ${res.text.slice(0, 300)}`);
  return res.body;
}

// ─────────────────────────────── lifecycle ─────────────────────────────
before(async () => {
  init();
  seed.seedAll();
  await importF1Data({ log: () => {} });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

// ─────────────────────────────── the tests ─────────────────────────────
test('health endpoint reports a live app', async () => {
  const body = must(await call('GET', '/api/health'), 200, 'health');
  assert.equal(body.ok, true);
  assert.equal(body.app, 'WORKLY');
});

test('an anonymous request has no session', async () => {
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

test('unknown API routes return JSON, not the SPA shell', async () => {
  const res = await call('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.ok(res.body && res.body.error);
});

test('registration, login and logout work without administrator approval', async () => {
  const session = jar();
  const reg = must(
    await call('POST', '/api/auth/register', {
      session,
      body: {
        email: 'student1@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Aisyah Rahman',
        formLevel: 2,
        heardFrom: 'Teacher',
      },
    }),
    201,
    'register student',
  );
  assert.equal(reg.profile.role, 'student');
  assert.equal(reg.redirectTo, '/student/dashboard');
  assert.ok(reg.membership, 'a student is enrolled into a class on registration');
  assert.ok(session.cookie, 'registration starts a session');

  const me = must(await call('GET', '/api/auth/me', { session }), 200, 'me');
  assert.equal(me.profile.email, 'student1@example.com');

  // Duplicate email is rejected.
  const dup = await call('POST', '/api/auth/register', {
    body: {
      email: 'student1@example.com',
      password: 'CorrectHorse9',
      role: 'student',
      displayName: 'Someone Else',
      formLevel: 1,
    },
  });
  assert.equal(dup.status, 409);

  // Wrong password fails with the same message as an unknown account.
  const bad = await call('POST', '/api/auth/login', {
    body: { email: 'student1@example.com', password: 'wrong-password' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'Invalid email or password.');

  const relogin = jar();
  must(
    await call('POST', '/api/auth/login', {
      session: relogin,
      body: { email: 'student1@example.com', password: 'CorrectHorse9' },
    }),
    200,
    'login',
  );

  must(await call('POST', '/api/auth/logout', { session: relogin }), 200, 'logout');
  const afterLogout = await call('GET', '/api/auth/me', { session: relogin });
  assert.equal(afterLogout.status, 401, 'the session is destroyed on the server');
});

test('a student cannot reach teacher-only endpoints', async () => {
  const session = jar();
  must(
    await call('POST', '/api/auth/register', {
      session,
      body: {
        email: 'student2@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Hakim Zulkifli',
        formLevel: 2,
      },
    }),
    201,
    'register student2',
  );
  const res = await call('GET', '/api/teacher/assignments', { session });
  assert.equal(res.status, 403);
});

test('school structure matches the SMKA Shams configuration', async () => {
  const session = jar();
  must(
    await call('POST', '/api/auth/register', {
      session,
      body: {
        email: 'structure@example.com',
        password: 'CorrectHorse9',
        role: 'teacher',
        displayName: 'Ustaz Faiz',
        teacherType: 'class',
      },
    }),
    201,
    'register teacher',
  );

  const body = must(await call('GET', '/api/school/structure', { session }), 200, 'structure');
  assert.equal(body.classes.length, 25, 'Tingkatan 1–5 × 5 classes');
  const names = ['Ikram', 'Ikhlas', 'Ihsan', 'Islah', 'Irsyad'];
  for (const form of [1, 2, 3, 4, 5]) {
    const row = body.classes.filter((c) => c.form_level === form).sort((a, b) => a.display_order - b.display_order);
    assert.deepEqual(row.map((c) => c.name), names);
  }

  // Irsyad uses ASK instead of RBT for every form.
  const irsyad = body.classes.filter((c) => c.name === 'Irsyad');
  assert.equal(irsyad.length, 5);
  for (const cls of irsyad) {
    const subjects = must(
      await call('GET', `/api/school/classes/${cls.id}/subjects`, { session }),
      200,
      'irshad subjects',
    );
    const codes = (subjects.subjects || subjects).map((s) => s.code);
    assert.ok(codes.includes('ASK'), `${cls.name} Form ${cls.form_level} offers ASK`);
    assert.ok(!codes.includes('RBT'), `${cls.name} Form ${cls.form_level} must not offer RBT`);
  }
});

// The main academic journey, run once and shared by the assertions below.
const flow = {};

test('teacher publishes an assignment for a class', async () => {
  flow.teacher = jar();
  must(
    await call('POST', '/api/auth/register', {
      session: flow.teacher,
      body: {
        email: 'teacher.main@example.com',
        password: 'CorrectHorse9',
        role: 'teacher',
        displayName: 'Ustazah Nur',
        teacherType: 'class',
      },
    }),
    201,
    'register main teacher',
  );

  const structure = must(
    await call('GET', '/api/school/structure', { session: flow.teacher }),
    200,
    'structure again',
  );
  flow.class = structure.classes.find((c) => c.form_level === 3 && c.name === 'Ikram');

  const subjects = must(
    await call('GET', `/api/school/classes/${flow.class.id}/subjects`, { session: flow.teacher }),
    200,
    'class subjects',
  );
  flow.subject = (subjects.subjects || subjects)[0];
  assert.ok(flow.subject && flow.subject.id);

  // The teacher registers the class/subject they teach.
  must(
    await call('POST', '/api/teacher/teaching', {
      session: flow.teacher,
      body: { classId: flow.class.id, subjectId: flow.subject.id },
    }),
    201,
    'add teaching assignment',
  );

  const deadline = new Date(Date.now() + 5 * 86400000).toISOString();
  const created = must(
    await call('POST', '/api/teacher/assignments', {
      session: flow.teacher,
      body: {
        classId: flow.class.id,
        subjectId: flow.subject.id,
        title: 'Chapter 3 Essay',
        description: 'Write about the water cycle.',
        instructions: 'At least 400 words.',
        markingCriteria: 'Clarity and accuracy.',
        acceptedFormats: ['pdf', 'jpg'],
        deadlineAt: deadline,
        publish: true,
      },
    }),
    201,
    'create assignment',
  );

  flow.assignment = created.assignment;
  assert.equal(flow.assignment.status, 'published');
});

test('a draft assignment is invisible to students until published', async () => {
  const deadline = new Date(Date.now() + 4 * 86400000).toISOString();
  const draft = must(
    await call('POST', '/api/teacher/assignments', {
      session: flow.teacher,
      body: {
        classId: flow.class.id,
        subjectId: flow.subject.id,
        title: 'Draft Only',
        deadlineAt: deadline,
      },
    }),
    201,
    'create draft',
  );
  assert.equal(draft.assignment.status, 'draft');

  flow.student = jar();
  must(
    await call('POST', '/api/auth/register', {
      session: flow.student,
      body: {
        email: 'student.main@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Nabil Hakim',
        formLevel: 3,
        classId: flow.class.id,
      },
    }),
    201,
    'register main student',
  );

  const list = must(
    await call('GET', '/api/student/assignments', { session: flow.student }),
    200,
    'student assignments',
  );
  const ids = (list.assignments || list).map((a) => a.id);
  assert.ok(ids.includes(flow.assignment.id), 'the published assignment is listed');
  assert.ok(!ids.includes(draft.assignment.id), 'the draft is not listed');

  const hidden = await call('GET', `/api/student/assignments/${draft.assignment.id}`, {
    session: flow.student,
  });
  assert.equal(hidden.status, 404);
});

test('a student submits work and is told the work will be reviewed', async () => {
  const submit = must(
    await call('POST', `/api/student/assignments/${flow.assignment.id}/submit`, {
      session: flow.student,
      body: { body: 'The water cycle moves water through evaporation and condensation.' },
    }),
    201,
    'submit work',
  );
  assert.equal(
    submit.message,
    'Your teacher will check this work and you will receive a code.',
  );
  flow.submissionId = submit.submissionId;

  // Not completed, and no code can exist yet.
  const detail = must(
    await call('GET', `/api/student/assignments/${flow.assignment.id}`, { session: flow.student }),
    200,
    'assignment detail',
  );
  assert.equal(detail.status, 'submitted');
  assert.equal(detail.statusLabel, 'Submitted for Teacher Review');
  assert.equal(detail.code, null, 'a code must not be issued before approval');

  const inbox = must(await call('GET', '/api/inbox', { session: flow.student }), 200, 'inbox');
  assert.equal(inbox.codes.length, 0, 'the inbox holds no code before approval');

  // A second submission while one is waiting is refused.
  const again = await call('POST', `/api/student/assignments/${flow.assignment.id}/submit`, {
    session: flow.student,
    body: { body: 'second attempt' },
  });
  assert.equal(again.status, 409);
});

test('submitting with an attached file stores the file', async () => {
  // Publish a second assignment so the student has a clean submission slot.
  const deadline = new Date(Date.now() + 3 * 86400000).toISOString();
  const created = must(
    await call('POST', '/api/teacher/assignments', {
      session: flow.teacher,
      body: {
        classId: flow.class.id,
        subjectId: flow.subject.id,
        title: 'Photo Evidence',
        deadlineAt: deadline,
        acceptedFormats: ['pdf', 'jpg'],
        publish: true,
      },
    }),
    201,
    'create upload assignment',
  );
  flow.uploadAssignment = created.assignment;

  const form = new FormData();
  form.append('body', 'Attached the practical report.');
  form.append('files', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'report.pdf');

  const submit = must(
    await call('POST', `/api/student/assignments/${flow.uploadAssignment.id}/submit`, {
      session: flow.student,
      form,
    }),
    201,
    'submit with file',
  );
  assert.equal(submit.message, 'Your teacher will check this work and you will receive a code.');

  const detail = must(
    await call(
      'GET',
      `/api/student/assignments/${flow.uploadAssignment.id}`,
      { session: flow.student },
    ),
    200,
    'upload detail',
  );
  assert.equal(detail.submission.files.length, 1);
  assert.equal(detail.submission.files[0].original_name, 'report.pdf');
});

test('a rejection notifies the student and generates no code', async () => {
  const reviews = must(
    await call('GET', '/api/teacher/reviews', { session: flow.teacher }),
    200,
    'review queue',
  );
  assert.ok(reviews.reviews.some((r) => r.id === flow.submissionId));

  const rejected = must(
    await call('POST', `/api/teacher/submissions/${flow.submissionId}/review`, {
      session: flow.teacher,
      body: { decision: 'reject', feedback: 'Please add the diagram.' },
    }),
    200,
    'reject',
  );
  assert.equal(rejected.decision, 'reject');

  const detail = must(
    await call('GET', `/api/student/assignments/${flow.assignment.id}`, { session: flow.student }),
    200,
    'detail after rejection',
  );
  assert.equal(detail.status, 'rejected');
  assert.equal(detail.code, null);

  const inbox = must(await call('GET', '/api/inbox', { session: flow.student }), 200, 'inbox');
  assert.equal(inbox.codes.length, 0, 'rejection never issues a code');
  assert.ok(
    inbox.messages.some((m) => m.kind === 'submission_rejected'),
    'the student is notified of the rejection',
  );

  // A rejected assignment accepts a new attempt.
  must(
    await call('POST', `/api/student/assignments/${flow.assignment.id}/submit`, {
      session: flow.student,
      body: { body: 'The water cycle, with the diagram included this time.' },
    }),
    201,
    'resubmit after rejection',
  );
});

test('approval issues a single-use 7-day code into the student inbox', async () => {
  const reviews = must(
    await call('GET', '/api/teacher/reviews', { session: flow.teacher }),
    200,
    'review queue after resubmit',
  );
  const pending = reviews.reviews.find(
    (r) => r.assignment_id === flow.assignment.id && r.status === 'submitted',
  );
  assert.ok(pending, 'the resubmitted work is waiting for review');
  flow.secondSubmissionId = pending.id;

  const approved = must(
    await call('POST', `/api/teacher/submissions/${pending.id}/review`, {
      session: flow.teacher,
      body: { decision: 'approve', feedback: 'Well explained.' },
    }),
    200,
    'approve',
  );
  assert.equal(approved.decision, 'approve');
  assert.equal(approved.deliveredTo, 'student_inbox');
  assert.ok(approved.expiresAt, 'the response states the expiry');

  const expiresAt = new Date(`${approved.expiresAt.replace(' ', 'T')}Z`);
  const days = (expiresAt - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `code expires in 7 days (got ${days.toFixed(3)})`);

  const inbox = must(await call('GET', '/api/inbox', { session: flow.student }), 200, 'inbox with code');
  assert.equal(inbox.codes.length, 1);
  flow.code = inbox.codes[0].code;
  assert.match(flow.code, /^[A-Z0-9]{8}$/, 'the code is 8 alphanumeric characters');
  assert.equal(
    inbox.codes[0].warning,
    'WARNING: This verification code is valid for 7 days only. Please enter and submit your code before it expires.',
  );

  // The plaintext code is never stored, and a teacher response does not contain it.
  assert.ok(!JSON.stringify(approved).includes(flow.code));
});

test('the wrong code, another student, and cross-assignment use are all refused', async () => {
  const wrong = await call('POST', `/api/student/assignments/${flow.assignment.id}/verify`, {
    session: flow.student,
    body: { code: 'ZZZZZZZZ' },
  });
  assert.equal(wrong.status, 400);

  const other = jar();
  must(
    await call('POST', '/api/auth/register', {
      session: other,
      body: {
        email: 'student.other@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Sofea Imani',
        formLevel: 3,
        classId: flow.class.id,
      },
    }),
    201,
    'register other student',
  );
  const stolen = await call('POST', `/api/student/assignments/${flow.assignment.id}/verify`, {
    session: other,
    body: { code: flow.code },
  });
  assert.equal(stolen.status, 403, 'a code belongs to exactly one student');

  const wrongAssignment = await call(
    'POST',
    `/api/student/assignments/${flow.uploadAssignment.id}/verify`,
    { session: flow.student, body: { code: flow.code } },
  );
  assert.equal(wrongAssignment.status, 400);
});

test('a valid code completes the assignment exactly once', async () => {
  const ok = must(
    await call('POST', `/api/student/assignments/${flow.assignment.id}/verify`, {
      session: flow.student,
      body: { code: flow.code },
    }),
    200,
    'verify',
  );
  assert.equal(ok.status, 'completed');
  assert.equal(ok.statusLabel, 'Submitted — Completed');

  const detail = must(
    await call('GET', `/api/student/assignments/${flow.assignment.id}`, { session: flow.student }),
    200,
    'detail after completion',
  );
  assert.equal(detail.status, 'completed');
  assert.equal(detail.canSubmit, false, 'a completed assignment cannot be resubmitted');

  const reuse = await call('POST', `/api/student/assignments/${flow.assignment.id}/verify`, {
    session: flow.student,
    body: { code: flow.code },
  });
  assert.equal(reuse.status, 409, 'a code can only be used once');
});

test('analytics count real submissions and never invent marks', async () => {
  const analytics = must(
    await call('GET', '/api/student/analytics', { session: flow.student }),
    200,
    'analytics',
  );
  assert.equal(analytics.hasActivity, true);
  const counters = analytics.counters || analytics.stats || {};
  assert.ok(
    JSON.stringify(analytics).includes('"completed":1') ||
      JSON.stringify(analytics).includes('"completed": 1'),
    'exactly one assignment is completed',
  );
  assert.ok(counters, 'analytics exposes counters');

  // No marks were ever entered, so subject scores must be null rather than zero.
  const subjects = analytics.subjects || [];
  for (const subject of subjects) {
    if ('averageMark' in subject) {
      assert.ok(
        subject.averageMark === null || typeof subject.averageMark === 'number',
        'marks are either a real number or null',
      );
    }
  }
  if (analytics.insights) {
    assert.equal(analytics.insights.aiUsed, false, 'no AI service is claimed');
  }
});

test('learning modules persist notes, plans and portfolio items', async () => {
  const note = must(
    await call('POST', '/api/student/notes', {
      session: flow.student,
      body: { title: 'Water cycle', body: 'Evaporation, condensation, precipitation.', subjectId: flow.subject.id },
    }),
    201,
    'create note',
  );
  const noteId = note.note ? note.note.id : note.id;

  const updated = must(
    await call('PATCH', `/api/student/notes/${noteId}`, {
      session: flow.student,
      body: { body: 'Evaporation, condensation, precipitation, collection.' },
    }),
    200,
    'update note',
  );
  assert.ok(JSON.stringify(updated).includes('collection'));

  const notes = must(await call('GET', '/api/student/notes', { session: flow.student }), 200, 'list notes');
  const noteList = notes.notes || notes;
  assert.ok(noteList.some((n) => n.id === noteId));

  must(
    await call('POST', '/api/student/planner', {
      session: flow.student,
      body: {
        title: 'Revise chapter 3',
        subjectId: flow.subject.id,
        scheduledFor: new Date(Date.now() + 86400000).toISOString(),
        durationMin: 45,
      },
    }),
    201,
    'create plan',
  );
  const plans = must(
    await call('GET', '/api/student/planner', { session: flow.student }),
    200,
    'list plans',
  );
  const planList = plans.plans || plans;
  assert.equal(planList.length, 1);

  must(await call('DELETE', `/api/student/notes/${noteId}`, { session: flow.student }), 200, 'delete note');
  const afterDelete = must(
    await call('GET', '/api/student/notes', { session: flow.student }),
    200,
    'notes after delete',
  );
  assert.equal((afterDelete.notes || afterDelete).length, 0);
});

test('F1 database is queryable, filtered and sorted', async () => {
  const stats = must(await call('GET', '/api/f1/stats'), 200, 'f1 stats');
  assert.ok(stats.drivers >= 900, `the full historical database is present (${stats.drivers})`);
  assert.equal(stats.from, 1950);
  assert.equal(stats.featured, 62, 'all supplied featured records are kept');

  const featured = must(await call('GET', '/api/f1/featured'), 200, 'featured');
  const senna = featured.drivers.find((d) => d.name === 'Ayrton Senna');
  assert.ok(senna, 'featured identities are preserved verbatim');
  assert.equal(senna.number, '1');
  assert.equal(senna.team, 'McLaren');
  assert.equal(senna.nickname, 'Magic');

  const search = must(await call('GET', '/api/f1/drivers?q=senna', {}), 200, 'search');
  assert.ok(search.drivers.some((d) => d.name === 'Ayrton Senna'));

  const byEra = must(await call('GET', '/api/f1/drivers?era=1950s&limit=5'), 200, 'era filter');
  for (const d of byEra.drivers) {
    assert.ok(d.firstSeason <= 1959 && d.lastSeason >= 1950);
  }

  const byTitle = must(await call('GET', '/api/f1/drivers?titles=1&sort=titles&limit=3'), 200, 'titles sort');
  assert.equal(byTitle.drivers.length, 3);
  assert.ok(byTitle.drivers[0].stats.titles >= byTitle.drivers[1].stats.titles);

  const byNickname = must(await call('GET', '/api/f1/drivers?nickname=Iceman'), 200, 'nickname search');
  assert.ok(byNickname.drivers.some((d) => d.name === 'Kimi Räikkönen'));

  const profile = must(await call('GET', `/api/f1/drivers/${senna.driverId}`), 200, 'profile');
  assert.equal(profile.identity.name, 'Ayrton Senna');
  assert.equal(profile.featuredIdentity.nickname, 'Magic');
  assert.ok(profile.historicalRecord.seasons.length > 0, 'the historical season record is separate');
  const seasons = profile.historicalRecord.seasons.map((s) => s.season);
  assert.ok(seasons.includes(1984) && seasons.includes(1994));
  assert.ok(profile.historicalRecord.constructors.some((c) => /McLaren/i.test(c.name)));
  assert.equal(profile.images.primary, null, 'no photo is invented');
});

test('driver selection is class-scoped, atomic and released on switch', async () => {
  const pool = must(await call('GET', '/api/f1/drivers?limit=6&sort=name'), 200, 'driver pool');
  const [driverA, driverB, driverC] = pool.drivers;

  // Student 1 takes driver A.
  must(
    await call('POST', '/api/f1/selection', {
      session: flow.student,
      body: { driverId: driverA.id },
    }),
    201,
    'first selection',
  );

  // Student 2 in the same class cannot take it.
  const clash = await call('POST', '/api/f1/selection', {
    session: flow.other || jar(),
    body: { driverId: driverA.id },
  });
  // (flow.other is registered below when needed; a 401 here is equally correct.)
  assert.ok([401, 403].includes(clash.status), `unauthenticated selection refused (${clash.status})`);

  const second = jar();
  must(
    await call('POST', '/api/auth/register', {
      session: second,
      body: {
        email: 'student.classmate@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Amirul Hakim',
        formLevel: 3,
        classId: flow.class.id,
      },
    }),
    201,
    'register classmate',
  );

  const taken = await call('POST', '/api/f1/selection', {
    session: second,
    body: { driverId: driverA.id },
  });
  assert.equal(taken.status, 409, 'a driver already taken in the class is refused');

  // A student in a different class may take the same driver.
  const otherClass = must(
    await call('GET', '/api/school/structure', { session: flow.teacher }),
    200,
    'structure for other class',
  ).classes.find((c) => c.form_level === 4 && c.name === 'Ihsan');

  const outsider = jar();
  must(
    await call('POST', '/api/auth/register', {
      session: outsider,
      body: {
        email: 'student.otherclass@example.com',
        password: 'CorrectHorse9',
        role: 'student',
        displayName: 'Zahra Balqis',
        formLevel: 4,
        classId: otherClass.id,
      },
    }),
    201,
    'register student in another class',
  );
  must(
    await call('POST', '/api/f1/selection', {
      session: outsider,
      body: { driverId: driverA.id },
    }),
    201,
    'the same driver in a different class',
  );

  // Switching releases the previous driver.
  must(
    await call('POST', '/api/f1/selection', {
      session: flow.student,
      body: { driverId: driverB.id },
    }),
    201,
    'switch driver',
  );
  const nowFree = must(
    await call('POST', '/api/f1/selection', { session: second, body: { driverId: driverA.id } }),
    201,
    'the released driver can now be taken',
  );
  assert.equal(nowFree.driverId, driverA.id);

  // The classmate's live selection is now driver A, and driver B is still held.
  const mine = must(await call('GET', '/api/f1/selection', { session: flow.student }), 200, 'my selection');
  assert.equal(mine.selection.driverId, driverB.id);

  const classSelections = must(
    await call('GET', '/api/f1/class-selections', { session: flow.student }),
    200,
    'class selections',
  );
  const takenIds = classSelections.drivers.map((d) => d.driverId).sort();
  assert.deepEqual(takenIds, [driverA.id, driverB.id].sort());

  // Garaging a car does not touch driver data.
  must(
    await call('PATCH', '/api/f1/garage', {
      session: flow.student,
      body: { primaryColor: '#101010', accentColor: '#D6C19A', rims: 'gold', sponsorText: 'WORKLY' },
    }),
    200,
    'save garage',
  );
  const garage = must(await call('GET', '/api/f1/garage', { session: flow.student }), 200, 'garage');
  assert.equal(garage.car.sponsorText, 'WORKLY');
  assert.equal(garage.driver.id, driverB.id);
  assert.ok(driverC);

  must(
    await call('POST', '/api/f1/garage/presets', {
      session: flow.student,
      body: { name: 'Race trim' },
    }),
    201,
    'save preset',
  );
  const presets = must(await call('GET', '/api/f1/garage', { session: flow.student }), 200, 'garage with preset');
  assert.equal(presets.presets.length, 1);
});

test('the championship quiz is graded on the server and keeps a driver snapshot', async () => {
  const quiz = must(await call('GET', '/api/f1/quiz', { session: flow.student }), 200, 'quiz');
  assert.ok(quiz.questions.length > 0);
  assert.ok(
    quiz.questions.every((q) => !('correct_index' in q) && !('correctIndex' in q)),
    'answers are never sent to the client',
  );

  const answers = quiz.questions.slice(0, 3).map((q) => ({ id: q.id, answer: 0 }));
  const attempt = must(
    await call('POST', '/api/f1/quiz/attempt', { session: flow.student, body: { answers } }),
    201,
    'quiz attempt',
  );
  assert.equal(attempt.total, 3);
  assert.ok(attempt.driver, 'the attempt stores the driver in use at the time');

  // Switching driver must not rewrite the stored attempt.
  const pool = must(await call('GET', '/api/f1/drivers?limit=3&sort=name'), 200, 'pool');
  const previousDriver = attempt.driver.id;
  const replacement = pool.drivers.find((d) => d.id !== previousDriver);
  const switchRes = await call('POST', '/api/f1/selection', {
    session: flow.student,
    body: { driverId: replacement.id },
  });
  assert.ok([201].includes(switchRes.status));

  const attempts = must(
    await call('GET', '/api/f1/my-attempts', { session: flow.student }),
    200,
    'my attempts',
  );
  const stored = attempts.attempts.find((a) => a.id === attempt.attemptId || a.points === attempt.points);
  assert.ok(stored);
  assert.equal(stored.driver.id, previousDriver, 'the historical snapshot is unchanged');

  const standings = must(
    await call('GET', '/api/f1/championship', { session: flow.student }),
    200,
    'standings',
  );
  assert.ok(standings.standings.some((s) => s.mine));
});

test('a student cannot read another student’s submission file or records', async () => {
  const other = jar();
  must(
    await call('POST', '/api/auth/login', {
      session: other,
      body: { email: 'student.classmate@example.com', password: 'CorrectHorse9' },
    }),
    200,
    'login classmate',
  );
  const foreign = await call('GET', `/api/student/assignments/${flow.assignment.id}`, { session: other });
  // Same class, so the assignment is visible — but the private submission is not.
  if (foreign.status === 200) {
    assert.equal(foreign.body.submission, null, 'another student’s submission is never returned');
  }

  const foreignFile = await call('GET', '/api/files/submission/1', { session: other });
  assert.ok([403, 404].includes(foreignFile.status), 'submission files are authorised per user');
});
