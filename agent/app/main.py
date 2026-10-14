"""Agent 服務入口。

啟動：cd agent && source .venv/bin/activate && uvicorn app.main:app --port 8787
"""
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, data, ollama_client
from .schemas import HealthResponse

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


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
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
