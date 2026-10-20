import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, exportJournal } from './journal.js';
import { hash } from './model.js';
import { mockFeed, ROOM_CODE, POLICY, event, batch, id } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-time-journal-demo-'));
try {
  const start = event(1, 'start', '2026-01-01T09:00:00Z');
  const stop = event(2, 'stop', '2026-01-01T10:30:00Z');
  const open = event(3, 'start', '2026-01-01T11:00:00Z');
  const source = mockFeed([{ notifications: [], cursor: id(0) }, batch(start, stop), batch(stop), batch(open)]);
  let journal = await openJournal({ client: source.client, directory, room: ROOM_CODE, policy: POLICY, connectionKey: hash('demo') });
  await journal.poll();
  await journal.poll(); // Exact replay changes neither totals nor the cursor.
  await journal.close();
  journal = await openJournal({ client: source.client, directory, room: ROOM_CODE, policy: POLICY, connectionKey: hash('demo') });
  await journal.poll();
  await journal.close();
  const { report } = await exportJournal(directory);
  console.log(JSON.stringify({
    mode: 'offline SDK transport; no network or credentials',
    completedMinutes: report.people[0].totalMilliseconds / 60000,
    openSessions: report.people[0].incomplete.filter((entry) => entry.reason === 'still_open').length,
    recordedEvents: report.eventCount,
    requests: source.requests,
  }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
