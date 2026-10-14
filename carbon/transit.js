/* ══════════════════════════════════════════════════
   車站與公車可達資料（TDX 模式，docs/carbon-route-prompt.md §5.2）
   - 載入 data/transit_stations.json、data/bus_access.json（由 scripts/build-transit-data.mjs 產生）
   - 檔案不存在或格式不對時 ready = false，route-panel 會退回 MVP 模式
   - nearest(point, mode) → { km, id? }；沒有資料時回傳 null（該端改用 MVP 判斷）
══════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    const core = root.CarbonCore;
    const STATION_MODES = ['train', 'hsr', 'mrt'];

    const state = {
        ready: false,
        stationsByMode: {},   // mode → [{ id, lat, lng }]
        busAccess: null,      // 景點 id → 最近站牌距離（公里）或 null（搜尋範圍內沒有站牌）
        stationsAt: null,
        busAt: null,
    };

    async function getJson(url) {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
        return res.json();
    }

    async function load() {
        const [st, bus] = await Promise.allSettled([
            getJson('./data/transit_stations.json'),
            getJson('./data/bus_access.json'),
        ]);
        if (st.status === 'fulfilled' && Array.isArray(st.value.stations)) {
            for (const s of st.value.stations) {
                if (!STATION_MODES.includes(s.mode) || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
                (state.stationsByMode[s.mode] = state.stationsByMode[s.mode] || []).push({ id: s.id, lat: s.lat, lng: s.lng });
            }
            state.stationsAt = st.value.generatedAt || null;
        }
        if (bus.status === 'fulfilled' && bus.value.access && typeof bus.value.access === 'object') {
            state.busAccess = bus.value.access;
            state.busAt = bus.value.generatedAt || null;
        }
        state.ready = Object.keys(state.stationsByMode).length > 0 || !!state.busAccess;
        return state.ready;
    }

    function nearest(point, mode) {
        if (mode === 'bus') {
            // 只有景點有預先算好的距離；旅客自選的起點沒有（回傳 null → 標「需確認站點」）
            if (!state.busAccess || !point.id || !(point.id in state.busAccess)) return null;
            const km = state.busAccess[point.id];
            // null 代表搜尋範圍內沒有公車站牌：回傳極大距離，讓公車不出現
            return { km: Number.isFinite(km) ? km : Number.MAX_VALUE };
        }
        const list = state.stationsByMode[mode];
        if (!list || !list.length) return null;
        let best = null, bestKm = Infinity;
        for (const s of list) {
            const d = core.haversineKm(point, s);
            if (d < bestKm) { bestKm = d; best = s; }
        }
        return { km: bestKm, id: best.id };
    }

    root.CarbonTransit = { state, load, nearest };
})(typeof self !== 'undefined' ? self : this);
