import base64
from copy import deepcopy

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


FRIDAY = {
    "Row": [{
        "key": "MjAxNy0wNy0wNw==",
        "Cell": [
            {"column": "bTphdHRhY2tfZmxvd3M=", "$": "Mjg4OTIz"},
            {"column": "bTpiZW5pZ25fZmxvd3M=", "$": "NDE0MzIy"},
            {"column": "bTp0b3RhbF9mbG93cw==", "$": "NzAzMjQ1"},
        ],
    }],
}


def client_for(handler):
    return TestClient(create_app(transport=httpx.MockTransport(handler)))


def test_friday_summary_uses_read_only_hbase_request():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/cyber_daily/2017-07-07"
        assert request.url.params["v"] == "1"
        assert request.headers["Accept"] == "application/json"
        return httpx.Response(200, json=FRIDAY)

    with client_for(handler) as client:
        response = client.get("/api/summary?day=2017-07-07")
    assert response.status_code == 200
    assert response.json() == {
        "day": "2017-07-07", "total_flows": 703245,
        "benign_flows": 414322, "attack_flows": 288923,
    }


@pytest.mark.parametrize("query", ["", "?day=bad", "?day=2017-02-30", "?day=20170707", "?day=2017-7-7"])
def test_invalid_day_never_queries_hbase(query):
    def handler(request):
        pytest.fail("Invalid date reached HBase")

    with client_for(handler) as client:
        assert client.get("/api/summary" + query).status_code == 422


@pytest.mark.parametrize("status,expected", [(404, 404), (500, 502), (403, 502)])
def test_upstream_errors(status, expected):
    with client_for(lambda request: httpx.Response(status)) as client:
        assert client.get("/api/summary?day=2017-07-07").status_code == expected


@pytest.mark.parametrize("error,expected", [(httpx.ConnectError, 503), (httpx.ReadTimeout, 504)])
def test_network_errors(error, expected):
    def handler(request):
        raise error("upstream failed", request=request)

    with client_for(handler) as client:
        assert client.get("/api/summary?day=2017-07-07").status_code == expected
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/health/ready").status_code == 503


def test_health_checks():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/version"
        return httpx.Response(200, json={"REST": "test"})

    with client_for(handler) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/health/ready").json() == {"status": "ok", "hbase": "reachable"}


@pytest.mark.parametrize("payload,expected", [({"Row": []}, 404), ({}, 502), ({"Row": [None]}, 502), ([], 502)])
def test_missing_or_malformed_rows(payload, expected):
    with client_for(lambda request: httpx.Response(200, json=payload)) as client:
        assert client.get("/api/summary?day=2017-07-07").status_code == expected


@pytest.mark.parametrize("fault", ["base64", "integer", "missing", "duplicate", "row", "inconsistent", "negative"])
def test_corrupt_cells_are_not_silently_zeroed(fault):
    payload = deepcopy(FRIDAY)
    row = payload["Row"][0]
    cells = row["Cell"]
    if fault == "base64":
        cells[0]["$"] = "%%%"
    elif fault == "integer":
        cells[0]["$"] = base64.b64encode(b"bad").decode()
    elif fault == "missing":
        cells.pop()
    elif fault == "duplicate":
        cells.append(cells[0])
    elif fault == "row":
        row["key"] = base64.b64encode(b"2017-07-06").decode()
    elif fault == "inconsistent":
        cells[0]["$"] = base64.b64encode(b"1").decode()
    else:
        cells[0]["$"] = base64.b64encode(b"-1").decode()
    with client_for(lambda request: httpx.Response(200, json=payload)) as client:
        assert client.get("/api/summary?day=2017-07-07").status_code == 502


def test_invalid_json():
    with client_for(lambda request: httpx.Response(200, text="not json")) as client:
        assert client.get("/api/summary?day=2017-07-07").status_code == 502
