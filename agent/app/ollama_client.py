"""與 Ollama 通訊。"""
import httpx

from . import config


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
