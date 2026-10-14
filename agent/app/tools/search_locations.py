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
            "limit": {"type": "integer", "description": "回傳筆數，預設 6，最多 15"},
        },
        "required": ["query"],
    },
}

# 外語常見詞 → 資料中的中文關鍵字（資料只有中文名稱）
KEYWORD_MAP = {
    "night market": "夜市", "old street": "老街", "hot spring": "溫泉", "temple": "廟", "museum": "博物館",
    "park": "公園", "beach": "海", "lake": "湖", "forest": "森林", "trail": "步道", "farm": "農場",
    "tea": "茶", "village": "村", "market": "市場", "mountain": "山",
    "nachtmarkt": "夜市", "nachtmärkt": "夜市", "tempel": "廟", "strand": "海", "wald": "森林", "温泉": "溫泉",
}
CATEGORY_WORDS = {
    "restaurant": "restaurant", "餐廳": "restaurant", "美食": "restaurant", "小吃": "restaurant", "food": "restaurant",
    "attraction": "attraction", "景點": "attraction", "activity": "activity", "event": "activity",
    "活動": "activity", "文創": "activity",
}
STOP_WORDS = ["有哪些", "有什麼", "推薦", "哪裡", "什麼", "好玩", "旅遊", "一日遊", "二日遊", "兩天", "行程", "地點",
              "怎麼玩", "怎麼去", "可以去", "想去", "請問", "幫我", "安排", "介紹", "一下", "可以", "呢", "吧",
              "where", "what", "can", "find", "in", "the", "near", "我", "的", "嗎", "？", "?"]
_SPLIT = re.compile(r"[\s,，、。!！]+")
_KANA = re.compile(r"[\u3040-\u30ff]+")   # 日文假名：用來切出日文問句裡的漢字詞（例如「台中の夜市を」→「夜市」）


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
    for part in _SPLIT.split(q):
        if not part or part.isascii():           # 資料是中文，剩下的英文詞比對不到
            continue
        if _KANA.search(part):                   # 日文：用假名切開，只留兩個字以上的漢字詞
            terms += [p for p in _KANA.split(part) if len(p) >= 2]
        else:
            terms.append(part)
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


def _search(terms: list[str], city: str | None, category: str | None) -> list[dict]:
    pool = [x for x in data.get_locations()
            if (not category or x["cat"] == category) and (not city or x["city"] == city)]
    if not terms:
        return pool
    scored = [(s, x) for x in pool if (s := _score(x, terms)) > 0]
    scored.sort(key=lambda sx: (-sx[0], sx[1]["name"]))
    return [x for _, x in scored]


def not_found(reason: str) -> dict:
    # 提示用簡短英文：中文提示會讓英文／日文／德文的回覆被帶成中文
    return {"count": 0, "results": [], "status": "not_found",
            "note": f"{reason} Tell the user honestly that the data has no match. Do not invent places.",
            "cities_with_data": list(data.available_cities())[:6]}


def run(query: str = "", category: str | None = None, city: str | None = None, limit: int = 6) -> dict:
    terms, q_city, q_category = parse_query(query)
    category = category or q_category

    if city:
        city = data.match_city(city) or parse_query(city)[1]
        if not city:
            return not_found("Unknown city.")
    else:
        city = q_city

    # 依序放寬條件，直到找到結果；note 告訴模型放寬了什麼
    attempts = [(terms, city, category, None)]
    if category:
        # 小模型常加錯類別（例如用 restaurant 找溫泉）
        attempts.append((terms, city, None, f"No {category} matched; results include all categories."))
    if city and terms:
        # 關鍵字比對不到，但有縣市：改列出該縣市的地點（沒有縣市時不放寬，避免亂推薦）
        attempts.append(([], city, None,
                         f"Nothing matched {'、'.join(terms)} in {city}. First tell the user honestly that no "
                         f"{'、'.join(terms)} was found in the data; these results are only OTHER places in {city} "
                         f"(do not call them {'、'.join(terms)})."))

    for used_terms, used_city, used_category, note in attempts:
        hits = _search(used_terms, used_city, used_category)
        if hits:
            out = {"count": min(len(hits), limit), "total_matches": len(hits),
                   "filters": {"city": used_city, "category": used_category, "keywords": used_terms},
                   "results": [brief(x) for x in hits[:limit]]}
            if note:
                out["note"] = note
            return out

    where = f" in {city}" if city else ""
    return not_found(f"No places{where} match {'、'.join(terms) or 'the query'}.")
