'use strict';
/**
 * WORKLY — school structure seed.
 *
 * Creates the SMKA Shams structure: Tingkatan 1–5, five classes per form in the
 * required order (Ikram, Ikhlas, Ihsan, Islah, Irsyad), KSSM/SMKA subjects, and
 * the Irsyad rule (ASK replaces RBT for every form).
 */
const { db, nowTs } = require('./db');

const FORMS = [1, 2, 3, 4, 5];
const CLASS_NAMES = ['Ikram', 'Ikhlas', 'Ihsan', 'Islah', 'Irsyad'];

// code, name, appliesTo(formLevel)
const SUBJECTS = [
  ['BM', 'Bahasa Melayu', () => true],
  ['BI', 'Bahasa Inggeris', () => true],
  ['MATH', 'Matematik', () => true],
  ['SAINS', 'Sains', (f) => f <= 3],
  ['FIZIK', 'Fizik', (f) => f >= 4],
  ['KIMIA', 'Kimia', (f) => f >= 4],
  ['BIO', 'Biologi', (f) => f >= 4],
  ['SEJ', 'Sejarah', () => true],
  ['PI', 'Pendidikan Islam', () => true],
  ['BA', 'Bahasa Arab', () => true],
  ['GEO', 'Geografi', () => true],
  ['PSV', 'Pendidikan Seni Visual', () => true],
  ['PJK', 'Pendidikan Jasmani dan Kesihatan', () => true],
  ['ASK', 'Asas Sains Komputer', () => true],
  ['RBT', 'Reka Bentuk dan Teknologi', () => true],
];

const REVISION_TOPICS = [
  ['MATH', 1, 'Integer dan Operasi', 'Integer, urutan operasi dan penyelesaian masalah harian.',
    ['Hitung: -7 + 12 - 5', 'Nyatakan integer terkecil antara -3, 0, -8', 'Selesaikan 4x = 36']],
  ['MATH', 4, 'Fungsi dan Persamaan Kuadratik', 'Hubungan fungsi, punca persamaan kuadratik dan graf.',
    ['Cari punca bagi x² - 5x + 6 = 0', 'Apakah bentuk am fungsi kuadratik?', 'Tentukan paksi simetri bagi y = x² - 4x + 3']],
  ['SAINS', 2, 'Nutrisi dan Sistem Pencernaan', 'Kelas nutrien, keperluan kalori dan organ pencernaan.',
    ['Namakan tiga kelas makanan', 'Apakah fungsi vitamin C?', 'Di manakah penyerapan nutrien utama berlaku?']],
  ['FIZIK', 4, 'Gerakan Linear', 'Jarak, sesaran, laju, halaju dan pecutan.',
    ['Bezakan laju dan halaju', 'Apakah unit SI bagi pecutan?', 'Sebuah kereta bergerak 100 m dalam 5 s. Kira halaju purata.']],
  ['KIMIA', 4, 'Jadual Berkala', 'Susunan unsur, kumpulan dan kala.',
    ['Apakah kumpulan bagi natrium?', 'Mengapa gas nadir stabil?', 'Nyatakan trend saiz atom merentasi kala.']],
  ['BIO', 4, 'Sel dan Organisasi Sel', 'Struktur sel, organel dan organisasi tisu.',
    ['Namakan organel penghasil tenaga', 'Bezakan sel tumbuhan dan sel haiwan', 'Apakah fungsi membran plasma?']],
  ['BM', 1, 'Tatabahasa: Kata Nama', 'Kata nama am, khas dan ganti nama.',
    ['Berikan dua contoh kata nama khas', 'Apakah ganti nama diri ketiga?', 'Bina satu ayat menggunakan kata nama am.']],
  ['BI', 3, 'Writing: Formal Letters', 'Structure, register and purpose of formal correspondence.',
    ['List two features of a formal letter', 'Write a suitable opening salutation', 'Explain the difference between formal and informal register']],
  ['SEJ', 3, 'Kedatangan Kuasa Barat', 'Faktor dan kesan kedatangan kuasa Barat ke Tanah Melayu.',
    ['Senaraikan dua kuasa Barat', 'Apakah kesan penjajahan terhadap ekonomi?', 'Nyatakan perjanjian penting 1824']],
  ['PI', 2, 'Akidah: Rukun Iman', 'Enam rukun iman dan implikasi dalam kehidupan.',
    ['Senaraikan rukun iman', 'Apakah maksud iman kepada qada dan qadar?', 'Mengapa iman kepada malaikat penting?']],
  ['BA', 1, 'Mufradat: Keluarga', 'Perkataan asas Arab berkaitan keluarga.',
    ['Terjemahkan "ab" ke Bahasa Melayu', 'Apakah perkataan Arab bagi "ibu"?', 'Bina satu ayat mudah tentang keluarga']],
  ['GEO', 2, 'Cuaca dan Iklim Malaysia', 'Unsur cuaca, iklim monsun dan kesannya.',
    ['Namakan dua unsur cuaca', 'Apakah punca monsun tenggara?', 'Nyatakan satu kesan hujan lebat']],
  ['PSV', 1, 'Asas Lukisan', 'Media, teknik dan komposisi asas lukisan.',
    ['Namakan dua media lukisan', 'Apakah maksud komposisi?', 'Nyatakan satu teknik lorekan']],
  ['PJK', 2, 'Kecergasan Fizikal', 'Komponen kecergasan dan ujian standard.',
    ['Namakan tiga komponen kecergasan', 'Apakah ujian untuk daya tahan kardiovaskular?', 'Mengapa pemanasan badan penting?']],
  ['ASK', 1, 'Asas Pemikiran Komputasional', 'Konsep pemikiran komputasional dan aplikasinya.',
    ['Apakah maksud dekomposisi?', 'Namakan dua teknik pemikiran komputasional', 'Berikan satu contoh pengecaman pola']],
  ['ASK', 3, 'Algoritma dan Pengaturcaraan', 'Algoritma, pseudokod dan struktur kawalan.',
    ['Apakah itu algoritma?', 'Bezakan gelung for dan while', 'Tulis pseudokod untuk jumlah 1 hingga 10']],
  ['RBT', 1, 'Pengenalan Reka Bentuk dan Teknologi', 'Proses reka bentuk dan bahan.',
    ['Namakan dua bahan binaan', 'Apakah langkah pertama proses reka bentuk?', 'Mengapa lakaran penting?']],
  ['RBT', 3, 'Reka Bentuk Elektrik', 'Litar asas, komponen dan keselamatan.',
    ['Namakan dua komponen litar', 'Apakah fungsi perintang?', 'Nyatakan satu langkah keselamatan elektrik']],
];

// F1 Knowledge Championship question bank (era-based, deterministic scoring)
const QUIZ = [
  ['1950s', 'The Pioneering Era', "Who won the first ever Formula One World Championship in 1950?", ['Juan Manuel Fangio', 'Nino Farina', 'Alberto Ascari', 'Stirling Moss'], 1],
  ['1950s', 'The Pioneering Era', "How many World Championship titles did Juan Manuel Fangio win?", ['3', '4', '5', '6'], 2],
  ['1950s', 'The Pioneering Era', "Which team did Alberto Ascari win both his titles with?", ['Maserati', 'Ferrari', 'Alfa Romeo', 'Vanwall'], 1],
  ['1950s', 'The Pioneering Era', "Stirling Moss is famously associated with which nickname?", ['El Maestro', 'Mr. Motor Racing', 'The Flying Scot', 'Il Leone'], 1],
  ['1960s', 'The Classic Racing Era', "Jim Clark won his two World Championship titles with which constructor?", ['Ferrari', 'BRM', 'Lotus', 'Cooper'], 2],
  ['1960s', 'The Classic Racing Era', "Who became the first driver to win a posthumous World Championship in 1970?", ['Jochen Rindt', 'Jackie Stewart', 'Graham Hill', 'Denny Hulme'], 0],
  ['1960s', 'The Classic Racing Era', "Jack Brabham is unique as a World Champion because he was also what?", ['A team owner', 'A race steward', 'A tyre engineer', 'A circuit designer'], 0],
  ['1960s', 'The Classic Racing Era', "John Surtees is famous for winning world titles in F1 and which other discipline?", ['Rallying', 'Motorcycle racing', 'Endurance racing', 'Touring cars'], 1],
  ['1970s', 'Ground Effect and Innovation', "Niki Lauda won his first World Championship in 1975 driving for which team?", ['McLaren', 'Ferrari', 'Tyrrell', 'Brabham'], 1],
  ['1970s', 'Ground Effect and Innovation', "James Hunt won the 1976 title with which constructor?", ['Ferrari', 'McLaren', 'Lotus', 'March'], 1],
  ['1970s', 'Ground Effect and Innovation', "Mario Andretti won the 1978 World Championship in which car?", ['Lotus 79', 'Ferrari 312T3', 'McLaren M26', 'Brabham BT46'], 0],
  ['1970s', 'Ground Effect and Innovation', "Which 1979 champion drove for Ferrari?", ['Jody Scheckter', 'Gilles Villeneuve', 'Carlos Reutemann', 'Alan Jones'], 0],
  ['1980s', 'The Turbo Era', "Ayrton Senna won his first World Championship with which team?", ['Williams', 'Lotus', 'McLaren', 'Toleman'], 2],
  ['1980s', 'The Turbo Era', "Alain Prost won his 1985 and 1986 titles with which constructor?", ['Renault', 'McLaren', 'Williams', 'Ferrari'], 1],
  ['1980s', 'The Turbo Era', "Nigel Mansell's nickname is which of the following?", ['Il Leone', 'The Professor', 'The Rat', 'Magic'], 0],
  ['1980s', 'The Turbo Era', "Keke Rosberg won the 1982 title driving for which team?", ['Williams', 'McLaren', 'Brabham', 'Tyrrell'], 0],
  ['1990s', 'The Modern Racing Era', "Michael Schumacher won his first two titles with which team?", ['Ferrari', 'Benetton', 'Williams', 'McLaren'], 1],
  ['1990s', 'The Modern Racing Era', "Damon Hill won the 1996 World Championship driving which car number?", ['0', '1', '5', '27'], 0],
  ['1990s', 'The Modern Racing Era', "Mika Häkkinen won his titles with which constructor?", ['Ferrari', 'Williams', 'McLaren', 'Benetton'], 2],
  ['1990s', 'The Modern Racing Era', "Which driver won the 1997 title before it was transferred to Jacques Villeneuve?", ['Michael Schumacher', 'Damon Hill', 'Jacques Villeneuve', 'David Coulthard'], 0],
  ['2000s', 'V10 and V8 Era', "How many consecutive titles did Michael Schumacher win from 2000 to 2004?", ['3', '4', '5', '6'], 2],
  ['2000s', 'V10 and V8 Era', "Fernando Alonso won his back-to-back titles with which team?", ['Ferrari', 'Renault', 'McLaren', 'Aston Martin'], 1],
  ['2000s', 'V10 and V8 Era', "Which team did Jenson Button win the 2009 title with?", ['Brawn GP', 'McLaren', 'Red Bull Racing', 'Toyota'], 0],
  ['2000s', 'V10 and V8 Era', "Kimi Räikkönen won the 2007 championship driving for which team?", ['McLaren', 'Ferrari', 'Renault', 'BMW Sauber'], 1],
  ['2010s', 'The Hybrid Era', "Sebastian Vettel won four consecutive titles with which team?", ['Ferrari', 'Red Bull Racing', 'Mercedes', 'McLaren'], 1],
  ['2010s', 'The Hybrid Era', "Lewis Hamilton won his 2014 and 2015 titles with which constructor?", ['Mercedes', 'McLaren', 'Ferrari', 'Red Bull Racing'], 0],
  ['2010s', 'The Hybrid Era', "Nico Rosberg won his only title in which year?", ['2014', '2015', '2016', '2017'], 2],
  ['2010s', 'The Hybrid Era', "Charles Leclerc is nicknamed \"Il Predestinato\", which means what in English?", ['The Predestined One', 'The Iceman', 'The Professor', 'The Hammer'], 0],
  ['2020s', 'Modern Ground Effect Era', "Max Verstappen won his first World Championship in which year?", ['2019', '2020', '2021', '2022'], 2],
  ['2020s', 'Modern Ground Effect Era', "Which team has Verstappen driven for throughout his championship run?", ['Mercedes', 'Ferrari', 'Red Bull Racing', 'McLaren'], 2],
  ['2020s', 'Modern Ground Effect Era', "Lando Norris races with which featured number?", ['3', '4', '16', '81'], 1],
  ['2020s', 'Modern Ground Effect Era', "Oscar Piastri's featured racing number is which of these?", ['16', '55', '81', '63'], 2],
  ['2020s', 'Modern Ground Effect Era', "George Russell's nickname \"Mr Saturday\" relates to which session?", ['Sprint', 'Qualifying', 'Practice', 'Race'], 1],
];

function ensureAcademicYear(year) {
  const existing = db.prepare('SELECT * FROM academic_years WHERE year = ?').get(year);
  if (existing) return existing;
  const info = db
    .prepare(
      'INSERT INTO academic_years (year, starts_on, ends_on, is_current) VALUES (?, ?, ?, 0)',
    )
    .run(year, `${year}-01-01`, `${year}-12-31`);
  return db.prepare('SELECT * FROM academic_years WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Open a new academic year: the previous year is archived (assignments only),
 * memberships for the old year stay untouched, and the new year becomes current.
 * Historical records are never deleted.
 */
function startAcademicYear(year) {
  return db.transaction(() => {
    const ay = ensureAcademicYear(year);
    db.prepare('UPDATE academic_years SET is_current = 0 WHERE id != ?').run(ay.id);
    db.prepare('UPDATE academic_years SET is_current = 1 WHERE id = ?').run(ay.id);
    // Archive previous-year assignments rather than deleting them.
    db.prepare(
      "UPDATE assignments SET status = 'archived' WHERE academic_year_id != ? AND status = 'published'",
    ).run(ay.id);
    return ay;
  })();
}

function seedSchool() {
  return db.transaction(() => {
    // Classes: Tingkatan 1..5, each with the five required classes in order.
    const insertClass = db.prepare(
      `INSERT INTO classes (form_level, name, display_order) VALUES (?, ?, ?)
       ON CONFLICT (form_level, name) DO UPDATE SET display_order = excluded.display_order`,
    );
    for (const form of FORMS) {
      CLASS_NAMES.forEach((name, idx) => insertClass.run(form, name, idx + 1));
    }

    // Subjects
    const insertSubject = db.prepare(
      `INSERT INTO subjects (code, name, category) VALUES (?, ?, 'KSSM')
       ON CONFLICT (code) DO UPDATE SET name = excluded.name`,
    );
    for (const [code, name] of SUBJECTS) insertSubject.run(code, name);

    const subjectId = (code) => db.prepare('SELECT id FROM subjects WHERE code = ?').get(code).id;
    const classes = db.prepare('SELECT * FROM classes').all();
    const link = db.prepare(
      'INSERT OR IGNORE INTO class_subjects (class_id, subject_id) VALUES (?, ?)',
    );

    for (const cls of classes) {
      for (const [code, , applies] of SUBJECTS) {
        if (!applies(cls.form_level)) continue;
        if (code === 'ASK' && cls.name !== 'Irsyad') continue;
        if (code === 'RBT' && cls.name === 'Irsyad') continue;
        link.run(cls.id, subjectId(code));
      }
    }
    return { classes: classes.length, subjects: SUBJECTS.length };
  })();
}

function seedRevision() {
  const getSubject = db.prepare('SELECT id FROM subjects WHERE code = ?');
  const exists = db.prepare(
    'SELECT id FROM revision_topics WHERE subject_id = ? AND form_level = ? AND title = ?',
  );
  const insert = db.prepare(
    'INSERT INTO revision_topics (subject_id, form_level, title, summary, questions) VALUES (?,?,?,?,?)',
  );
  let added = 0;
  for (const [code, form, title, summary, questions] of REVISION_TOPICS) {
    const subject = getSubject.get(code);
    if (!subject) continue;
    if (exists.get(subject.id, form, title)) continue;
    insert.run(subject.id, form, title, summary, JSON.stringify(questions));
    added += 1;
  }
  return added;
}

function seedQuiz() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM quiz_questions').get().n;
  if (count > 0) return 0;
  const insert = db.prepare(
    'INSERT INTO quiz_questions (era, topic, question, options, correct_index, points) VALUES (?,?,?,?,?,10)',
  );
  for (const [era, topic, question, options, correct] of QUIZ) {
    insert.run(era, topic, question, JSON.stringify(options), correct);
  }
  return QUIZ.length;
}

/** Idempotent: safe to run on every boot. */
function seedAll({ year = new Date().getUTCFullYear() } = {}) {
  const school = seedSchool();
  if (!db.prepare('SELECT id FROM academic_years WHERE is_current = 1').get()) {
    startAcademicYear(year);
  }
  const revision = seedRevision();
  const quiz = seedQuiz();
  return { ...school, revision, quiz };
}

module.exports = {
  seedAll,
  seedSchool,
  seedRevision,
  seedQuiz,
  ensureAcademicYear,
  startAcademicYear,
  FORMS,
  CLASS_NAMES,
};

if (require.main === module) {
  const { init } = require('./db');
  init();
  console.log(JSON.stringify(seedAll(), null, 2));
}
