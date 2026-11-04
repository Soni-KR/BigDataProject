"""Read-only CyberFlow API backed by the existing HBase REST gateway."""

import base64
import json  #convertir du JSON en objets Python
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



class AttackCategory(BaseModel):
    attack_type: str = Field(min_length=1)
    flow_count: int = Field(ge=0)


class AttackStatistics(BaseModel):
    day: date
    attack_flows: int = Field(ge=0)
    categories: list[AttackCategory]


class PortStatistic(BaseModel):
    destination_port: int = Field(ge=0, le=65535, strict=True)
    total_flows: int = Field(ge=0, strict=True)
    attack_flows: int = Field(ge=0, strict=True)


class PortStatistics(BaseModel):
    day: date
    total_ports: int = Field(ge=0, le=65536, strict=True)
    total_flows: int = Field(ge=0, strict=True)
    attack_flows: int = Field(ge=0, strict=True)
    ports: list[PortStatistic]


def decode_statistics(payload: dict, day: str, metrics: set[str]) -> dict:
    rows = payload.get("Row", [])
    if not isinstance(rows, list) or len(rows) > 65536:
        raise ValueError("Invalid aggregate rows")
    result = {}
    for row in rows:
        key = decode_text(row["key"])
        if not key.startswith(day + "#") or not key[len(day) + 1:] or key in result:
            raise ValueError("Unexpected or duplicate aggregate key")
        values = {}
        for cell in row["Cell"]:
            column = decode_text(cell["column"])
            if column not in metrics:
                continue
            raw = decode_text(cell["$"])
            if column in values or not raw.isascii() or not raw.isdecimal():
                raise ValueError("Invalid aggregate metric")
            values[column] = int(raw)
        if set(values) != metrics:
            raise ValueError("Missing aggregate metric")
        result[key] = values
    return result


def create_app(*, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            base_url=os.getenv("HBASE_REST_URL", "http://hadoop-master:8090").rstrip("/"),
            timeout=15.0,
            headers={"Accept": "application/json"},
            trust_env=False,
            transport=transport,
        ) as client:
            app.state.hbase = client
            yield

    api = FastAPI(title="CyberFlow API", version="0.1.0", lifespan=lifespan)

    async def read_hbase(request: Request, path: str, *, params=None, allow_missing=False):
        try:
            response = await request.app.state.hbase.get(path, params=params)
            response.raise_for_status()
            return response
        except httpx.TimeoutException as exc:
            raise HTTPException(504, "HBase REST request timed out") from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                if allow_missing:
                    return None
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

    async def read_daily(request: Request, day: str):
        try:
            date.fromisoformat(day)
        except ValueError as exc:
            raise HTTPException(422, "day must be a valid YYYY-MM-DD date") from exc
        response = await read_hbase(request, f"/cyber_daily/{day}", params={"v": 1})
        try:
            payload = response.json()
            return decode_summary(payload, day), payload
        except SummaryNotFound as exc:
            raise HTTPException(404, "Summary not found") from exc
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            raise HTTPException(502, "Invalid HBase summary data") from exc

    @api.get("/api/summary", response_model=Summary)
    async def summary(request: Request, day: Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]):
        daily, _ = await read_daily(request, day)
        return daily

    async def statistics(request: Request, table: str, day: str, metrics: set[str]):
        response = await read_hbase(request, f"/{table}/{day}%23*", params={"v": 1, "endrow": day + "$"}, allow_missing=True)
        if response is None:
            # An empty prefix is valid; a missing table is an upstream failure.
            try:
                await read_hbase(request, f"/{table}/schema")
            except HTTPException as exc:
                if exc.status_code == 404:
                    raise HTTPException(502, "HBase aggregate table is missing") from exc
                raise
            return {}
        try:
            return decode_statistics(response.json(), day, metrics)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            raise HTTPException(502, "Invalid HBase aggregate data") from exc

    @api.get("/api/attacks", response_model=AttackStatistics)
    async def attacks(request: Request, day: Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]):
        daily = await summary(request, day)
        rows = await statistics(request, "cyber_attacks", day, {"m:flow_count"})
        categories = [
            AttackCategory(attack_type=key[len(day) + 1:], flow_count=values["m:flow_count"])
            for key, values in rows.items()
        ]
        categories.sort(key=lambda item: (-item.flow_count, item.attack_type))
        if sum(item.flow_count for item in categories) != daily.attack_flows:
            raise HTTPException(502, "Attack aggregates do not match the daily summary")
        return AttackStatistics(day=day, attack_flows=daily.attack_flows, categories=categories)

    @api.get("/api/ports", response_model=PortStatistics)
    async def ports(
        request: Request,
        day: Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")],
        limit: Annotated[int, Query(ge=1, le=50)] = 10,
    ):
        daily, payload = await read_daily(request, day)
        try:
            cells = [cell for cell in payload["Row"][0]["Cell"]
                     if decode_text(cell["column"]) == "m:port_stats"]
            if not cells:
                raise HTTPException(503, "Port statistics are not imported; run the pipeline")
            if len(cells) != 1:
                raise ValueError("Duplicate port snapshot")
            data = json.loads(decode_text(cells[0]["$"]))
            result = PortStatistics(day=day, **data)
            if (result.total_flows != daily.total_flows or result.attack_flows != daily.attack_flows
                    or len(result.ports) != min(50, result.total_ports)
                    or len({item.destination_port for item in result.ports}) != len(result.ports)
                    or any(item.attack_flows > item.total_flows for item in result.ports)):
                raise ValueError("Inconsistent port snapshot")
            top_total = sum(item.total_flows for item in result.ports)
            top_attacks = sum(item.attack_flows for item in result.ports)
            if top_total > daily.total_flows or top_attacks > daily.attack_flows:
                raise ValueError("Invalid port totals")
            if result.total_ports <= 50 and (top_total != daily.total_flows or top_attacks != daily.attack_flows):
                raise ValueError("Incomplete port snapshot")
            result.ports.sort(key=lambda item: (-item.total_flows, item.destination_port))
            result.ports = result.ports[:limit]
            return result
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            raise HTTPException(502, "Invalid HBase port statistics") from exc

    return api


app = create_app()
