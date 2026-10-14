"""get_site_help：回答網站使用問題（內容在 config/site_help.json）。"""
import json
from functools import lru_cache

from .. import config

SCHEMA = {
    "name": "get_site_help",
    "description": (
        "取得本網站的使用說明。使用者問網站怎麼用、怎麼集章、徽章怎麼拿、照片沒有 GPS 怎麼辦時使用。"
        "topic：usage=網站功能總覽、stamp=集章方式、badge=徽章與通行證、gps=照片定位問題。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {"type": "string", "enum": ["usage", "stamp", "badge", "gps"], "description": "說明主題"},
        },
        "required": ["topic"],
    },
}

HELP_PATH = config.AGENT_DIR / "config" / "site_help.json"


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(HELP_PATH.read_text(encoding="utf-8"))


def run(topic: str, lang: str = "zh-TW") -> dict:
    """lang 由伺服器依請求帶入，不由模型指定。缺少該語言時退回英文，再退回繁中。"""
    help_data = _load()
    for code in (lang, "en", "zh-TW"):
        text = help_data.get(code, {}).get(topic)
        if text:
            return {"topic": topic, "lang": code, "text": text}
    return {"error": "沒有這個說明主題"}
