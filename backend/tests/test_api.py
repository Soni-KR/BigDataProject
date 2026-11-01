import base64
import json
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

def encoded(value):
    return base64.b64encode(str(value).encode()).decode()


def aggregate_row(key, **metrics):
    return {"key": encoded(key), "Cell": [
        {"column": encoded("m:" + name), "$": encoded(value)}
        for name, value in metrics.items()
    ]}


SMALL_DAY = {"Row": [aggregate_row("2017-07-07", total_flows=10, benign_flows=6, attack_flows=4)]}


def statistics_client(rows, table="cyber_attacks", summary=SMALL_DAY, status=200, schema=200):
    def handler(request):
        if request.url.path.startswith("/cyber_daily/"):
            return httpx.Response(200, json=summary)
        if request.url.path == "/" + table + "/schema":
            return httpx.Response(schema, json={})
        assert request.method == "GET"
        assert request.url.params["endrow"] == "2017-07-07$"
        assert request.url.raw_path.startswith(("/" + table + "/2017-07-07%23*").encode())
        return httpx.Response(status, json={"Row": rows})
    return client_for(handler)


def test_attack_categories_are_decoded_and_sorted():
    rows = [aggregate_row("2017-07-07#FTP", flow_count=1), aggregate_row("2017-07-07#SSH", flow_count=3)]
    with statistics_client(rows) as client:
        response = client.get("/api/attacks?day=2017-07-07")
    assert response.status_code == 200
    assert response.json() == {
        "day": "2017-07-07", "attack_flows": 4,
        "categories": [{"attack_type": "SSH", "flow_count": 3}, {"attack_type": "FTP", "flow_count": 1}],
    }


def test_benign_day_has_no_attack_categories():
    daily = {"Row": [aggregate_row("2017-07-07", total_flows=10, benign_flows=10, attack_flows=0)]}
    with statistics_client([], summary=daily, status=404) as client:
        response = client.get("/api/attacks?day=2017-07-07")
    assert response.status_code == 200
    assert response.json()["categories"] == []


def test_missing_aggregate_table_is_not_reported_as_zero_attacks():
    with statistics_client([], status=404, schema=404) as client:
        assert client.get("/api/attacks?day=2017-07-07").status_code == 502


PORT_SNAPSHOT = {
    "total_ports": 2, "total_flows": 10, "attack_flows": 4,
    "ports": [
        {"destination_port": 443, "total_flows": 4, "attack_flows": 3},
        {"destination_port": 80, "total_flows": 6, "attack_flows": 1},
    ],
}


def port_client(snapshot, summary=SMALL_DAY, calls=None):
    def handler(request):
        if calls is not None:
            calls.append(request.url.path)
        assert request.method == "GET"
        assert request.url.path == "/cyber_daily/2017-07-07"
        assert request.url.params["v"] == "1"
        payload = deepcopy(summary)
        if snapshot is not None:
            payload["Row"][0]["Cell"].append({
                "column": encoded("m:port_stats"), "$": encoded(json.dumps(snapshot)),
            })
        return httpx.Response(200, json=payload)
    return client_for(handler)


def test_port_limit_applies_after_totals_are_verified():
    calls = []
    with port_client(PORT_SNAPSHOT, calls=calls) as client:
        response = client.get("/api/ports?day=2017-07-07&limit=1")
    assert response.status_code == 200
    assert response.json() == {
        "day": "2017-07-07", "total_ports": 2, "total_flows": 10, "attack_flows": 4,
        "ports": [{"destination_port": 80, "total_flows": 6, "attack_flows": 1}],
    }
    assert calls == ["/cyber_daily/2017-07-07"]


def test_port_ties_sort_by_port_number():
    snapshot = deepcopy(PORT_SNAPSHOT)
    for row in snapshot["ports"]:
        row.update(total_flows=5, attack_flows=2)
    with port_client(snapshot) as client:
        assert client.get("/api/ports?day=2017-07-07&limit=1").json()["ports"][0]["destination_port"] == 80


def test_missing_port_snapshot_does_not_fall_back_to_a_scan():
    calls = []
    with port_client(None, calls=calls) as client:
        response = client.get("/api/ports?day=2017-07-07")
    assert response.status_code == 503
    assert calls == ["/cyber_daily/2017-07-07"]


def test_stored_top_fifty_preserves_full_totals():
    snapshot = {"total_ports": 51, "total_flows": 51, "attack_flows": 0, "ports": [
        {"destination_port": port, "total_flows": 1, "attack_flows": 0} for port in range(50)
    ]}
    daily = {"Row": [aggregate_row("2017-07-07", total_flows=51, benign_flows=51, attack_flows=0)]}
    with port_client(snapshot, summary=daily) as client:
        result = client.get("/api/ports?day=2017-07-07&limit=50").json()
    assert result["total_ports"] == 51
    assert result["total_flows"] == 51
    assert len(result["ports"]) == 50


@pytest.mark.parametrize("endpoint", ["attacks", "ports"])
@pytest.mark.parametrize("query", ["", "?day=bad", "?day=2017-02-30", "?day=20170707"])
def test_statistics_dates_are_validated(endpoint, query):
    def handler(request):
        pytest.fail("Invalid date reached HBase")
    with client_for(handler) as client:
        assert client.get("/api/" + endpoint + query).status_code == 422


@pytest.mark.parametrize("limit", ["0", "51", "-1", "bad"])
def test_port_limit_is_bounded(limit):
    with client_for(lambda request: pytest.fail("Invalid limit reached HBase")) as client:
        assert client.get("/api/ports?day=2017-07-07&limit=" + limit).status_code == 422


@pytest.mark.parametrize("rows", [
    [], [aggregate_row("2017-07-07#SSH", flow_count=3)],
    [aggregate_row("2017-07-06#SSH", flow_count=4)],
    [aggregate_row("2017-07-07#SSH", flow_count=-4)],
    [aggregate_row("2017-07-07#SSH", total_flows=4)],
    [aggregate_row("2017-07-07#SSH", flow_count=2)] * 2,
])
def test_incomplete_or_corrupt_attack_statistics_fail(rows):
    with statistics_client(rows) as client:
        assert client.get("/api/attacks?day=2017-07-07").status_code == 502


@pytest.mark.parametrize("snapshot", [
    {},
    {**PORT_SNAPSHOT, "total_ports": 1},
    {**PORT_SNAPSHOT, "total_ports": 65537},
    {**PORT_SNAPSHOT, "total_flows": 9},
    {**PORT_SNAPSHOT, "ports": PORT_SNAPSHOT["ports"][:1]},
    {**PORT_SNAPSHOT, "ports": [PORT_SNAPSHOT["ports"][0]] * 2},
    {**PORT_SNAPSHOT, "ports": [{"destination_port": 65536, "total_flows": 10, "attack_flows": 4}]},
    {**PORT_SNAPSHOT, "ports": [{"destination_port": "80", "total_flows": 10, "attack_flows": 4}]},
    {**PORT_SNAPSHOT, "ports": [{"destination_port": 80, "total_flows": 3, "attack_flows": 4}]},
])
def test_invalid_or_incomplete_port_statistics_fail(snapshot):
    with port_client(snapshot) as client:
        assert client.get("/api/ports?day=2017-07-07").status_code == 502


@pytest.mark.parametrize("raw", ["%%%", encoded("not json"), encoded("null"), encoded("[]")])
def test_corrupt_port_snapshot_fails(raw):
    payload = deepcopy(SMALL_DAY)
    payload["Row"][0]["Cell"].append({"column": encoded("m:port_stats"), "$": raw})
    with client_for(lambda request: httpx.Response(200, json=payload)) as client:
        assert client.get("/api/ports?day=2017-07-07").status_code == 502


@pytest.mark.parametrize("endpoint", ["attacks", "ports"])
def test_statistics_missing_day_and_network_errors(endpoint):
    with client_for(lambda request: httpx.Response(404)) as client:
        assert client.get("/api/" + endpoint + "?day=2017-07-07").status_code == 404
    def handler(request):
        raise httpx.ConnectError("offline", request=request)
    with client_for(handler) as client:
        assert client.get("/api/" + endpoint + "?day=2017-07-07").status_code == 503

def test_hbase_empty_scan_object_is_valid_for_a_benign_day():
    daily = {"Row": [aggregate_row("2017-07-07", total_flows=10, benign_flows=10, attack_flows=0)]}
    def handler(request):
        if request.url.path.startswith("/cyber_daily/"):
            return httpx.Response(200, json=daily)
        assert request.url.params["endrow"] == "2017-07-07$"
        return httpx.Response(200, json={})
    with client_for(handler) as client:
        response = client.get("/api/attacks?day=2017-07-07")
    assert response.status_code == 200
    assert response.json()["categories"] == []

@pytest.mark.parametrize("endpoint", ["attacks"])
@pytest.mark.parametrize("fault,expected", [
    ("timeout", 504), ("connection", 503), ("http", 502),
    ("json", 502), ("base64", 502), ("wrong_prefix", 502),
])
def test_statistics_upstream_failures_after_valid_summary(endpoint, fault, expected):
    def handler(request):
        if request.url.path.startswith("/cyber_daily/"):
            return httpx.Response(200, json=SMALL_DAY)
        assert request.method == "GET"
        assert request.url.fragment == ""
        assert b"%23*" in request.url.raw_path
        assert request.url.params["endrow"] == "2017-07-07$"
        assert request.url.params["v"] == "1"
        assert request.headers["Accept"] == "application/json"
        if fault == "timeout":
            raise httpx.ReadTimeout("aggregate timeout", request=request)
        if fault == "connection":
            raise httpx.ConnectError("aggregate unavailable", request=request)
        if fault == "http":
            return httpx.Response(500)
        if fault == "json":
            return httpx.Response(200, text="not json")
        prefix = "2017-07-08#" if fault == "wrong_prefix" else "2017-07-07#"
        row = (aggregate_row(prefix + "SSH", flow_count=4) if endpoint == "attacks"
               else aggregate_row(prefix + "00080", total_flows=10, attack_flows=4))
        if fault == "base64":
            row["Cell"][0]["$"] = "%%%"
        return httpx.Response(200, json={"Row": [row]})
    with client_for(handler) as client:
        assert client.get("/api/" + endpoint + "?day=2017-07-07").status_code == expected
