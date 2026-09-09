"""Operational event log - the technical trace the ground station keeps."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from typing import Callable, Iterable

LEVELS = ("DEBUG", "INFO", "ADVISORY", "WARNING", "CRITICAL")


class EventLog:
    def __init__(self, capacity: int = 600) -> None:
        self._events: deque[dict] = deque(maxlen=capacity)
        self._seq = 0
        self._subscribers: list[Callable[[dict], None]] = []

    def subscribe(self, callback: Callable[[dict], None]) -> Callable[[], None]:
        self._subscribers.append(callback)

        def unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return unsubscribe

    def emit(self, level: str, source: str, message: str, **meta) -> dict:
        self._seq += 1
        now = datetime.now(timezone.utc)
        event = {
            "seq": self._seq,
            "ts": now.isoformat(timespec="milliseconds"),
            "clock": now.strftime("%H:%M:%S"),
            "level": level if level in LEVELS else "INFO",
            "source": source,
            "message": message,
            "meta": meta or {},
        }
        self._events.append(event)
        for callback in list(self._subscribers):
            try:
                callback(event)
            except Exception:
                continue
        return event

    def info(self, source: str, message: str, **meta) -> dict:
        return self.emit("INFO", source, message, **meta)

    def advisory(self, source: str, message: str, **meta) -> dict:
        return self.emit("ADVISORY", source, message, **meta)

    def warning(self, source: str, message: str, **meta) -> dict:
        return self.emit("WARNING", source, message, **meta)

    def critical(self, source: str, message: str, **meta) -> dict:
        return self.emit("CRITICAL", source, message, **meta)

    def tail(self, limit: int = 120, level: str | None = None) -> list[dict]:
        events: Iterable[dict] = self._events
        if level:
            wanted = LEVELS[LEVELS.index(level):] if level in LEVELS else LEVELS
            events = [e for e in events if e["level"] in wanted]
        return list(events)[-limit:]

    def clear(self) -> None:
        self._events.clear()


event_log = EventLog()
