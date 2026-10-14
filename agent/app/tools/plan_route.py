"""plan_route：多個地點的參觀順序、各段距離與各交通方式碳排。"""
import re

from .. import carbon, data
from ..geo import haversine_m

SCHEMA = {
    "name": "plan_route",
    "description": (
        "安排 2 到 8 個地點的參觀順序，計算各段距離、建議的低碳交通方式，以及各交通方式的碳排比較。"
        "使用者要求路線、行程順序、怎麼去比較環保、碳排時使用。"
        "locations 可以填地點 id（來自 search_locations），或資料中的正式地點名稱。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "locations": {"type": "array", "items": {"type": "string"},
                          "description": "2 到 8 個地點 id 或正式名稱，第一個是出發點"},
        },
        "required": ["locations"],
    },
}

NOTE = ("Distances are straight-line x1.3 estimates. Carbon is per person, estimated with official "
        "factors (kg CO2e per person-km). Always tell the user these are estimates.")


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


def nearest_neighbor(locs: list[dict]) -> list[dict]:
    """從第一個地點出發，每次走到最近的未訪地點。"""
    order, rest = [locs[0]], locs[1:]
    while rest:
        cur = order[-1]
        nxt = min(rest, key=lambda x: haversine_m(cur["lat"], cur["lng"], x["lat"], x["lng"]))
        order.append(nxt)
        rest.remove(nxt)
    return order


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

    order = nearest_neighbor(found)
    legs, suggested_kg, sea_km = [], 0.0, 0.0
    for a, b in zip(order, order[1:]):
        km = carbon.road_km(haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]))
        modes = carbon.feasible_modes(km, a["city"], b["city"])
        mode = carbon.suggest(modes)
        leg = {"from": a["id"], "to": b["id"], "from_name": a["name"], "to_name": b["name"],
               "km": km, "est": True, "modes": modes, "suggested": mode}
        if mode:
            suggested_kg += carbon.kg(mode, km)
        else:
            leg["note"] = "Crosses the sea (outlying island). Needs a flight or ferry; not included in carbon totals."
            sea_km += km
        legs.append(leg)

    total_km = round(sum(l["km"] for l in legs) - sea_km, 1)   # 碳排只算陸路
    usable = {m for m in carbon.MODES if all(m in l["modes"] for l in legs if l["modes"])}
    compare = [m for m in ("bus", "train", "motorcycle", "car") if m in usable]
    car_kg = carbon.kg("car", total_km)
    suggested_kg = round(suggested_kg, 3)
    out = {
        "order": [x["id"] for x in order],
        "names": [x["name"] for x in order],
        "legs": legs,
        "total_km": total_km,
        "carbon": [{"mode": m, "kgCO2e": carbon.kg(m, total_km)} for m in compare],
        "suggested_kgCO2e": suggested_kg,
        "car_kgCO2e": car_kg,
        "saved_vs_car_kgCO2e": round(car_kg - suggested_kg, 3),
        "note": NOTE,
    }
    if missing:
        out["not_found"] = missing
    return out
