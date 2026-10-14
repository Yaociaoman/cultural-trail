"""Agent 服務入口。

啟動：cd agent && source .venv/bin/activate && uvicorn app.main:app --port 8787
"""
import asyncio
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import agent, config, data, ollama_client
from .limits import Busy, ConcurrencyLimiter, RateLimiter
from .schemas import ChatRequest, ChatResponse, HealthResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("agent")

app = FastAPI(
    title="Taiwan Cultural Trails Agent",
    # 安全：正式環境不公開 API 文件頁面
    docs_url="/docs" if config.DEBUG else None,
    redoc_url=None,
    openapi_url="/openapi.json" if config.DEBUG else None,
)

# 安全：CORS 只允許白名單來源，不帶 cookie
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    max_age=600,
)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


MAX_BODY_BYTES = 32 * 1024


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    # 安全：限制請求大小，避免超大請求佔用記憶體
    if request.method == "POST":
        length = request.headers.get("content-length")
        if length is None:
            response = error_response(411, "需要 Content-Length", "length_required")
        elif not length.isdigit() or int(length) > MAX_BODY_BYTES:
            response = error_response(413, "請求內容過大", "too_large")
        else:
            response = await call_next(request)
    else:
        response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    return response


# ── 統一錯誤格式：{ "error": "訊息", "code": "..." } ──

ERROR_CODES = {400: "bad_request", 404: "not_found", 405: "method_not_allowed",
               413: "too_large", 429: "rate_limited", 503: "unavailable"}


def error_response(status: int, message: str, code: str | None = None) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"error": message, "code": code or ERROR_CODES.get(status, "error")})


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else "請求錯誤"
    return error_response(exc.status_code, detail)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # 安全：不把使用者輸入原樣回傳，只說明哪個欄位有問題
    fields = sorted({".".join(str(p) for p in e.get("loc", [])[1:]) or "body" for e in exc.errors()})
    return error_response(400, "請求格式錯誤：" + ", ".join(fields), "bad_request")


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    # 安全：內部錯誤細節只寫進日誌，不回傳給使用者
    log.exception("未預期的錯誤：%s %s", request.method, request.url.path)
    return error_response(500, "伺服器內部錯誤", "internal")


# ── API ──

chat_rate = RateLimiter(limit=20, window=60)        # 同一來源每分鐘最多 20 次
chat_slots = ConcurrencyLimiter(running=2, queue=3)  # 同時處理 2 個，排隊最多 3 個


def client_key(request: Request) -> str:
    # 只有明確設定 TRUST_PROXY=1（例如走 https 通道）才相信 X-Forwarded-For，否則可被偽造
    if config.TRUST_PROXY:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.get("/health", response_model=HealthResponse)
async def health():
    ollama_ok, model_ready = await ollama_client.check_model()
    count = len(data.get_locations())
    body = HealthResponse(
        ok=ollama_ok and model_ready and count > 0,
        ollama=ollama_ok,
        model=config.OLLAMA_MODEL,
        model_ready=model_ready,
        locations=count,
    )
    # 不健康時回 503，前端可直接判斷切換成離線模式
    return JSONResponse(status_code=200 if body.ok else 503, content=body.model_dump())


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    if not chat_rate.allow(client_key(request)):
        return error_response(429, "請求太頻繁，請稍後再試", "rate_limited")
    try:
        async with chat_slots:
            return await agent.run_agent(req)
    except Busy:
        return error_response(503, "目前使用人數較多，請稍後再試", "busy")
    except asyncio.TimeoutError:
        return error_response(503, "AI 回應逾時", "timeout")
    except ollama_client.OllamaError:
        return error_response(503, "AI 服務暫時無法使用", "ollama_unavailable")
