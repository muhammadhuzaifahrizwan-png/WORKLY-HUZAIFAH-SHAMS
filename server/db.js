'use strict';
/**
 * WORKLY — database layer.
 *
 * SQLite (WAL) with a single connection. Every write that must be atomic runs
 * inside db.transaction(). Timestamps are stored as UTC "YYYY-MM-DD HH:MM:SS"
 * so that both JavaScript and SQLite's datetime() agree on comparisons.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.WORKLY_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = process.env.WORKLY_DB_PATH || path.join(DATA_DIR, 'workly.db');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Apply the schema. Idempotent: every statement is CREATE ... IF NOT EXISTS. */
function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

// ─────────────────────────────── helpers ────────────────────────────────
/** UTC timestamp string: "2026-11-02 09:44:00". */
function ts(date = new Date()) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}
function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86400000);
}
function nowTs() {
  return ts();
}

/** A stable per-installation secret used for code sealing (never in source). */
function installationSecret() {
  if (process.env.WORKLY_SECRET) return process.env.WORKLY_SECRET;
  const keyPath = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(keyPath, 'utf8').trim();
}

// ───────────────────────── password hashing ────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ─────────────────── verification-code sealing helpers ─────────────────
function sealKey() {
  return crypto.scryptSync(installationSecret(), 'workly-verification-code', 32);
}

/** Store-only hash (preferred lookup form); the plain code is never persisted. */
function hashCode(code) {
  return crypto
    .createHmac('sha256', installationSecret())
    .update(String(code).trim().toUpperCase())
    .digest('hex');
}

/**
 * Sealed copy so the owning student can re-read the code from their own inbox.
 * Encrypted with AES-256-GCM; unsealing requires the server secret.
 */
function sealCode(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const payload = Buffer.concat([cipher.update(String(code), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${payload.toString('base64')}`;
}

function unsealCode(sealed) {
  try {
    const [ivB64, tagB64, dataB64] = String(sealed).split('.');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      sealKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = {
  db,
  init,
  ts,
  nowTs,
  addDays,
  hashPassword,
  verifyPassword,
  hashCode,
  sealCode,
  unsealCode,
  DATA_DIR,
  UPLOAD_DIR,
  DB_PATH,
};
