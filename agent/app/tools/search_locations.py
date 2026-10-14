"""search_locations：依關鍵字／城市／類別找地點。"""
import re

from .. import data
from ..data import normalize
from .common import brief

SCHEMA = {
    "name": "search_locations",
    "description": (
        "在官方觀光資料中搜尋景點、餐廳或文創活動。"
        "使用者問到任何地點、城市、行程、美食、推薦時，一定要先呼叫這個工具，不可憑記憶回答。"
        "query 請用繁體中文關鍵字（例如「老街」「夜市」「博物館」）；城市請放在 city。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "繁體中文關鍵字，例如「老街」「溫泉」；只想列出某城市的地點時可留空"},
            "category": {"type": "string", "enum": ["attraction", "restaurant", "activity"],
                         "description": "attraction=景點、restaurant=餐廳、activity=文創活動；不限類別就不要填"},
            "city": {"type": "string", "description": "縣市名稱，例如「臺南」「宜蘭縣」「Taipei」"},
            "limit": {"type": "integer", "description": "回傳筆數，預設 8，最多 15"},
        },
        "required": ["query"],
    },
}

# 外語常見詞 → 資料中的中文關鍵字（資料只有中文名稱）
KEYWORD_MAP = {
    "night market": "夜市", "old street": "老街", "hot spring": "溫泉", "temple": "廟", "museum": "博物館",
    "park": "公園", "beach": "海", "lake": "湖", "forest": "森林", "trail": "步道", "farm": "農場",
    "tea": "茶", "village": "村", "market": "市場", "mountain": "山",
    "nachtmarkt": "夜市", "tempel": "廟", "strand": "海", "wald": "森林", "温泉": "溫泉",
}
CATEGORY_WORDS = {
    "restaurant": "restaurant", "餐廳": "restaurant", "美食": "restaurant", "小吃": "restaurant", "food": "restaurant",
    "attraction": "attraction", "景點": "attraction", "activity": "activity", "event": "activity",
    "活動": "activity", "文創": "activity",
}
STOP_WORDS = ["有哪些", "有什麼", "推薦", "哪裡", "什麼", "好玩", "旅遊", "一日遊", "行程", "地點",
              "where", "what", "can", "find", "in", "the", "near", "我", "的", "嗎", "？", "?"]
_SPLIT = re.compile(r"[\s,，、。!！]+")


def _city_aliases() -> list[tuple[str, str]]:
    pairs = [(normalize(c), c) for c in data.CITIES] + [(normalize(c[:2]), c) for c in data.CITIES]
    pairs += [(normalize(a), c) for c, aliases in data.CITIES.items() for a in aliases]
    return sorted(set(pairs), key=lambda p: -len(p[0]))  # 長的先比對，避免「新竹縣」被「新竹」吃掉


def parse_query(query: str) -> tuple[list[str], str | None, str | None]:
    """把查詢拆成 (關鍵字, 縣市, 類別)。"""
    q = normalize(query)[:100]
    city = category = None
    for alias, c in _city_aliases():
        if alias and alias in q:
            city = city or c
            q = q.replace(alias, " ")
    terms = []
    for word, zh in KEYWORD_MAP.items():
        if word in q:
            terms.append(normalize(zh))
            q = q.replace(word, " ")
    for word, cat in CATEGORY_WORDS.items():
        if word in q:
            category = category or cat
            q = q.replace(word, " ")
    for w in STOP_WORDS:
        q = re.sub(rf"\b{re.escape(w)}\b", " ", q) if w.isascii() and w.isalpha() else q.replace(w, " ")
    terms += [t for t in _SPLIT.split(q) if t and not t.isascii()]  # 資料是中文，剩下的英文詞比對不到
    return terms, city, category


def _score(loc: dict, terms: list[str]) -> int:
    s = 0
    for t in terms:
        if t in loc["_name"]:
            s += 3
        elif t in loc["_addr"]:
            s += 2
        elif t in loc["_desc"]:
            s += 1
    return s


def run(query: str = "", category: str | None = None, city: str | None = None, limit: int = 8) -> dict:
    terms, q_city, q_category = parse_query(query)
    category = category or q_category

    if city:
        city_name = data.match_city(city) or parse_query(city)[1]
        if not city_name:
            return {"count": 0, "results": [], "note": f"資料中找不到縣市「{city}」",
                    "available_cities": data.available_cities()}
    else:
        city_name = q_city

    pool = [x for x in data.get_locations()
            if (not category or x["cat"] == category) and (not city_name or x["city"] == city_name)]

    if terms:
        scored = [(s, x) for x in pool if (s := _score(x, terms)) > 0]
        scored.sort(key=lambda sx: (-sx[0], sx[1]["name"]))
        hits = [x for _, x in scored]
    else:
        hits = pool

    results = [brief(x) for x in hits[:limit]]
    out = {"count": len(results), "total_matches": len(hits),
           "filters": {"city": city_name, "category": category, "keywords": terms}, "results": results}
    if not results:
        out["note"] = "資料中找不到符合的地點，請如實告知使用者，並可從 available_cities 提供替代建議"
        out["available_cities"] = data.available_cities()
    return out
