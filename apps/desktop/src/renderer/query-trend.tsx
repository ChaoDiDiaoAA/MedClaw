import { useEffect, useState } from 'react';
import { BUSINESS_RULES, type QueryRecord, type QuerySummary } from '../../../../packages/contracts/src/query';
import { canonicalRequest } from '../../../../packages/contracts/src/run';
import type { PublicReturn } from '../../../../packages/contracts/src/protocol';
import { errorMessage } from '../../../../packages/contracts/src/error';

export async function loadTrendRows(query: QuerySummary, read: (page: number) => Promise<PublicReturn<'query.read'>>, progress: (rows: QueryRecord['rows']) => void, active: () => boolean) {
  if (query.kind !== 'trend' || query.totalRows > BUSINESS_RULES.maxSavedRows) throw new Error('Saved trend is inconsistent.');
  const rows: QueryRecord['rows'] = []; let targetVersion: string | null = null;
  for (let page = 1; page === 1 || rows.length < query.totalRows; page++) {
    if (!active()) throw new Error('Trend read cancelled.');
    const result = await read(page); if (!active()) throw new Error('Trend read cancelled.');
    const part = result.page;
    if (result.query.id !== query.id || result.query.sessionId !== query.sessionId || result.query.resultHash !== query.resultHash || result.query.totalRows !== query.totalRows
      || part.queryId !== query.id || part.page !== page || part.pageSize !== BUSINESS_RULES.maxPageSize || part.totalRows !== query.totalRows
      || targetVersion !== null && targetVersion !== part.targetVersion || part.rows.length !== Math.min(BUSINESS_RULES.maxPageSize, query.totalRows - rows.length)
      || part.rows.some(row => typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value)))) throw new Error('Saved trend is inconsistent.');
    targetVersion = part.targetVersion; rows.push(...part.rows); progress([...rows]);
  }
  return rows;
}

export function SavedTrendPlot({ rows, query }: { rows: QueryRecord['rows']; query: QuerySummary }) {
  const dates = [...new Set(rows.map(row => String(row.date)))].sort(), groupBy = 'groupBy' in query.params ? query.params.groupBy : null;
  const groups = new Map<string, QueryRecord['rows']>();
  for (const row of rows) {
    const key = canonicalRequest({ ...(groupBy && groupBy !== 'date' ? { [groupBy]: row[groupBy] ?? null } : {}), metric: row.metric ?? null, unit: row.unit ?? null, currency: row.currency ?? null, priceUnit: row.priceUnit ?? null });
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const colors = ['#437a6a', '#92643e', '#476ea1', '#8e5b87'];
  return <>{[...groups].map(([key, series], index) => {
    const values = series.filter(row => row.gap !== true && typeof row.value === 'number').map(row => Number(row.value));
    const minimum = values.reduce((lowest, value) => Math.min(lowest, value), 0), maximum = values.reduce((highest, value) => Math.max(highest, value), 1), range = maximum - minimum;
    const x = (date: string) => 45 + (dates.length <= 1 ? 300 : dates.indexOf(date) * 600 / (dates.length - 1));
    const y = (value: number) => 190 - (value - minimum) * 160 / range;
    let path = '', connected = false;
    for (const row of [...series].sort((left, right) => String(left.date).localeCompare(String(right.date)))) {
      if (row.gap === true || row.value === null) { connected = false; continue; }
      path += `${connected ? 'L' : 'M'}${x(String(row.date)).toFixed(2)},${y(Number(row.value)).toFixed(2)}${connected ? '' : 'h0.01'} `; connected = true;
    }
    const label = Object.entries(JSON.parse(key) as Record<string, unknown>).filter(([, value]) => value !== null).map(([field, value]) => `${field}: ${value}`).join(' · ');
    return <figure key={key} className="query-trend"><figcaption>{label}</figcaption><svg viewBox="0 0 700 240" role="img" aria-label={`Saved daily trend: ${label}`}>
      <title>{label}</title><desc>{series.length} saved points. {series.filter(row => row.gap === true).length} date gaps. {series.filter(row => row.value === null).length} missing values. Gaps are not interpolated. Exact values are in the saved result table.</desc>
      <path d="M45 30V190H645" fill="none" stroke="currentColor" opacity="0.4" /><path data-testid="trend-series" d={path} fill="none" stroke={colors[index % colors.length]} strokeWidth="2" strokeLinecap="round" />
      <text x="5" y="38" fontSize="11">{maximum}</text><text x="5" y="190" fontSize="11">{minimum}</text>
      <text x="45" y="220" fontSize="11">{dates[0]}</text><text x="645" y="220" fontSize="11" textAnchor="end">{dates.at(-1)}</text>
    </svg></figure>;
  })}</>;
}

export function QueryTrend(props: { query: QuerySummary; instanceId: string | null; visible: boolean }) {
  const [rows, setRows] = useState<QueryRecord['rows']>([]), [complete, setComplete] = useState(false), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setRows([]); setComplete(false); setError(null);
    if (props.visible) void loadTrendRows(props.query, async page => {
      const result = await window.medclaw.request('query.read', { queryId: props.query.id, page, pageSize: BUSINESS_RULES.maxPageSize });
      if (!result.ok) throw new Error(errorMessage(result.error)); return result.data;
    }, prefix => { if (active) setRows(prefix); }, () => active).then(() => { if (active) setComplete(true); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'The saved trend could not be read.'); });
    return () => { active = false; };
  }, [props.query.id, props.query.resultHash, props.instanceId, props.visible, attempt]);
  return <section className="panel" aria-label="Saved daily trend"><h2>Saved daily trend</h2><p role="status">{complete ? 'Complete saved trend' : 'Incomplete saved trend'} · {rows.length} / {props.query.totalRows} points</p>
    <p className="tiny">Zero is a measured value. Missing prices and date gaps break the line. Each unit has its own scale. Read exact values in the result table for Query {props.query.id}.</p>
    {error && <p role="alert">{error}</p>}{error && <button onClick={() => setAttempt(value => value + 1)}>Read saved trend again</button>}
    <SavedTrendPlot rows={rows} query={props.query} />
  </section>;
}
