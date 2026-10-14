// 執行：node --test carbon/tests/
// 預期值一律由 carbon-factors.json、carbon-config.json 計算，不把真實係數寫死在測試裡
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const core = require('../carbon-core.js');
const config = require('../carbon-config.json');
const factors = require('../carbon-factors.json');

const ORIGIN = { lat: 23.5, lng: 120.9 };   // 本島（南投）

/** 從 ORIGIN 往正北，估算路程剛好是 km 公里的點 */
function pointAtRoadKm(km, from = ORIGIN) {
    const straight = km / config.detourFactor;
    return { lat: from.lat + (straight / 6371.0088) * 180 / Math.PI, lng: from.lng };
}

const g = mode => factors.factors[mode].gCO2e;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/** 檢查整個物件沒有 NaN、Infinity、undefined */
function assertClean(obj, where = 'root') {
    if (obj === undefined) assert.fail(`${where} 是 undefined`);
    if (typeof obj === 'number') assert.ok(Number.isFinite(obj), `${where} = ${obj}`);
    if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) assertClean(v, `${where}.${k}`);
    }
}

test('距離：haversine × 繞路係數', () => {
    const b = pointAtRoadKm(10);
    assert.ok(near(core.roadKm(ORIGIN, b, config), 10, 1e-6));
    assert.ok(near(core.haversineKm(ORIGIN, b), 10 / config.detourFactor, 1e-6));
});

test('汽車、機車為每人基準：總碳排與人數成正比，每人碳排不變（Phase 0 決定）', () => {
    for (const mode of ['car', 'motorcycle']) {
        const c4 = core.carbonKg(mode, 10, 4, factors);
        const c5 = core.carbonKg(mode, 10, 5, factors);
        assert.ok(near(c4.totalKg, g(mode) * 10 * 4 / 1000));
        assert.ok(near(c5.totalKg, c4.totalKg / 4 * 5));
        assert.ok(near(c4.perPersonKg, c5.perPersonKg));
    }
});

test('大眾運輸人數加倍：總碳排加倍、每人不變', () => {
    for (const mode of ['bus', 'train', 'hsr']) {
        const a = core.carbonKg(mode, 30, 3, factors);
        const b = core.carbonKg(mode, 30, 6, factors);
        assert.ok(near(b.totalKg, a.totalKg * 2));
        assert.ok(near(b.perPersonKg, a.perPersonKg));
    }
});

test('步行、腳踏車碳排為 0', () => {
    for (const mode of ['walk', 'bicycle']) {
        const c = core.carbonKg(mode, 2, 3, factors);
        assert.equal(c.totalKg, 0);
        assert.equal(c.perPersonKg, 0);
    }
});

test('每人碳排 × 人數 = 總碳排（每一段、每一種方式）', () => {
    for (const people of [1, 3, 7, 10]) {
        const leg = core.computeLeg(ORIGIN, pointAtRoadKm(40), people, config, factors);
        for (const o of leg.options) assert.ok(near(o.perPersonKg * people, o.totalKg), o.mode);
    }
});

test('0.3、5、50、300 km 每段都至少 2 種交通方式', () => {
    for (const km of [0.3, 5, 50, 300]) {
        const leg = core.computeLeg(ORIGIN, pointAtRoadKm(km), 1, config, factors);
        assert.equal(leg.skipped, false);
        assert.ok(leg.options.length >= 2, `${km} km 只有 ${leg.options.map(o => o.mode)}`);
        assert.equal(leg.insufficient, false);
    }
});

test('MVP 模式：不出現捷運；公車、臺鐵、高鐵只在範圍內出現並帶「需確認站點」', () => {
    for (const km of [0.3, 1, 5, 12, 30, 60, 90, 300]) {
        const leg = core.computeLeg(ORIGIN, pointAtRoadKm(km), 1, config, factors);
        const modes = leg.options.map(o => o.mode);
        assert.ok(!modes.includes('mrt'), `${km} km 出現捷運`);
        for (const mode of ['bus', 'train', 'hsr']) {
            const r = config.rangeKm[mode];
            const expected = (r.min === null || km >= r.min) && (r.max === null || km <= r.max);
            assert.equal(modes.includes(mode), expected, `${mode} @ ${km} km`);
            const opt = leg.options.find(o => o.mode === mode);
            if (opt) assert.ok(opt.tags.includes('verifyStation'));
        }
    }
});

test('超過距離上限：步行、腳踏車、機車不出現', () => {
    for (const mode of ['walk', 'bicycle', 'motorcycle']) {
        const max = config.rangeKm[mode].max;
        const over = core.computeLeg(ORIGIN, pointAtRoadKm(max + 0.5), 1, config, factors);
        const under = core.computeLeg(ORIGIN, pointAtRoadKm(max - 0.1), 1, config, factors);
        assert.ok(!over.options.some(o => o.mode === mode), `${mode} 超過上限仍出現`);
        assert.ok(under.options.some(o => o.mode === mode), `${mode} 在上限內卻沒出現`);
    }
});

test('建議：一定在合理時間內，且是其中碳排最低者；另外標出最快與最低碳', () => {
    for (const km of [0.3, 2, 5, 8, 12, 20, 50, 80, 120, 300]) {
        for (const people of [1, 5]) {
            const leg = core.computeLeg(ORIGIN, pointAtRoadKm(km), people, config, factors);
            const fastest = Math.min(...leg.options.map(o => o.timeMin));
            const limit = Math.max(fastest * config.suggestion.reasonableFactor,
                fastest + config.suggestion.reasonableExtraMin);
            const s = leg.options.find(o => o.mode === leg.suggested);
            assert.ok(s.timeMin <= limit, `${km} km 建議 ${s.mode} 超出合理時間`);
            for (const o of leg.options) {
                if (o.timeMin <= limit) assert.ok(s.totalKg <= o.totalKg, `${km} km：${o.mode} 比建議更低碳`);
            }
            assert.equal(leg.options.find(o => o.mode === leg.fastest).timeMin, fastest);
            assert.equal(leg.options.find(o => o.mode === leg.lowestCarbon).totalKg,
                Math.min(...leg.options.map(o => o.totalKg)));
        }
    }
});

test('與汽車的差額 = 汽車總碳排 − 該方式總碳排', () => {
    const leg = core.computeLeg(ORIGIN, pointAtRoadKm(20), 3, config, factors);
    const car = g('car') * 20 * 3 / 1000;
    assert.ok(near(leg.carKg, car, 1e-6));
    for (const o of leg.options) assert.ok(near(o.savedVsCarKg, leg.carKg - o.totalKg));
    assert.equal(leg.options.find(o => o.mode === 'car').savedVsCarKg, 0);
});

test('時間 = 距離 ÷ 速度 + 等待', () => {
    const leg = core.computeLeg(ORIGIN, pointAtRoadKm(60), 1, config, factors);
    for (const o of leg.options) {
        const expect = 60 / config.speedKmh[o.mode] * 60 + config.waitMin[o.mode];
        assert.ok(near(o.timeMin, expect, 1e-6), o.mode);
    }
});

test('景點：第 9 個被拒絕、重複被拒絕；上下移動與移除', () => {
    let stops = [];
    for (let i = 0; i < config.limits.maxStops; i++) {
        const r = core.addStop(stops, { id: `s${i}`, lat: 23 + i * 0.01, lng: 121 }, config);
        assert.ok(r.ok);
        stops = r.stops;
    }
    const ninth = core.addStop(stops, { id: 's9', lat: 24, lng: 121 }, config);
    assert.equal(ninth.ok, false);
    assert.equal(ninth.reason, 'full');
    assert.equal(ninth.stops.length, config.limits.maxStops);

    const dup = core.addStop(stops.slice(0, 2), { id: 's0', lat: 23, lng: 121 }, config);
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'duplicate');

    const moved = core.moveStop(stops, 's1', -1);
    assert.deepEqual(moved.slice(0, 2).map(s => s.id), ['s1', 's0']);
    assert.deepEqual(core.moveStop(stops, 's0', -1).map(s => s.id), stops.map(s => s.id));
    assert.equal(core.removeStop(stops, 's3').length, stops.length - 1);
});

test('人數限制在 1～10', () => {
    const { minPeople, maxPeople } = config.limits;
    assert.equal(core.clampPeople(0, config), minPeople);
    assert.equal(core.clampPeople(-3, config), minPeople);
    assert.equal(core.clampPeople(99, config), maxPeople);
    assert.equal(core.clampPeople('abc', config), minPeople);
    assert.equal(core.clampPeople(undefined, config), minPeople);
    assert.equal(core.clampPeople('4', config), 4);
});

test('起點等於景點、景點重複：該段略過，不產生 NaN 或負數', () => {
    const a = { id: 'a', ...pointAtRoadKm(5) };
    const trip = core.planTrip(ORIGIN, [{ id: 'o', ...ORIGIN }, a, { ...a }], 2, config, factors);
    assert.equal(trip.legs[0].skipped, true);
    assert.equal(trip.legs[0].reason, 'samePlace');
    assert.equal(trip.legs[1].skipped, false);
    assert.equal(trip.legs[2].skipped, true);
    const sum = core.summarize(trip, {});
    assert.equal(sum.legsCounted, 1);
    assert.ok(sum.totalKg >= 0);
    assertClean(trip);
    assertClean(sum);
});

test('available: false 的交通方式不出現（捷運，以及暫時關掉的公車）', () => {
    for (const km of [1, 5, 20]) {
        const leg = core.computeLeg(ORIGIN, pointAtRoadKm(km), 1, config, factors);
        assert.ok(!leg.options.some(o => o.mode === 'mrt'));
    }
    const noBus = JSON.parse(JSON.stringify(factors));
    noBus.factors.bus.available = false;
    const leg = core.computeLeg(ORIGIN, pointAtRoadKm(20), 1, config, noBus);
    assert.ok(!leg.options.some(o => o.mode === 'bus'));
});

test('跨海（本島 ↔ 離島）：略過並標示；離島內不出現臺鐵、高鐵', () => {
    const penghu = { lat: 23.57, lng: 119.58 };
    const penghu2 = { lat: 23.66, lng: 119.60 };
    const sea = core.computeLeg(ORIGIN, penghu, 1, config, factors);
    assert.equal(sea.skipped, true);
    assert.equal(sea.reason, 'seaCrossing');
    const onIsland = core.computeLeg(penghu, penghu2, 1, config, factors);
    const modes = onIsland.options.map(o => o.mode);
    assert.ok(!modes.includes('train') && !modes.includes('hsr'));
    assert.ok(modes.length >= 2);
});

test('資料中每個景點的座標都落在它所屬縣市的陸地上（離島範圍設定檢查）', () => {
    const locs = require(path.join(__dirname, '../../data/locations.json'));
    const expected = { '金門縣': 'kinmen', '澎湖縣': 'penghu', '連江縣': 'matsu' };
    for (const l of locs) {
        const want = expected[l.city] || 'main';
        if (want === 'main' && /綠島|蘭嶼|琉球/.test(l.addr || '')) continue;
        assert.equal(core.landmassOf(l, config), want, `${l.name}（${l.city}）`);
    }
});

test('TDX 模式（Phase 3 介面）：兩端都在可達範圍才出現，並加上步行時間', () => {
    const transit = { nearestKm: (p, mode) => (mode === 'train' ? 0.8 : mode === 'hsr' ? 10 : 0.2) };
    const leg = core.computeLeg(ORIGIN, pointAtRoadKm(30), 1, config, factors, { transit });
    const modes = leg.options.map(o => o.mode);
    assert.ok(modes.includes('train'));
    assert.ok(!modes.includes('hsr'), '高鐵站太遠仍出現');
    assert.ok(!modes.includes('mrt'), '沒有捷運係數仍出現');
    const train = leg.options.find(o => o.mode === 'train');
    assert.ok(!train.tags.includes('verifyStation'));
    const expect = 30 / config.speedKmh.train * 60 + config.waitMin.train + 1.6 / config.speedKmh.walk * 60;
    assert.ok(near(train.timeMin, expect, 1e-6));
});

test('整趟加總：依選擇計算，沒選的段用建議；與全程開車比較', () => {
    const stops = [10, 25, 60].map((km, i) => ({ id: `p${i}`, ...pointAtRoadKm(km) }));
    const trip = core.planTrip(ORIGIN, stops, 5, config, factors);
    const def = core.summarize(trip, {});
    assert.deepEqual(def.chosen, trip.legs.map(l => l.suggested));
    const allCar = core.summarize(trip, { 0: 'car', 1: 'car', 2: 'car' });
    assert.ok(near(allCar.savedVsCarKg, 0, 1e-9));
    assert.ok(near(allCar.totalKg, allCar.carKg));
    assert.ok(near(def.perPersonKg * 5, def.totalKg));
    assert.ok(def.savedVsCarKg >= 0);
    assertClean(def);
    assertClean(allCar);
});

test('所有輸出沒有 NaN、Infinity、undefined（各種距離與人數）', () => {
    for (const km of [0, 0.01, 0.3, 2.5, 15, 80, 100, 400]) {
        for (const people of [1, 10, 0, 'x']) {
            assertClean(core.computeLeg(ORIGIN, pointAtRoadKm(km), people, config, factors), `${km}km/${people}`);
        }
    }
    assertClean(core.computeLeg(ORIGIN, { lat: NaN, lng: 1 }, 1, config, factors));
});
