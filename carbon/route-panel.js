/* ══════════════════════════════════════════════════
   行程路線與碳排：介面（docs/carbon-route-prompt.md §7）
   - 需要先載入 carbon/strings.js、carbon/carbon-core.js，以及 index.html 主程式
     （使用其中的 allLocations、map、HAS_MAP、showStatus）
   - 不修改 selectLocation 本身，只在外面包一層，在原本的流程跑完後更新「加入行程」按鈕
   - 所有資料文字（景點名稱、來源名稱）一律用 textContent，不用 innerHTML
   - 純前端：不呼叫後端、不呼叫 AI；位置不儲存、不上傳
══════════════════════════════════════════════════ */
(function () {
    'use strict';

    const core = window.CarbonCore;
    const { tr, getLang } = window.CarbonStrings;

    // 地圖線條顏色（沿用網站色票）
    const MODE_COLORS = {
        walk: '#5a8f8f', bicycle: '#3f7d4e', bus: '#c96b1a', mrt: '#2b5f6e',
        train: '#2b5f6e', hsr: '#7a4e8c', motorcycle: '#b87355', car: '#9e2a1c',
    };

    const state = {
        config: null,
        factors: null,
        loadError: false,
        stops: [],          // [{ id, name, lat, lng }]，依旅客加入的順序
        origin: null,       // { lat, lng }，不儲存
        people: 1,
        picking: false,
        locating: false,
        trip: null,         // core.planTrip 的結果
        selection: {},      // 段落索引 → 交通方式
        collapsed: false,
        currentLoc: null,   // 資訊面板目前顯示的地點
        layer: null,        // 地圖圖層（起點標記與示意直線）
        message: '',        // 提示訊息的 key（切換語言時跟著換）
    };

    /* ── 小工具 ───────────────────────────── */

    /** 建立元素：h('div', { class: 'x', onclick: fn }, '文字', child) ；文字一律走 textContent */
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return el;
    }

    function numberFormat(x, digits) {
        return new Intl.NumberFormat(getLang(), { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(x);
    }

    /** 公斤：0 顯示 0；很小的值顯示 <0.01；10 以上取 1 位小數 */
    function fmtKg(kg) {
        const v = Math.abs(kg);
        if (v === 0) return '0';
        if (v < 0.01) return '<' + numberFormat(0.01, 2);
        return numberFormat(v, v >= 10 ? 1 : 2);
    }

    function fmtKm(km) {
        return numberFormat(km, km >= 10 ? 0 : 1);
    }

    function fmtTime(min) {
        const m = Math.max(1, Math.round(min));
        if (m < 60) return tr('time.min', { m });
        return tr('time.hm', { h: Math.floor(m / 60), m: m % 60 });
    }

    function modeName(mode) {
        return tr('mode.' + mode);
    }

    function toast(msg) {
        if (typeof showStatus === 'function') showStatus(msg);
    }

    /* ── 設定與係數 ───────────────────────── */

    async function loadData() {
        try {
            const [c, f] = await Promise.all([
                fetch('./carbon/carbon-config.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
                fetch('./carbon/carbon-factors.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
            ]);
            state.config = c;
            state.factors = f;
        } catch (e) {
            console.warn('carbon data load failed:', e.message);
            state.loadError = true;
        }
        render();
    }

    /* ── 行程內容 ─────────────────────────── */

    function inTrip(id) {
        return state.stops.some(s => s.id === id);
    }

    function toggleStop(loc) {
        if (!state.config || !loc) return;
        if (inTrip(loc.id)) {
            state.stops = core.removeStop(state.stops, loc.id);
        } else {
            const r = core.addStop(state.stops,
                { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng }, state.config);
            if (!r.ok) {
                toast(tr(r.reason === 'full' ? 'msg.full' : 'msg.duplicate', { max: state.config.limits.maxStops }));
                return;
            }
            state.stops = r.stops;
            state.collapsed = false;
            toast(tr('msg.added', { name: loc.name }));
        }
        changed();
    }

    function moveStop(id, delta) {
        state.stops = core.moveStop(state.stops, id, delta);
        changed();
    }

    function removeStop(id) {
        state.stops = core.removeStop(state.stops, id);
        changed();
    }

    function setPeople(n) {
        state.people = core.clampPeople(n, state.config);
        changed();
    }

    /** 輸入變動：已經查詢過的話就直接重算（純計算，很快） */
    function changed() {
        if (state.trip) {
            if (canQuery()) compute();
            else { state.trip = null; state.selection = {}; }
        }
        render();
        renderSlot();
    }

    function canQuery() {
        return !!(state.config && state.origin && state.stops.length > 0);
    }

    function compute() {
        // 同一對起訖的段落，保留旅客原本選的交通方式（例如只改人數時）
        const prevByKey = {};
        if (state.trip) {
            state.trip.legs.forEach((leg, i) => {
                if (state.selection[i]) prevByKey[state.trip.keys[i]] = state.selection[i];
            });
        }
        const pts = currentPoints();
        const pointKey = p => p.id || `${p.lat},${p.lng}`;
        state.trip = core.planTrip(state.origin, state.stops, state.people, state.config, state.factors);
        state.trip.keys = state.trip.legs.map(leg => `${pointKey(pts[leg.fromIndex])}>${pointKey(pts[leg.toIndex])}`);
        const sel = {};
        state.trip.legs.forEach((leg, i) => {
            const want = prevByKey[state.trip.keys[i]];
            if (want && leg.options.some(o => o.mode === want)) sel[i] = want;
        });
        state.selection = sel;
    }

    function currentPoints() {
        return [state.origin, ...state.stops];
    }

    function query() {
        if (!canQuery()) {
            state.message = 'panel.needInput';
            render();
            return;
        }
        state.message = '';
        compute();
        render();
    }

    /* ── 起點 ─────────────────────────────── */

    function startPicking() {
        if (typeof HAS_MAP === 'undefined' || !HAS_MAP) return;
        state.picking = !state.picking;
        document.getElementById('map').classList.toggle('trip-picking', state.picking);
        if (state.picking) toast(tr('panel.pickHint'));
        render();
    }

    function onMapClick(e) {
        if (!state.picking) return;
        state.picking = false;
        document.getElementById('map').classList.remove('trip-picking');
        state.origin = { lat: e.latlng.lat, lng: e.latlng.lng };
        state.message = '';
        changed();
    }

    function useMyLocation() {
        if (!navigator.geolocation) {
            state.message = 'panel.locationError';
            render();
            return;
        }
        state.locating = true;
        state.message = '';
        render();
        navigator.geolocation.getCurrentPosition(pos => {
            state.locating = false;
            state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            if (HAS_MAP) map.setView([state.origin.lat, state.origin.lng], 13);
            changed();
        }, () => {
            state.locating = false;
            state.message = 'panel.locationError';
            render();
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
    }

    /* ── 地圖圖層：起點標記與示意直線 ─────── */

    function drawMap() {
        if (typeof HAS_MAP === 'undefined' || !HAS_MAP) return;
        if (state.layer) map.removeLayer(state.layer);
        state.layer = L.layerGroup().addTo(map);

        if (state.origin) {
            L.circleMarker([state.origin.lat, state.origin.lng], {
                radius: 9, color: '#ffffff', weight: 3, fillColor: '#2b5f6e', fillOpacity: 1,
            }).bindTooltip(tr('result.originName'), { permanent: false }).addTo(state.layer);
        }

        // 景點順序編號
        state.stops.forEach((s, i) => {
            L.marker([s.lat, s.lng], {
                interactive: false,
                icon: L.divIcon({ className: 'trip-num-icon', html: String(i + 1), iconSize: [20, 20], iconAnchor: [10, 40] }),
            }).addTo(state.layer);
        });

        if (!state.trip) return;
        const pts = currentPoints();
        const sum = core.summarize(state.trip, state.selection);
        state.trip.legs.forEach((leg, i) => {
            const a = pts[leg.fromIndex], b = pts[leg.toIndex];
            if (!a || !b || leg.reason === 'samePlace' || leg.reason === 'invalidPoint') return;
            const mode = sum.chosen[i];
            L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
                color: mode ? MODE_COLORS[mode] : '#888888',
                weight: 4, opacity: 0.85, dashArray: '8 8',
            }).bindTooltip(tr('result.lineNote'), { sticky: true }).addTo(state.layer);
        });
    }

    /* ── 資訊面板的「加入行程」按鈕 ────────── */

    function renderSlot() {
        const slot = document.getElementById('tripSlot');
        if (!slot) return;
        slot.replaceChildren();
        const loc = state.currentLoc;
        if (!loc || !state.config) return;
        const added = inTrip(loc.id);
        slot.appendChild(h('button', {
            type: 'button',
            class: 'panel-link-btn trip-slot-btn' + (added ? ' added' : ''),
            onclick: () => toggleStop(loc),
        }, tr(added ? 'slot.remove' : 'slot.add')));
    }

    function hookSelectLocation() {
        const original = window.selectLocation;
        if (typeof original !== 'function') return;
        window.selectLocation = function (i) {
            const result = original.apply(this, arguments);
            state.currentLoc = (typeof allLocations !== 'undefined' && allLocations[i]) || null;
            renderSlot();
            return result;
        };
    }

    /* ── 行程面板 ─────────────────────────── */

    function render() {
        const root = document.getElementById('tripPanel');
        if (!root) return;
        root.classList.toggle('collapsed', state.collapsed);
        root.replaceChildren();

        const max = state.config ? state.config.limits.maxStops : 8;
        root.appendChild(h('button', {
            type: 'button', class: 'trip-head',
            'aria-expanded': String(!state.collapsed),
            title: tr(state.collapsed ? 'panel.expand' : 'panel.collapse'),
            onclick: () => { state.collapsed = !state.collapsed; render(); },
        },
            h('span', { class: 'trip-head-title' }, tr('panel.title')),
            h('span', { class: 'trip-head-count' }, tr('panel.count', { n: state.stops.length, max })),
            h('span', { class: 'trip-head-caret' }, state.collapsed ? '▴' : '▾'),
        ));

        if (state.collapsed) { drawMap(); return; }

        const body = h('div', { class: 'trip-body' });
        root.appendChild(body);

        if (state.loadError) {
            body.appendChild(h('p', { class: 'trip-msg' }, tr('method.loadError')));
            return;
        }
        if (!state.config) return;

        // 景點清單
        if (!state.stops.length) {
            body.appendChild(h('p', { class: 'trip-empty' }, tr('panel.empty')));
        } else {
            const list = h('ol', { class: 'trip-stops' });
            state.stops.forEach((s, i) => {
                list.appendChild(h('li', {},
                    h('span', { class: 'trip-stop-name' }, s.name),
                    h('span', { class: 'trip-stop-actions' },
                        h('button', { type: 'button', title: tr('panel.up'), 'aria-label': tr('panel.up'),
                            disabled: i === 0, onclick: () => moveStop(s.id, -1) }, '▲'),
                        h('button', { type: 'button', title: tr('panel.down'), 'aria-label': tr('panel.down'),
                            disabled: i === state.stops.length - 1, onclick: () => moveStop(s.id, 1) }, '▼'),
                        h('button', { type: 'button', title: tr('panel.remove'), 'aria-label': tr('panel.remove'),
                            onclick: () => removeStop(s.id) }, '✕'),
                    )));
            });
            body.appendChild(list);
        }

        // 起點
        const originText = state.origin
            ? tr('panel.originSet', { lat: state.origin.lat.toFixed(4), lng: state.origin.lng.toFixed(4) })
            : tr('panel.originNone');
        body.appendChild(h('div', { class: 'trip-row' },
            h('div', { class: 'trip-label' }, tr('panel.origin')),
            h('div', { class: 'trip-origin-text' }, originText),
            h('div', { class: 'trip-btns' },
                h('button', { type: 'button', class: 'trip-btn' + (state.picking ? ' active' : ''), onclick: startPicking },
                    tr(state.picking ? 'panel.pickHint' : 'panel.pickOnMap')),
                h('button', { type: 'button', class: 'trip-btn', disabled: state.locating, onclick: useMyLocation },
                    tr(state.locating ? 'panel.locating' : 'panel.useLocation')),
            ),
            h('div', { class: 'trip-note' }, tr('panel.locationNote')),
        ));

        // 人數
        const { minPeople, maxPeople } = state.config.limits;
        const input = h('input', {
            type: 'number', min: minPeople, max: maxPeople, step: 1, value: state.people,
            'aria-label': tr('panel.people'),
            onchange: e => setPeople(e.target.value),
        });
        body.appendChild(h('div', { class: 'trip-row trip-people' },
            h('div', { class: 'trip-label' }, tr('panel.people')),
            h('button', { type: 'button', class: 'trip-step', disabled: state.people <= minPeople,
                'aria-label': '−', onclick: () => setPeople(state.people - 1) }, '−'),
            input,
            h('button', { type: 'button', class: 'trip-step', disabled: state.people >= maxPeople,
                'aria-label': '+', onclick: () => setPeople(state.people + 1) }, '+'),
        ));

        body.appendChild(h('button', { type: 'button', class: 'trip-query', onclick: query }, tr('panel.query')));
        if (state.message) body.appendChild(h('p', { class: 'trip-msg' }, tr(state.message)));

        if (state.trip) body.appendChild(renderResults());
        drawMap();
    }

    function renderResults() {
        const wrap = h('div', { class: 'trip-results' });
        wrap.appendChild(h('p', { class: 'trip-disclaimer' },
            tr('result.disclaimer', { detour: numberFormat(state.config.detourFactor, 2) }), ' ',
            tr('result.lineNote')));
        wrap.appendChild(h('button', { type: 'button', class: 'trip-link', onclick: openMethod }, tr('result.method')));

        const pts = currentPoints();
        const names = [tr('result.originName'), ...state.stops.map(s => s.name)];
        const sum = core.summarize(state.trip, state.selection);

        state.trip.legs.forEach((leg, i) => {
            const card = h('section', { class: 'trip-leg' });
            card.appendChild(h('h4', {}, tr('result.legTitle', { from: names[leg.fromIndex], to: names[leg.toIndex] })));
            if (leg.skipped) {
                if (leg.reason === 'seaCrossing') card.appendChild(h('div', { class: 'trip-leg-km' }, tr('result.legKm', { km: fmtKm(leg.km) })));
                card.appendChild(h('p', { class: 'trip-msg' }, tr('skip.' + leg.reason)));
                wrap.appendChild(card);
                return;
            }
            card.appendChild(h('div', { class: 'trip-leg-km' }, tr('result.legKm', { km: fmtKm(leg.km) })));
            card.appendChild(h('p', { class: 'trip-suggest' }, suggestionText(leg)));
            if (leg.insufficient) card.appendChild(h('p', { class: 'trip-msg' }, tr('leg.insufficient')));

            const chosen = sum.chosen[i];
            const group = 'trip-leg-' + i;
            const opts = h('div', { class: 'trip-options', role: 'radiogroup' });
            for (const o of leg.options) {
                const badges = [];
                if (o.mode === leg.suggested) badges.push(h('span', { class: 'trip-badge suggested' }, tr('result.badge.suggested')));
                if (o.mode === leg.fastest) badges.push(h('span', { class: 'trip-badge' }, tr('result.badge.fastest')));
                if (o.mode === leg.lowestCarbon) badges.push(h('span', { class: 'trip-badge' }, tr('result.badge.lowest')));
                const tags = o.tags.map(t => h('span', { class: 'trip-tag tag-' + t }, tr('tag.' + t)));
                let vsCar = null;
                if (o.savedVsCarKg !== null && o.mode !== 'car') {
                    const d = o.savedVsCarKg;
                    vsCar = Math.abs(d) < 0.005 ? tr('result.vsCarSame')
                        : tr(d > 0 ? 'result.vsCarLess' : 'result.vsCarMore', { kg: fmtKg(d) });
                }
                const id = `${group}-${o.mode}`;
                opts.appendChild(h('label', { class: 'trip-opt' + (o.mode === chosen ? ' chosen' : ''), for: id },
                    h('input', { type: 'radio', name: group, id, value: o.mode, checked: o.mode === chosen,
                        onchange: () => { state.selection[i] = o.mode; render(); } }),
                    h('span', { class: 'trip-opt-main' },
                        h('span', { class: 'trip-opt-line' },
                            h('span', { class: 'trip-dot', style: `background:${MODE_COLORS[o.mode]}` }),
                            h('b', {}, modeName(o.mode)), ' ',
                            h('span', { class: 'trip-opt-time' }, tr('result.time', { time: fmtTime(o.timeMin) })),
                            ...badges),
                        h('span', { class: 'trip-opt-line trip-opt-kg' },
                            tr('result.kgTotal', { kg: fmtKg(o.totalKg) }),
                            state.trip.people > 1 ? ` · ${tr('result.kgPerPerson', { kg: fmtKg(o.perPersonKg) })}` : '',
                            vsCar ? ` · ${vsCar}` : ''),
                        tags.length ? h('span', { class: 'trip-opt-line' }, ...tags) : null,
                    )));
            }
            card.appendChild(opts);
            wrap.appendChild(card);
        });

        // 整趟合計
        const total = h('section', { class: 'trip-summary' }, h('h4', {}, tr('sum.title')));
        if (!sum.legsCounted) {
            total.appendChild(h('p', {}, tr('sum.noLegs')));
        } else {
            total.appendChild(h('p', {}, tr('sum.total', { kg: fmtKg(sum.totalKg), pp: fmtKg(sum.perPersonKg) })));
            total.appendChild(h('p', {}, tr('sum.time', { time: fmtTime(sum.totalMin) })));
            if (sum.savedVsCarKg !== null) {
                const d = sum.savedVsCarKg;
                total.appendChild(h('p', { class: 'trip-sum-car' }, Math.abs(d) < 0.005 ? tr('sum.vsCarSame')
                    : tr(d > 0 ? 'sum.vsCarLess' : 'sum.vsCarMore', { kg: fmtKg(d) })));
            }
        }
        wrap.appendChild(total);
        return wrap;
    }

    function suggestionText(leg) {
        const s = leg.options.find(o => o.mode === leg.suggested);
        if (!s) return '';
        if (s.mode === 'car') return tr('suggest.car');
        const car = leg.options.find(o => o.mode === 'car');
        if (!car || s.savedVsCarKg === null) return tr('suggest.noCar', { mode: modeName(s.mode) });
        const diff = Math.round(s.timeMin - car.timeMin);
        const params = { mode: modeName(s.mode), kg: fmtKg(s.savedVsCarKg), pp: state.trip.people > 1 ? tr('suggest.pp', { kg: fmtKg(s.savedVsCarKg / state.trip.people) }) : '', min: Math.abs(diff) };
        if (diff > 0) return tr('suggest.slower', params);
        if (diff < 0) return tr('suggest.faster', params);
        return tr('suggest.same', params);
    }

    /* ── 計算方式與資料來源 ───────────────── */

    function rangeText(r) {
        if (!r || (r.min === null && r.max === null)) return tr('method.rangeAny');
        if (r.min !== null && r.max !== null) return tr('method.rangeBoth', { min: fmtKm(r.min), max: fmtKm(r.max) });
        if (r.min !== null) return tr('method.rangeMin', { min: fmtKm(r.min) });
        return tr('method.rangeMax', { max: fmtKm(r.max) });
    }

    function openMethod() {
        const { config, factors } = state;
        if (!config) return;
        closeMethod();

        const factorRows = config.modes.map(mode => {
            const f = factors.factors[mode];
            const ok = f && f.available;
            const src = ok && f.source && f.source.url
                ? h('a', { href: f.source.url, target: '_blank', rel: 'noopener' }, `${f.source.org}：${f.source.name}`)
                : tr('method.noSource');
            return h('tr', {},
                h('td', {}, modeName(mode)),
                h('td', {}, ok ? numberFormat(f.gCO2e / 1000, 4) : tr('method.unavailable')),
                h('td', {}, ok && f.year ? String(f.year) : '—'),
                h('td', {}, src, ok && f.notes ? h('div', { class: 'trip-method-note' }, f.notes) : null));
        });

        const assumptionRows = config.modes.filter(m => factors.factors[m] && factors.factors[m].available).map(mode =>
            h('tr', {},
                h('td', {}, modeName(mode)),
                h('td', {}, `${numberFormat(config.speedKmh[mode], 0)} km/h`),
                h('td', {}, config.waitMin[mode] ? tr('time.min', { m: config.waitMin[mode] }) : '—'),
                h('td', {}, rangeText(config.rangeKm[mode]))));

        const dialog = h('div', { class: 'trip-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tripMethodTitle',
            onclick: e => { if (e.target === dialog) closeMethod(); } },
            h('div', { class: 'trip-modal-card' },
                h('button', { type: 'button', class: 'trip-modal-close', 'aria-label': tr('method.close'), onclick: closeMethod }, '✕'),
                h('h3', { id: 'tripMethodTitle' }, tr('method.title')),
                h('p', {}, tr('method.formula')),
                h('p', {}, tr('method.distance', { detour: numberFormat(config.detourFactor, 2) })),
                h('p', {}, tr('method.time')),
                h('p', {}, tr('method.rule', { factor: numberFormat(config.suggestion.reasonableFactor, 2), extra: config.suggestion.reasonableExtraMin })),
                h('p', {}, tr('method.zero')),
                h('h4', {}, tr('method.factors')),
                h('div', { class: 'trip-table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {},
                        h('th', {}, tr('method.col.mode')), h('th', {}, tr('method.col.factor')),
                        h('th', {}, tr('method.col.year')), h('th', {}, tr('method.col.source')))),
                    h('tbody', {}, factorRows))),
                h('h4', {}, tr('method.assumptions')),
                h('div', { class: 'trip-table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {},
                        h('th', {}, tr('method.col.mode')), h('th', {}, tr('method.col.speed')),
                        h('th', {}, tr('method.col.wait')), h('th', {}, tr('method.col.range')))),
                    h('tbody', {}, assumptionRows))),
                h('h4', {}, tr('method.labels')),
                h('ul', {},
                    ['official', 'estimatedFactor', 'verifyStation'].map(t =>
                        h('li', {}, h('span', { class: 'trip-tag tag-' + t }, tr('tag.' + t)), ' ', tr('method.label.' + t)))),
                h('p', { class: 'trip-note' }, tr('method.retrieved', { date: factors.retrievedAt })),
            ));
        document.body.appendChild(dialog);
        dialog.querySelector('.trip-modal-close').focus();
    }

    function closeMethod() {
        document.querySelectorAll('.trip-modal').forEach(m => m.remove());
    }

    /* ── 啟動 ─────────────────────────────── */

    function init() {
        if (!core || !document.getElementById('tripPanel')) return;
        state.people = 1;
        hookSelectLocation();
        if (typeof HAS_MAP !== 'undefined' && HAS_MAP) map.on('click', onMapClick);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeMethod();
                if (state.picking) startPicking();
            }
        });
        // AI Guide 切換語言時一併更新（語言存在 localStorage 的 tct_lang）
        document.addEventListener('change', e => {
            if (e.target && e.target.classList && e.target.classList.contains('chat-lang')) {
                setTimeout(() => { render(); renderSlot(); }, 0);
            }
        });
        render();
        loadData().then(renderSlot);
    }

    init();
    window.RoutePanel = { state, render, openMethod };
})();
