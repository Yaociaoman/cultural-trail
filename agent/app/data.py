"""讀取 locations.json（唯讀）。檔案更新時自動重新載入。

注意：data/locations.json 由 GitHub Actions 每週覆蓋，這裡只讀不寫。
"""
import json
import logging
import threading

from . import config

log = logging.getLogger("agent.data")

_lock = threading.Lock()
_cache: dict = {"mtime": None, "items": []}


def get_locations() -> list[dict]:
    """回傳地點清單；檔案修改時間變了才重新讀取。讀取失敗時保留上一份資料。"""
    path = config.LOCATIONS_PATH
    try:
        mtime = path.stat().st_mtime
    except OSError:
        log.warning("找不到地點資料檔")
        return _cache["items"]

    with _lock:
        if _cache["mtime"] != mtime:
            try:
                items = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(items, list):
                    raise ValueError("格式應為陣列")
                _cache.update(mtime=mtime, items=items)
                log.info("已載入地點資料 %d 筆", len(items))
            except (OSError, ValueError) as e:
                log.warning("地點資料讀取失敗：%s", type(e).__name__)
        return _cache["items"]
