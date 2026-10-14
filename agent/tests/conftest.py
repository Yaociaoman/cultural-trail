"""測試共用設定：改用固定的小型測試資料，不受每週資料更新影響。"""
from pathlib import Path

import pytest

from app import config, data

SAMPLE = Path(__file__).parent / "fixtures" / "locations_sample.json"


@pytest.fixture(autouse=True)
def sample_locations(monkeypatch):
    monkeypatch.setattr(config, "LOCATIONS_PATH", SAMPLE)
    data._cache.update(mtime=None, items=[], by_id={})
    yield
    data._cache.update(mtime=None, items=[], by_id={})
