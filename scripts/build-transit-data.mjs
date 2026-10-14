// 產生地圖頁「行程路線與碳排」用的運輸資料（docs/carbon-route-prompt.md §5.2）
//   data/transit_stations.json：臺鐵、高鐵、捷運車站（前端整份載入，找任一點最近的車站）
//   data/bus_access.json      ：每個景點到最近公車站牌的距離（公車站牌太多，不放前端）
//
// 執行：TDX_CLIENT_ID=... TDX_CLIENT_SECRET=... node scripts/build-transit-data.mjs
// - 金鑰只從環境變數讀取（GitHub Secrets），不會印出
// - 沒有金鑰、或某一類抓取失敗時，保留上次的檔案，不讓 workflow 失敗
// - API 路徑依 TDX 官方 swagger（公共運輸-軌道 v2／v3、公共運輸-公車 v2）
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { haversineKm } = require('../carbon/carbon-core.js');

const BASE = 'https://tdx.transportdata.tw/api/basic';
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const STATIONS_PATH = 'data/transit_stations.json';
const BUS_PATH = 'data/bus_access.json';
const LOCATIONS_PATH = 'data/locations.json';

const REQUEST_GAP_MS = 1200;   // 每次請求間隔
const MAX_RETRIES = 6;
const BUS_SEARCH_KM = 2;       // 超過這個距離就記為 null（附近沒有公車站牌）
const GRID_DEG = 0.01;         // 空間格網大小（約 1 公里）

// 捷運系統（TRTCMG 是貓空纜車，不列入）
const METRO_SYSTEMS = ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TMRT', 'NTMC', 'NTALRT'];
const BUS_CITIES = ['Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung', 'Keelung', 'Hsinchu',
  'HsinchuCounty', 'MiaoliCounty', 'ChanghuaCounty', 'NantouCounty', 'YunlinCounty', 'ChiayiCounty', 'Chiayi',
  'PingtungCounty', 'YilanCounty', 'HualienCounty', 'TaitungCounty', 'KinmenCounty', 'PenghuCounty', 'LienchiangCounty'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

async function getToken(id, secret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error('Token HTTP ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('No access_token');
  return data.access_token;
}

// 遇到 429／5xx 會自動等待重試；其他錯誤（401、403 等）直接回傳
async function tdxGet(path, token, query = {}) {
  const params = new URLSearchParams({ ...query, $format: 'JSON' });
  const url = `${BASE}${path}?${params}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip, br' } });
    if (res.ok) return { ok: true, json: await res.json() };
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 3000 * 2 ** attempt);
      console.log(`${path}: HTTP ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    return { ok: false, status: res.status, body: (await res.text()).slice(0, 200) };
  }
  return { ok: false, status: 429, body: 'retries exhausted' };
}

function validPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 21.5 && lat < 26.5 && lng > 118 && lng < 122.5;
}

/** TDX 車站 → 輸出格式；mode 對應 carbon-config 的交通方式（train／hsr／mrt） */
export function toStation(item, mode, operator) {
  const lat = Number(item.StationPosition?.PositionLat);
  const lng = Number(item.StationPosition?.PositionLon);
  const name = item.StationName?.Zh_tw;
  if (!validPoint(lat, lng) || !name || !item.StationUID) return null;
  return {
    id: item.StationUID, name, mode, operator,
    city: item.LocationCity || '',
    lat: round(lat, 5), lng: round(lng, 5),
  };
}

/** 空間格網：key = 格子座標 */
export function buildGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.lat / GRID_DEG)},${Math.floor(p.lng / GRID_DEG)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  return grid;
}

/** 某點到最近站牌的距離（公里），只看周圍幾格；找不到回傳 null */
export function nearestInGrid(grid, p, searchKm = BUS_SEARCH_KM) {
  const rings = Math.ceil(searchKm / (GRID_DEG * 111 * Math.cos(p.lat * Math.PI / 180))) + 1;
  const ci = Math.floor(p.lat / GRID_DEG), cj = Math.floor(p.lng / GRID_DEG);
  let best = Infinity;
  for (let di = -rings; di <= rings; di++) {
    for (let dj = -rings; dj <= rings; dj++) {
      for (const s of grid.get(`${ci + di},${cj + dj}`) || []) {
        const d = haversineKm(p, s);
        if (d < best) best = d;
      }
    }
  }
  return best <= searchKm ? round(best, 3) : null;
}

/** 每個景點到最近公車站牌的距離 */
export function buildBusAccess(locations, stops, searchKm = BUS_SEARCH_KM) {
  const grid = buildGrid(stops);
  const access = {};
  for (const loc of locations) {
    if (!loc.id || !validPoint(loc.lat, loc.lng)) continue;
    access[loc.id] = nearestInGrid(grid, loc, searchKm);
  }
  return access;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** 資料有變才寫檔（避免每週只因時間戳記不同就產生 commit） */
async function writeIfChanged(path, data) {
  const prev = await readJson(path, null);
  const strip = o => JSON.stringify({ ...o, generatedAt: undefined });
  if (prev && strip(prev) === strip(data)) {
    console.log(`${path}: 沒有變動`);
    return;
  }
  await writeFile(path, JSON.stringify(data) + '\n');
  console.log(`${path}: 已更新`);
}

async function buildStations(token) {
  const prev = await readJson(STATIONS_PATH, { stations: [] });
  const groups = [
    { mode: 'train', operator: 'TRA', path: '/v3/Rail/TRA/Station', pick: j => j.Stations },
    { mode: 'hsr', operator: 'THSR', path: '/v2/Rail/THSR/Station', pick: j => j },
    ...METRO_SYSTEMS.map(sys => ({ mode: 'mrt', operator: sys, path: `/v2/Rail/Metro/Station/${sys}`, pick: j => j })),
  ];
  const stations = [];
  const failed = [];
  for (const g of groups) {
    const r = await tdxGet(g.path, token);
    const items = r.ok ? g.pick(r.json) : null;
    if (Array.isArray(items) && items.length) {
      const list = items.map(it => toStation(it, g.mode, g.operator)).filter(Boolean);
      console.log(`${g.operator}: ${list.length} 站`);
      stations.push(...list);
    } else {
      // 這一類失敗：保留上次的資料
      console.log(`${g.operator}: 失敗（HTTP ${r.status ?? 'ok/empty'} ${r.body ?? ''}），保留上次資料`);
      failed.push(g.operator);
      stations.push(...prev.stations.filter(s => s.operator === g.operator));
    }
    await sleep(REQUEST_GAP_MS);
  }
  if (!stations.length) return false;
  await writeIfChanged(STATIONS_PATH, {
    generatedAt: new Date().toISOString(),
    source: 'TDX 運輸資料流通服務（交通部）：/v3/Rail/TRA/Station、/v2/Rail/THSR/Station、/v2/Rail/Metro/Station/{RailSystem}',
    failed,
    stations,
  });
  return true;
}

async function buildBus(token) {
  const locations = await readJson(LOCATIONS_PATH, []);
  if (!locations.length) {
    console.log('bus: 沒有景點資料，略過');
    return false;
  }
  const stops = [];
  const sources = [...BUS_CITIES.map(c => `/v2/Bus/Stop/City/${c}`), '/v2/Bus/Stop/InterCity'];
  for (const path of sources) {
    const r = await tdxGet(path, token, { $select: 'StopUID,StopPosition' });
    if (!r.ok || !Array.isArray(r.json)) {
      // 少一個縣市會讓距離變大（錯誤地顯示「附近沒有公車」），所以整份保留上次的檔案
      console.log(`${path}: 失敗（HTTP ${r.status} ${r.body ?? ''}），保留上次的 ${BUS_PATH}`);
      return false;
    }
    for (const s of r.json) {
      const lat = Number(s.StopPosition?.PositionLat), lng = Number(s.StopPosition?.PositionLon);
      if (validPoint(lat, lng)) stops.push({ lat, lng });
    }
    console.log(`${path}: ${r.json.length} 個站牌`);
    await sleep(REQUEST_GAP_MS);
  }
  await writeIfChanged(BUS_PATH, {
    generatedAt: new Date().toISOString(),
    source: 'TDX 運輸資料流通服務（交通部）：/v2/Bus/Stop/City/{City}、/v2/Bus/Stop/InterCity',
    searchKm: BUS_SEARCH_KM,
    stopCount: stops.length,
    access: buildBusAccess(locations, stops),
  });
  return true;
}

async function main() {
  const { TDX_CLIENT_ID, TDX_CLIENT_SECRET } = process.env;
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    console.log('沒有 TDX 金鑰（TDX_CLIENT_ID／TDX_CLIENT_SECRET），保留現有的運輸資料檔');
    return;
  }
  let token;
  try {
    token = await getToken(TDX_CLIENT_ID, TDX_CLIENT_SECRET);
  } catch (e) {
    console.log(`取得 TDX token 失敗（${e.message}），保留現有的運輸資料檔`);
    return;
  }
  await buildStations(token);
  await buildBus(token);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    // 不讓 workflow 失敗：觀光資料仍要能照常更新
    console.log('運輸資料更新失敗：' + e.message);
  });
}
