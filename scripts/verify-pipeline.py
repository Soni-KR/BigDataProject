#!/usr/bin/env python3
"""Compare a completed Spark run with HBase-backed API responses."""
import argparse
import json
import subprocess
from urllib.request import urlopen

parser = argparse.ArgumentParser()
parser.add_argument("run_path")
parser.add_argument("--api", default="http://api:8000")
parser.add_argument("--dashboard", default="http://dashboard:8080")
args = parser.parse_args()
if not args.run_path.startswith("/cyberflow/runs/") or ".." in args.run_path:
    parser.error("Use a completed path under /cyberflow/runs/")


def get(base, path):
    with urlopen(base + path, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


manifest_text = subprocess.check_output([
    "hdfs", "dfs", "-cat", args.run_path + "/exports/manifest/part-*"
]).decode("utf-8")
manifest = [json.loads(line) for line in manifest_text.splitlines() if line.strip()]
if not manifest:
    raise RuntimeError("The run manifest is empty")
source_ports = {}
port_export = subprocess.Popen(
    ["hdfs", "dfs", "-cat", args.run_path + "/exports/ports/part-*"],
    stdout=subprocess.PIPE, universal_newlines=True)
for line in port_export.stdout:
    key, count, attacks = line.rstrip("\r\n").split("|")
    day, port = key.split("#", 1)
    source_ports.setdefault(day, []).append({
        "destination_port": int(port), "total_flows": int(count), "attack_flows": int(attacks),
    })
if port_export.wait() != 0:
    raise RuntimeError("Cannot read the Spark port export")

total = 0
for expected in sorted(manifest, key=lambda row: row["day"]):
    day = expected["day"]
    daily = get(args.api, "/api/summary?day=" + day)
    attacks = get(args.api, "/api/attacks?day=" + day)
    ports = get(args.api, "/api/ports?day=" + day + "&limit=50")
    for metric in ("total_flows", "benign_flows", "attack_flows"):
        if daily[metric] != expected[metric]:
            raise RuntimeError("Daily count mismatch: " + day + " " + metric)
    if (attacks["attack_flows"] != daily["attack_flows"]
            or sum(row["flow_count"] for row in attacks["categories"]) != daily["attack_flows"]
            or len(attacks["categories"]) != expected["attack_categories"]):
        raise RuntimeError("Attack aggregate mismatch: " + day)
    if (ports["total_flows"] != daily["total_flows"]
            or ports["attack_flows"] != daily["attack_flows"]
            or ports["total_ports"] != expected["destination_ports"]):
        raise RuntimeError("Port aggregate mismatch: " + day)
    expected_ports = sorted(source_ports[day], key=lambda row: (-row["total_flows"], row["destination_port"]))
    if (ports["ports"] != expected_ports[:50]
            or sum(row["total_flows"] for row in expected_ports) != daily["total_flows"]
            or sum(row["attack_flows"] for row in expected_ports) != daily["attack_flows"]):
        raise RuntimeError("Port ranking or totals disagree with Spark: " + day)
    for limit in (1, 10):
        limited = get(args.api, "/api/ports?day=" + day + "&limit=" + str(limit))
        if limited["ports"] != expected_ports[:limit] or limited["total_ports"] != len(expected_ports):
            raise RuntimeError("Port limit changed the ranking: " + day)
    total += daily["total_flows"]
    print("{}: {} flows, {} attack categories, {} ports".format(
        day, daily["total_flows"], len(attacks["categories"]), ports["total_ports"]))

listing = subprocess.check_output(["hdfs", "dfs", "-ls", "/cyberflow/raw/*.csv"]).decode("utf-8")
headers = sum(line.startswith("-") for line in listing.splitlines())
raw = subprocess.Popen(["hdfs", "dfs", "-cat", "/cyberflow/raw/*.csv"], stdout=subprocess.PIPE)
raw_rows = sum(1 for line in raw.stdout) - headers
if raw.wait() != 0 or raw_rows != total:
    raise RuntimeError("Raw CSV and processed row counts disagree")

day = manifest[-1]["day"]
for endpoint in ("summary", "attacks", "ports"):
    if get(args.dashboard, "/api/" + endpoint + "?day=" + day) != get(args.api, "/api/" + endpoint + "?day=" + day):
        raise RuntimeError("Dashboard proxy mismatch: " + endpoint)
if get(args.dashboard, "/healthz")["status"] != "ok":
    raise RuntimeError("Dashboard health check failed")
print("Verified {} raw CSV files and {} flows through Spark, HBase, API and dashboard proxy.".format(headers, total))
