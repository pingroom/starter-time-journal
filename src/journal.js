import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { hash, ROOM, validatePolicy, validateState, validateBatch, applyBatch, summarize, timestamp } from './model.js';

export async function openJournal({ client, directory, room, policy, connectionKey, signal, now = () => new Date().toISOString(), write = atomicJson }) {
  policy = validatePolicy(policy);
  if (typeof room !== 'string' || !ROOM.test(room) || typeof connectionKey !== 'string' || !/^[0-9a-f]{64}$/.test(connectionKey)
    || typeof client?.notifications?.wait !== 'function') throw new Error('A client, room, policy, and connection fingerprint are required.');
  const release = await acquireLock(directory);
  let active = false;
  let closed = false;
  try {
    const scope = hash({ room, policy, connectionKey });
    let state = await readJson(join(directory, 'state.json'));
    if (state === null) {
      signal?.throwIfAborted();
      const head = validateBatch(await client.notifications.wait({ timeout: 0, limit: 50, signal }));
      signal?.throwIfAborted();
      const observed = timestamp(now());
      state = { version: 1, journalId: randomUUID(), scope, room, policy, initialCursor: head.cursor,
        cursor: head.cursor, initializedAt: observed, observedAt: observed, events: [] };
      await write(directory, 'state.json', validateState(state));
    } else {
      validateState(state);
      if (state.scope !== scope || state.room !== room || hash(state.policy) !== hash(policy)) throw new Error('Journal belongs to another connection or policy. Keep its state and archive deliberately.');
    }
    return {
      snapshot: () => structuredClone(state),
      async poll() {
        if (closed || active) throw new Error('Journal is closed or already polling.');
        active = true;
        try {
          signal?.throwIfAborted();
          const batch = await client.notifications.wait({ after: state.cursor, timeout: 20, limit: 50, signal });
          signal?.throwIfAborted();
          const next = applyBatch(state, batch, now());
          if (next !== state) { await write(directory, 'state.json', next); state = next; }
          return { received: batch.notifications.length, acceptedTotal: state.events.length };
        } finally { active = false; }
      },
      async close() {
        if (active) throw new Error('Finish or abort the active poll before closing.');
        if (!closed) { closed = true; await release(); }
      },
    };
  } catch (error) { await release(); throw error; }
}

export async function exportJournal(directory) {
  const release = await acquireLock(directory);
  try {
    const state = await readJson(join(directory, 'state.json'));
    if (state === null) throw new Error('No journal yet. Run the listener first.');
    const report = summarize(state);
    const filename = `timesheet-${report.snapshotHash}.json`;
    const output = join(directory, 'exports');
    const saved = await readJson(join(output, filename));
    if (saved !== null && hash(saved) !== hash(report)) throw new Error('Conflicting export exists; preserve it and investigate.');
    if (saved === null) await atomicJson(output, filename, report);
    return { path: join(output, filename), report };
  } finally { await release(); }
}
