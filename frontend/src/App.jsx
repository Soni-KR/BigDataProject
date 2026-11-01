import { useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays,
  Check, ChevronDown, Database, ExternalLink, FileJson, Gauge,
  LayoutDashboard, Menu, Network, RefreshCw, Server, Shield,
  ShieldCheck, ShieldAlert, Workflow, X, Zap,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { attackRate, CAPTURE_DAYS, loadDashboard, summariesCsv } from './api.js';
import StatisticsPanels from './StatisticsPanels.jsx';

const integer = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const number = value => integer.format(value);
const percent = value => value.toFixed(2) + '%';
const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'capture-days', label: 'Capture days', icon: CalendarDays },
  { id: 'pipeline', label: 'Data pipeline', icon: Workflow },
];

function useDashboard() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ phase: 'loading', records: [], health: null });
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setState({ phase: 'loading', records: [], health: null });
    const timer = setTimeout(() => {
      if (disposed) return;
      controller.abort();
      setState({
        phase: 'ready', health: { api: false, hbase: false },
        records: CAPTURE_DAYS.map(day => ({ ...day, status: 'error', message: 'Request timed out. Refresh to try again.' })),
      });
    }, 12000);
    loadDashboard({ signal: controller.signal }).then(result => {
      if (!disposed && !controller.signal.aborted) setState({ ...result, phase: 'ready' });
    }).catch(error => {
      if (!disposed && !controller.signal.aborted) {
        setState({
          phase: 'ready', health: { api: false, hbase: false },
          records: CAPTURE_DAYS.map(day => ({ ...day, status: 'error', message: error.message })),
        });
      }
    }).finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [revision]);
  return { ...state, revision, refresh: () => setRevision(value => value + 1) };
}

function Connection({ health, loading, compact: isCompact = false }) {
  const connected = health?.hbase;
  return <span className={'connection ' + (loading ? 'checking' : connected ? 'connected' : 'disconnected')}>
    <span className="status-dot" />
    {loading ? 'Checking connection' : connected ? (isCompact ? 'Connected' : 'HBase connected') : 'Connection unavailable'}
  </span>;
}

function MetricCard({ title, value, detail, icon: Icon, tone, loading }) {
  return <article className={'metric-card ' + (tone || '')}>
    <div className="metric-heading"><span>{title}</span><span className="metric-icon"><Icon size={18} aria-hidden="true" /></span></div>
    <div className={'metric-value ' + (loading ? 'skeleton' : '')}>{loading ? <span>&nbsp;</span> : value ?? '—'}</div>
    <p>{loading ? 'Loading capture data…' : detail}</p>
  </article>;
}

function ChartTooltip({ active, payload, label, mode }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip">
    <strong>{label}</strong>
    {payload.map(item => <div key={item.dataKey}><span>{item.name}</span><b>{mode === 'rate' ? percent(item.value) : number(item.value)}</b></div>)}
  </div>;
}

function TrafficChart({ records, loading }) {
  const [mode, setMode] = useState('flows');
  const available = records.filter(row => row.status === 'ready');
  const data = CAPTURE_DAYS.map(capture => {
    const row = records.find(record => record.day === capture.day);
    return { label: capture.short + ' ' + capture.date.slice(0, 2),
      benign: row?.data?.benign_flows ?? null, attacks: row?.data?.attack_flows ?? null,
      rate: row?.data ? attackRate(row.data) : null };
  });
  return <section className="panel traffic-panel" aria-labelledby="traffic-title">
    <div className="panel-heading">
      <div><h2 id="traffic-title">Traffic across the week</h2><p>Daily capture volume, by classification</p></div>
      <div className="segmented-control" role="group" aria-label="Chart metric">
        <button aria-pressed={mode === 'flows'} onClick={() => setMode('flows')}>Flows</button>
        <button aria-pressed={mode === 'rate'} onClick={() => setMode('rate')}>Attack rate</button>
      </div>
    </div>
    <div className="chart-legend">
      {mode === 'flows'
        ? <><span><i className="legend-dot benign" />Benign</span><span><i className="legend-dot attacks" />Attack</span></>
        : <span><i className="legend-dot attacks" />Attack flows / total flows</span>}
      <span className="chart-unit">{mode === 'flows' ? 'NUMBER OF FLOWS' : 'PERCENT OF DAILY TRAFFIC'}</span>
    </div>
    <div className="traffic-chart">
      {loading ? <div className="chart-loading" role="status"><Activity size={24} aria-hidden="true" /><span>Loading the capture week…</span></div>
        : available.length === 0 ? <div className="chart-empty"><Activity size={28} aria-hidden="true" /><strong>No traffic data available</strong><p>Check the connection and refresh to try again.</p></div>
        : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {mode === 'flows'
            ? <BarChart data={data} margin={{ top: 12, right: 10, bottom: 0, left: -12 }} barSize={44} accessibilityLayer aria-label="Daily benign and attack flows. Exact values are in the capture days table.">
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dy={12} height={40} />
                <YAxis tickFormatter={value => compact.format(value)} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} width={60} />
                <Tooltip content={<ChartTooltip mode={mode} />} cursor={{ fill: 'var(--hover)' }} />
                <Bar dataKey="benign" name="Benign flows" stackId="flows" fill="var(--benign)" radius={[0, 0, 4, 4]} isAnimationActive={false} />
                <Bar dataKey="attacks" name="Attack flows" stackId="flows" fill="var(--attack)" radius={[5, 5, 0, 0]} isAnimationActive={false} />
              </BarChart>
            : <LineChart data={data} margin={{ top: 12, right: 20, bottom: 0, left: -12 }} accessibilityLayer aria-label="Daily attack rate. Exact values are in the capture days table.">
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} dy={12} height={40} />
                <YAxis tickFormatter={value => value + '%'} domain={[0, 100]} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} width={60} />
                <Tooltip content={<ChartTooltip mode={mode} />} />
                <Line dataKey="rate" name="Attack rate" type="linear" connectNulls={false} stroke="var(--attack)" strokeWidth={3} dot={{ r: 5, fill: 'var(--surface)', strokeWidth: 3 }} activeDot={{ r: 7 }} isAnimationActive={false} />
              </LineChart>}
        </ResponsiveContainer>}
    </div>
    <div className="chart-caption"><span><CalendarDays size={14} aria-hidden="true" />03 – 07 July 2017</span><a href="#capture-days">View capture details <ArrowRight size={14} aria-hidden="true" /></a></div>
    {!loading && available.length > 0 && available.length < 5 && <p className="partial-note">{available.length} of 5 capture days available. Gaps indicate unavailable data.</p>}
  </section>;
}

function Composition({ summary, capture, loading }) {
  const rate = summary ? attackRate(summary) : 0;
  const data = summary ? [{ name: 'Benign', value: summary.benign_flows }, { name: 'Attack', value: summary.attack_flows }] : [];
  return <section className="panel composition-panel" aria-labelledby="composition-title">
    <div className="panel-heading"><div><h2 id="composition-title">Traffic composition</h2><p>{capture.name}, {capture.date} 2017</p></div><span className="small-icon"><Shield size={19} aria-hidden="true" /></span></div>
    <div className="donut-wrap">
      {loading ? <div className="donut-placeholder skeleton" aria-label="Loading traffic composition" />
        : !summary || summary.total_flows === 0 ? <div className="chart-empty"><Shield size={30} aria-hidden="true" /><strong>{summary ? 'No flows captured' : 'No summary available'}</strong></div>
        : <>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <PieChart accessibilityLayer aria-label={'Traffic composition: ' + percent(100 - rate) + ' benign, ' + percent(rate) + ' attack.'}>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="71%" outerRadius="91%" startAngle={90} endAngle={-270} paddingAngle={summary.attack_flows && summary.benign_flows ? 3 : 0} stroke="none" isAnimationActive={false}>
                <Cell fill="var(--benign)" /><Cell fill="var(--attack)" />
              </Pie>
              <Tooltip formatter={value => number(value)} />
            </PieChart>
          </ResponsiveContainer>
          <div className="donut-center"><span>ATTACK RATE</span><strong>{percent(rate)}</strong><small>of daily traffic</small></div>
        </>}
    </div>
    <div className="composition-legend">
      <div><span><i className="legend-dot benign" />Benign flows</span><strong>{summary ? number(summary.benign_flows) : '—'}</strong><small>{summary && summary.total_flows ? percent(100 - rate) : '—'}</small></div>
      <div><span><i className="legend-dot attacks" />Attack flows</span><strong>{summary ? number(summary.attack_flows) : '—'}</strong><small>{summary && summary.total_flows ? percent(rate) : '—'}</small></div>
    </div>
  </section>;
}

function CaptureTable({ records, selectedDay, selectDay, loading }) {
  return <section className="panel capture-panel" id="capture-days" tabIndex={-1} aria-labelledby="capture-title">
    <div className="panel-heading"><div><div className="heading-with-badge"><h2 id="capture-title">Capture days</h2><span className="count-badge">05</span></div><p>Select a day to inspect its traffic summary.</p></div><span className="dataset-label"><Database size={14} aria-hidden="true" /> CIC-IDS2017</span></div>
    <div className="table-scroll" role="region" aria-label="Daily traffic summaries" tabIndex={0}>
      <table>
        <caption className="sr-only">Daily network flows and attack rates for the five capture days. Select a capture day to update the summary cards.</caption>
        <thead><tr><th scope="col">Capture day</th><th scope="col">Total flows</th><th scope="col">Benign</th><th scope="col">Attack</th><th scope="col">Attack rate</th><th scope="col"><span className="sr-only">Data availability</span></th></tr></thead>
        <tbody>{CAPTURE_DAYS.map(capture => {
          const row = records.find(item => item.day === capture.day);
          const selected = capture.day === selectedDay;
          return <tr key={capture.day} className={selected ? 'selected-row' : ''}>
            <th scope="row"><button className="day-button" aria-pressed={selected} onClick={() => selectDay(capture.day)}><span className="day-calendar">{capture.date.slice(0, 2)}</span><span><strong>{capture.name}</strong><small>{capture.date} 2017</small></span>{selected && <span className="selected-check"><Check size={13} aria-hidden="true" /><span className="sr-only">Selected</span></span>}</button></th>
            <td>{row?.data ? number(row.data.total_flows) : '—'}</td>
            <td>{row?.data ? number(row.data.benign_flows) : '—'}</td>
            <td>{row?.data ? number(row.data.attack_flows) : '—'}</td>
            <td><div className="rate-cell"><span>{row?.data ? percent(attackRate(row.data)) : '—'}</span><span className="rate-track" aria-hidden="true"><span style={{ width: row?.data ? attackRate(row.data) + '%' : '0%' }} /></span></div></td>
            <td><span className={'availability ' + (row?.status || 'loading')}><span className="status-dot" />{loading ? 'Loading' : row?.status === 'ready' ? 'Available' : row?.status === 'missing' ? 'No record' : 'Unavailable'}</span></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="table-footnote"><ShieldCheck size={14} aria-hidden="true" /><span>Counts reflect the dataset’s original benign and attack labels.</span></div>
  </section>;
}

function Pipeline({ health, loading }) {
  const nodes = [
    { title: 'HDFS', detail: 'Raw capture storage', icon: Server },
    { title: 'Spark', detail: 'Daily aggregation', icon: Zap },
    { title: 'HBase', detail: loading ? 'Checking…' : health?.hbase ? 'Gateway reachable' : 'Gateway unavailable', icon: Database, state: health?.hbase },
    { title: 'FastAPI', detail: loading ? 'Checking…' : health?.api ? 'API reachable' : 'API unavailable', icon: Network, state: health?.api },
    { title: 'React', detail: 'Your dashboard', icon: LayoutDashboard },
  ];
  return <section className="panel pipeline-panel" id="pipeline" tabIndex={-1} aria-labelledby="pipeline-title">
    <div className="panel-heading"><div><h2 id="pipeline-title">Data pipeline</h2></div><span className="read-only-label"><ShieldCheck size={14} aria-hidden="true" />Read-only access</span></div>
    <ol className="pipeline-track">{nodes.map(({ title, detail, icon: Icon, state }, index) => <li key={title}>
      <span className={'pipeline-icon ' + (state === true ? 'online' : state === false && !loading ? 'offline' : '')}><Icon size={20} aria-hidden="true" /></span>
      <span><strong>{title}</strong><small>{detail}</small></span>
      {index < nodes.length - 1 && <ArrowRight className="pipeline-arrow" size={16} aria-hidden="true" />}
    </li>)}</ol>
    <p className="pipeline-note">Connection checks cover HBase REST and FastAPI. HDFS and Spark show the upstream processing stages.</p>
  </section>;
}

export default function App() {
  const { phase, records, health, revision, refresh } = useDashboard();
  const [selectedDay, setSelectedDay] = useState('2017-07-07');
  const [activeSection, setActiveSection] = useState('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggle = useRef(null);
  const [announcement, setAnnouncement] = useState('');
  const loading = phase === 'loading';
  const capture = CAPTURE_DAYS.find(day => day.day === selectedDay);
  const selected = records.find(row => row.day === selectedDay);
  const summary = selected?.data;
  const available = records.filter(row => row.status === 'ready').length;
  const rate = summary ? attackRate(summary) : null;

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActiveSection(visible[0].target.id);
    }, { rootMargin: '-15% 0px -45% 0px' });
    navigation.forEach(item => { const element = document.getElementById(item.id); if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = event => { if (event.key === 'Escape') { setMenuOpen(false); menuToggle.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  function exportCsv() {
    const url = URL.createObjectURL(new Blob(['\ufeff' + summariesCsv(records)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cyberflow-captures-2017-07-03_2017-07-07.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setAnnouncement('CSV exported with ' + available + ' available capture days.');
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside id="mobile-nav" className={'sidebar ' + (menuOpen ? 'is-open' : '')} aria-label="Workspace sidebar">
      <a className="brand" href="#overview" onClick={() => setMenuOpen(false)}><span className="brand-mark"><Activity size={25} strokeWidth={2} aria-hidden="true" /></span><span>cyberflow<span className="brand-period">.</span><small>NETWORK ANALYTICS</small></span></a>
      <div className="sidebar-body">
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">{navigation.map(({ id, label, icon: Icon }) => <a key={id} href={'#' + id} className={activeSection === id ? 'active' : ''} aria-current={activeSection === id ? 'location' : undefined} onClick={() => { setActiveSection(id); setMenuOpen(false); }}><Icon size={19} aria-hidden="true" /><span>{label}</span>{activeSection === id && <span className="nav-active-dot" />}</a>)}</nav>
        <p className="nav-label resources-label">RESOURCES</p>
        <a className="resource-link" href="/docs" target="_blank" rel="noopener noreferrer"><FileJson size={18} aria-hidden="true" /><span>API reference</span><ExternalLink size={13} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
      </div>
      <div className="dataset-card"><span className="dataset-icon"><Database size={21} aria-hidden="true" /></span><span className="eyebrow">THE DATASET</span><strong>CIC-IDS2017</strong><span className="historical-tag">Historical captures</span></div>
      <div className="sidebar-footer"><span className="project-avatar">CF</span><span><strong>CyberFlow project</strong><small>Local workspace</small></span><span className="local-dot" /></div>
    </aside>
    {menuOpen && <button className="menu-scrim" aria-label="Close navigation" onClick={() => { setMenuOpen(false); menuToggle.current?.focus(); }} />}
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button ref={menuToggle} className="mobile-menu icon-button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="mobile-nav" onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={21} /> : <Menu size={21} />}</button><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>Traffic intelligence</strong></div><div className="topbar-actions"><Connection health={health} loading={loading} /><span className="topbar-divider" /><button className="refresh-button" aria-label={loading ? "Refreshing data" : "Refresh data"} onClick={refresh} disabled={loading}><RefreshCw className={loading ? 'spinning' : ''} size={15} aria-hidden="true" /><span>{loading ? 'Refreshing' : 'Refresh data'}</span></button></div></header>
      <main id="main-content">
        <section id="overview" tabIndex={-1} className="overview-section" aria-labelledby="overview-title">
          <div className="page-heading"><div><h1 id="overview-title">Network overview<span>.</span></h1></div><button className="button button-dark export-button" onClick={exportCsv} disabled={loading || available === 0}><ArrowDownToLine size={17} aria-hidden="true" />Export CSV<ArrowUpRight size={15} aria-hidden="true" /></button></div>
          <div className="capture-toolbar"><div className="period-label"><CalendarDays size={16} aria-hidden="true" /><span>03 – 07 July 2017</span><span className="period-divider">·</span><span className="period-description">Historical capture week</span></div><div className="capture-select"><label htmlFor="capture-day">Inspect day</label><div className="select-wrap"><select id="capture-day" value={selectedDay} onChange={event => setSelectedDay(event.target.value)}>{CAPTURE_DAYS.map(day => <option key={day.day} value={day.day}>{day.name}, {day.date}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div></div></div>
          {!loading && !health?.hbase && <div className="notice error-notice" role="alert"><ShieldAlert size={19} aria-hidden="true" /><span>{health?.api ? 'HBase is unavailable. Check the REST gateway, then refresh.' : 'The API is unavailable. Check the API container, then refresh.'}</span><button onClick={refresh}>Try again<ArrowRight size={14} aria-hidden="true" /></button></div>}
          {!loading && selected && selected.status !== 'ready' && <div className="notice" role="status"><Database size={18} aria-hidden="true" /><span>{capture.name}: {selected.message}</span></div>}
          <div className="selection-caption"><span>{capture.name.toUpperCase()}’S SNAPSHOT</span><span>{capture.date} 2017</span></div>
          <div className="metrics-grid" aria-busy={loading}>
            <MetricCard title="Total flows" value={summary && number(summary.total_flows)} detail="Captured network flows" icon={Activity} loading={loading} />
            <MetricCard title="Benign flows" value={summary && number(summary.benign_flows)} detail={summary && summary.total_flows ? percent(100 - rate) + ' of daily traffic' : 'Labeled as benign'} icon={ShieldCheck} tone="benign-card" loading={loading} />
            <MetricCard title="Attack flows" value={summary && number(summary.attack_flows)} detail="Labeled as attack traffic" icon={ShieldAlert} tone="attack-card" loading={loading} />
            <MetricCard title="Attack rate" value={summary && percent(rate)} detail="Attack flows / total flows" icon={Gauge} tone="rate-card" loading={loading} />
          </div>
          <div className="charts-grid"><TrafficChart records={records} loading={loading} /><Composition summary={summary} capture={capture} loading={loading} /></div>
          <StatisticsPanels key={selectedDay + ":" + revision} day={capture} />
        </section>
        <CaptureTable records={records} selectedDay={selectedDay} selectDay={setSelectedDay} loading={loading} />
        <Pipeline health={health} loading={loading} />
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      </main>
    </div>
  </div>;
}
