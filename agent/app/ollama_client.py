"""與 Ollama 通訊。"""
import json
import logging
import time

import httpx

from . import config

# num_predict：回覆長度上限，避免小模型不停重複。
# repeat_penalty=1.0（關閉）：清單裡地名本來就會重複（例如多個「礁溪」），懲罰重複會讓模型把地名寫錯字
CHAT_OPTIONS = {"temperature": 0.2, "num_ctx": 4096, "num_predict": 256, "repeat_penalty": 1.0}
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


async def chat(messages: list[dict], tools: list[dict] | None = None, timeout: float = 45.0,
               max_tokens: int | None = None) -> dict:
    """呼叫 /api/chat（不串流），回傳 message 物件。max_tokens 可覆寫回覆長度上限。"""
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {**CHAT_OPTIONS, **({"num_predict": max_tokens} if max_tokens else {})},
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


async def chat_stream(messages: list[dict], tools: list[dict] | None = None, timeout: float = 45.0,
                      max_tokens: int | None = None, on_content=None) -> dict:
    """串流呼叫 /api/chat：每收到一段文字就呼叫 on_content(目前累積的全文)；回傳完整 message。"""
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": messages,
        "stream": True,
        "options": {**CHAT_OPTIONS, **({"num_predict": max_tokens} if max_tokens else {})},
        "keep_alive": KEEP_ALIVE,
    }
    if tools:
        payload["tools"] = tools
    started = time.monotonic()
    content, tool_calls = "", []
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{config.OLLAMA_HOST}/api/chat", json=payload) as res:
                res.raise_for_status()
                async for line in res.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    msg = chunk.get("message") or {}
                    if msg.get("tool_calls"):
                        tool_calls += msg["tool_calls"]
                    piece = msg.get("content") or ""
                    if piece:
                        content += piece
                        if on_content:
                            await on_content(content)
                    if chunk.get("done"):
                        log.info("ollama(stream) %.1fs prompt=%s gen=%s", time.monotonic() - started,
                                 chunk.get("prompt_eval_count"), chunk.get("eval_count"))
                        break
    except (httpx.HTTPError, ValueError) as e:
        raise OllamaError(type(e).__name__) from e
    return {"role": "assistant", "content": content, "tool_calls": tool_calls}
