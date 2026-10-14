"""get_location：讀取單一地點的完整資訊。"""
from .. import data
from .common import clean

SCHEMA = {
    "name": "get_location",
    "description": "依地點 id 取得完整介紹、地址與座標。使用者想知道某個已查到地點的細節時使用；id 必須來自其他工具的結果。",
    "parameters": {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "地點 id，例如 Attraction_345040000G_000001"}},
        "required": ["id"],
    },
}


def run(id: str) -> dict:
    loc = data.get_by_id(id.strip())
    if not loc:
        return {"error": "資料中找不到這個地點 id，請先用 search_locations 查詢"}
    return {
        "id": loc["id"],
        "name": loc["name"],
        "category": loc["cat"],
        "city": loc["city"],
        "addr": clean(loc.get("addr", "")),
        "desc": clean(loc.get("desc", ""), 300),
        "lat": round(loc["lat"], 6),
        "lng": round(loc["lng"], 6),
        "officialUrl": loc.get("officialUrl", ""),
    }
