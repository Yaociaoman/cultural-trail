"""路線與碳排測試（docs/agent-spec.md §7）。"""
import pytest

from app import carbon, guard
from app.tools import run_tool, validate_args, ToolArgError


# ── 碳排係數與交通方式 ──

def test_factors_loaded_from_official_file():
    f = carbon.factors()
    assert f["walk"] == 0 and f["bicycle"] == 0
    assert f["car"] == 0.115 and f["bus"] == 0.0944
    assert all(0 <= v < 1 for v in f.values())   # 單位是 kg（台鐵原始值 54 已換算）


def test_kg_calculation():
    assert carbon.kg("car", 10) == 1.15
    assert carbon.kg("walk", 10) == 0


def test_mode_distance_limits():
    assert "walk" in carbon.feasible_modes(1.5) and "walk" not in carbon.feasible_modes(2.5)
    assert "bicycle" in carbon.feasible_modes(8) and "bicycle" not in carbon.feasible_modes(8.5)
    assert "train" not in carbon.feasible_modes(5) and "train" in carbon.feasible_modes(20)


def test_metro_not_used():
    # 官方資料沒有捷運係數，暫不計算
    assert "metro" not in carbon.factors()
    assert "metro" not in carbon.feasible_modes(5, "臺北市", "新北市")


def test_hsr_only_on_west_corridor():
    assert "hsr" in carbon.feasible_modes(300, "臺北市", "臺南市")
    assert "hsr" not in carbon.feasible_modes(60, "宜蘭縣", "宜蘭縣")
    assert "hsr" not in carbon.feasible_modes(60, "臺北市", "宜蘭縣")


def test_islands():
    assert carbon.feasible_modes(300, "金門縣", "宜蘭縣") == []
    assert "train" not in carbon.feasible_modes(20, "金門縣", "金門縣")
    assert carbon.suggest([]) is None


def test_suggest_lowest_carbon():
    assert carbon.suggest(["walk", "bicycle", "bus", "car"]) == "walk"
    assert carbon.suggest(["bus", "motorcycle", "car"]) == "bus"
    assert carbon.suggest(["train", "hsr", "bus", "car"]) == "hsr"


# ── plan_route ──

def test_route_nearest_neighbor_order():
    # 從安平古堡出發：最近的是安平老街豆花（約 150 m），然後林百貨
    r = run_tool("plan_route", {"locations": ["A_TN_1", "A_TN_2", "R_TN_1"]})
    assert r["order"] == ["A_TN_1", "R_TN_1", "A_TN_2"]
    assert all(l["est"] is True for l in r["legs"])
    assert r["legs"][0]["suggested"] == "walk"


def test_route_accepts_names_and_ids():
    r = run_tool("plan_route", {"locations": ["華山1914文化創意產業園區", "A_TP_2"]})
    assert r["order"] == ["A_TP_1", "A_TP_2"]
    assert r["legs"][0]["suggested"] == "bicycle"   # 約 7 km：超過步行範圍、在腳踏車範圍內


def test_route_numbers_consistent():
    r = run_tool("plan_route", {"locations": ["A_TN_1", "A_TN_2", "R_TN_1"]})
    assert r["total_km"] == round(sum(l["km"] for l in r["legs"]), 1)
    assert r["car_kgCO2e"] == carbon.kg("car", r["total_km"])
    assert r["saved_vs_car_kgCO2e"] == round(r["car_kgCO2e"] - r["suggested_kgCO2e"], 3)
    assert "estimate" in r["note"]


def test_route_unknown_places():
    r = run_tool("plan_route", {"locations": ["火星基地", "月球站"]})
    assert "error" in r and r["not_found"] == ["火星基地", "月球站"]
    r = run_tool("plan_route", {"locations": ["A_TN_1", "火星基地", "A_TN_2"]})
    assert r["not_found"] == ["火星基地"] and len(r["order"]) == 2


def test_route_duplicates_removed():
    r = run_tool("plan_route", {"locations": ["A_TN_1", "A_TN_1"]})
    assert "error" in r


def test_route_array_validation():
    assert validate_args("plan_route", {"locations": "A_TN_1, A_TN_2"})["locations"] == ["A_TN_1", "A_TN_2"]
    assert len(validate_args("plan_route", {"locations": [f"x{i}" for i in range(20)]})["locations"]) == 8
    with pytest.raises(ToolArgError):
        validate_args("plan_route", {"locations": ["A_TN_1"]})


def test_route_crossing_sea():
    from app import data
    data.get_locations()  # 載入測試資料
    kinmen = {**data.get_by_id("A_YL_1"), "id": "K1", "name": "金門測試", "_name": "金門測試",
              "city": "金門縣", "lat": 24.43, "lng": 118.32}
    data._cache["items"].append(kinmen)
    data._cache["by_id"]["K1"] = kinmen
    r = run_tool("plan_route", {"locations": ["A_YL_1", "K1"]})
    assert r["legs"][0]["suggested"] is None and "sea" in r["legs"][0]["note"]
    assert r["total_km"] == 0


# ── estimate_carbon ──

def test_estimate_carbon():
    r = run_tool("estimate_carbon", {"distance_km": 10, "mode": "bus"})
    assert r["kgCO2e"] == 0.944 and r["car_kgCO2e"] == 1.15 and r["saved_vs_car_kgCO2e"] == 0.206
    assert "error" in run_tool("estimate_carbon", {"distance_km": 10, "mode": "rocket"})
    assert run_tool("estimate_carbon", {"distance_km": -5, "mode": "car"})["kgCO2e"] == 0


# ── guard 數字檢查 ──

ROUTE = {"total_km": 5.2, "suggested_kgCO2e": 0.0, "car_kgCO2e": 0.598, "saved_vs_car_kgCO2e": 0.598,
         "legs": [{"km": 5.2, "suggested": "bicycle", "from_name": "華山", "to_name": "士林夜市"}],
         "carbon": [{"mode": "bus", "kgCO2e": 0.491}, {"mode": "car", "kgCO2e": 0.598}]}


def test_summary_always_appended():
    out = guard.finalize_route("騎腳踏車最環保。", ROUTE, "zh-TW")
    assert out.startswith("騎腳踏車最環保。")
    assert "📊" in out and "華山 → 士林夜市" in out and "5.2 公里" in out and "腳踏車" in out and "估算" in out


def test_model_number_sentences_removed():
    # 就算數字存在於工具結果（0.598 是自駕），模型也可能對錯交通方式，所以一律由系統摘要提供
    out = guard.finalize_route("建議騎腳踏車。步行碳排 0.598 公斤。全程 12 公里。很環保！", ROUTE, "zh-TW")
    assert out.startswith("建議騎腳踏車。很環保！")
    assert "12 公里" not in out and "0.598" not in out


def test_model_numbers_removed_other_languages():
    out = guard.finalize_route("Take the bike. It is 53.9 kilometers.\n- Bus: 5.088 kgCO2e\nEnjoy!", ROUTE, "en")
    assert "kilometers" not in out and "5.088" not in out and out.startswith("Take the bike.")


def test_no_route_untouched():
    assert guard.finalize_route("任意 99 公里", None, "zh-TW") == "任意 99 公里"


def test_summary_languages():
    for lang, word in [("en", "cycling"), ("ja", "自転車"), ("de", "Fahrrad")]:
        assert word in guard.route_summary(ROUTE, lang)


def test_find_place_names_in_sentence():
    from app.tools.plan_route import find_place_names
    assert find_place_names("幫我安排安平古堡到林百貨的路線") == ["安平古堡", "林百貨"]
    assert find_place_names("林百貨，然後安平古堡") == ["林百貨", "安平古堡"]   # 依出現順序
    assert find_place_names("今天天氣很好") == []
