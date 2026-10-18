import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import exifr from 'exifr';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transaction } from './db.js';
import { EMAIL_RE, gpsIsValid, haversineMeters, isSupportedImage, photoTimeIsValid } from './validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'backend/uploads'));
await fs.mkdir(uploadDir, { recursive: true });
const app = express();
const production = process.env.NODE_ENV === 'production';
const cookieName = 'tct_session';
const sessionDays = Number(process.env.SESSION_DAYS || 7);
const maxPhotoBytes = Number(process.env.PHOTO_MAX_BYTES || 10 * 1024 * 1024);
const radiusMeters = Number(process.env.STAMP_RADIUS_METERS || 500);
const maxAgeHours = Number(process.env.PHOTO_MAX_AGE_HOURS || 48);
const pointsPerStamp = Number(process.env.POINTS_PER_STAMP || 10);
const locationsFile = path.join(root, 'data/locations.json');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
// Never expose the database, environment files, or user photo storage through static hosting.
app.use('/backend', (_req, res) => res.sendStatus(404));
app.use(express.static(root, { index: 'index.html', dotfiles: 'ignore' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxPhotoBytes, files: 1 } });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const publicUser = user => ({ id: user.id, email: user.email, username: user.username, points: user.points });
const cleanEmail = value => String(value || '').trim().toLowerCase();

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'CROSS_ORIGIN_REQUEST', message: 'Cross-origin request rejected.' });
  next();
}
app.use('/api', requireSameOrigin);

function requireUser(req, res, next) {
  const raw = req.cookies[cookieName];
  if (!raw) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Please sign in.' });
  const tokenHash = hash(raw);
  const session = db.prepare(`SELECT users.id, users.email, users.username, users.points
    FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash, Date.now());
  if (!session) {
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
    return res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Please sign in again.' });
  }
  req.user = session;
  req.sessionHash = tokenHash;
  next();
}

function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionDays * 86_400_000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, expiresAt);
  res.cookie(cookieName, token, { httpOnly: true, secure: production, sameSite: 'strict', path: '/', maxAge: sessionDays * 86_400_000 });
}

function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
  if (username.length < 1 || username.length > 20) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Name must contain 1 to 20 characters.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must contain 10 to 128 characters.' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.status(409).json({ error: 'EMAIL_EXISTS', message: 'This email is already registered.' });
  const user = { id: crypto.randomUUID(), email, username, passwordHash: await bcrypt.hash(password, 12) };
  try {
    db.prepare('INSERT INTO users(id,email,username,password_hash) VALUES(?,?,?,?)').run(user.id, user.email, user.username, user.passwordHash);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'EMAIL_EXISTS', message: 'This email is already registered.' });
    throw error;
  }
  issueSession(res, user.id);
  return res.status(201).json({ user: publicUser({ ...user, points: 0 }) });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
  issueSession(res, user.id);
  return res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', requireUser, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
  res.status(204).end();
});
app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/locations', asyncRoute(async (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(locationsFile);
}));

app.get('/api/stamps', requireUser, (req, res) => {
  const stamps = db.prepare('SELECT id,location_id AS locationId,captured_at AS capturedAt,distance_m AS distanceM,verification_method AS verificationMethod,created_at AS createdAt FROM stamps WHERE user_id=? ORDER BY created_at DESC').all(req.user.id)
    .map(stamp => ({ ...stamp, photoUrl: `/api/stamps/${encodeURIComponent(stamp.locationId)}/photo` }));
  res.json({ stamps });
});

app.post('/api/stamps', requireUser, upload.single('photo'), asyncRoute(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'PHOTO_REQUIRED', message: 'Choose a photo to collect a stamp.' });
  if (!isSupportedImage(file.mimetype, file.originalname)) return res.status(415).json({ error: 'UNSUPPORTED_IMAGE', message: 'Use a JPEG, PNG, WebP, HEIC, or HEIF photo.' });
  const signature = file.buffer.subarray(0, 16);
  const detected = signature[0] === 0xff && signature[1] === 0xd8
    ? 'jpeg' : signature.toString('ascii', 4, 8) === 'ftyp'
      ? 'heif' : signature.toString('ascii', 1, 4) === 'PNG'
        ? 'png' : signature.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!detected) return res.status(415).json({ error: 'INVALID_IMAGE', message: 'The uploaded file is not a supported image.' });
  const manual = req.body.manual === 'true';
  let metadata;
  try { metadata = await exifr.parse(file.buffer, { gps: true, exif: true, tiff: true }) || {}; }
  catch {
    if (!manual) return res.status(422).json({ error: 'INVALID_EXIF', message: 'Could not read photo metadata.' });
    metadata = {};
  }
  const capturedAt = metadata.DateTimeOriginal || metadata.CreateDate || metadata.ModifyDate;
  const captureTimeValid = Boolean(capturedAt) && photoTimeIsValid(capturedAt, Date.now(), maxAgeHours);
  if ((!manual && !captureTimeValid) || (manual && capturedAt && !captureTimeValid)) {
    return res.status(422).json({ error: 'PHOTO_TIME_INVALID', message: `The photo must have been taken within the last ${maxAgeHours} hours.` });
  }
  // Manual submissions without readable capture time record upload time; the actual photo time cannot be verified.
  const recordedCapturedAt = capturedAt ? new Date(capturedAt).toISOString() : new Date().toISOString();

  const locations = JSON.parse(await fs.readFile(locationsFile, 'utf8'));
  let loc;
  let distance;
  let latitude;
  let longitude;
  let verificationMethod = 'gps';

  if (manual) {
    const locationId = String(req.body.locationId || '');
    loc = locations.find(item => item.id === locationId);
    if (!loc) return res.status(400).json({ error: 'INVALID_LOCATION', message: 'Choose a valid trail location for manual stamping.' });
    verificationMethod = 'manual';
    if (gpsIsValid(metadata)) {
      latitude = metadata.latitude;
      longitude = metadata.longitude;
      distance = haversineMeters(latitude, longitude, loc.lat, loc.lng);
    } else {
      // The selected location is stored as a placeholder coordinate; the method marks it unverified.
      latitude = loc.lat;
      longitude = loc.lng;
      distance = 0;
    }
  } else {
    if (!gpsIsValid(metadata)) {
      return res.status(422).json({ error: 'GPS_REQUIRED', message: 'This photo has no readable GPS location. You can choose the location manually.' });
    }
    const matches = locations.map(item => ({ loc: item, distance: haversineMeters(metadata.latitude, metadata.longitude, item.lat, item.lng) }))
      .filter(match => match.distance <= radiusMeters).sort((a, b) => a.distance - b.distance);
    if (!matches.length) return res.status(422).json({ error: 'LOCATION_TOO_FAR', message: `No trail location is within ${radiusMeters} metres of the photo. You can choose the location manually.` });
    ({ loc, distance } = matches[0]);
    latitude = metadata.latitude;
    longitude = metadata.longitude;
  }

  const photoHash = hash(file.buffer);
  if (db.prepare('SELECT 1 FROM stamps WHERE user_id=? AND location_id=?').get(req.user.id, loc.id)) return res.status(409).json({ error: 'STAMP_EXISTS', message: 'You already collected this location’s stamp.' });
  if (db.prepare('SELECT 1 FROM stamps WHERE user_id=? AND photo_sha256=?').get(req.user.id, photoHash)) return res.status(409).json({ error: 'PHOTO_DUPLICATE', message: 'This photo has already been used.' });

  const ext = detected === 'heif' ? ( /\.heic$/i.test(file.originalname) ? '.heic' : '.heif') : `.${detected === 'jpeg' ? 'jpg' : detected}`;
  const photoName = `${crypto.randomUUID()}${ext}`;
  const photoPath = path.join(uploadDir, photoName);
  await fs.writeFile(photoPath, file.buffer, { flag: 'wx', mode: 0o600 });
  const stampId = crypto.randomUUID();
  try {
    transaction(() => {
      db.prepare('INSERT INTO stamps(id,user_id,location_id,photo_path,photo_sha256,captured_at,latitude,longitude,distance_m,verification_method) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(stampId, req.user.id, loc.id, photoName, photoHash, recordedCapturedAt, latitude, longitude, distance, verificationMethod);
      db.prepare('INSERT INTO point_ledger(id,user_id,amount,reason,reference_id) VALUES(?,?,?,?,?)')
        .run(crypto.randomUUID(), req.user.id, pointsPerStamp, 'stamp', loc.id);
      db.prepare('UPDATE users SET points=points+? WHERE id=?').run(pointsPerStamp, req.user.id);
    });
  } catch (error) {
    await fs.unlink(photoPath).catch(() => {});
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'DUPLICATE_STAMP', message: 'This location or photo has already been used.' });
    throw error;
  }
  res.status(201).json({ stamp: { id: stampId, locationId: loc.id, locationName: loc.name, distanceM: Math.round(distance), verificationMethod, capturedAt: recordedCapturedAt, photoUrl: `/api/stamps/${encodeURIComponent(loc.id)}/photo` }, points: req.user.points + pointsPerStamp });
}));

app.get('/api/stamps/:locationId/photo', requireUser, (req, res) => {
  const stamp = db.prepare('SELECT photo_path FROM stamps WHERE user_id=? AND location_id=?').get(req.user.id, req.params.locationId);
  if (!stamp) return res.status(404).json({ error: 'PHOTO_NOT_FOUND', message: 'Photo not found.' });
  const photoPath = path.join(uploadDir, path.basename(stamp.photo_path));
  res.set('Cache-Control', 'private, no-store');
  res.type(path.extname(photoPath)).sendFile(photoPath);
});

app.get('/api/points', requireUser, (req, res) => {
  const entries = db.prepare('SELECT id,amount,reason,reference_id AS referenceId,created_at AS createdAt FROM point_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  res.json({ points: req.user.points, entries });
});
app.get('/api/rewards', (_req, res) => {
  res.json({ rewards: db.prepare('SELECT id,name,description,cost,stock FROM rewards WHERE active=1 ORDER BY cost,id').all() });
});
app.post('/api/redemptions', requireUser, (req, res) => {
  const rewardId = String(req.body.rewardId || '');
  const result = transaction(() => {
    const reward = db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(rewardId);
    if (!reward) return { error: 'REWARD_NOT_FOUND', status: 404 };
    const user = db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id);
    if (user.points < reward.cost) return { error: 'INSUFFICIENT_POINTS', status: 409 };
    if (reward.stock !== null && reward.stock <= 0) return { error: 'OUT_OF_STOCK', status: 409 };
    const id = crypto.randomUUID();
    db.prepare('UPDATE users SET points=points-? WHERE id=?').run(reward.cost, req.user.id);
    if (reward.stock !== null) db.prepare('UPDATE rewards SET stock=stock-1 WHERE id=?').run(reward.id);
    db.prepare('INSERT INTO redemptions(id,user_id,reward_id,points_spent) VALUES(?,?,?,?)').run(id, req.user.id, reward.id, reward.cost);
    db.prepare('INSERT INTO point_ledger(id,user_id,amount,reason,reference_id) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), req.user.id, -reward.cost, 'redemption', id);
    return { id, points: user.points - reward.cost, reward: { id: reward.id, name: reward.name, cost: reward.cost } };
  });
  if (result.error) return res.status(result.status).json({ error: result.error, message: result.error.replaceAll('_', ' ').toLowerCase() });
  res.status(201).json({ redemption: result });
});
app.get('/api/redemptions', requireUser, (req, res) => {
  const redemptions = db.prepare(`SELECT r.id,r.reward_id AS rewardId,w.name,r.points_spent AS pointsSpent,r.created_at AS createdAt
    FROM redemptions r JOIN rewards w ON w.id=r.reward_id WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT 100`).all(req.user.id);
  res.json({ redemptions });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large.' : 'Invalid photo upload.' });
  console.error(error);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Cultural Trails running at http://localhost:${port}`));
