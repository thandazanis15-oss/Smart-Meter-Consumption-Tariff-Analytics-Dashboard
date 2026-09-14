from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import os
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import uvicorn

load_dotenv(Path(__file__).resolve().parent / ".env")

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

USERS_FILE = Path(__file__).with_name("users.json")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change-me-private")


class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str
    role: str | None = None


def hash_password(password: str) -> str:
    return hashlib.sha256(password.strip().encode("utf-8")).hexdigest()


def normalize_user_record(user: dict[str, Any]) -> dict[str, Any]:
    username = str(user.get("username", "")).strip()
    email = str(user.get("email", "")).strip()
    password_hash = str(user.get("password_hash") or user.get("password") or "")
    role = str(user.get("role", "user")).lower() if str(user.get("role", "user")).strip() else "user"
    return {
        "username": username,
        "email": email,
        "password_hash": password_hash,
        "role": role,
        "created_at": user.get("created_at") or datetime.utcnow().isoformat(timespec="seconds"),
    }


def load_users() -> list[dict[str, Any]]:
    if not USERS_FILE.exists():
        default_users = [{
            "username": ADMIN_USERNAME,
            "email": "admin@smartmeter.local",
            "password_hash": hash_password(ADMIN_PASSWORD),
            "role": "admin",
            "created_at": datetime.utcnow().isoformat(timespec="seconds"),
        }]
        USERS_FILE.write_text(json.dumps(default_users, indent=2), encoding="utf-8")
        return default_users

    try:
        raw = USERS_FILE.read_text(encoding="utf-8")
        if not raw.strip():
            default_users = [{
                "username": ADMIN_USERNAME,
                "email": "admin@smartmeter.local",
                "password_hash": hash_password(ADMIN_PASSWORD),
                "role": "admin",
                "created_at": datetime.utcnow().isoformat(timespec="seconds"),
            }]
            USERS_FILE.write_text(json.dumps(default_users, indent=2), encoding="utf-8")
            return default_users

        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            migrated = []
            for username, password_hash in parsed.items():
                migrated.append({
                    "username": username,
                    "email": f"{username.lower()}@smartmeter.local",
                    "password_hash": password_hash,
                    "role": "admin" if username.lower() == ADMIN_USERNAME.lower() else "user",
                    "created_at": datetime.utcnow().isoformat(timespec="seconds"),
                })
            USERS_FILE.write_text(json.dumps(migrated, indent=2), encoding="utf-8")
            return migrated

        return [normalize_user_record(user) for user in parsed]
    except json.JSONDecodeError:
        fallback = [{
            "username": ADMIN_USERNAME,
            "email": "admin@smartmeter.local",
            "password_hash": hash_password(ADMIN_PASSWORD),
            "role": "admin",
            "created_at": datetime.utcnow().isoformat(timespec="seconds"),
        }]
        USERS_FILE.write_text(json.dumps(fallback, indent=2), encoding="utf-8")
        return fallback


def save_users(users: list[dict[str, Any]]) -> None:
    USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")


def find_user(username: str) -> dict[str, Any] | None:
    normalized = username.strip()
    if not normalized:
        return None
    for user in load_users():
        if user.get("username", "").lower() == normalized.lower():
            return user
    return None


def verify_credentials(username: str, password: str) -> bool:
    user = find_user(username)
    if not user:
        return False
    return bool(user.get("password_hash") == hash_password(password))


@app.post("/auth/register")
async def register_user(payload: RegisterRequest) -> dict[str, Any]:
    username = payload.username.strip()
    email = payload.email.strip().lower()
    password = payload.password.strip()

    if not username or len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must have at least 3 characters.")
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters long.")

    users = load_users()
    if any(user.get("username", "").lower() == username.lower() for user in users):
        raise HTTPException(status_code=409, detail="That username is already in use.")
    if any(user.get("email", "").lower() == email.lower() for user in users):
        raise HTTPException(status_code=409, detail="That email address is already in use.")

    user_record = {
        "username": username,
        "email": email,
        "password_hash": hash_password(password),
        "role": "user",
        "created_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    users.append(user_record)
    save_users(users)
    return {"message": "Account created successfully.", "user": {"username": username, "email": email, "role": "user"}}


@app.post("/auth/login")
async def login_user(payload: LoginRequest) -> dict[str, Any]:
    username = payload.username.strip()
    password = payload.password.strip()
    requested_role = (payload.role or "").strip().lower()

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required.")

    user = find_user(username)
    if user and user.get("password_hash") == hash_password(password):
        if requested_role in {"admin", "administrator"} and user.get("role") != "admin":
            raise HTTPException(status_code=401, detail="This account is not authorized for admin login.")
        if requested_role in {"department", "member", "user"} and user.get("role") == "admin":
            raise HTTPException(status_code=401, detail="Use the Admin option for administrator access.")
        return {
            "message": "Login successful.",
            "user": {
                "username": user.get("username", username),
                "email": user.get("email", ""),
                "role": user.get("role", "user"),
            },
        }

    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        if requested_role in {"department", "member", "user"}:
            raise HTTPException(status_code=401, detail="Use the Admin option for administrator access.")
        admin_user = find_user(ADMIN_USERNAME) or {
            "username": ADMIN_USERNAME,
            "email": "admin@smartmeter.local",
            "role": "admin",
        }
        return {
            "message": "Login successful.",
            "user": {
                "username": admin_user.get("username", "Thanda"),
                "email": admin_user.get("email", "admin@smartmeter.local"),
                "role": "admin",
            },
        }

    if requested_role in {"department", "member", "user"}:
        raise HTTPException(status_code=401, detail="Department member account not found or credentials are incorrect.")

    raise HTTPException(status_code=401, detail="Invalid username or password.")


@app.get("/admin/users")
async def admin_users() -> list[dict[str, Any]]:
    users = load_users()
    return [
        {
            "username": user.get("username", "Unknown"),
            "email": user.get("email", ""),
            "role": user.get("role", "user"),
            "created_at": user.get("created_at", "unknown"),
        }
        for user in users
    ]


@app.post("/admin/notice")
async def admin_notice(payload: dict[str, str]) -> dict[str, str]:
    message = (payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Notice message is required.")
    return {"message": message, "status": "broadcasted"}


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

    weather_factor = 1 + (0.08 * random.uniform(-1, 1))
    occupancy_factor = 1 + (0.06 * random.uniform(-1, 1))
    load_variation = 1 + (0.05 * random.uniform(-1, 1))
    baseline = HOURLY_PROFILE["base"] * multiplier
    consumption_kwh = baseline * weather_factor * occupancy_factor * load_variation
    consumption_kwh = min(max(consumption_kwh, 18), 160)

    temperature = 20 + (12 * ((-abs(hour - 14) / 12) + 1)) + random.uniform(-4, 4)
    temperature = max(11, min(36, temperature))
    demand_kw = round(consumption_kwh * 1.6, 2)
    tariff = "peak" if 7 <= hour <= 9 or 17 <= hour <= 21 else "off_peak"

    anomaly = False
    if random.random() < 0.08:
        anomaly = True
        consumption_kwh *= random.uniform(1.18, 1.42)
        demand_kw *= random.uniform(1.12, 1.32)

    price = 0.27 if tariff == "peak" else 0.18
    return {
        "timestamp": current_hour.isoformat(),
        "hour": current_hour.strftime("%H:00"),
        "day": current_hour.strftime("%A"),
        "temperature_c": round(temperature, 1),
        "consumption_kwh": round(consumption_kwh, 2),
        "demand_kw": round(demand_kw, 2),
        "tariff": tariff,
        "anomaly": anomaly,
        "price_per_kwh": round(price, 3),
        "estimated_cost": round(consumption_kwh * price, 2),
    }


def generate_history(start_date: str | None = None, end_date: str | None = None) -> list[dict[str, Any]]:
    now = datetime.now().replace(minute=0, second=0, microsecond=0)
    start_dt = datetime.fromisoformat(start_date) if start_date else now - timedelta(days=7)
    end_dt = datetime.fromisoformat(end_date) if end_date else now
    start_dt = start_dt.replace(minute=0, second=0, microsecond=0)
    end_dt = end_dt.replace(hour=23, minute=59, second=59, microsecond=0)

    points: list[dict[str, Any]] = []
    current = start_dt
    while current <= end_dt:
        hours_ago = int((now - current).total_seconds() // 3600)
        if hours_ago >= 0:
            points.append(generate_hourly_payload(hours_ago))
        current += timedelta(hours=1)

    return sorted(points, key=lambda item: item["timestamp"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/history")
async def history(
    start_date: str | None = Query(default=None, alias="start_date"),
    end_date: str | None = Query(default=None, alias="end_date"),
) -> list[dict[str, Any]]:
    return generate_history(start_date=start_date, end_date=end_date)


@app.get("/report/export")
async def export_report(
    start_date: str | None = Query(default=None, alias="start_date"),
    end_date: str | None = Query(default=None, alias="end_date"),
) -> PlainTextResponse:
    data = generate_history(start_date=start_date, end_date=end_date)
    fieldnames = [
        "timestamp",
        "hour",
        "day",
        "temperature_c",
        "consumption_kwh",
        "demand_kw",
        "tariff",
        "anomaly",
        "price_per_kwh",
        "estimated_cost",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for row in data:
        writer.writerow(row)
    return PlainTextResponse(buffer.getvalue(), media_type="text/csv")


@app.websocket("/ws/metrics")
async def metrics_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        for i in range(72):
            payload = generate_hourly_payload(i)
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(1.4)
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
