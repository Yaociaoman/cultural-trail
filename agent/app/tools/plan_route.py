"""plan_route：多個地點依使用者提到的順序，計算各段距離與各交通方式的大約碳排。

不挑「建議」方式，也不重新排序：建議由地圖頁「我的行程」依時間與碳排產生（與地圖頁一致）。
"""
import re

from .. import carbon, data
from ..geo import haversine_m

SCHEMA = {
    "name": "plan_route",
    "description": (
        "依使用者提到的順序，計算 2 到 8 個地點之間各段的距離，以及各交通方式每人的大約碳排。"
        "使用者問路線、怎麼去比較環保、碳排時使用。"
        "locations 可以填地點 id（來自 search_locations），或資料中的正式地點名稱。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "locations": {"type": "array", "items": {"type": "string"},
                          "description": "2 到 8 個地點 id 或正式名稱，依使用者提到的順序，第一個是出發點"},
        },
        "required": ["locations"],
    },
}

NOTE = ("Distances are straight-line x1.3 estimates. Carbon is per person, estimated with official "
        "factors (kg CO2e per person-km). Always tell the user these are estimates. Do not pick a 'best' mode; "
        "tell the user to use My Trip on the map page (Add to trip -> Find routes) to compare time and see suggestions.")


def resolve(ref: str) -> dict | None:
    """id 或名稱 → 地點。名稱先找完全相同，再找唯一包含的。"""
    loc = data.get_by_id(ref)
    if loc:
        return loc
    name = data.normalize(ref)
    if not name:
        return None
    locs = data.get_locations()
    exact = [x for x in locs if x["_name"] == name or _match_key(x["name"]) == name]
    if exact:
        return exact[0]
    partial = [x for x in locs if name in x["_name"]]
    return partial[0] if len(partial) == 1 else None


def _match_key(name: str) -> str:
    """比對用名稱：去掉括號內的別名，例如「湯圍溝溫泉公園(湯圍風呂)」→「湯圍溝溫泉公園」。"""
    return data.normalize(re.sub(r"[（(].*?[)）]", "", name))


def find_place_names(text: str, max_names: int = 8) -> list[str]:
    """找出句子中提到的資料地名（依出現順序，長名稱優先、不重疊）。"""
    q = data.normalize(text)
    hits = []
    for loc in sorted(data.get_locations(), key=lambda x: -len(_match_key(x["name"]))):
        key = _match_key(loc["name"])
        if len(key) < 3:
            continue
        pos = q.find(key)
        if pos >= 0 and not any(pos < e and pos + len(key) > s for s, e, _ in hits):
            hits.append((pos, pos + len(key), loc["name"]))
    return [name for _, _, name in sorted(hits)][:max_names]


def run(locations: list[str]) -> dict:
    found, missing, seen = [], [], set()
    for ref in locations:
        loc = resolve(ref)
        if not loc:
            missing.append(ref)
        elif loc["id"] not in seen:
            seen.add(loc["id"])
            found.append(loc)
    if len(found) < 2:
        return {"error": "These places are not in the data. Tell the user honestly; do not invent a route.",
                "not_found": missing}

    order = found   # 依使用者提到的順序（與地圖頁相同，不自動排序）
    legs, land_km = [], 0.0
    for a, b in zip(order, order[1:]):
        # 碳排用未四捨五入的距離計算（與地圖頁相同），距離只在輸出時取到 0.1 公里
        raw_km = carbon.road_km_raw(haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]))
        modes = carbon.feasible_modes(raw_km, (a["lat"], a["lng"]), (b["lat"], b["lng"]))
        leg = {"from": a["id"], "to": b["id"], "from_name": a["name"], "to_name": b["name"],
               "km": round(raw_km, 1), "est": True,
               "modes": [{"mode": m, "kgCO2e": carbon.kg(m, raw_km)} for m in modes]}
        if modes:
            land_km += raw_km
        else:
            leg["note"] = "Crosses the sea (outlying island). Needs a flight or ferry; not included in carbon totals."
        legs.append(leg)

    out = {
        "order": [x["id"] for x in order],
        "names": [x["name"] for x in order],
        "legs": legs,
        "total_km": round(land_km, 1),                 # 碳排只算陸路
        "car_kgCO2e": carbon.kg("car", land_km),
        "note": NOTE,
    }
    if missing:
        out["not_found"] = missing
    return out
