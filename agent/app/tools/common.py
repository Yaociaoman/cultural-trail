"""工具共用：輸出精簡化。"""
import re

DESC_MAX = 60   # 小模型讀長結果很慢（M1 約每 1000 token 多 10 秒）
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text: str, limit: int | None = None) -> str:
    """移除控制字元、壓縮空白；需要時截斷。"""
    t = re.sub(r"\s+", " ", _CTRL.sub("", text or "")).strip()
    if limit and len(t) > limit:
        t = t[:limit].rstrip() + "…"
    return t


def brief(loc: dict) -> dict:
    """給模型看的精簡地點資訊（避免塞爆小模型的上下文）。"""
    return {
        "id": loc["id"],
        "name": loc["name"],
        "category": loc["cat"],
        "city": loc["city"],
        "addr": clean(loc.get("addr", "")),
        "desc": clean(loc.get("desc", ""), DESC_MAX),
    }
