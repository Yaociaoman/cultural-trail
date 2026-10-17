export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isSupportedImage(mime, originalName = '') {
  return new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']).has(mime.toLowerCase())
    || /\.(jpe?g|png|webp|heic|heif)$/i.test(originalName);
}

export function photoTimeIsValid(capturedAt, now = Date.now(), maxAgeHours = 48) {
  const time = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  return Number.isFinite(time) && time <= now + 5 * 60_000 && time >= now - maxAgeHours * 3_600_000;
}

export function gpsIsValid(gps) {
  return gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)
    && Math.abs(gps.latitude) <= 90 && Math.abs(gps.longitude) <= 180;
}
