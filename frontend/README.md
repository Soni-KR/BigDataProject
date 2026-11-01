# CyberFlow React dashboard

React + Vite + Recharts frontend for the existing read-only FastAPI backend.
All traffic counts come from GET /api/summary for 03–07 July 2017. The fixed
capture dates describe the dataset; no flow counts are hardcoded in the app.
Test fixtures contain the already-verified Friday response.

## Start with Docker (recommended)

From the repository root in PowerShell:

```powershell
.\start-dashboard.ps1
```

Or use the equivalent command:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dashboard.yml up -d --build --wait --wait-timeout 90
```

Open http://localhost:3000. The existing Hadoop cluster and HBase REST gateway
must be running. The original backend and Compose file are unchanged; the new
Compose overlay adds only the dashboard service on the external hadoop network.
Both services bind their host ports to localhost.

If port 3000 is already in use:

```powershell
$env:CYBERFLOW_DASHBOARD_PORT = '3001'
.\start-dashboard.ps1
```

The dashboard proxies /api, /health, /docs and /openapi.json to the API.
The browser never needs to resolve Docker hostnames. No CORS change is needed.
GET /healthz checks the frontend server. HBase readiness is shown separately.
The dashboard can start while HBase is unavailable and shows an actionable error.

## Features

- A date selector for the five capture days; Friday selected initially.
- Exact total, benign and attack counts, plus calculated attack rate.
- Weekly stacked flows chart and attack-rate chart.
- Selected-day composition chart and accessible exact-value table.
- CSV export of available summaries, with stable numeric columns and UTF-8 BOM
  for Excel. Missing/failed capture days are excluded, never exported as zeros.
- Manual refresh, partial-data messages, missing-record state and outage state.
- Responsive navigation, keyboard controls and reduced-motion support.
- API documentation opens through the same dashboard origin.

This is analysis of historical labeled captures, not live intrusion detection.
HDFS and Spark in the pipeline describe upstream processing; the health checks
only assert HBase REST and FastAPI connectivity.

## Local development

Use Node.js 24 LTS. Start the existing API first. From the frontend folder:

```powershell
npm ci
npm run dev
```

Open http://localhost:5173. Vite proxies backend paths to http://127.0.0.1:8000.
For a different backend port, set API_PROXY_TARGET before starting Vite.

```powershell
$env:API_PROXY_TARGET = 'http://127.0.0.1:8001'
npm run dev
```

Fonts are bundled locally through npm, so the page does not depend on Google
Fonts at runtime. package-lock.json fixes the full npm dependency tree.

## Verify

```powershell
npm test
npm run build
```

The Node test suite covers the Friday response and attack rate, zero traffic,
invalid counts, partial data, missing rows, total outage, malformed JSON, aborted
refreshes and CSV correctness. Docker runs these tests before building.

In the browser:
1. Friday: total 703245, benign 414322, attack 288923, rate 41.08%.
2. Select Monday: total 529918, benign 529918, attack 0, rate 0.00%.
3. Switch the weekly chart between Flows and Attack rate.
4. Select a capture-day row and verify the cards and donut update.
5. Export CSV and verify it includes five rows when all days are available.
6. Check sidebar navigation and the API reference link.
7. Refresh and verify the data returns. Check a narrow mobile viewport as well.

Inspect or stop only the application:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dashboard.yml ps
docker compose -f docker-compose.yml -f docker-compose.dashboard.yml logs --tail 50 dashboard
docker compose -f docker-compose.yml -f docker-compose.dashboard.yml down
```

These commands do not manage the separately running Hadoop containers or modify
raw HDFS/HBase data.
