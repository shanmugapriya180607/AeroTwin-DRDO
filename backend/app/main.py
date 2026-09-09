"""AEROTWIN ground-station backend."""

from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import router
from .core.constants import (AIRWORTHINESS_NOTICE, BUILD_STATUS, PRODUCT_NAME,
                             PRODUCT_SUBTITLE, PROGRAMME_REF)
from .service import service
from .ws.hub import ws_router

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    await service.startup()
    yield
    await service.shutdown()


app = FastAPI(
    title=f"{PRODUCT_NAME} - {PRODUCT_SUBTITLE}",
    description=(
        "Physics-synchronised digital twin for MALE UAV aero piston engines. "
        f"{BUILD_STATUS}. {AIRWORTHINESS_NOTICE}"
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # on-premise single-host deployment
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(ws_router)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "product": PRODUCT_NAME,
        "programme": PROGRAMME_REF,
        "boot": service.boot.status,
        "running": service.running,
    }


if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        index = FRONTEND_DIST / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"detail": "Frontend build not found"}, status_code=404)
