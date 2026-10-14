"""輸出檢查：模型的回覆送出前一律經過這裡。

- 移除 HTML（前端目前用 innerHTML 顯示，避免 XSS）
- 移除網址與 Markdown 連結（模型可能編造網址，或被注入釣魚連結）
- 移除回覆中直接寫出的地點 id 與內部工具名稱
- 修正清單中寫錯字的地名（對照工具結果），移除重複項目
- 偵測系統提示詞外洩、程式碼（不協助與旅遊無關的事）
- 繁中回覆把常見簡體字轉成繁體
- 只回傳資料集中真的存在、且回覆中有提到的地點 id
- 有路線時附上系統計算的摘要，並刪除模型自己寫的距離／碳排數字（數字以工具結果為準）
"""
import re
from difflib import SequenceMatcher

from . import data
from .prompt import LEAK_MARKERS

MAX_REPLY_CHARS = 2000

_HTML_TAG = re.compile(r"</?[a-zA-Z!][^>]*>")
_SCRIPTY = re.compile(r"(javascript|vbscript|data)\s*:", re.IGNORECASE)
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_RAW_ID = re.compile(r"\b(?:Attraction|Restaurant|Event|Hotel)_[A-Za-z0-9_]+\b")
_INTERNAL = re.compile(r"search_locations|get_location|nearby_locations|plan_route|estimate_carbon|"
                       r"get_site_help|get_my_progress|tool_calls?|地點\s*id|\bid\b|工具(?:查詢|結果|回傳)|the tool", re.IGNORECASE)
_LIST_ITEM = re.compile(r"^(\s*)(\d+[.)、．]|[-*•])\s*(.*)$")
NAME_FIX_RATIO = 0.8
# 句子：到中文句號／問號／驚嘆號、英文句點（後面接空白，避免切到 53.9 這種小數）或換行為止
_SENTENCE = re.compile(r"[^\n]*?(?:[。！？!?]|\.(?=\s|$)|\n|$)")


# 程式碼特徵：code block 或常見程式語法開頭的行
_CODE = re.compile(r"```|^\s*(?:def |class |import |from \S+ import |print\(|console\.log|function\s*\w*\(|"
                   r"for \S+ in \S+:|#include|public static|SELECT .+ FROM)", re.MULTILINE | re.IGNORECASE)

OFF_TOPIC = {
    "zh-TW": "抱歉，我是旅遊導覽員，只能協助臺灣的景點、美食、文創活動與行程規劃。想去哪裡走走呢？",
    "en": "Sorry, I'm a travel guide and can only help with places, food, cultural activities and trip planning in Taiwan. Where would you like to go?",
    "ja": "申し訳ありませんが、旅行ガイドなので台湾の観光地・グルメ・文化イベント・旅程づくりのみお手伝いできます。どこへ行きたいですか？",
    "de": "Entschuldigung, ich bin Reiseführer und helfe nur bei Orten, Essen, Kulturveranstaltungen und Reiseplanung in Taiwan. Wohin möchtest du?",
}

# 常見簡體字 → 繁體（小模型偶爾混入）。只放沒有歧義的字；「台」「里」「后」等繁體也常用的字不轉，避免改到正式地名
_S2T_CHARS = dict(zip(
    "这们来时说么为会对发现点车门东风馆乐历华艺术业广场线铁区园创汤湾节开关头买卖饭鱼鸡龙让请问谢欢迎边远过还进选择应该经济产气价钱语读写听页师学觉见览观视码图书间运动样实际处备务网络费号单电话传统吗营体验预约诉给们从个热闹",
    "這們來時說麼為會對發現點車門東風館樂歷華藝術業廣場線鐵區園創湯灣節開關頭買賣飯魚雞龍讓請問謝歡迎邊遠過還進選擇應該經濟產氣價錢語讀寫聽頁師學覺見覽觀視碼圖書間運動樣實際處備務網絡費號單電話傳統嗎營體驗預約訴給們從個熱鬧",
))
_S2T = str.maketrans(_S2T_CHARS)
_S2T_WORDS = {"哪里": "哪裡", "这里": "這裡", "那里": "那裡", "里面": "裡面"}


def to_traditional(text: str) -> str:
    for simp, trad in _S2T_WORDS.items():
        text = text.replace(simp, trad)
    return text.translate(_S2T)


LEAK_REFUSAL = {
    "zh-TW": "抱歉，我不能提供內部設定。我可以幫你規劃行程或介紹景點，想去哪裡呢？",
    "en": "Sorry, I can't share my internal settings. I'd be happy to help plan a trip or introduce places. Where would you like to go?",
    "ja": "申し訳ありませんが、内部設定はお伝えできません。旅行プランや観光地のご案内ならお手伝いできます。どこへ行きたいですか？",
    "de": "Entschuldigung, meine internen Einstellungen kann ich nicht teilen. Gerne helfe ich bei der Reiseplanung. Wohin möchtest du?",
}


def clean_reply(text: str, lang: str) -> str:
    text = (text or "").strip()
    if any(m in text for m in LEAK_MARKERS):
        return LEAK_REFUSAL.get(lang, LEAK_REFUSAL["zh-TW"])
    if _CODE.search(text):
        return OFF_TOPIC.get(lang, OFF_TOPIC["zh-TW"])
    if lang == "zh-TW":
        text = to_traditional(text)
    text = _MD_LINK.sub(r"\1", text)                    # [文字](網址) → 文字
    text = _URL.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = _SCRIPTY.sub("", text)
    text = text.replace("<", "＜").replace(">", "＞")   # 剩下的角括號轉全形，不可能形成標籤
    text = _RAW_ID.sub("", text)
    # 內部用語（工具名稱、id）整句移除，不讓使用者看到
    text = "".join(s for s in _SENTENCE.findall(text) if not _INTERNAL.search(s))
    text = re.sub(r"[ \t]*\(\s*\)", "", text)            # 移除 id 後留下的空括號
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_REPLY_CHARS]


# 回覆中「數字＋單位」：距離與碳排
_NUMBER_WITH_UNIT = re.compile(r"\d+(?:[.,]\d+)?\s*(?:公里|公尺|公斤|kilomet|km|kg|キロ|㎞|㎏)", re.IGNORECASE)

MODE_NAMES = {
    "zh-TW": {"walk": "步行", "bicycle": "腳踏車", "train": "臺鐵", "hsr": "高鐵",
              "bus": "公車／客運", "motorcycle": "機車", "car": "自駕"},
    "en": {"walk": "walking", "bicycle": "cycling", "train": "train", "hsr": "high-speed rail",
           "bus": "bus", "motorcycle": "scooter", "car": "car"},
    "ja": {"walk": "徒歩", "bicycle": "自転車", "train": "台湾鉄道", "hsr": "高速鉄道",
           "bus": "バス", "motorcycle": "バイク", "car": "車"},
    "de": {"walk": "zu Fuß", "bicycle": "Fahrrad", "train": "Zug", "hsr": "Schnellzug",
           "bus": "Bus", "motorcycle": "Motorroller", "car": "Auto"},
}

ROUTE_TEXT = {
    "zh-TW": {"title": "📊 路線（系統估算）", "leg": "{i}. {a} → {b}：約 {km} 公里，建議{mode}",
              "sea": "{i}. {a} → {b}：跨海，需搭飛機或船（不計入碳排）",
              "total": "全程約 {km} 公里；建議方式碳排約 {kg} 公斤 CO2e，自駕約 {car} 公斤，可少排 {saved} 公斤。",
              "est": "距離為直線距離 ×1.3 的估算，碳排依環境部係數估算（每人）。"},
    "en": {"title": "📊 Route (system estimate)", "leg": "{i}. {a} → {b}: about {km} km, suggested: {mode}",
           "sea": "{i}. {a} → {b}: crosses the sea, needs a flight or ferry (not counted)",
           "total": "Total about {km} km; suggested modes ≈ {kg} kg CO2e vs. car ≈ {car} kg, saving {saved} kg.",
           "est": "Distances are straight-line ×1.3 estimates; carbon per person uses official Taiwan factors."},
    "ja": {"title": "📊 ルート（システム推定）", "leg": "{i}. {a} → {b}：約{km}km、おすすめ：{mode}",
           "sea": "{i}. {a} → {b}：海を渡るため飛行機か船が必要（CO2 は計算外）",
           "total": "合計 約{km}km；おすすめの移動で CO2 約{kg}kg、車は約{car}kg、{saved}kg 削減。",
           "est": "距離は直線距離×1.3 の推定、CO2 は台湾環境部の係数による 1 人あたりの推定です。"},
    "de": {"title": "📊 Route (Systemschätzung)", "leg": "{i}. {a} → {b}: ca. {km} km, empfohlen: {mode}",
           "sea": "{i}. {a} → {b}: über das Meer, Flug oder Fähre nötig (nicht berechnet)",
           "total": "Insgesamt ca. {km} km; empfohlene Verkehrsmittel ≈ {kg} kg CO2e, Auto ≈ {car} kg, Ersparnis {saved} kg.",
           "est": "Entfernungen: Luftlinie ×1,3 (Schätzung); CO2 pro Person nach offiziellen Faktoren Taiwans."},
}


def route_summary(route: dict, lang: str) -> str:
    t = ROUTE_TEXT.get(lang, ROUTE_TEXT["zh-TW"])
    names = MODE_NAMES.get(lang, MODE_NAMES["zh-TW"])
    lines = [t["title"]]
    for i, leg in enumerate(route["legs"], 1):
        if leg.get("suggested"):
            lines.append(t["leg"].format(i=i, a=leg["from_name"], b=leg["to_name"], km=leg["km"],
                                         mode=names[leg["suggested"]]))
        else:
            lines.append(t["sea"].format(i=i, a=leg["from_name"], b=leg["to_name"]))
    lines.append(t["total"].format(km=route["total_km"], kg=round(route["suggested_kgCO2e"], 2),
                                   car=round(route["car_kgCO2e"], 2), saved=round(route["saved_vs_car_kgCO2e"], 2)))
    lines.append(t["est"])
    return "\n".join(lines)




def finalize_route(reply: str, route: dict | None, lang: str) -> str:
    """有路線時，距離與碳排數字一律由系統摘要提供（以工具結果為準）。
    小模型常把數字對錯交通方式，所以刪掉模型自己寫的、含距離或碳排數字的句子。"""
    if not route:
        return reply
    kept = [s for s in _SENTENCE.findall(reply) if not _NUMBER_WITH_UNIT.search(s)]
    return f"{''.join(kept).strip()}\n\n{route_summary(route, lang)}".strip()


_NAME_SEGMENT = re.compile(r"^(\**)([^，,：:、。\s*]+)(\**)(.*)$")


def _strip_alias(name: str) -> str:
    return re.sub(r"[（(].*?[)）]", "", name)


def _closest_name(segment: str, names: list[str]) -> str | None:
    """地名片段若與某個工具查到的地名只差一兩個字，回傳正式名稱；完全相同或差太多都回傳 None。"""
    if any(segment in (n, _strip_alias(n)) for n in names):
        return None                                   # 已經是正確名稱（含省略括號別名）
    best, ratio = None, 0.0
    for name in names:
        for form in (name, _strip_alias(name)):
            if abs(len(form) - len(segment)) > 2:
                continue
            r = SequenceMatcher(None, segment, form).ratio()
            # 短地名錯一個字時 ratio 偏低（4 個字錯 1 個 = 0.75）：長度相同且只差一個字也算
            if len(form) == len(segment) >= 4 and sum(a != b for a, b in zip(form, segment)) == 1:
                r = max(r, NAME_FIX_RATIO)
            if r > ratio:
                best, ratio = name, r
    return best if ratio >= NAME_FIX_RATIO else None


def fix_list_names(reply: str, candidate_ids: list[str]) -> str:
    """清單項目開頭的地名若寫錯字（與工具查到的地名只差一兩個字），改回正式名稱；
    重複的項目（含底下的子項目）移除並重新編號。"""
    names = [loc["name"] for i in dict.fromkeys(candidate_ids) if (loc := data.get_by_id(i))]
    if not names:
        return reply
    out, seen, skipping, number = [], set(), False, 0
    for line in reply.split("\n"):
        m = _LIST_ITEM.match(line)
        if not m:
            out.append(line)
            continue
        indent, marker, body = m.groups()
        if marker[0].isdigit() and not indent:
            # 主項目：只比對開頭的地名片段（到第一個逗號／冒號為止），整段替換，不會多出或吃掉字
            seg = _NAME_SEGMENT.match(body)
            if seg:
                fixed = _closest_name(seg.group(2), names)
                if fixed:
                    body = f"{seg.group(1)}{fixed}{seg.group(3)}{seg.group(4)}"
            key = data.normalize(body)
            skipping = key in seen
            seen.add(key)
            if skipping:
                continue
            number += 1
            out.append(f"{number}. {body}")
        elif not skipping:
            out.append(line)     # 子項目跟著主項目保留或移除
    return "\n".join(out)


def preview(raw: str, lang: str, candidate_ids: list[str], has_route: bool) -> str:
    """串流途中送給前端的文字：跟最終回覆一樣先經過檢查（HTML、網址、外洩、程式碼、地名…），
    沒檢查過的模型輸出不會出現在畫面上。路線問題的數字由最後的系統摘要提供，這裡先拿掉含數字的句子。"""
    text = fix_list_names(clean_reply(raw, lang), candidate_ids)
    if has_route:
        text = "".join(s for s in _SENTENCE.findall(text) if not _NUMBER_WITH_UNIT.search(s))
    return text.strip()


def mentioned_locations(reply: str, candidate_ids: list[str]) -> list[str]:
    """候選 id（來自工具結果）中，存在於資料集、且名稱有出現在回覆裡的，依出現順序排列。"""
    found = []
    norm_reply = data.normalize(reply)
    for loc_id in dict.fromkeys(candidate_ids):
        loc = data.get_by_id(loc_id)
        if not loc:
            continue   # 資料集中不存在的 id 一律移除
        pos = norm_reply.find(loc["_name"])
        if pos >= 0:
            found.append((pos, loc_id))
    found.sort()
    return [loc_id for _, loc_id in found]
