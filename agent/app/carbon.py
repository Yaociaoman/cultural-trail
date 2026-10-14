"""碳排計算與交通方式判斷。

係數與設定和地圖頁共用同一份（carbon/carbon-factors.json、carbon/carbon-config.json），
改數字只要改那裡。Agent 只列出各交通方式的大約碳排，**不挑「建議」方式**：
建議由地圖頁的「我的行程」依時間與碳排的固定規則產生，兩邊才不會給出不同答案。
數字一律由這裡計算，模型只負責敘述。
"""
import json
from functools import lru_cache

from . import config

CARBON_DIR = config.AGENT_DIR.parent / "carbon"
FACTORS_PATH = CARBON_DIR / "carbon-factors.json"
CONFIG_PATH = CARBON_DIR / "carbon-config.json"


@lru_cache(maxsize=1)
def settings() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def factors() -> dict[str, float]:
    """可用的交通方式 → kg CO2e／人·公里（官方為每人基準；available=false 的不列入，例如捷運）。"""
    raw = json.loads(FACTORS_PATH.read_text(encoding="utf-8"))["factors"]
    return {mode: f["gCO2e"] / 1000 for mode, f in raw.items()
            if f.get("available") and f.get("basis") == "per_passenger_km" and f.get("gCO2e") is not None}


def modes() -> list[str]:
    """依設定檔的順序，只留有係數的交通方式。"""
    return [m for m in settings()["modes"] if m in factors()]


def road_km_raw(straight_m: float) -> float:
    """估算路程（公里）= 直線距離 × 繞路係數（與地圖頁相同），不四捨五入"""
    return straight_m / 1000 * settings()["detourFactor"]


def road_km(straight_m: float) -> float:
    return round(road_km_raw(straight_m), 1)


def kg(mode: str, km: float) -> float:
    return round(factors()[mode] * max(km, 0), 3)


def landmass(lat: float, lng: float) -> str:
    """離島回傳其 id，其餘視為本島 main（範圍見 carbon-config.json 的 landmasses）。"""
    for m in settings()["landmasses"]:
        min_lat, min_lng, max_lat, max_lng = m["bbox"]
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            return m["id"]
    return "main"


def _in_range(km: float, r: dict | None) -> bool:
    if not r:
        return True
    if r.get("min") is not None and km < r["min"]:
        return False
    if r.get("max") is not None and km > r["max"]:
        return False
    return True


def feasible_modes(km: float, a: tuple[float, float] | None = None, b: tuple[float, float] | None = None) -> list[str]:
    """這段距離可以用哪些交通方式（只依距離範圍與離島規則，同地圖頁沒有車站資料時的判斷）。
    a、b 為 (lat, lng)；跨海（本島↔離島）回傳空清單。"""
    cfg = settings()
    land_a = landmass(*a) if a else "main"
    land_b = landmass(*b) if b else "main"
    if land_a != land_b:
        return []
    out = []
    for mode in modes():
        if land_a != "main" and mode in cfg.get("mainOnlyModes", []):
            continue
        if mode in cfg.get("mvpHiddenModes", []):
            continue
        if _in_range(km, cfg["rangeKm"].get(mode)):
            out.append(mode)
    return out

