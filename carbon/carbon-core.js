/* ══════════════════════════════════════════════════
   碳排與路線計算核心（docs/carbon-route-prompt.md §6）
   - 純函式、沒有 DOM；瀏覽器（window.CarbonCore）與 Node（require）都能用
   - 設定與係數由呼叫端傳入（carbon-config.json、carbon-factors.json），這裡不寫死任何數字
   - 係數一律為每人基準（官方單位：延人公里）：總碳排 = 係數 × 距離 × 人數
══════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CarbonCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EARTH_RADIUS_KM = 6371.0088;

    function isFiniteNum(x) {
        return typeof x === 'number' && Number.isFinite(x);
    }

    function isPoint(p) {
        return !!p && isFiniteNum(p.lat) && isFiniteNum(p.lng)
            && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
    }

    /** 兩點直線距離（公里） */
    function haversineKm(a, b) {
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** 估算路程 = 直線距離 × 繞路係數 */
    function roadKm(a, b, config) {
        return haversineKm(a, b) * config.detourFactor;
    }

    /** 點位在哪一塊陸地：離島回傳其 id，其餘視為本島 'main' */
    function landmassOf(p, config) {
        for (const m of config.landmasses || []) {
            const [minLat, minLng, maxLat, maxLng] = m.bbox;
            if (p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng) return m.id;
        }
        return 'main';
    }

    /** 人數：取整數並限制在設定範圍內；無效值回到最小值 */
    function clampPeople(n, config) {
        const { minPeople, maxPeople } = config.limits;
        const v = Math.round(Number(n));
        if (!Number.isFinite(v)) return minPeople;
        return Math.min(maxPeople, Math.max(minPeople, v));
    }

    /** 加入景點：超過上限或重複時拒絕，不改動原陣列 */
    function addStop(stops, stop, config) {
        if (!stop || !stop.id || !isPoint(stop)) return { ok: false, reason: 'invalid', stops };
        if (stops.some(s => s.id === stop.id)) return { ok: false, reason: 'duplicate', stops };
        if (stops.length >= config.limits.maxStops) return { ok: false, reason: 'full', stops };
        return { ok: true, reason: null, stops: [...stops, stop] };
    }

    function removeStop(stops, id) {
        return stops.filter(s => s.id !== id);
    }

    /** 上移（delta = -1）或下移（delta = 1）；超出範圍時不動 */
    function moveStop(stops, id, delta) {
        const i = stops.findIndex(s => s.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= stops.length) return stops.slice();
        const out = stops.slice();
        [out[i], out[j]] = [out[j], out[i]];
        return out;
    }

    function inRange(km, range) {
        if (!range) return true;
        if (range.min !== null && range.min !== undefined && km < range.min) return false;
        if (range.max !== null && range.max !== undefined && km > range.max) return false;
        return true;
    }

    function factorOf(mode, factors) {
        const f = factors.factors[mode];
        if (!f || !f.available || !isFiniteNum(f.gCO2e) || f.gCO2e < 0) return null;
        if (f.basis !== 'per_passenger_km') return null;   // 目前只支援每人基準（Phase 0 決定）
        return f;
    }

    /** 碳排（公斤）：每人基準 */
    function carbonKg(mode, km, people, factors) {
        const f = factorOf(mode, factors);
        if (!f) return null;
        const perPersonKg = f.gCO2e * km / 1000;
        return { totalKg: perPersonKg * people, perPersonKg };
    }

    /** 時間（分鐘）＝ 距離 ÷ 速度 ＋ 等待；TDX 模式另加兩端步行 */
    function travelMin(mode, km, config, accessWalkKm) {
        const speed = config.speedKmh[mode];
        if (!isFiniteNum(speed) || speed <= 0) return null;
        const walk = accessWalkKm > 0 ? accessWalkKm / config.speedKmh.walk * 60 : 0;
        return km / speed * 60 + (config.waitMin[mode] || 0) + walk;
    }

    /**
     * 這段可以用哪些交通方式，以及每種方式的判斷依據。
     * ctx.transit（TDX 模式）若提供，需有 nearest(point, mode) → { km, id? } 或 null（沒有資料）；
     * 沒有 ctx.transit 就是 MVP 模式。
     */
    function feasibleModes(km, from, to, config, factors, ctx) {
        const transit = ctx && ctx.transit;
        const bothMain = landmassOf(from, config) === 'main' && landmassOf(to, config) === 'main';
        const out = [];
        for (const mode of config.modes) {
            if (!factorOf(mode, factors)) continue;
            if (!bothMain && (config.mainOnlyModes || []).includes(mode)) continue;
            const isStation = config.stationModes.includes(mode);
            if (!isStation) {
                if (inRange(km, config.rangeKm[mode])) out.push({ mode, verifyStation: false, accessWalkKm: 0 });
                continue;
            }
            // 兩種模式都套用距離範圍（例如 1 公里不建議搭臺鐵）；TDX 模式再加上站點判斷
            if (!inRange(km, config.rangeKm[mode])) continue;
            const reach = config.stationReachKm[mode];
            const a = transit ? transit.nearest(from, mode) : null;
            const b = transit ? transit.nearest(to, mode) : null;
            if (a && b && isFiniteNum(a.km) && isFiniteNum(b.km)) {
                // TDX 模式：兩端都有站點資料，依可達距離判斷；兩端最近的是同一站就不用搭
                const sameStation = a.id !== undefined && a.id === b.id;
                if (a.km <= reach && b.km <= reach && !sameStation) {
                    out.push({ mode, verifyStation: false, accessWalkKm: a.km + b.km });
                }
                continue;
            }
            // MVP 模式（或缺少某一端的站點資料）：依距離範圍，標「需確認站點」
            if ((config.mvpHiddenModes || []).includes(mode)) continue;
            out.push({ mode, verifyStation: true, accessWalkKm: 0 });
        }
        return out;
    }

    /**
     * 建議規則（§6.6）：最快時間的「合理時間」內，碳排最低者；
     * 同樣碳排時依 config.modes 的順序（步行優先於腳踏車）。
     */
    function pickSuggestion(options, config) {
        if (!options.length) return { suggested: null, fastest: null, lowestCarbon: null, reasonableMin: null };
        const order = m => config.modes.indexOf(m);
        const fastest = options.reduce((a, b) => (b.timeMin < a.timeMin ? b : a));
        const lowest = options.reduce((a, b) =>
            (b.totalKg < a.totalKg || (b.totalKg === a.totalKg && order(b.mode) < order(a.mode)) ? b : a));
        const s = config.suggestion;
        const reasonableMin = Math.max(fastest.timeMin * s.reasonableFactor, fastest.timeMin + s.reasonableExtraMin);
        const pool = options.filter(o => o.timeMin <= reasonableMin);
        const suggested = pool.reduce((a, b) =>
            (b.totalKg < a.totalKg || (b.totalKg === a.totalKg && order(b.mode) < order(a.mode)) ? b : a));
        return { suggested: suggested.mode, fastest: fastest.mode, lowestCarbon: lowest.mode, reasonableMin };
    }

    /** 單段：from、to 為 { lat, lng }；回傳各交通方式的時間、碳排與建議 */
    function computeLeg(from, to, people, config, factors, ctx) {
        const n = clampPeople(people, config);
        if (!isPoint(from) || !isPoint(to)) {
            return { km: 0, straightKm: 0, skipped: true, reason: 'invalidPoint', options: [] };
        }
        const straightKm = haversineKm(from, to);
        const km = straightKm * config.detourFactor;
        if (km < config.minLegKm) {
            return { km: 0, straightKm: 0, skipped: true, reason: 'samePlace', options: [] };
        }
        if (landmassOf(from, config) !== landmassOf(to, config)) {
            return { km, straightKm, skipped: true, reason: 'seaCrossing', options: [] };
        }
        const base = carbonKg(config.baselineMode, km, n, factors);
        const options = feasibleModes(km, from, to, config, factors, ctx).map(f => {
            const c = carbonKg(f.mode, km, n, factors);
            const fac = factors.factors[f.mode];
            const tags = [];
            if (fac.tier === 1) tags.push('official');
            if (fac.tier === 2) tags.push('estimatedFactor');
            if (f.verifyStation) tags.push('verifyStation');
            return {
                mode: f.mode,
                timeMin: travelMin(f.mode, km, config, f.accessWalkKm),
                totalKg: c.totalKg,
                perPersonKg: c.perPersonKg,
                // 正數 = 比開車少排；負數 = 比開車多排；沒有汽車係數時為 null
                savedVsCarKg: base ? base.totalKg - c.totalKg : null,
                tags,
            };
        }).filter(o => isFiniteNum(o.timeMin));
        const pick = pickSuggestion(options, config);
        return {
            km, straightKm, skipped: false, reason: null,
            insufficient: options.length < 2,
            carKg: base ? base.totalKg : null,
            options, ...pick,
        };
    }

    /** 整趟：起點 → 景點 1 → 景點 2 …（依旅客排好的順序，不自動排序） */
    function planTrip(origin, stops, people, config, factors, ctx) {
        const n = clampPeople(people, config);
        const pts = [origin, ...stops.slice(0, config.limits.maxStops)];
        const legs = [];
        for (let i = 1; i < pts.length; i++) {
            legs.push({ fromIndex: i - 1, toIndex: i, ...computeLeg(pts[i - 1], pts[i], n, config, factors, ctx) });
        }
        return { people: n, legs };
    }

    /**
     * 依旅客選的方式（每段一個，沒選就用建議）加總。
     * 跳過的段落（同地點、跨海）不計入。
     */
    function summarize(trip, selection) {
        let totalKg = 0, totalMin = 0, carKg = 0, counted = 0, carComparable = true;
        const chosen = trip.legs.map((leg, i) => {
            if (leg.skipped || !leg.options.length) return null;
            const want = selection && selection[i];
            const opt = leg.options.find(o => o.mode === want) || leg.options.find(o => o.mode === leg.suggested);
            totalKg += opt.totalKg;
            totalMin += opt.timeMin;
            if (leg.carKg === null) carComparable = false;
            else carKg += leg.carKg;
            counted++;
            return opt.mode;
        });
        const people = trip.people;
        return {
            chosen,
            legsCounted: counted,
            totalKg,
            perPersonKg: totalKg / people,
            totalMin,
            carKg: carComparable ? carKg : null,
            savedVsCarKg: carComparable ? carKg - totalKg : null,
        };
    }

    return {
        haversineKm, roadKm, landmassOf, clampPeople,
        addStop, removeStop, moveStop,
        carbonKg, travelMin, feasibleModes, pickSuggestion,
        computeLeg, planTrip, summarize,
    };
});
