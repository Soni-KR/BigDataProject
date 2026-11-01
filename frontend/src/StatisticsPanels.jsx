import { useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldCheck } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { loadStatistics } from './api.js';

const number = value => new Intl.NumberFormat('en-US').format(value);
const compact = value => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function Ranking({ kind, result, day, retry }) {
  const attacks = kind === 'attacks';
  const title = attacks ? 'Attack categories' : 'Top destination ports';
  const data = result?.data;
  const rows = data ? (attacks ? data.categories.map(row => ({
    ...row, name: row.attack_type, attacks: row.flow_count,
  })) : data.ports.map(row => ({
    ...row, name: String(row.destination_port),
    attacks: row.attack_flows, benign: row.total_flows - row.attack_flows,
  }))) : [];
  return <section className="panel ranking-panel" aria-labelledby={kind + '-title'}>
    <div className="panel-heading"><div><h2 id={kind + '-title'}>{title}</h2><p>{day.name}, {day.date}</p></div>
      {!attacks && data && <span className="ranking-meta">{data.total_ports.toLocaleString()} ports</span>}
    </div>
    {result?.status === 'error' ? <div className="ranking-empty" role="status"><p>{result.message}</p><button className="ranking-retry" onClick={retry}><RefreshCw size={14} aria-hidden="true" />Retry</button></div>
      : !data ? <div className="ranking-empty" role="status"><Activity size={22} aria-hidden="true" /><span>Loading statistics…</span></div>
      : rows.length === 0 ? <div className="ranking-empty"><ShieldCheck size={26} aria-hidden="true" /><p>{attacks ? 'No attack flows on this day.' : 'No destination-port records.'}</p></div>
      : <>
        <div className="ranking-chart" style={{ height: Math.max(280, rows.length * 32 + 45) }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={rows} layout="vertical" margin={{ top: 8, right: attacks ? 45 : 20, bottom: 8, left: 0 }} barSize={15} accessibilityLayer aria-label={title + '. Exact values are available in View counts.'}>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={attacks ? 145 : 48} tick={{ fontSize: 11, fill: 'var(--text)', width: attacks ? 135 : 42 }} axisLine={false} tickLine={false} />
              <Tooltip formatter={value => number(value)} cursor={{ fill: 'var(--hover)' }} />
              {!attacks && <Bar dataKey="benign" name="Benign flows" fill="var(--benign)" stackId="port" isAnimationActive={false} />}
              <Bar dataKey="attacks" name="Attack flows" fill="var(--attack)" stackId="port" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                {attacks && <LabelList dataKey="attacks" position="right" formatter={compact} style={{ fontSize: 10, fill: 'var(--muted)' }} />}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {!attacks && <div className="ranking-legend"><span><i className="legend-dot benign" />Benign</span><span><i className="legend-dot attacks" />Attack</span><small>Top {rows.length} by total flows</small></div>}
        <details className="ranking-counts"><summary>View counts</summary><div className="table-scroll" tabIndex={0} role="region" aria-label={title + ' counts'}>
          <table><caption className="sr-only">{title} for {day.name}</caption>
            <thead><tr><th scope="col">{attacks ? 'Category' : 'Port'}</th>{!attacks && <th scope="col">Total flows</th>}<th scope="col">Attack flows</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.name}><th scope="row">{row.name}</th>{!attacks && <td>{number(row.total_flows)}</td>}<td>{number(row.attacks)}</td></tr>)}</tbody>
          </table>
        </div></details>
      </>}
  </section>;
}

export default function StatisticsPanels({ day }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setState(null);
    const timer = setTimeout(() => {
      controller.abort();
      const error = { status: 'error', message: 'Statistics timed out. Try again.' };
      if (!disposed) setState({ attacks: error, ports: error });
    }, 22000);
    loadStatistics(day.day, { signal: controller.signal }).then(result => {
      if (!disposed && !controller.signal.aborted) setState(result);
    }).catch(error => {
      if (!disposed && !controller.signal.aborted) {
        const failed = { status: 'error', message: error.message };
        setState({ attacks: failed, ports: failed });
      }
    }).finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [day.day, attempt]);

  return <div className="statistics-grid">
    <Ranking kind="attacks" result={state?.attacks} day={day} retry={() => setAttempt(value => value + 1)} />
    <Ranking kind="ports" result={state?.ports} day={day} retry={() => setAttempt(value => value + 1)} />
  </div>;
}
