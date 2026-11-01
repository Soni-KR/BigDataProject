import test from 'node:test';
import assert from 'node:assert/strict';
import { attackRate, CAPTURE_DAYS, loadDashboard, summariesCsv, validateSummary } from './api.js';

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
