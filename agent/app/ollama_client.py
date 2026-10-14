"""與 Ollama 通訊。"""
import logging
import time

import httpx

from . import config

# num_predict：回覆長度上限，避免小模型不停重複。
# repeat_penalty=1.0（關閉）：清單裡地名本來就會重複（例如多個「礁溪」），懲罰重複會讓模型把地名寫錯字
CHAT_OPTIONS = {"temperature": 0.3, "num_ctx": 4096, "num_predict": 320, "repeat_penalty": 1.0}
KEEP_ALIVE = "30m"   # 模型留在記憶體 30 分鐘，避免每次重新載入


log = logging.getLogger("agent.ollama")


class OllamaError(Exception):
    """Ollama 連不上、逾時或回傳格式錯誤。"""


async def check_model(timeout: float = 3.0) -> tuple[bool, bool]:
    """回傳 (Ollama 是否連得上, 設定的模型是否已下載)。"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(f"{config.OLLAMA_HOST}/api/tags")
            res.raise_for_status()
            names = {m.get("name") for m in res.json().get("models", [])}
    except (httpx.HTTPError, ValueError):
        return False, False
    return True, config.OLLAMA_MODEL in names


async def chat(messages: list[dict], tools: list[dict] | None = None, timeout: float = 45.0) -> dict:
    """呼叫 /api/chat（不串流），回傳 message 物件。"""
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": CHAT_OPTIONS,
        "keep_alive": KEEP_ALIVE,
    }
    if tools:
        payload["tools"] = tools
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(f"{config.OLLAMA_HOST}/api/chat", json=payload)
            res.raise_for_status()
            body = res.json()
            message = body.get("message")
            # 只記錄耗時與 token 數，不記錄內容
            log.info("ollama %.1fs prompt=%s gen=%s", time.monotonic() - started,
                     body.get("prompt_eval_count"), body.get("eval_count"))
    except (httpx.HTTPError, ValueError) as e:
        raise OllamaError(type(e).__name__) from e
    if not isinstance(message, dict):
        raise OllamaError("bad response")
    return message
