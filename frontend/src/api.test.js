import test from 'node:test';
import assert from 'node:assert/strict';
import { attackRate, CAPTURE_DAYS, loadDashboard, summariesCsv, validateSummary, loadStatistics, validateAttacks, validatePorts } from './api.js';

const friday = { day: '2017-07-07', total_flows: 703245, benign_flows: 414322, attack_flows: 288923 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('verified Friday counts remain exact and attack rate is calculated', () => {
  assert.deepEqual(validateSummary(friday, friday.day), friday);
  assert.equal(attackRate(friday).toFixed(2), '41.08');
});

test('zero traffic has a defined rate', () => {
  assert.equal(attackRate({ total_flows: 0, attack_flows: 0 }), 0);
});

test('wrong day, missing fields, negative and inconsistent counts are rejected', () => {
  for (const invalid of [
    { ...friday, day: '2017-07-06' }, { ...friday, attack_flows: undefined },
    { ...friday, attack_flows: -1 }, { ...friday, total_flows: 1 },
    { ...friday, total_flows: '703245' }, { ...friday, total_flows: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => validateSummary(invalid, friday.day));
});

test('a missing day and upstream failure do not erase other days or become zero counts', async () => {
  const requested = [];
  const fetcher = async path => {
    requested.push(path);
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/health/ready') return json({ status: 'ok', hbase: 'reachable' });
    const day = new URL(path, 'http://localhost').searchParams.get('day');
    if (day === '2017-07-03') return json({}, 404);
    if (day === '2017-07-04') return json({}, 503);
    return json({ ...friday, day });
  };
  const result = await loadDashboard({ fetcher });
  assert.equal(result.records.length, CAPTURE_DAYS.length);
  assert.equal(result.records[0].status, 'missing');
  assert.equal(result.records[1].status, 'error');
  assert.equal(result.records[0].data, undefined);
  assert.equal(result.records[4].data.total_flows, 703245);
  assert.deepEqual(result.health, { api: true, hbase: true });
  assert.equal(requested.length, 7);
  assert.ok(requested.every(path => path.startsWith('/')));
});

test('network outage produces errors for every day and disconnected health', async () => {
  const result = await loadDashboard({ fetcher: async () => { throw new TypeError('offline'); } });
  assert.ok(result.records.every(row => row.status === 'error' && row.data === undefined));
  assert.deepEqual(result.health, { api: false, hbase: false });
});

test('malformed JSON is an error, not a successful empty dataset', async () => {
  const result = await loadDashboard({ fetcher: async () => new Response('<html>Bad gateway</html>') });
  assert.ok(result.records.every(row => row.status === 'error'));
  assert.deepEqual(result.health, { api: false, hbase: false });
});

test('aborted refresh cannot commit stale results', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadDashboard({ signal: controller.signal, fetcher: async () => json(friday) }),
    error => error.name === 'AbortError');
});

test('CSV includes real available rows only and preserves exact counts', () => {
  const csv = summariesCsv([{ status: 'missing' }, { status: 'ready', data: friday }]);
  assert.equal(csv, 'day,total_flows,benign_flows,attack_flows,attack_rate_percent\r\n2017-07-07,703245,414322,288923,41.08\r\n');
});

const categories = {
  day: '2017-07-07', attack_flows: 288923,
  categories: [
    { attack_type: 'PortScan', flow_count: 158930 },
    { attack_type: 'DDoS', flow_count: 128027 },
    { attack_type: 'Bot', flow_count: 1966 },
  ],
};
const ports = {
  day: '2017-07-07', total_ports: 3, total_flows: 10, attack_flows: 4,
  ports: [{ destination_port: 80, total_flows: 6, attack_flows: 1 }],
};

test('attack categories preserve the real Friday total', () => {
  assert.deepEqual(validateAttacks(categories, friday.day), categories);
});

test('a valid top-port result need not contain every port', () => {
  assert.deepEqual(validatePorts(ports, friday.day), ports);
});

test('zero-attack day is a valid empty category list', () => {
  assert.deepEqual(validateAttacks({ ...categories, attack_flows: 0, categories: [] }, friday.day).categories, []);
});

test('incomplete or duplicated category totals are rejected', () => {
  for (const invalid of [
    { ...categories, day: '2017-07-03' }, { ...categories, categories: [] },
    { ...categories, categories: [{ attack_type: 'Bot', flow_count: -1 }] },
    { ...categories, categories: [{ attack_type: 'Bot', flow_count: 1 }, { attack_type: 'Bot', flow_count: 288922 }] },
  ]) assert.throws(() => validateAttacks(invalid, friday.day));
});

test('invalid or inconsistent port statistics are rejected', () => {
  for (const invalid of [
    { ...ports, day: '2017-07-03' }, { ...ports, total_ports: 0 },
    { ...ports, total_flows: 5 },
    { ...ports, ports: [{ destination_port: 65536, total_flows: 1, attack_flows: 0 }] },
    { ...ports, ports: [{ destination_port: 80, total_flows: 1, attack_flows: 2 }] },
    { ...ports, ports: [ports.ports[0], ports.ports[0]] },
  ]) assert.throws(() => validatePorts(invalid, friday.day));
});

test('selected-day statistics use real endpoint paths', async () => {
  const paths = [];
  const result = await loadStatistics(friday.day, { fetcher: async path => {
    paths.push(path);
    return json(path.startsWith('/api/attacks') ? categories : ports);
  } });
  assert.deepEqual(paths, ['/api/attacks?day=2017-07-07', '/api/ports?day=2017-07-07&limit=10']);
  assert.equal(result.attacks.data.categories[0].flow_count, 158930);
  assert.equal(result.ports.data.ports[0].destination_port, 80);
});

test('one statistics failure preserves the other chart and does not invent data', async () => {
  const result = await loadStatistics(friday.day, { fetcher: async path =>
    path.startsWith('/api/attacks') ? json({}, 503) : json(ports) });
  assert.equal(result.attacks.status, 'error');
  assert.equal(result.attacks.data, undefined);
  assert.equal(result.ports.status, 'ready');
});

test('changing days cancels stale statistics', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadStatistics(friday.day, { signal: controller.signal, fetcher: async () => json(categories) }),
    error => error.name === 'AbortError');
});
