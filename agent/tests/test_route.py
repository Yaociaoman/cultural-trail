"""路線與碳排測試（docs/agent-spec.md §7）。"""
import pytest

from app import carbon, guard
from app.tools import run_tool, validate_args, ToolArgError


# ── 碳排係數與交通方式（與地圖頁共用 carbon/ 的設定檔） ──

def test_factors_loaded_from_shared_file():
    import json
    raw = json.loads(carbon.FACTORS_PATH.read_text(encoding="utf-8"))["factors"]
    f = carbon.factors()
    assert f["walk"] == 0 and f["bicycle"] == 0
    assert f["car"] == raw["car"]["gCO2e"] / 1000 and f["bus"] == raw["bus"]["gCO2e"] / 1000
    assert all(0 <= v < 1 for v in f.values())   # 單位是 kg／人·公里


def test_kg_calculation():
    assert carbon.kg("car", 10) == round(carbon.factors()["car"] * 10, 3)
    assert carbon.kg("walk", 10) == 0


def test_mode_distance_limits_follow_shared_config():
    r = carbon.settings()["rangeKm"]
    assert "walk" in carbon.feasible_modes(r["walk"]["max"]) and "walk" not in carbon.feasible_modes(r["walk"]["max"] + 0.1)
    assert "bicycle" not in carbon.feasible_modes(r["bicycle"]["max"] + 0.1)
    assert "train" not in carbon.feasible_modes(r["train"]["min"] - 1) and "train" in carbon.feasible_modes(r["train"]["min"] + 1)
    assert "hsr" not in carbon.feasible_modes(r["hsr"]["min"] - 1) and "hsr" in carbon.feasible_modes(300)


def test_metro_not_used():
    # 官方資料沒有捷運係數（available=false），不列入
    assert "mrt" not in carbon.factors()
    assert "mrt" not in carbon.feasible_modes(5)


def test_islands():
    yilan, kinmen, kinmen2 = (24.75, 121.75), (24.43, 118.32), (24.45, 118.40)
    assert carbon.feasible_modes(300, yilan, kinmen) == []
    on_island = carbon.feasible_modes(20, kinmen, kinmen2)
    assert "train" not in on_island and "hsr" not in on_island and "car" in on_island


def test_no_suggestion_function():
    # 建議只由地圖頁產生，Agent 不挑建議
    assert not hasattr(carbon, "suggest")


# ── plan_route ──

def test_route_keeps_user_order():
    # 與地圖頁相同：依使用者提到的順序，不自動排序
    r = run_tool("plan_route", {"locations": ["A_TN_1", "A_TN_2", "R_TN_1"]})
    assert r["order"] == ["A_TN_1", "A_TN_2", "R_TN_1"]
    assert all(l["est"] is True for l in r["legs"])
    assert all("suggested" not in l for l in r["legs"]) and "suggested_kgCO2e" not in r
    assert "My Trip" in r["note"]


def test_route_lists_each_mode_carbon():
    r = run_tool("plan_route", {"locations": ["華山1914文化創意產業園區", "A_TP_2"]})
    assert r["order"] == ["A_TP_1", "A_TP_2"]
    leg = r["legs"][0]
    modes = [m["mode"] for m in leg["modes"]]
    assert modes == carbon.feasible_modes(leg["km"], (25.0441, 121.5293), (25.0880, 121.5240))
    for m in leg["modes"]:
        assert abs(m["kgCO2e"] - carbon.kg(m["mode"], leg["km"])) <= carbon.factors()[m["mode"]] * 0.051 + 0.001   # km 顯示到 0.1


def test_route_numbers_consistent():
    r = run_tool("plan_route", {"locations": ["A_TN_1", "A_TN_2", "R_TN_1"]})
    assert abs(r["total_km"] - sum(l["km"] for l in r["legs"])) <= 0.1
    car_legs = sum(next(m["kgCO2e"] for m in l["modes"] if m["mode"] == "car") for l in r["legs"])
    assert abs(r["car_kgCO2e"] - car_legs) < 0.002
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
    assert r["legs"][0]["modes"] == [] and "sea" in r["legs"][0]["note"]
    assert r["total_km"] == 0


# ── estimate_carbon ──

def test_estimate_carbon():
    r = run_tool("estimate_carbon", {"distance_km": 10, "mode": "bus"})
    assert r["kgCO2e"] == carbon.kg("bus", 10) and r["car_kgCO2e"] == carbon.kg("car", 10)
    assert r["saved_vs_car_kgCO2e"] == round(r["car_kgCO2e"] - r["kgCO2e"], 3)
    assert "error" in run_tool("estimate_carbon", {"distance_km": 10, "mode": "rocket"})
    assert run_tool("estimate_carbon", {"distance_km": -5, "mode": "car"})["kgCO2e"] == 0


# ── guard 數字檢查 ──

ROUTE = {"total_km": 5.2, "car_kgCO2e": 0.598,
         "legs": [{"km": 5.2, "from_name": "華山", "to_name": "士林夜市",
                   "modes": [{"mode": "bicycle", "kgCO2e": 0}, {"mode": "bus", "kgCO2e": 0.491},
                             {"mode": "car", "kgCO2e": 0.598}]}]}


def test_summary_always_appended():
    out = guard.finalize_route("騎腳踏車最環保。", ROUTE, "zh-TW")
    assert out.startswith("騎腳踏車最環保。")
    assert "📊" in out and "華山 → 士林夜市" in out and "5.2 公里" in out and "腳踏車 0 公斤" in out and "公車 0.49 公斤" in out
    leg_lines = [l for l in out.split("\n") if l[:1].isdigit()]
    assert "估算" in out and all("建議" not in l for l in leg_lines)          # 各段不挑建議
    assert "我的行程" in out and "加入行程" in out and "查詢路線" in out              # 引導到地圖頁


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
    # 交通方式與按鈕名稱和地圖頁（carbon/strings.js）一致
    for lang, mode, button in [("en", "Bicycle", "Find routes"), ("ja", "自転車", "ルート検索"),
                               ("de", "Fahrrad", "Routen suchen")]:
        out = guard.route_summary(ROUTE, lang)
        assert mode in out and button in out


def test_find_place_names_in_sentence():
    from app.tools.plan_route import find_place_names
    assert find_place_names("幫我安排安平古堡到林百貨的路線") == ["安平古堡", "林百貨"]
    assert find_place_names("林百貨，然後安平古堡") == ["林百貨", "安平古堡"]   # 依出現順序
    assert find_place_names("今天天氣很好") == []
