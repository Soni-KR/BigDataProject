"""Read-only CyberFlow API backed by the existing HBase REST gateway."""

import base64
import binascii
import os
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field


class SummaryNotFound(Exception):
    pass


class Summary(BaseModel):
    day: date
    total_flows: int = Field(ge=0)
    benign_flows: int = Field(ge=0)
    attack_flows: int = Field(ge=0)


METRICS = {"m:total_flows", "m:benign_flows", "m:attack_flows"}


def decode_text(value: str) -> str:
    return base64.b64decode(value, validate=True).decode("utf-8")


def decode_summary(payload: dict, day: str) -> Summary:
    """Decode the exact requested row; reject incomplete or ambiguous metrics."""
    rows = payload["Row"]
    if not rows:
        raise SummaryNotFound("Row not found")
    if len(rows) != 1 or decode_text(rows[0]["key"]) != day:
        raise ValueError("Unexpected row")
    values = {}
    for cell in rows[0]["Cell"]:
        column = decode_text(cell["column"])
        if column not in METRICS:
            continue
        name = column.split(":", 1)[1]
        raw = decode_text(cell["$"])
        if name in values or not raw.isascii() or not raw.isdecimal():
            raise ValueError("Invalid or duplicate metric")
        values[name] = int(raw)
    if set(values) != {column.split(":", 1)[1] for column in METRICS}:
        raise ValueError("Missing metric")
    if values["total_flows"] != values["benign_flows"] + values["attack_flows"]:
        raise ValueError("Inconsistent flow counts")
    return Summary(day=day, **values)


def create_app(*, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            base_url=os.getenv("HBASE_REST_URL", "http://hadoop-master:8090").rstrip("/"),
            timeout=5.0,
            headers={"Accept": "application/json"},
            trust_env=False,
            transport=transport,
        ) as client:
            app.state.hbase = client
            yield

    api = FastAPI(title="CyberFlow API", version="0.1.0", lifespan=lifespan)

    async def read_hbase(request: Request, path: str, *, params=None):
        try:
            response = await request.app.state.hbase.get(path, params=params)
            response.raise_for_status()
            return response
        except httpx.TimeoutException as exc:
            raise HTTPException(504, "HBase REST request timed out") from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                raise HTTPException(404, "Summary not found") from exc
            raise HTTPException(502, "HBase REST returned an error") from exc
        except httpx.RequestError as exc:
            raise HTTPException(503, "HBase REST is unavailable") from exc

    @api.get("/health")
    def health():
        """Process liveness; does not query HBase."""
        return {"status": "ok"}

    @api.get("/health/ready")
    async def ready(request: Request):
        """Readiness checks gateway connectivity without requiring a data row."""
        try:
            await read_hbase(request, "/version")
        except HTTPException as exc:
            raise HTTPException(503, "HBase REST is unavailable") from exc
        return {"status": "ok", "hbase": "reachable"}

    @api.get("/api/summary", response_model=Summary)
    async def summary(
        request: Request,
        day: Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")],
    ):
        try:
            date.fromisoformat(day)
        except ValueError as exc:
            raise HTTPException(422, "day must be a valid YYYY-MM-DD date") from exc
        response = await read_hbase(request, f"/cyber_daily/{day}", params={"v": 1})
        try:
            return decode_summary(response.json(), day)
        except SummaryNotFound as exc:
            raise HTTPException(404, "Summary not found") from exc
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, binascii.Error) as exc:
            raise HTTPException(502, "Invalid HBase summary data") from exc

    return api


app = create_app()
