from __future__ import annotations

import asyncio
import json
import random
from datetime import datetime, timedelta
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Smart Meter Billing Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HOURLY_PROFILE = {
    "base": 42,
    "morning_peak": 1.35,
    "evening_peak": 1.5,
    "night_demand": 0.66,
}


def generate_hourly_payload(hour_index: int) -> dict[str, Any]:
    now = datetime.now().replace(minute=0, second=0, microsecond=0)
    current_hour = now - timedelta(hours=hour_index)

    hour = current_hour.hour
    multiplier = 1.0
    if 7 <= hour <= 9:
        multiplier = HOURLY_PROFILE["morning_peak"]
    elif 17 <= hour <= 21:
        multiplier = HOURLY_PROFILE["evening_peak"]
    elif 0 <= hour <= 5:
        multiplier = HOURLY_PROFILE["night_demand"]

    usage = HOURLY_PROFILE["base"] * multiplier
    weather_factor = 1 + (0.11 * random.uniform(-1, 1))
    occupancy_factor = 1 + (0.12 * random.uniform(-1, 1))
    load_variation = 1 + (0.08 * random.uniform(-1, 1))

    consumption_kwh = max(10, usage * weather_factor * occupancy_factor * load_variation)
    temperature = round(18 + (hour * 0.85) + random.uniform(-6, 9), 1)
    demand_kw = round(consumption_kwh * 1.8, 2)
    tariff = "peak" if 7 <= hour <= 9 or 17 <= hour <= 21 else "off_peak"

    anomaly = False
    if random.random() < 0.15:
        anomaly = True
        consumption_kwh *= random.uniform(1.3, 1.85)
        demand_kw *= random.uniform(1.2, 1.7)

    return {
        "timestamp": current_hour.isoformat(),
        "hour": current_hour.strftime("%H:00"),
        "day": current_hour.strftime("%A"),
        "temperature_c": temperature,
        "consumption_kwh": round(consumption_kwh, 2),
        "demand_kw": round(demand_kw, 2),
        "tariff": tariff,
        "anomaly": anomaly,
        "price_per_kwh": round(0.18 if tariff == "off_peak" else 0.27, 3),
        "estimated_cost": round(consumption_kwh * (0.18 if tariff == "off_peak" else 0.27), 2),
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/history")
async def history() -> list[dict[str, Any]]:
    return [generate_hourly_payload(index) for index in range(24)]


@app.websocket("/ws/metrics")
async def metrics_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        for i in range(60):
            payload = generate_hourly_payload(i)
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(1.2)
    except Exception:
        pass
    finally:
        await websocket.close()
