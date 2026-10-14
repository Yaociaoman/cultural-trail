"""Agent 迴圈：呼叫 Ollama → 執行工具 → 再呼叫，直到模型給出最終回覆。（docs/agent-spec.md §6.4）"""
import asyncio
import json
import logging
import re
import time

from . import guard, ollama_client, tools
from .lang import wrong_language
from .prompt import LANG_NAMES, build_system_prompt
from .schemas import ChatRequest
from .tools.search_locations import parse_query

log = logging.getLogger("agent.loop")

MAX_TOOL_ROUNDS = 5
TOTAL_TIMEOUT = 45.0
MAX_TOOL_CALLS_PER_ROUND = 4   # 避免模型一次塞一堆工具呼叫

FORCE_ANSWER = {
    "zh-TW": "工具呼叫次數已達上限，請直接用目前查到的資料回答使用者。",
    "en": "Tool call limit reached. Answer the user now using only the data already retrieved.",
    "ja": "ツールの呼び出し回数が上限に達しました。取得済みのデータだけで回答してください。",
    "de": "Das Limit für Werkzeugaufrufe ist erreicht. Antworte jetzt nur mit den bereits abgerufenen Daten.",
}

DEFAULT_CHIPS = {
    "zh-TW": ["這個網站怎麼使用？", "如何解鎖集章？", "宜蘭溫泉推薦", "我附近有什麼？"],
    "en": ["How do I use this site?", "How do I unlock stamps?", "Hot springs in Yilan", "What's near me?"],
    "ja": ["このサイトの使い方は？", "スタンプの集め方は？", "宜蘭の温泉は？", "近くに何がある？"],
    "de": ["Wie benutze ich die Seite?", "Wie sammle ich Stempel?", "Heiße Quellen in Yilan", "Was ist in meiner Nähe?"],
}


# 看起來是在問地點、行程或網站用法（這類問題一定要先查資料）
_NEEDS_DATA = re.compile(
    r"行程|一日遊|推薦|好玩|景點|美食|餐廳|小吃|夜市|老街|溫泉|去哪|哪裡|附近|集章|徽章|網站|怎麼用|"
    r"trip|visit|itinerary|recommend|where|near|stamp|badge|"
    r"観光|おすすめ|何が|どこ|近く|スタンプ|"
    r"besuchen|empfehl|Sehensw|wo |Nähe|Stempel", re.IGNORECASE)

_SITE_TOPICS = [
    ("stamp", re.compile(r"集章|解鎖|蓋章|上傳|stamp|スタンプ|Stempel", re.IGNORECASE)),
    ("badge", re.compile(r"徽章|通行證|badge|バッジ|Abzeichen", re.IGNORECASE)),
    ("gps", re.compile(r"gps|定位|位置資訊|位置情報", re.IGNORECASE)),
    ("usage", re.compile(r"網站|怎麼用|如何使用|使用方式|how (do i|to) use|使い方|benutze", re.IGNORECASE)),
]

REWRITE = ("Rewrite the following answer in {lang_name}. Keep every place name exactly as written "
           "(official Chinese names). Do not add or remove information. Output only the rewritten answer.")

EMPTY_REPLY = {
    "zh-TW": "抱歉，我這次沒有整理出答案，可以換個方式再問一次嗎？",
    "en": "Sorry, I couldn't put together an answer this time. Could you rephrase your question?",
    "ja": "申し訳ありません、今回はうまく回答できませんでした。言い方を変えてもう一度聞いてもらえますか？",
    "de": "Entschuldigung, diesmal konnte ich keine Antwort formulieren. Kannst du die Frage anders stellen?",
}


def needs_data(text: str) -> bool:
    _, city, category = parse_query(text)
    return bool(city or category or _NEEDS_DATA.search(text))


def auto_tool_call(text: str) -> dict:
    """模型沒有自己查資料時，由伺服器代查：網站問題查說明，其他查地點。"""
    for topic, pattern in _SITE_TOPICS:
        if pattern.search(text):
            return {"function": {"name": "get_site_help", "arguments": {"topic": topic}}}
    return {"function": {"name": "search_locations", "arguments": {"query": text}}}


def _collect_ids(result: dict) -> list[str]:
    """從工具結果收集地點 id（之後由 guard 再過濾一次）。"""
    ids = []
    if isinstance(result.get("id"), str):
        ids.append(result["id"])
    for r in result.get("results", []) or []:
        if isinstance(r, dict) and isinstance(r.get("id"), str):
            ids.append(r["id"])
    return ids


async def _loop(req: ChatRequest, used_tools: list[str]) -> tuple[str, list[str]]:
    ctx = req.context
    messages = [{"role": "system",
                 "content": build_system_prompt(req.lang, ctx.lat if ctx else None, ctx.lng if ctx else None)}]
    messages += [{"role": m.role, "content": m.content} for m in req.recent()]
    tool_ctx = {"lang": req.lang}
    candidate_ids: list[str] = []
    tool_defs = tools.ollama_tools()

    last_user = req.recent()[-1].content
    for _ in range(MAX_TOOL_ROUNDS):
        msg = await ollama_client.chat(messages, tool_defs)
        calls = msg.get("tool_calls") or []
        if not calls:
            # 小模型有時不查資料就直接回答（容易編造地點或功能）：伺服器代查一次，丟掉它原本的回答
            if not used_tools and needs_data(last_user):
                msg, calls = {"content": ""}, [auto_tool_call(last_user)]
                used_tools.append("auto")
            else:
                return msg.get("content", ""), candidate_ids

        messages.append({"role": "assistant", "content": msg.get("content", ""), "tool_calls": calls})
        for call in calls[:MAX_TOOL_CALLS_PER_ROUND]:
            fn = call.get("function") or {}
            name, args = fn.get("name", ""), fn.get("arguments") or {}
            if isinstance(args, str):            # 有些模型會回傳 JSON 字串
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            result = tools.run_tool(name, args, tool_ctx)
            used_tools.append(name if name in tools.TOOLS else "invalid")
            candidate_ids += _collect_ids(result)
            messages.append({"role": "tool", "tool_name": name,
                             "content": json.dumps(result, ensure_ascii=False)})

    # 超過工具呼叫上限：不給工具，強制用現有資料回答
    messages.append({"role": "system", "content": FORCE_ANSWER.get(req.lang, FORCE_ANSWER["zh-TW"])})
    msg = await ollama_client.chat(messages, None)
    return msg.get("content", ""), candidate_ids


async def _fix_language(text: str, lang: str) -> str:
    """回覆語言不對時，請模型翻譯一次（不給工具）。"""
    msg = await ollama_client.chat([
        {"role": "system", "content": REWRITE.format(lang_name=LANG_NAMES.get(lang, "繁體中文"))},
        {"role": "user", "content": text},
    ])
    return msg.get("content", "") or text


async def _answer(req: ChatRequest, used_tools: list[str]) -> tuple[str, list[str]]:
    raw, candidate_ids = await _loop(req, used_tools)
    if wrong_language(raw, req.lang):
        used_tools.append("rewrite_lang")
        raw = await _fix_language(raw, req.lang)
    return raw, candidate_ids


async def run_agent(req: ChatRequest) -> dict:
    """執行 Agent；Ollama 連不上或逾時時丟出 OllamaError / asyncio.TimeoutError。"""
    started = time.monotonic()
    used_tools: list[str] = []
    try:
        raw, candidate_ids = await asyncio.wait_for(_answer(req, used_tools), TOTAL_TIMEOUT)
    finally:
        # 隱私：日誌只記錄耗時與工具名稱，不記錄對話內容與位置
        log.info("chat done in %.1fs, tools=%s", time.monotonic() - started, used_tools)

    reply = guard.clean_reply(raw, req.lang) or EMPTY_REPLY.get(req.lang, EMPTY_REPLY["zh-TW"])
    return {
        "reply": reply,
        "chips": DEFAULT_CHIPS.get(req.lang, DEFAULT_CHIPS["zh-TW"]),
        "locations": guard.mentioned_locations(reply, candidate_ids),
        "route": None,
        "lang": req.lang,
        "fallback": False,
    }
