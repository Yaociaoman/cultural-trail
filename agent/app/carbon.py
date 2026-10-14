"""碳排計算與交通方式判斷（docs/agent-spec.md §7）。

數字一律由這裡計算，模型只負責敘述。
"""
import json
from functools import lru_cache

from . import config

FACTORS_PATH = config.AGENT_DIR / "config" / "carbon_factors.json"

DETOUR = 1.3   # 直線距離 × 繞路係數 = 估算路程

# 捷運：官方碳足跡資料沒有係數，依使用者決定暫不列入
MODES = ["walk", "bicycle", "train", "hsr", "bus", "motorcycle", "car"]

# 單段距離限制（公里）：(最短, 最長)；None 代表不限
MODE_RANGE = {
    "walk": (None, 2),
    "bicycle": (None, 8),
    "train": (10, None),   # 太短的距離搭火車不實際
    "hsr": (40, None),
}

# 高鐵沿線縣市（西部走廊；兩端都在這些縣市且跨縣市才建議高鐵）
HSR_CITIES = {"臺北市", "新北市", "桃園市", "新竹縣", "新竹市", "苗栗縣", "臺中市", "彰化縣",
              "雲林縣", "嘉義縣", "嘉義市", "臺南市", "高雄市"}
# 離島：沒有臺鐵，跟本島之間也沒有陸路
ISLANDS = {"金門縣", "澎湖縣", "連江縣"}


@lru_cache(maxsize=1)
def factors() -> dict[str, float]:
    raw = json.loads(FACTORS_PATH.read_text(encoding="utf-8"))["factors"]
    return {mode: float(v["kg"]) for mode, v in raw.items()}


def road_km(straight_m: float) -> float:
    return round(straight_m / 1000 * DETOUR, 1)


def kg(mode: str, km: float) -> float:
    return round(factors()[mode] * km, 3)


def crosses_sea(city_a: str, city_b: str) -> bool:
    return city_a != city_b and (city_a in ISLANDS or city_b in ISLANDS)


def feasible_modes(km: float, city_a: str = "", city_b: str = "") -> list[str]:
    """這段距離可以用哪些交通方式（由程式決定，不是模型）。跨海（離島↔本島）回傳空清單。"""
    if crosses_sea(city_a, city_b):
        return []
    out = []
    for mode in MODES:
        lo, hi = MODE_RANGE.get(mode, (None, None))
        if (lo is not None and km < lo) or (hi is not None and km > hi):
            continue
        if mode == "hsr" and not (city_a in HSR_CITIES and city_b in HSR_CITIES and city_a != city_b):
            continue
        if mode == "train" and (city_a in ISLANDS or city_b in ISLANDS):
            continue
        out.append(mode)
    return out


def suggest(modes: list[str]) -> str | None:
    """可行方式中碳排最低的；同樣是 0（步行、腳踏車）時優先步行。"""
    if not modes:
        return None
    return min(modes, key=lambda m: (factors()[m], MODES.index(m)))
