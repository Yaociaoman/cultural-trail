"""輸出檢查：模型的回覆送出前一律經過這裡。

- 移除 HTML（前端目前用 innerHTML 顯示，避免 XSS）
- 移除網址與 Markdown 連結（模型可能編造網址，或被注入釣魚連結）
- 移除回覆中直接寫出的地點 id
- 偵測系統提示詞外洩
- 只回傳資料集中真的存在、且回覆中有提到的地點 id
"""
import re

from . import data
from .prompt import LEAK_MARKERS

MAX_REPLY_CHARS = 2000

_HTML_TAG = re.compile(r"</?[a-zA-Z!][^>]*>")
_SCRIPTY = re.compile(r"(javascript|vbscript|data)\s*:", re.IGNORECASE)
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_RAW_ID = re.compile(r"\b(?:Attraction|Restaurant|Event|Hotel)_[A-Za-z0-9_]+\b")

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
    text = _MD_LINK.sub(r"\1", text)                    # [文字](網址) → 文字
    text = _URL.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = _SCRIPTY.sub("", text)
    text = text.replace("<", "＜").replace(">", "＞")   # 剩下的角括號轉全形，不可能形成標籤
    text = _RAW_ID.sub("", text)
    text = re.sub(r"[ \t]*\(\s*\)", "", text)            # 移除 id 後留下的空括號
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_REPLY_CHARS]


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
