"""讀取 locations.json（唯讀）。檔案更新時自動重新載入。

注意：data/locations.json 由 GitHub Actions 每週覆蓋，這裡只讀不寫。
"""
import json
import logging
import re
import threading

from . import config

log = logging.getLogger("agent.data")

# 資料集的 category → 工具參數用的短名稱（小模型比較好填）
CATEGORY_KEYS = {
    "Tourist attractions": "attraction",
    "Tourist restaurant": "restaurant",
    "Cultural and creative activities": "activity",
}

# 縣市：正式名稱 → 可接受的別名（英文、簡寫、「台」寫法）
CITIES = {
    "臺北市": ["台北", "taipei"], "新北市": ["新北", "new taipei"], "桃園市": ["桃園", "taoyuan"],
    "臺中市": ["台中", "taichung"], "臺南市": ["台南", "tainan"], "高雄市": ["高雄", "kaohsiung"],
    "基隆市": ["基隆", "keelung"], "新竹市": ["新竹市", "hsinchu city"], "新竹縣": ["新竹縣", "hsinchu county"],
    "苗栗縣": ["苗栗", "miaoli"], "彰化縣": ["彰化", "changhua"], "南投縣": ["南投", "nantou"],
    "雲林縣": ["雲林", "yunlin"], "嘉義市": ["嘉義市", "chiayi city"], "嘉義縣": ["嘉義縣", "chiayi county"],
    "屏東縣": ["屏東", "pingtung"], "宜蘭縣": ["宜蘭", "yilan"], "花蓮縣": ["花蓮", "hualien"],
    "臺東縣": ["台東", "taitung"], "澎湖縣": ["澎湖", "penghu"], "金門縣": ["金門", "kinmen"],
    "連江縣": ["連江", "馬祖", "matsu", "lienchiang"],
}

_lock = threading.Lock()
_cache: dict = {"mtime": None, "items": [], "by_id": {}}


def normalize(text: str) -> str:
    """比對用：統一「台／臺」、轉小寫、去頭尾空白。"""
    return (text or "").replace("台", "臺").lower().strip()


def parse_city(addr: str) -> str:
    """從地址開頭取出縣市，例如「宜蘭縣大同鄉…」→「宜蘭縣」。"""
    m = re.match(r"\s*\d{0,6}\s*(..[縣市])", normalize(addr))
    return m.group(1) if m else ""


def match_city(text: str) -> str | None:
    """把使用者／模型給的城市字串對應到正式縣市名稱；對不到回傳 None。"""
    t = normalize(text)
    if not t:
        return None
    for city, aliases in CITIES.items():
        if t == city or t in (normalize(a) for a in aliases) or t == city[:2]:
            return city
    return None


def _prepare(raw: list) -> list[dict]:
    items = []
    for x in raw:
        if not isinstance(x, dict) or not x.get("id") or not x.get("name"):
            continue
        try:
            lat, lng = float(x["lat"]), float(x["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        items.append({
            **x,
            "lat": lat, "lng": lng,
            "cat": CATEGORY_KEYS.get(x.get("category"), "other"),
            "city": parse_city(x.get("addr", "")),
            "_name": normalize(x["name"]),
            "_addr": normalize(x.get("addr", "")),
            "_desc": normalize(x.get("desc", "")),
        })
    return items


def _load() -> None:
    path = config.LOCATIONS_PATH
    try:
        mtime = path.stat().st_mtime
    except OSError:
        log.warning("找不到地點資料檔")
        return
    with _lock:
        if _cache["mtime"] == mtime:
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                raise ValueError("格式應為陣列")
            items = _prepare(raw)
            _cache.update(mtime=mtime, items=items, by_id={x["id"]: x for x in items})
            log.info("已載入地點資料 %d 筆", len(items))
        except (OSError, ValueError) as e:
            # 讀取失敗時保留上一份資料
            log.warning("地點資料讀取失敗：%s", type(e).__name__)


def get_locations() -> list[dict]:
    """回傳地點清單；檔案修改時間變了才重新讀取。"""
    _load()
    return _cache["items"]


def get_by_id(location_id: str) -> dict | None:
    _load()
    return _cache["by_id"].get(location_id)


def available_cities() -> dict[str, int]:
    """資料中有哪些縣市、各幾筆（查不到時給模型做替代建議）。"""
    counts: dict[str, int] = {}
    for x in get_locations():
        if x["city"]:
            counts[x["city"]] = counts.get(x["city"], 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))
