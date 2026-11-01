export const CAPTURE_DAYS = [
  { day: '2017-07-03', name: 'Monday', short: 'Mon', date: '03 Jul' },
  { day: '2017-07-04', name: 'Tuesday', short: 'Tue', date: '04 Jul' },
  { day: '2017-07-05', name: 'Wednesday', short: 'Wed', date: '05 Jul' },
  { day: '2017-07-06', name: 'Thursday', short: 'Thu', date: '06 Jul' },
  { day: '2017-07-07', name: 'Friday', short: 'Fri', date: '07 Jul' },
];

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function validateSummary(value, day) {
  const metrics = ['total_flows', 'benign_flows', 'attack_flows'];
  if (!value || value.day !== day ||
      !metrics.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      value.total_flows !== value.benign_flows + value.attack_flows) {
    throw new ApiError('The API returned inconsistent traffic counts.');
  }
  return value;
}

export function attackRate(summary) {
  return summary.total_flows === 0 ? 0 : summary.attack_flows / summary.total_flows * 100;
}

async function request(path, { fetcher, signal }) {
  let response;
  try {
    response = await fetcher(path, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('Cannot reach the API. Check the API container and refresh.');
  }
  if (!response.ok) {
    const message = response.status === 404 ? 'No summary is stored for this capture day.'
      : response.status === 504 ? 'HBase took too long to respond. Try refreshing.'
      : response.status === 503 ? 'HBase is unavailable. Check the gateway and refresh.'
      : 'The API could not return valid data. Check the API logs and refresh.';
    throw new ApiError(message, response.status);
  }
  try { return await response.json(); }
  catch { throw new ApiError('The API response was not valid JSON.'); }
}

export async function loadDashboard({ signal, fetcher = globalThis.fetch } = {}) {
  const options = { signal, fetcher };
  const [summaries, health] = await Promise.all([
    Promise.allSettled(CAPTURE_DAYS.map(async ({ day }) =>
      validateSummary(await request('/api/summary?day=' + day, options), day))),
    Promise.allSettled(['/health', '/health/ready'].map(path => request(path, options))),
  ]);
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  return {
    records: CAPTURE_DAYS.map((capture, index) => {
      const result = summaries[index];
      return result.status === 'fulfilled'
        ? { ...capture, status: 'ready', data: result.value }
        : { ...capture, status: result.reason.status === 404 ? 'missing' : 'error', message: result.reason.message };
    }),
    health: {
      api: health[0].status === 'fulfilled' && health[0].value?.status === 'ok',
      hbase: health[1].status === 'fulfilled' && health[1].value?.status === 'ok'
        && health[1].value?.hbase === 'reachable',
    },
  };
}

export function summariesCsv(records) {
  const header = 'day,total_flows,benign_flows,attack_flows,attack_rate_percent';
  return [header, ...records.filter(row => row.status === 'ready').map(({ data }) =>
    [data.day, data.total_flows, data.benign_flows, data.attack_flows, attackRate(data).toFixed(2)].join(',')),
  ].join('\r\n') + '\r\n';
}

export function validateAttacks(value, day) {
  if (!value || value.day !== day || !Array.isArray(value.categories) ||
      !Number.isSafeInteger(value.attack_flows) || value.attack_flows < 0 ||
      !value.categories.every(row => typeof row.attack_type === 'string' && row.attack_type.length > 0 &&
        Number.isSafeInteger(row.flow_count) && row.flow_count >= 0) ||
      new Set(value.categories.map(row => row.attack_type)).size !== value.categories.length ||
      value.categories.reduce((sum, row) => sum + row.flow_count, 0) !== value.attack_flows) {
    throw new ApiError('The API returned inconsistent attack categories.');
  }
  return value;
}

export function validatePorts(value, day) {
  if (!value || value.day !== day || !Array.isArray(value.ports) ||
      !['total_ports', 'total_flows', 'attack_flows'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      value.attack_flows > value.total_flows || value.ports.length > value.total_ports ||
      !value.ports.every(row => Number.isInteger(row.destination_port) && row.destination_port >= 0 &&
        row.destination_port <= 65535 && Number.isSafeInteger(row.total_flows) && row.total_flows >= 0 &&
        Number.isSafeInteger(row.attack_flows) && row.attack_flows >= 0 && row.attack_flows <= row.total_flows) ||
      new Set(value.ports.map(row => row.destination_port)).size !== value.ports.length ||
      value.ports.reduce((sum, row) => sum + row.total_flows, 0) > value.total_flows ||
      value.ports.reduce((sum, row) => sum + row.attack_flows, 0) > value.attack_flows) {
    throw new ApiError('The API returned inconsistent port statistics.');
  }
  return value;
}

export async function loadStatistics(day, { signal, fetcher = globalThis.fetch } = {}) {
  const options = { signal, fetcher };
  const [attacks, ports] = await Promise.allSettled([
    request('/api/attacks?day=' + day, options).then(value => validateAttacks(value, day)),
    request('/api/ports?day=' + day + '&limit=10', options).then(value => validatePorts(value, day)),
  ]);
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const result = response => response.status === 'fulfilled'
    ? { status: 'ready', data: response.value }
    : { status: 'error', message: response.reason.message };
  return { attacks: result(attacks), ports: result(ports) };
}
