// 從「政府資料開放平臺 data.gov.tw」下載交通部觀光署的觀光資訊資料庫，產生 data/locations.json
//
// 資料來源（免金鑰、每日更新、政府資料開放授權條款第 1 版）：
//   景點 https://data.gov.tw/dataset/7777
//   餐飲 https://data.gov.tw/dataset/7779
//   活動 https://data.gov.tw/dataset/7778
//
// 做法：下載完整資料 → 轉成網站用的格式 → 各縣市平均挑選（不集中在少數縣市，總數約 750 筆）
// 執行：node scripts/fetch-opendata.mjs            （寫入 data/locations.json）
//       OUTPUT=/tmp/preview.json node scripts/fetch-opendata.mjs   （只輸出預覽）
// 需要系統有 unzip 指令（macOS、GitHub Actions 的 ubuntu 都有）

import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

const BASE = 'https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw';
const OUTPUT = process.env.OUTPUT || 'data/locations.json';
const MAX_ZIP_BYTES = 50 * 1024 * 1024;   // 安全上限：異常大的檔案不處理

// category 必須和 index.html 的 TDX_SOURCES.name 完全一致
// max：這一類總共最多幾筆；perCity：每個縣市最多幾筆（讓全台平均分布）
const SOURCES = [
  { file: 'Attraction', list: 'Attractions', idField: 'AttractionID', nameField: 'AttractionName',
    category: 'Tourist attractions', icon: 'S', color: '#c96b1a', max: 600, perCity: 20 },
  { file: 'Restaurant', list: 'Restaurants', idField: 'RestaurantID', nameField: 'RestaurantName',
    category: 'Tourist restaurant', icon: 'R', color: '#2b8c6e', max: 300, perCity: 10 },
  { file: 'Event', list: 'Events', idField: 'EventID', nameField: 'EventName',
    category: 'Cultural and creative activities', icon: 'A', color: '#9e2a1c', max: 200, perCity: 8, isEvent: true },
];

const clean = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

// 只接受單純的 http(s) 網址：前端會把網址放進 HTML 屬性，含引號或角括號的一律丟棄
function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\/[^\s"'<>`]+$/i.test(s) ? s : '';
}

// 從縣市欄位或地址開頭取出縣市（統一成「臺」）
export function cityOf(text) {
  const m = String(text || '').replace(/台/g, '臺').replace(/^\s*\d{3,6}\s*/, '').match(/^(..[縣市])/);
  return m ? m[1] : '';
}

export function convert(src, item, now = Date.now()) {
  const lat = parseFloat(item.PositionLat);
  const lng = parseFloat(item.PositionLon);
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < 21.5 || lat > 26.5 || lng < 118.0 || lng > 122.5) return null;

  const id = clean(item[src.idField]);
  const name = clean(item[src.nameField]);
  if (!id || !name) return null;

  if (src.isEvent) {
    if (item.EventStatus === 'EventCancelled') return null;
    const end = item.EndDateTime ? Date.parse(item.EndDateTime) : NaN;
    if (!isNaN(end) && end < now) return null;   // 已結束的活動不收
  }

  const a = item.PostalAddress || {};
  const addr = clean([a.City, a.Town, a.StreetAddress].filter(Boolean).join(''));
  const city = cityOf(a.City || addr);
  if (!city) return null;

  return {
    id,
    name,
    category: src.category,
    icon: src.icon,
    color: src.color,
    lat, lng, addr,
    desc: clean(item.Description).slice(0, 200),
    pic: safeUrl(item.Images?.[0]?.URL),
    officialUrl: safeUrl(item.WebsiteURL) || 'https://www.taiwan.net.tw/',
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + addr)}`,
    city,
  };
}

// 資料品質分數：有照片、有足夠介紹的優先
function quality(loc) {
  return (loc.pic ? 2 : 0) + (loc.desc.length >= 30 ? 1 : 0);
}

/**
 * 依縣市平均挑選資料。
 * - 穩定：上次已經選過的地點優先保留（集章綁定地點 id，不能每週大洗牌）
 * - 平均：各縣市輪流挑，每縣市最多 perCity 筆，總數最多 max 筆
 * - 品質：同縣市內，有照片、有介紹的優先，其次依 id 排序（結果固定，不隨機）
 */
export function selectBalanced(locs, { max, perCity }, previousIds = new Set()) {
  const byCity = new Map();
  for (const loc of locs) {
    if (!byCity.has(loc.city)) byCity.set(loc.city, []);
    byCity.get(loc.city).push(loc);
  }
  for (const list of byCity.values()) {
    list.sort((a, b) =>
      (previousIds.has(b.id) - previousIds.has(a.id)) ||
      (quality(b) - quality(a)) ||
      a.id.localeCompare(b.id));
  }

  const picked = [];
  const cities = [...byCity.keys()].sort();
  for (let round = 0; round < perCity && picked.length < max; round++) {
    for (const c of cities) {
      const loc = byCity.get(c)[round];
      if (loc && picked.length < max) picked.push(loc);
    }
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

// 下載 zip 並讀出其中的 <file>List.json（檔案開頭有 BOM，要去掉）
async function download(src, dir) {
  const url = `${BASE}/${src.file}-json.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error('zip too large');
  const zipPath = join(dir, `${src.file}.zip`);
  await writeFile(zipPath, buf);
  // execFile 不經過 shell，參數不會被當成指令解析
  const { stdout } = await run('unzip', ['-p', zipPath, `${src.file}List.json`], { maxBuffer: 200 * 1024 * 1024 });
  const json = JSON.parse(stdout.replace(/^﻿/, ''));
  const items = json[src.list];
  if (!Array.isArray(items)) throw new Error(`missing ${src.list}`);
  return items;
}

async function loadPrevious() {
  try {
    const arr = JSON.parse(await readFile('data/locations.json', 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function main() {
  const previous = await loadPrevious();
  const previousIds = new Set(previous.map(p => p.id));
  const dir = await mkdtemp(join(tmpdir(), 'opendata-'));
  const output = [];

  try {
    for (const src of SOURCES) {
      let locs = [];
      try {
        const raw = await download(src, dir);
        const converted = raw.map(it => convert(src, it)).filter(Boolean);
        locs = selectBalanced(converted, src, previousIds);
        const cities = new Set(locs.map(l => l.city)).size;
        console.log(`${src.file}: raw ${raw.length} -> valid ${converted.length} -> kept ${locs.length} (${cities} cities)`);
      } catch (e) {
        console.log(`${src.file}: error ${e.message}`);
      }

      // 這個來源抓不到時，沿用上次的舊資料，避免整份資料壞掉
      if (locs.length === 0) {
        locs = previous.filter(p => p.category === src.category);
        console.log(`${src.file}: fallback to previous data (${locs.length})`);
      }
      output.push(...locs);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (output.length === 0) throw new Error('No data at all, abort');

  await mkdir(OUTPUT.includes('/') ? OUTPUT.slice(0, OUTPUT.lastIndexOf('/')) : '.', { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(output));
  console.log(`Wrote ${output.length} locations to ${OUTPUT}`);
}

// 直接執行時才跑（讓測試可以單獨 import）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
