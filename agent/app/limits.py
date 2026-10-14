"""速率限制與並行限制（單機記憶體版，demo 規模足夠）。"""
import asyncio
import time
from collections import deque


class RateLimiter:
    """滑動視窗：同一個 key 在 window 秒內最多 limit 次。"""

    def __init__(self, limit: int, window: float = 60.0, max_keys: int = 10_000):
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self._hits: dict[str, deque] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        if len(self._hits) > self.max_keys:     # 避免被大量不同來源塞爆記憶體
            self._prune(now)
        return True

    def _prune(self, now: float) -> None:
        for k in [k for k, h in self._hits.items() if not h or now - h[-1] > self.window]:
            del self._hits[k]


class Busy(Exception):
    """排隊已滿。"""


class ConcurrencyLimiter:
    """同時最多 running 個請求處理中，另外最多 queue 個排隊；再多就直接拒絕。"""

    def __init__(self, running: int = 2, queue: int = 3):
        self._sem = asyncio.Semaphore(running)
        self._capacity = running + queue
        self._inflight = 0

    async def __aenter__(self):
        if self._inflight >= self._capacity:
            raise Busy()
        self._inflight += 1
        try:
            await self._sem.acquire()
        except BaseException:
            self._inflight -= 1
            raise
        return self

    async def __aexit__(self, *exc):
        self._sem.release()
        self._inflight -= 1
