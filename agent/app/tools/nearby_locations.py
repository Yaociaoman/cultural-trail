"""nearby_locations：找某座標附近的地點。"""
from .. import data
from ..geo import haversine_m
from .common import brief

SCHEMA = {
    "name": "nearby_locations",
    "description": (
        "找某個座標附近的景點、餐廳或文創活動，結果依距離由近到遠排列。"
        "使用者問「我附近有什麼」時使用（座標由系統提供），或想找某個已查到地點周邊的地點時，用該地點的 lat、lng。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "lat": {"type": "number", "description": "緯度"},
            "lng": {"type": "number", "description": "經度"},
            "radius_m": {"type": "integer", "description": "搜尋半徑（公尺），預設 3000，最多 20000"},
            "category": {"type": "string", "enum": ["attraction", "restaurant", "activity"],
                         "description": "attraction=景點、restaurant=餐廳、activity=文創活動；不限就不要填"},
            "limit": {"type": "integer", "description": "回傳筆數，預設 6，最多 15"},
        },
        "required": ["lat", "lng"],
    },
}


def run(lat: float, lng: float, radius_m: int = 3000, category: str | None = None, limit: int = 6) -> dict:
    found = []
    for x in data.get_locations():
        if category and x["cat"] != category:
            continue
        d = haversine_m(lat, lng, x["lat"], x["lng"])
        if d <= radius_m:
            found.append((d, x))
    found.sort(key=lambda dx: dx[0])
    results = [{**brief(x), "distance_m": round(d)} for d, x in found[:limit]]
    out = {"count": len(results), "radius_m": radius_m, "results": results}
    if not results:
        out["status"] = "not_found"
        out["note"] = f"No places within {radius_m} m. Suggest a larger radius. Do not invent places."
    return out
