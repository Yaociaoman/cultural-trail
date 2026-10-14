"""pydantic 請求／回應模型。"""
import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_MESSAGE_CHARS = 200   # 使用者訊息上限，與前端 maxlength=200 一致
MAX_ASSISTANT_CHARS = 300 # 前端回傳的歷史 AI 回覆，超過就截斷（不拒絕）；越短模型讀得越快
MAX_HISTORY = 6           # 只保留最近 6 則
SUPPORTED_LANGS = ("zh-TW", "en", "ja", "de")

_CTRL = re.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]")


class HealthResponse(BaseModel):
    ok: bool
    ollama: bool
    model: str
    model_ready: bool
    locations: int


class ErrorResponse(BaseModel):
    error: str
    code: str


class ChatMessage(BaseModel):
    # 安全：只接受 user／assistant，前端不能送 system 或 tool 角色來改寫規則
    role: Literal["user", "assistant"]
    content: str

    @field_validator("content")
    @classmethod
    def clean_content(cls, v: str) -> str:
        v = _CTRL.sub("", v).strip()   # 移除控制字元與隱藏的方向控制字元
        if not v:
            raise ValueError("訊息不可為空")
        return v

    @model_validator(mode="after")
    def check_length(self):
        if self.role == "user" and len(self.content) > MAX_MESSAGE_CHARS:
            raise ValueError(f"訊息長度不可超過 {MAX_MESSAGE_CHARS} 字")
        if self.role == "assistant":
            self.content = self.content[:MAX_ASSISTANT_CHARS]
        return self


class ChatContext(BaseModel):
    lat: float | None = Field(default=None, ge=21.0, le=27.0)    # 臺灣（含離島）範圍
    lng: float | None = Field(default=None, ge=118.0, le=123.0)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=50)
    lang: str = "zh-TW"
    user: dict | None = None      # 目前不使用；使用者身分之後由 A 的後端驗證，不信任前端傳來的值
    context: ChatContext | None = None

    @field_validator("lang")
    @classmethod
    def normalize_lang(cls, v: str) -> str:
        return v if v in SUPPORTED_LANGS else "zh-TW"

    def recent(self) -> list[ChatMessage]:
        """伺服器端截斷：只保留最近 MAX_HISTORY 則，且第一則必須是使用者。"""
        msgs = self.messages[-MAX_HISTORY:]
        while msgs and msgs[0].role != "user":
            msgs = msgs[1:]
        return msgs


class ChatResponse(BaseModel):
    reply: str
    chips: list[str] = []
    locations: list[str] = []
    route: dict | None = None
    lang: str
    fallback: bool = False
