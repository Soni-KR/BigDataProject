# CyberFlow dashboard design decisions

Applied the installed ui-ux-pro-max skill and its local searches.

- Product search: Analytics Dashboard (data-dense, comparative and drill-down).
- Design-system style match: Minimalism & Swiss Style (functional grid, clear hierarchy).
- The generated Enterprise Gateway landing-page pattern did not match this analytics task and was rejected. The verified Analytics Dashboard product result guides the layout.
- React stack search: accessible testing-library queries. This build uses semantic controls, explicit labels, named charts and a data table; browser checks use accessible names.
- Palette: dark forest sidebar, neutral light workspace, teal benign traffic and coral attack traffic. Colors are semantic CSS tokens. Numeric values use tabular IBM Plex Mono; interface text uses locally bundled DM Sans.
- Chart choices: stacked daily bars for composition and magnitude; a separate attack-rate line with a 0–100% axis. Null data remains a gap. The capture table exposes exact values without depending on color or hover.
- Current scope: five historical capture days, not live threat detection.
- Only observed HBase REST and API health receive connection status. HDFS/Spark are upstream architecture stages, not asserted live checks.
- Focus rings, skip link, keyboard-operable day controls, native select, labeled navigation, reduced motion and a collapsible mobile sidebar.
- No generated sample traffic, fake attack-type breakdowns, or replacement zeros for unavailable records.
- Frontend runs locally; Nginx forwards requests to FastAPI on the existing Docker network.
