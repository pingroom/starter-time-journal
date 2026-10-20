import assert from 'node:assert/strict';
import { makeClient, API } from './client.js';

export const ROOM_CODE = 'DEMO12345678';
export const PERSON = '11111111-1111-4111-8111-111111111111';
export const SECOND_PERSON = '22222222-2222-4222-8222-222222222222';
export const POLICY = { startAction: 1, stopAction: 2, maxSessionHours: 16, people: [{ id: PERSON, label: 'Teammate' }] };
export const id = (number) => `01990000-0000-7000-8000-${String(number).padStart(12, '0')}`;
export const event = (number, kind, at, extra = {}) => ({
  id: id(number), action_number: kind === 'start' ? 1 : 2, created_at: at,
  sender: { id: PERSON, name: 'Never used as identity' }, room: { code: ROOM_CODE },
  trigger_source: 'manual', origin_agent: null, question: null, is_handoff: false,
  message: 'Ignored content', ...extra,
});
export const batch = (...notifications) => ({ notifications, cursor: notifications.at(-1)?.id ?? id(0) });

/** Real SDK serialization and parsing; no network or credentials. */
export function mockFeed(responses) {
  const pending = [...responses];
  const requests = [];
  const client = makeClient({ token: 'offline-fixture-token', fetchImpl: async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, API);
    assert.equal(url.pathname, '/api/agent/notifications/wait');
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-fixture-token');
    assert.equal(init.redirect, 'manual');
    assert.equal(url.searchParams.get('limit'), '50');
    requests.push({ after: url.searchParams.get('after'), timeout: Number(url.searchParams.get('timeout')) });
    if (!pending.length) throw new Error('Unexpected extra mock request.');
    const next = pending.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  } });
  return { client, requests };
}
