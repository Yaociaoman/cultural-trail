import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, isSupportedImage, photoTimeIsValid, gpsIsValid } from '../src/validation.js';

test('distance uses metres and returns zero for identical coordinates', () => {
  assert.equal(haversineMeters(25, 121, 25, 121), 0);
  assert.ok(Math.abs(haversineMeters(25, 121, 25, 121.001) - 100.7) < 1);
});

test('accepts supported camera image types including HEIC', () => {
  assert.equal(isSupportedImage('image/heic', 'photo.heic'), true);
  assert.equal(isSupportedImage('image/jpeg', 'photo.jpg'), true);
  assert.equal(isSupportedImage('application/pdf', 'photo.pdf'), false);
});

test('photo time must be recent and not in the future', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(photoTimeIsValid('2026-01-01T12:00:00Z', now, 48), true);
  assert.equal(photoTimeIsValid('2025-12-31T23:00:00Z', now, 24), false);
  assert.equal(photoTimeIsValid('2026-01-02T01:00:00Z', now, 48), false);
});

test('GPS coordinates must be finite and inside earth bounds', () => {
  assert.equal(gpsIsValid({ latitude: 25, longitude: 121 }), true);
  assert.equal(gpsIsValid({ latitude: 91, longitude: 121 }), false);
  assert.equal(gpsIsValid({ latitude: NaN, longitude: 121 }), false);
});
