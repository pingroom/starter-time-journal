import { createHash } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROOM = /^[A-Z0-9]{12}$/;
export const MAX_EVENTS = 2000;
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isId = (value) => typeof value === 'string' && UUID.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected) {
  return object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function timestamp(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(raw)) throw new Error('Invalid UTC event timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC event timestamp.');
  return new Date(time).toISOString();
}

export function validatePolicy(raw) {
  if (!keys(raw, ['startAction', 'stopAction', 'maxSessionHours', 'people'])
    || !Number.isInteger(raw.startAction) || raw.startAction < 1 || raw.startAction > 16
    || !Number.isInteger(raw.stopAction) || raw.stopAction < 1 || raw.stopAction > 16
    || raw.startAction === raw.stopAction
    || !Number.isInteger(raw.maxSessionHours) || raw.maxSessionHours < 1 || raw.maxSessionHours > 24
    || !Array.isArray(raw.people) || raw.people.length < 1 || raw.people.length > 10) {
    throw new Error('Config requires distinct action slots 1–16, maxSessionHours 1–24, and 1–10 trusted people.');
  }
  const people = raw.people.map((person) => {
    if (!keys(person, ['id', 'label']) || !isId(person.id) || typeof person.label !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(person.label) || person.label.trim() !== person.label) {
      throw new Error('Each trusted person needs an exact lowercase sender UUID and a short plain label.');
    }
    return { id: person.id, label: person.label };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(people.map((person) => person.id)).size !== people.length) throw new Error('Duplicate trusted person.');
  return { startAction: raw.startAction, stopAction: raw.stopAction, maxSessionHours: raw.maxSessionHours, people };
}

export function eventRecord(event, room, policy) {
  if (!object(event) || event.room?.code !== room || !policy.people.some((person) => person.id === event.sender?.id)
    || ![policy.startAction, policy.stopAction].includes(event.action_number)
    || event.trigger_source !== 'manual' || event.origin_agent !== null
    || event.question !== null || event.is_handoff !== false) return null;
  if (!isId(event.id)) throw new Error('Eligible event has an invalid ID.');
  return { id: event.id, personId: event.sender.id, kind: event.action_number === policy.startAction ? 'start' : 'stop', at: timestamp(event.created_at) };
}

export function validateBatch(batch) {
  if (!object(batch) || !isId(batch.cursor) || !Array.isArray(batch.notifications) || batch.notifications.length > 50
    || batch.notifications.some((event) => !object(event) || !isId(event.id))
    || (batch.notifications.length && batch.notifications.at(-1).id !== batch.cursor)) throw new Error('Malformed notification batch; cursor retained.');
  for (let index = 1; index < batch.notifications.length; index += 1) {
    if (batch.notifications[index].id < batch.notifications[index - 1].id) throw new Error('Notification cursor order is invalid.');
  }
  return batch;
}

export function validateState(state) {
  if (!keys(state, ['version', 'journalId', 'scope', 'room', 'policy', 'initialCursor', 'cursor', 'initializedAt', 'observedAt', 'events'])
    || state.version !== 1 || !isId(state.journalId) || typeof state.scope !== 'string' || !/^[0-9a-f]{64}$/.test(state.scope)
    || typeof state.room !== 'string' || !ROOM.test(state.room) || !isId(state.initialCursor) || !isId(state.cursor)
    || state.cursor < state.initialCursor || !Array.isArray(state.events) || state.events.length > MAX_EVENTS) throw new Error('Invalid journal state; restore a valid backup.');
  const policy = validatePolicy(state.policy);
  if (hash(policy) !== hash(state.policy)) throw new Error('Noncanonical saved policy.');
  if (timestamp(state.initializedAt) !== state.initializedAt || timestamp(state.observedAt) !== state.observedAt
    || state.observedAt < state.initializedAt) throw new Error('Invalid journal observation time.');
  let previous = state.initialCursor;
  for (const event of state.events) {
    if (!keys(event, ['id', 'personId', 'kind', 'at']) || !isId(event.id) || event.id <= previous || event.id > state.cursor
      || !policy.people.some((person) => person.id === event.personId) || !['start', 'stop'].includes(event.kind)
      || timestamp(event.at) !== event.at) throw new Error('Invalid saved event.');
    previous = event.id;
  }
  return state;
}

export function applyBatch(state, batch, now = new Date().toISOString()) {
  validateState(state); validateBatch(batch);
  if (batch.cursor < state.cursor) throw new Error('Server cursor moved backwards.');
  const seen = new Map(state.events.map((event) => [event.id, event]));
  const additions = [];
  for (const raw of batch.notifications) {
    const event = eventRecord(raw, state.room, state.policy);
    const previous = seen.get(raw.id);
    if (previous) {
      if (!event || hash(previous) !== hash(event)) throw new Error('Previously recorded event changed.');
      continue;
    }
    if (!event) continue;
    if (event.id <= state.cursor) throw new Error('Unexpected old event; inspect feed history before continuing.');
    additions.push(event); seen.set(event.id, event);
  }
  if (state.events.length + additions.length > MAX_EVENTS) throw new Error('Journal capacity reached; cursor retained. Export and archive deliberately.');
  if (batch.cursor === state.cursor && !additions.length) return state;
  const observedAt = timestamp(now);
  return validateState({ ...state, cursor: batch.cursor, observedAt: observedAt < state.observedAt ? state.observedAt : observedAt, events: [...state.events, ...additions] });
}

export function summarize(state) {
  validateState(state);
  const people = state.policy.people.map((person) => ({ ...person, totalMilliseconds: 0, intervals: [], incomplete: [], anomalies: [] }));
  for (const person of people) {
    let pending = null;
    let lastAt = null;
    for (const event of state.events.filter((entry) => entry.personId === person.id)) {
      const anomaly = (reason) => person.anomalies.push({ eventId: event.id, at: event.at, reason });
      const incomplete = (reason) => { if (pending) person.incomplete.push({ startEventId: pending.id, startedAt: pending.at, reason }); pending = null; };
      if (lastAt !== null && event.at < lastAt) {
        anomaly('out_of_order_timestamp'); incomplete('out_of_order_timestamp'); continue;
      }
      lastAt = event.at;
      if (event.kind === 'start') {
        if (pending) { anomaly('repeated_start'); incomplete('repeated_start'); }
        pending = event;
      } else if (!pending) anomaly('stop_without_start');
      else {
        const milliseconds = Date.parse(event.at) - Date.parse(pending.at);
        if (milliseconds > state.policy.maxSessionHours * 3600000) {
          anomaly('session_too_long'); incomplete('session_too_long');
        } else {
          person.intervals.push({ startEventId: pending.id, stopEventId: event.id, startedAt: pending.at, stoppedAt: event.at, milliseconds });
          person.totalMilliseconds += milliseconds;
          pending = null;
        }
      }
    }
    if (pending) person.incomplete.push({ startEventId: pending.id, startedAt: pending.at, reason: 'still_open' });
  }
  return { version: 1, journalId: state.journalId, snapshotHash: hash(state), room: state.room,
    initializedAt: state.initializedAt, observedThroughCursor: state.cursor, lastObservedAt: state.observedAt,
    timestampBasis: 'server-created-at', attendanceVerified: false, completeHistory: false,
    eventCount: state.events.length, people };
}
