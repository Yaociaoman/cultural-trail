"""工具註冊表：schema（給模型看）+ 實作 + 參數驗證。

安全原則：
- 工具一律唯讀，不得集章、兌換點數或修改任何資料。
- 參數只接受 schema 定義的欄位，其餘丟棄；數值一律夾在合理範圍。
- lang、使用者身分等由伺服器帶入（ctx），不讓模型指定。
"""
import logging
import math

from . import (estimate_carbon, get_location, get_site_help, nearby_locations, plan_route,
               search_locations)

log = logging.getLogger("agent.tools")

_MODULES = [search_locations, get_location, nearby_locations, plan_route, estimate_carbon, get_site_help]
TOOLS = {m.SCHEMA["name"]: m for m in _MODULES}

# 由伺服器注入的參數：工具名稱 → 需要的 ctx 欄位
SERVER_ARGS = {"get_site_help": ["lang"]}

# 數值範圍限制（超出就夾回範圍內）
LIMITS = {
    "limit": (1, 15),
    "radius_m": (100, 20000),
    "lat": (-90, 90),
    "lng": (-180, 180),
    "distance_km": (0, 1000),
}
MAX_ITEMS = {"locations": (2, 8)}
MAX_STR = 100


class ToolArgError(ValueError):
    """參數不合法；訊息會回傳給模型讓它修正。"""


def ollama_tools() -> list[dict]:
    """給 Ollama /api/chat 的 tools 參數。"""
    return [{"type": "function", "function": m.SCHEMA} for m in _MODULES]


def _coerce(name: str, spec: dict, value):
    t = spec.get("type")
    if t == "string":
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise ToolArgError(f"{name} 應為文字")
        value = str(value).strip()[:MAX_STR]
        if "enum" in spec and value not in spec["enum"]:
            raise ToolArgError(f"{name} 只能是 {spec['enum']} 其中之一")
        return value
    if t in ("number", "integer"):
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ToolArgError(f"{name} 應為數字")
        if not math.isfinite(num):
            raise ToolArgError(f"{name} 應為有限數字")
        lo, hi = LIMITS.get(name, (-math.inf, math.inf))
        num = min(max(num, lo), hi)
        return int(num) if t == "integer" else num
    if t == "array":
        if isinstance(value, str):                 # 小模型有時給逗號分隔的字串
            value = [v for v in value.replace("，", ",").split(",")]
        if not isinstance(value, list):
            raise ToolArgError(f"{name} 應為陣列")
        items = [_coerce(name, spec.get("items", {}), v) for v in value if v not in (None, "")]
        lo, hi = MAX_ITEMS.get(name, (0, 20))
        items = items[:hi]
        if len(items) < lo:
            raise ToolArgError(f"{name} 至少需要 {lo} 個")
        return items
    raise ToolArgError(f"不支援的參數型別：{name}")


def validate_args(tool_name: str, args) -> dict:
    """驗證模型給的參數：丟棄未定義欄位、轉型、檢查必填。"""
    if tool_name not in TOOLS:
        raise ToolArgError(f"沒有這個工具：{tool_name}，可用的工具：{list(TOOLS)}")
    if not isinstance(args, dict):
        raise ToolArgError("參數必須是物件")
    params = TOOLS[tool_name].SCHEMA["parameters"]
    props, required = params["properties"], params.get("required", [])
    clean = {}
    for key, spec in props.items():
        value = args.get(key)
        # 選填欄位給空值就當作沒填（小模型常送 category: ""）；必填文字欄位允許空字串
        if value is None or (value == "" and key not in required):
            continue
        clean[key] = _coerce(key, spec, value)
    missing = [k for k in required if k not in clean]
    if missing:
        raise ToolArgError(f"缺少必填參數：{missing}")
    return clean


def run_tool(tool_name: str, args, ctx: dict | None = None) -> dict:
    """驗證參數後執行工具；參數錯誤時回傳錯誤訊息（不丟例外），讓模型可以修正。"""
    try:
        clean = validate_args(tool_name, args)
    except ToolArgError as e:
        return {"error": str(e)}
    for key in SERVER_ARGS.get(tool_name, []):
        if ctx and key in ctx:
            clean[key] = ctx[key]
    try:
        return TOOLS[tool_name].run(**clean)
    except Exception:
        # 安全：錯誤細節只寫日誌，不回傳給模型
        log.exception("工具執行失敗：%s", tool_name)
        return {"error": "工具暫時無法使用"}
