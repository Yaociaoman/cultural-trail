// 執行：node --test scripts/build-transit-data.test.mjs（不需要 TDX 金鑰，不連網）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildBusAccess, toStation } from './build-transit-data.mjs';

const require = createRequire(import.meta.url);
const { haversineKm } = require('../carbon/carbon-core.js');

// 固定亂數，結果可重現
function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

test('公車可達距離：格網搜尋與逐一比對結果相同', () => {
  const r = rng(42);
  const stops = Array.from({ length: 3000 }, () => ({ lat: 22 + r() * 3.2, lng: 120 + r() * 1.9 }));
  const locs = Array.from({ length: 200 }, (_, i) => ({ id: `L${i}`, lat: 22 + r() * 3.2, lng: 120 + r() * 1.9 }));
  const access = buildBusAccess(locs, stops, 2);
  for (const loc of locs) {
    const best = Math.min(...stops.map(s => haversineKm(loc, s)));
    if (best <= 2) assert.ok(Math.abs(access[loc.id] - best) < 0.001, loc.id);
    else assert.equal(access[loc.id], null, loc.id);
  }
});

test('公車可達距離：附近沒有站牌時為 null，無效座標略過', () => {
  const access = buildBusAccess(
    [{ id: 'far', lat: 23.5, lng: 121 }, { id: 'bad', lat: NaN, lng: 121 }],
    [{ lat: 25, lng: 121.5 }]);
  assert.equal(access.far, null);
  assert.ok(!('bad' in access));
});

test('車站轉換：取中文站名與座標，缺座標時略過', () => {
  const ok = toStation({
    StationUID: 'TRA-1000', StationName: { Zh_tw: '臺北', En: 'Taipei' },
    StationPosition: { PositionLat: 25.047675, PositionLon: 121.517055 }, LocationCity: '臺北市',
  }, 'train', 'TRA');
  assert.deepEqual(ok, { id: 'TRA-1000', name: '臺北', mode: 'train', operator: 'TRA', city: '臺北市', lat: 25.04768, lng: 121.51706 });
  assert.equal(toStation({ StationUID: 'x', StationName: { Zh_tw: 'x' }, StationPosition: {} }, 'hsr', 'THSR'), null);
});
