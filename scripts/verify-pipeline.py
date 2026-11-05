#!/usr/bin/env python3
"""Compare les résultats de Spark avec les réponses de l'API utilisant HBase."""

import argparse
import json
import subprocess
from urllib.request import urlopen

# Récupérer le chemin du traitement Spark à vérifier.
parser = argparse.ArgumentParser()
parser.add_argument("run_path")
parser.add_argument("--api", default="http://api:8000")
parser.add_argument("--dashboard", default="http://dashboard:8080")
args = parser.parse_args()

# Vérifier que le chemin correspond à une exécution CyberFlow valide.
if not args.run_path.startswith("/cyberflow/runs/") or ".." in args.run_path:
    parser.error("Use a completed path under /cyberflow/runs/")


# Envoyer une requête HTTP et récupérer la réponse JSON.
def get(base, path):
    with urlopen(base + path, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


# Lire le manifest généré par Spark depuis HDFS.
manifest_text = subprocess.check_output([
    "hdfs", "dfs", "-cat", args.run_path + "/exports/manifest/part-*"
]).decode("utf-8")

manifest = [json.loads(line) for line in manifest_text.splitlines() if line.strip()]

if not manifest:
    raise RuntimeError("The run manifest is empty")


# Récupérer les statistiques des ports calculées par Spark.
source_ports = {}

port_export = subprocess.Popen(
    ["hdfs", "dfs", "-cat", args.run_path + "/exports/ports/part-*"],
    stdout=subprocess.PIPE,
    universal_newlines=True
)

# Organiser les statistiques des ports par jour.
for line in port_export.stdout:
    key, count, attacks = line.rstrip("\r\n").split("|")
    day, port = key.split("#", 1)

    source_ports.setdefault(day, []).append({
        "destination_port": int(port),
        "total_flows": int(count),
        "attack_flows": int(attacks),
    })

# Vérifier que la lecture des données HDFS s'est terminée correctement.
if port_export.wait() != 0:
    raise RuntimeError("Cannot read the Spark port export")


total = 0

# Comparer les résultats Spark avec ceux stockés dans HBase et exposés par l'API.
for expected in sorted(manifest, key=lambda row: row["day"]):
    day = expected["day"]

    daily = get(args.api, "/api/summary?day=" + day)
    attacks = get(args.api, "/api/attacks?day=" + day)
    ports = get(args.api, "/api/ports?day=" + day + "&limit=50")

    # Vérifier les statistiques quotidiennes : trafic total, trafic normal et attaques.
    for metric in ("total_flows", "benign_flows", "attack_flows"):
        if daily[metric] != expected[metric]:
            raise RuntimeError("Daily count mismatch: " + day + " " + metric)

    # Vérifier les statistiques par catégorie d'attaque.
    if (
        attacks["attack_flows"] != daily["attack_flows"]
        or sum(row["flow_count"] for row in attacks["categories"])
        != daily["attack_flows"]
        or len(attacks["categories"]) != expected["attack_categories"]
    ):
        raise RuntimeError("Attack aggregate mismatch: " + day)

    # Vérifier les statistiques globales des ports.
    if (
        ports["total_flows"] != daily["total_flows"]
        or ports["attack_flows"] != daily["attack_flows"]
        or ports["total_ports"] != expected["destination_ports"]
    ):
        raise RuntimeError("Port aggregate mismatch: " + day)

    # Recalculer le classement des ports à partir des résultats de Spark.
    expected_ports = sorted(
        source_ports[day],
        key=lambda row: (-row["total_flows"], row["destination_port"])
    )

    # Vérifier le classement des 50 ports les plus utilisés et leurs totaux.
    if (
        ports["ports"] != expected_ports[:50]
        or sum(row["total_flows"] for row in expected_ports)
        != daily["total_flows"]
        or sum(row["attack_flows"] for row in expected_ports)
        != daily["attack_flows"]
    ):
        raise RuntimeError("Port ranking or totals disagree with Spark: " + day)

    # Vérifier que le paramètre limit conserve le même classement.
    for limit in (1, 10):
        limited = get(
            args.api,
            "/api/ports?day=" + day + "&limit=" + str(limit)
        )

        if (
            limited["ports"] != expected_ports[:limit]
            or limited["total_ports"] != len(expected_ports)
        ):
            raise RuntimeError("Port limit changed the ranking: " + day)

    # Ajouter le nombre de flux du jour au total général.
    total += daily["total_flows"]

    print("{}: {} flows, {} attack categories, {} ports".format(
        day,
        daily["total_flows"],
        len(attacks["categories"]),
        ports["total_ports"]
    ))


# Vérifier que le nombre de lignes des CSV sources correspond aux flux traités.
listing = subprocess.check_output([
    "hdfs", "dfs", "-ls", "/cyberflow/raw/*.csv"
]).decode("utf-8")

# Compter le nombre de fichiers CSV présents dans HDFS.
headers = sum(line.startswith("-") for line in listing.splitlines())

# Lire les fichiers CSV et compter leurs lignes.
raw = subprocess.Popen(
    ["hdfs", "dfs", "-cat", "/cyberflow/raw/*.csv"],
    stdout=subprocess.PIPE
)

raw_rows = sum(1 for line in raw.stdout) - headers

if raw.wait() != 0 or raw_rows != total:
    raise RuntimeError("Raw CSV and processed row counts disagree")


# Vérifier que le dashboard transmet correctement les réponses de l'API.
day = manifest[-1]["day"]

for endpoint in ("summary", "attacks", "ports"):
    api_result = get(args.api, "/api/" + endpoint + "?day=" + day)
    dashboard_result = get(
        args.dashboard,
        "/api/" + endpoint + "?day=" + day
    )

    if dashboard_result != api_result:
        raise RuntimeError("Dashboard proxy mismatch: " + endpoint)


# Vérifier que le dashboard est opérationnel.
if get(args.dashboard, "/healthz")["status"] != "ok":
    raise RuntimeError("Dashboard health check failed")


# Afficher le résultat final de la vérification.
print(
    "Verified {} raw CSV files and {} flows through Spark, HBase, API and dashboard proxy."
    .format(headers, total)
)
