// 執行：node --test scripts/fetch-opendata.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityOf, convert, selectBalanced } from './fetch-opendata.mjs';

const SRC = { idField: 'AttractionID', nameField: 'AttractionName', category: 'Tourist attractions',
              icon: 'S', color: '#c96b1a' };
const item = (over = {}) => ({
  AttractionID: 'Attraction_1', AttractionName: '安平古堡', PositionLat: 23.0, PositionLon: 120.16,
  PostalAddress: { City: '臺南市', Town: '安平區', StreetAddress: '國勝路82號' },
  Description: '荷蘭人興建的城堡', Images: [{ URL: 'https://example.gov.tw/a.jpg' }],
  WebsiteURL: 'https://example.gov.tw/', ...over,
});

test('cityOf 統一「臺」並去掉郵遞區號', () => {
  assert.equal(cityOf('台南市安平區'), '臺南市');
  assert.equal(cityOf('100臺北市中正區'), '臺北市');
  assert.equal(cityOf(''), '');
});

test('convert 轉出網站格式', () => {
  const loc = convert(SRC, item());
  assert.equal(loc.city, '臺南市');
  assert.equal(loc.addr, '臺南市安平區國勝路82號');
  assert.equal(loc.pic, 'https://example.gov.tw/a.jpg');
});

test('安全：危險網址與 HTML 會被移除（前端用 innerHTML 顯示這些欄位）', () => {
  const loc = convert(SRC, item({
    AttractionName: '<img src=x onerror=alert(1)>古堡',
    Images: [{ URL: 'javascript:alert(1)' }],
    WebsiteURL: 'https://x.tw/" onmouseover="alert(1)',
  }));
  assert.equal(loc.name, '古堡');
  assert.equal(loc.pic, '');
  assert.equal(loc.officialUrl, 'https://www.taiwan.net.tw/');
});

test('座標錯誤、沒有縣市、已結束的活動都排除', () => {
  assert.equal(convert(SRC, item({ PositionLat: 'x' })), null);
  assert.equal(convert(SRC, item({ PositionLat: 35 })), null);
  assert.equal(convert(SRC, item({ PostalAddress: {} })), null);
  const ev = { ...SRC, idField: 'EventID', nameField: 'EventName', isEvent: true };
  const e = { EventID: 'E1', EventName: '活動', PositionLat: 23, PositionLon: 120.2,
              PostalAddress: { City: '臺南市' } };
  assert.equal(convert(ev, { ...e, EndDateTime: '2020-01-01T00:00:00+08:00' }), null);
  assert.equal(convert(ev, { ...e, EventStatus: 'EventCancelled' }), null);
  assert.ok(convert(ev, { ...e, EndDateTime: '2999-01-01T00:00:00+08:00' }));
});

test('各縣市平均挑選，且結果穩定、保留上次的地點', () => {
  const mk = (city, n, p) => Array.from({ length: n }, (_, i) =>
    ({ id: `${p}_${String(i).padStart(5, '0')}`, city, pic: i % 2 ? 'x' : '', desc: 'x'.repeat(40) }));
  const raw = [...mk('桃園市', 500, 'A'), ...mk('臺南市', 50, 'B'), ...mk('澎湖縣', 3, 'C')];
  const out = selectBalanced(raw, { max: 600, perCity: 28 });
  const n = c => out.filter(x => x.city === c).length;
  assert.deepEqual([n('桃園市'), n('臺南市'), n('澎湖縣')], [28, 28, 3]);
  assert.deepEqual(selectBalanced(raw, { max: 600, perCity: 28 }).map(x => x.id), out.map(x => x.id));
  const kept = selectBalanced(raw, { max: 600, perCity: 28 }, new Set(['A_00400']));
  assert.ok(kept.some(x => x.id === 'A_00400'));
});
