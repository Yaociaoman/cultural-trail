"""estimate_carbon：單段距離的碳排試算。"""
from .. import carbon

SCHEMA = {
    "name": "estimate_carbon",
    "description": "試算某段距離用某種交通方式的碳排（每人），並與自駕比較。使用者只問單一段距離的碳排時使用；多個地點請用 plan_route。",
    "parameters": {
        "type": "object",
        "properties": {
            "distance_km": {"type": "number", "description": "距離（公里）"},
            "mode": {"type": "string", "enum": carbon.modes(),
                     "description": "walk 步行、bicycle 腳踏車、bus 公車客運、train 臺鐵、hsr 高鐵、motorcycle 機車、car 自駕"},
        },
        "required": ["distance_km", "mode"],
    },
}


def run(distance_km: float, mode: str) -> dict:
    km = round(distance_km, 1)
    value, car = carbon.kg(mode, km), carbon.kg("car", km)
    return {"distance_km": km, "mode": mode, "kgCO2e": value, "car_kgCO2e": car,
            "saved_vs_car_kgCO2e": round(car - value, 3),
            "note": "Per person, estimated with official factors. Tell the user this is an estimate."}
