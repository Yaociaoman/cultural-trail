/* ══════════════════════════════════════════════════
   行程路線與碳排：介面文字（docs/carbon-route-prompt.md §8）
   - 全站字典完成後再合併；目前語言讀 localStorage 的 tct_lang（與 AI Guide 共用）
   - 參數用 {name} 標記；文字一律以 textContent 顯示，不可放 HTML
   - ja、de：Phase 4 補齊，待人工審閱；缺少的 key 先退回英文
══════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    const LANGS = ['zh-TW', 'en', 'ja', 'de'];

    const STRINGS = {
        'zh-TW': {
            'mode.walk': '步行', 'mode.bicycle': '腳踏車', 'mode.bus': '公車', 'mode.mrt': '捷運',
            'mode.train': '臺鐵', 'mode.hsr': '高鐵', 'mode.motorcycle': '機車', 'mode.car': '汽車',

            'slot.add': '＋ 加入行程',
            'slot.remove': '－ 移出行程',
            'msg.full': '行程最多 {max} 個景點',
            'msg.duplicate': '這個景點已經在行程中',
            'msg.added': '已加入行程：{name}',

            'panel.title': '我的行程',
            'panel.count': '{n}／{max} 個景點',
            'panel.empty': '在地圖上點選景點，按「加入行程」。',
            'panel.up': '上移', 'panel.down': '下移', 'panel.remove': '移除',
            'panel.origin': '起點',
            'panel.originNone': '尚未選擇起點',
            'panel.originSet': '已選起點（{lat}, {lng}）',
            'panel.pickOnMap': '在地圖上點選',
            'panel.pickHint': '請在地圖上點一下作為起點',
            'panel.useLocation': '使用目前位置',
            'panel.locating': '定位中…',
            'panel.locationError': '無法取得目前位置，請改用「在地圖上點選」。',
            'panel.locationNote': '位置只用來計算，不會儲存或上傳。',
            'panel.people': '人數',
            'panel.query': '查詢路線',
            'panel.needInput': '請先選起點，並加入至少 1 個景點。',
            'panel.collapse': '收合', 'panel.expand': '展開',

            'result.disclaimer': '碳排為估算值，僅供參考。距離為直線距離 × {detour} 的估算，時間依平均速度估算。',
            'result.lineNote': '地圖上的線為示意直線，非實際路線。',
            'result.method': '計算方式與資料來源',
            'result.originName': '起點',
            'result.legTitle': '{from} → {to}',
            'result.legKm': '約 {km} 公里',
            'result.time': '約 {time}',
            'result.kgTotal': '{kg} kg CO₂e',
            'result.kgPerPerson': '每人 {kg} kg',
            'result.vsCarLess': '比開車少 {kg} kg',
            'result.vsCarMore': '比開車多 {kg} kg',
            'result.vsCarSame': '與開車相同',
            'result.badge.suggested': '建議', 'result.badge.fastest': '最快', 'result.badge.lowest': '最低碳',
            'tag.official': '官方資料', 'tag.estimatedFactor': '估算・係數', 'tag.verifyStation': '需確認站點',
            'skip.samePlace': '起點與終點相同，這一段略過。',
            'skip.seaCrossing': '這一段跨海，需搭飛機或船，不計入碳排。',
            'skip.invalidPoint': '這一段的位置資料有誤，已略過。',
            'leg.insufficient': '這一段目前資料不足，僅供參考。',
            'suggest.slower': '這一段建議{mode}，比開車少排約 {kg} kg CO₂e{pp}，約多花 {min} 分鐘。',
            'suggest.faster': '這一段建議{mode}，比開車少排約 {kg} kg CO₂e{pp}，還省約 {min} 分鐘。',
            'suggest.same': '這一段建議{mode}，比開車少排約 {kg} kg CO₂e{pp}，時間差不多。',
            'suggest.pp': '（每人 {kg} kg）',
            'suggest.car': '這一段開車最省時；其他方式所需時間明顯較長，可依需要自行選擇。',
            'suggest.noCar': '這一段建議{mode}。',
            'sum.title': '整趟合計',
            'sum.total': '總碳排 {kg} kg CO₂e（每人 {pp} kg）',
            'sum.time': '總時間約 {time}',
            'sum.vsCarLess': '比每段都開車少排 {kg} kg CO₂e',
            'sum.vsCarMore': '比每段都開車多排 {kg} kg CO₂e',
            'sum.vsCarSame': '與每段都開車相同',
            'sum.noLegs': '沒有可計算的路段。',
            'time.min': '{m} 分鐘', 'time.hm': '{h} 小時 {m} 分',

            'method.title': '計算方式與資料來源',
            'method.close': '關閉',
            'method.formula': '碳排 = 每人每公里係數 × 估算距離 × 人數。官方係數單位為「延人公里」（每人每公里），汽車與機車也依官方的每人基準計算。',
            'method.distance': '估算距離 = 兩點直線距離 × 繞路係數 {detour}。',
            'method.time': '時間 = 距離 ÷ 平均速度 ＋ 等車時間（皆為假設值）。',
            'method.rule': '建議規則：先找出最快的方式，在「不超過最快時間 × {factor}，或最快時間 ＋ {extra} 分鐘（取較長者）」的範圍內，選碳排最低的方式。',
            'method.zero': '步行、腳踏車僅計算行駛過程，視為 0 排放（不含製造與生命週期排放）。',
            'method.factors': '排放係數',
            'method.assumptions': '假設值',
            'method.labels': '標籤說明',
            'method.col.mode': '交通方式', 'method.col.factor': '係數（kg CO₂e／人·公里）',
            'method.col.year': '年度', 'method.col.source': '來源',
            'method.col.speed': '平均速度', 'method.col.wait': '等車', 'method.col.range': '顯示距離',
            'method.unavailable': '無官方係數，不顯示',
            'method.noSource': '—',
            'method.rangeAny': '不限',
            'method.rangeMin': '≥ {min} 公里', 'method.rangeMax': '≤ {max} 公里', 'method.rangeBoth': '{min}～{max} 公里',
            'method.label.official': '係數來自政府資料開放平臺的官方資料集。',
            'method.label.estimatedFactor': '係數來自其他有出處的來源（目前未使用）。',
            'method.label.verifyStation': '未確認附近是否有站點，只依距離判斷可能可搭，請出發前確認。',
            'method.retrieved': '資料整理日期：{date}',
            'method.loadError': '無法載入碳排設定檔，請用本機伺服器開啟網站。',
        },

        en: {
            'mode.walk': 'Walk', 'mode.bicycle': 'Bicycle', 'mode.bus': 'Bus', 'mode.mrt': 'MRT',
            'mode.train': 'TRA train', 'mode.hsr': 'High Speed Rail', 'mode.motorcycle': 'Scooter', 'mode.car': 'Car',

            'slot.add': '+ Add to trip',
            'slot.remove': '− Remove from trip',
            'msg.full': 'A trip can have up to {max} places',
            'msg.duplicate': 'This place is already in your trip',
            'msg.added': 'Added to trip: {name}',

            'panel.title': 'My Trip',
            'panel.count': '{n}/{max} places',
            'panel.empty': 'Select a place on the map and tap “Add to trip”.',
            'panel.up': 'Move up', 'panel.down': 'Move down', 'panel.remove': 'Remove',
            'panel.origin': 'Start',
            'panel.originNone': 'No starting point yet',
            'panel.originSet': 'Start set ({lat}, {lng})',
            'panel.pickOnMap': 'Pick on map',
            'panel.pickHint': 'Tap the map to set your starting point',
            'panel.useLocation': 'Use my location',
            'panel.locating': 'Locating…',
            'panel.locationError': 'Could not get your location. Please pick a point on the map instead.',
            'panel.locationNote': 'Your location is only used for this calculation; it is not stored or uploaded.',
            'panel.people': 'Travellers',
            'panel.query': 'Find routes',
            'panel.needInput': 'Choose a starting point and add at least 1 place.',
            'panel.collapse': 'Collapse', 'panel.expand': 'Expand',

            'result.disclaimer': 'Carbon figures are estimates for reference only. Distance = straight line × {detour}; times use average speeds.',
            'result.lineNote': 'Lines on the map are straight-line sketches, not actual routes.',
            'result.method': 'Method & data sources',
            'result.originName': 'Start',
            'result.legTitle': '{from} → {to}',
            'result.legKm': 'about {km} km',
            'result.time': 'about {time}',
            'result.kgTotal': '{kg} kg CO₂e',
            'result.kgPerPerson': '{kg} kg per person',
            'result.vsCarLess': '{kg} kg less than by car',
            'result.vsCarMore': '{kg} kg more than by car',
            'result.vsCarSame': 'same as by car',
            'result.badge.suggested': 'Suggested', 'result.badge.fastest': 'Fastest', 'result.badge.lowest': 'Lowest carbon',
            'tag.official': 'Official data', 'tag.estimatedFactor': 'Estimate · factor', 'tag.verifyStation': 'Check stations',
            'skip.samePlace': 'Start and end are the same place; this leg is skipped.',
            'skip.seaCrossing': 'This leg crosses the sea (plane or ferry) and is not included.',
            'skip.invalidPoint': 'Location data for this leg is invalid; skipped.',
            'leg.insufficient': 'Limited data for this leg; for reference only.',
            'suggest.slower': 'Suggested: {mode} — about {kg} kg CO₂e less than driving{pp}, about {min} min longer.',
            'suggest.faster': 'Suggested: {mode} — about {kg} kg CO₂e less than driving{pp}, and about {min} min faster.',
            'suggest.same': 'Suggested: {mode} — about {kg} kg CO₂e less than driving{pp}, similar travel time.',
            'suggest.pp': ' ({kg} kg per person)',
            'suggest.car': 'Driving is the quickest for this leg; other options take much longer. Choose whatever suits you.',
            'suggest.noCar': 'Suggested: {mode}.',
            'sum.title': 'Whole trip',
            'sum.total': 'Total {kg} kg CO₂e ({pp} kg per person)',
            'sum.time': 'Total time about {time}',
            'sum.vsCarLess': '{kg} kg CO₂e less than driving every leg',
            'sum.vsCarMore': '{kg} kg CO₂e more than driving every leg',
            'sum.vsCarSame': 'Same as driving every leg',
            'sum.noLegs': 'No legs to calculate.',
            'time.min': '{m} min', 'time.hm': '{h} h {m} min',

            'method.title': 'Method & data sources',
            'method.close': 'Close',
            'method.formula': 'Carbon = factor per person-km × estimated distance × travellers. Official factors are per passenger-km; cars and scooters also use the official per-person figures.',
            'method.distance': 'Estimated distance = straight-line distance × detour factor {detour}.',
            'method.time': 'Time = distance ÷ average speed + waiting time (all assumptions).',
            'method.rule': 'Suggestion rule: find the fastest option, then among options taking no longer than the fastest × {factor} or the fastest + {extra} min (whichever is longer), pick the lowest carbon.',
            'method.zero': 'Walking and cycling count only the trip itself and are treated as zero emissions (manufacturing and life-cycle emissions excluded).',
            'method.factors': 'Emission factors',
            'method.assumptions': 'Assumptions',
            'method.labels': 'Labels',
            'method.col.mode': 'Mode', 'method.col.factor': 'Factor (kg CO₂e / person-km)',
            'method.col.year': 'Year', 'method.col.source': 'Source',
            'method.col.speed': 'Avg. speed', 'method.col.wait': 'Wait', 'method.col.range': 'Shown for',
            'method.unavailable': 'No official factor; not shown',
            'method.noSource': '—',
            'method.rangeAny': 'any distance',
            'method.rangeMin': '≥ {min} km', 'method.rangeMax': '≤ {max} km', 'method.rangeBoth': '{min}–{max} km',
            'method.label.official': 'Factor from an official dataset on Taiwan’s Government Open Data Platform.',
            'method.label.estimatedFactor': 'Factor from another cited source (not currently used).',
            'method.label.verifyStation': 'Nearby stations were not verified; shown based on distance only. Please check before you go.',
            'method.retrieved': 'Data compiled on {date}',
            'method.loadError': 'Could not load the carbon settings. Please open the site through a local server.',
        },

        ja: {},
        de: {},
    };

    function getLang() {
        try {
            const v = localStorage.getItem('tct_lang');
            if (LANGS.includes(v)) return v;
        } catch (e) { /* 私密模式等情況讀不到，用預設 */ }
        return 'zh-TW';
    }

    /** 取文字並代入參數；找不到時依序退回英文、繁中，最後才顯示 key */
    function tr(key, params) {
        const lang = getLang();
        let s = STRINGS[lang][key];
        if (s === undefined) s = STRINGS.en[key];
        if (s === undefined) s = STRINGS['zh-TW'][key];
        if (s === undefined) return key;
        return s.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? String(params[k]) : m));
    }

    root.CarbonStrings = { STRINGS, LANGS, getLang, tr };
})(typeof self !== 'undefined' ? self : this);
