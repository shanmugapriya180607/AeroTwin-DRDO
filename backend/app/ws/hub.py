"""Websocket endpoints.

Four topics, matching the four things the ground station has to keep live:
telemetry, residuals, alerts and mission state. Each connection gets its own
bounded queue; a slow client drops frames rather than back-pressuring the twin.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.eventlog import event_log
from ..service import service

ws_router = APIRouter()
TOPICS = ("telemetry", "residuals", "alerts", "mission")


async def _pump(websocket: WebSocket, topic: str) -> None:
    await websocket.accept()
    queue = service.subscribe(topic)

    # Send an immediate snapshot so the client is never blank on connect.
    snapshot = {
        "telemetry": lambda: {"type": "telemetry", **service.telemetry_frame()},
        "residuals": lambda: {"type": "residuals", **service.residual_frame()},
        "alerts": lambda: {"type": "alerts", **service.alert_frame(),
                           "log": event_log.tail(60)},
        "mission": lambda: {"type": "mission", **service.mission_frame()},
    }[topic]

    try:
        payload = snapshot()
        if payload:
            await websocket.send_json(payload)
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=10.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "heartbeat", "topic": topic})
                continue
            await websocket.send_json(message)
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        return
    finally:
        service.unsubscribe(topic, queue)
        with contextlib.suppress(Exception):
            await websocket.close()


@ws_router.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket) -> None:
    await _pump(websocket, "telemetry")


@ws_router.websocket("/ws/residuals")
async def ws_residuals(websocket: WebSocket) -> None:
    await _pump(websocket, "residuals")


@ws_router.websocket("/ws/alerts")
async def ws_alerts(websocket: WebSocket) -> None:
    await _pump(websocket, "alerts")


@ws_router.websocket("/ws/mission")
async def ws_mission(websocket: WebSocket) -> None:
    await _pump(websocket, "mission")
