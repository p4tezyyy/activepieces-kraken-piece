export interface PollState { start: number; seen: string[] }
export async function pollHistory(
  state: PollState, now: number,
  fetchPage: (offset: number, start: number, end: number) => Promise<{ rows: Record<string, any>; count: number }>,
): Promise<{ events: unknown[]; state: PollState }> {
  const known = new Set(state.seen);
  const records = new Map<string, any>();
  for (let offset = 0; ; ) {
    const page = await fetchPage(offset, state.start, now);
    const entries = Object.entries(page.rows ?? {});
    for (const [id, row] of entries) records.set(id, row);
    offset += entries.length;
    if (offset >= page.count) break;
    if (!entries.length) throw new Error('Kraken history pagination stopped before all records were fetched. Cursor was not advanced.');
    if (offset > 10000) throw new Error('More than 10,000 records in polling window. Use a shorter polling interval. Cursor was not advanced.');
  }
  const events = [...records].filter(([id]) => !known.has(id))
    .sort((a, b) => Number(a[1].time ?? a[1].closetm ?? 0) - Number(b[1].time ?? b[1].closetm ?? 0))
    .map(([id, value]) => ({ id, ...value, _dedupe_key: id }));
  const seen = [...records].filter(([, row]) => Number(row.time ?? row.closetm ?? now) >= now - 5).map(([id]) => id);
  return { events, state: { start: now - 2, seen } };
}
