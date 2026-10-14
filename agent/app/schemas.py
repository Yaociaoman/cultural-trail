"""pydantic 請求／回應模型。"""
from pydantic import BaseModel


class HealthResponse(BaseModel):
    ok: bool
    ollama: bool
    model: str
    model_ready: bool
    locations: int


class ErrorResponse(BaseModel):
    error: str
    code: str
