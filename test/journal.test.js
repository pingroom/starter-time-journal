import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, exportJournal } from '../src/journal.js';
import { applyBatch, summarize, hash, timestamp, validatePolicy, validateState } from '../src/model.js';
import { readJson, atomicJson } from '../src/storage.js';
import { loadConnection, assertActions, assertRoom } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockFeed, ROOM_CODE, POLICY, PERSON, SECOND_PERSON, event, batch, id } from '../src/mock.js';

const at = (hour) => `2026-01-01T${String(hour).padStart(2, '0')}:00:00Z`;
const state = () => ({ version: 1, journalId: id(99999), scope: hash('scope'), room: ROOM_CODE, policy: structuredClone(POLICY),
  initialCursor: id(0), cursor: id(0), initializedAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:00.000Z', events: [] });
const advance = (value, ...events) => applyBatch(value, batch(...events), '2026-01-02T00:00:00.000Z');
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-journal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const options = (client, directory, extra = {}) => ({ client, directory, policy: POLICY, room: ROOM_CODE, connectionKey: hash('connection'), ...extra });

test('real SDK feed, restart, duplicate delivery and stable offline export', async (t) => {
  const directory = await temp(t);
  const one = event(1, 'start', at(9)), two = event(2, 'stop', at(10));
  const feed = mockFeed([{ notifications: [], cursor: id(0) }, batch(one), batch(one, two), batch(two)]);
  let journal = await openJournal(options(feed.client, directory));
  await journal.poll(); await journal.close();
  journal = await openJournal(options(feed.client, directory));
  await journal.poll(); await journal.poll(); await journal.close();
  const first = await exportJournal(directory), second = await exportJournal(directory);
  assert.equal(first.path, second.path);
  assert.equal(first.report.people[0].totalMilliseconds, 3600000);
  assert.equal(first.report.eventCount, 2);
  assert.equal(first.report.attendanceVerified, false);
  assert.deepEqual(feed.requests.map((request) => request.after), [null, id(0), id(1), id(2)]);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
});

test('initial head skips all old taps and resumes only later events', async (t) => {
  const directory = await temp(t);
  const feed = mockFeed([batch(event(5, 'start', at(8))), batch(event(6, 'stop', at(9)))]);
  const journal = await openJournal(options(feed.client, directory));
  await journal.poll();
  const report = summarize(journal.snapshot());
  assert.equal(report.eventCount, 1);
  assert.equal(report.people[0].totalMilliseconds, 0);
  assert.equal(report.people[0].anomalies[0].reason, 'stop_without_start');
  await journal.close();
});

test('two people keep independent intervals', () => {
  const initial = state();
  initial.policy.people.push({ id: SECOND_PERSON, label: 'Second person' });
  const result = advance(initial, event(1, 'start', at(8)), event(2, 'start', at(9), { sender: { id: SECOND_PERSON } }),
    event(3, 'stop', at(10)), event(4, 'stop', at(12), { sender: { id: SECOND_PERSON } }));
  assert.deepEqual(summarize(result).people.map((person) => person.totalMilliseconds), [7200000, 10800000]);
});

test('strict provenance ignores automation, wrong room, person, slot and missing fields', () => {
  const overrides = [
    { origin_agent: {} }, { origin_agent: undefined }, { question: {} }, { question: undefined },
    { is_handoff: true }, { is_handoff: undefined }, { trigger_source: 'webhook' },
    { room: { code: 'OTHER1234567' } }, { sender: { id: SECOND_PERSON } }, { action_number: 4 }, { action_number: '1' },
  ];
  const result = advance(state(), ...overrides.map((extra, index) => event(index + 1, 'start', at(8), extra)));
  assert.equal(result.events.length, 0); assert.equal(result.cursor, id(overrides.length));
});

test('message content and URLs remain unused data', () => {
  const result = advance(state(), event(1, 'start', at(9), { message: '$(touch stolen)', data: { command: 'rm -rf /', url: 'https://evil.invalid' }, attachments: [{}] }));
  assert.deepEqual(Object.keys(result.events[0]), ['id', 'personId', 'kind', 'at']);
  assert.ok(!JSON.stringify(result).includes('stolen'));
});

test('repeated Start marks earlier session incomplete and starts a fresh interval', () => {
  const report = summarize(advance(state(), event(1, 'start', at(8)), event(2, 'start', at(9)), event(3, 'stop', at(10))));
  assert.equal(report.people[0].totalMilliseconds, 3600000);
  assert.equal(report.people[0].incomplete[0].reason, 'repeated_start');
  assert.equal(report.people[0].anomalies[0].reason, 'repeated_start');
});

test('backward timestamps invalidate the open interval instead of inventing time', () => {
  let saved = advance(state(), event(1, 'start', at(9)));
  saved = advance(saved, event(2, 'stop', at(8)), event(3, 'stop', at(10)));
  const person = summarize(saved).people[0];
  assert.equal(person.totalMilliseconds, 0);
  assert.deepEqual(person.anomalies.map((entry) => entry.reason), ['out_of_order_timestamp', 'stop_without_start']);
  assert.equal(person.incomplete[0].reason, 'out_of_order_timestamp');
});

test('long sessions and still-open sessions contribute no time', () => {
  const initial = state(); initial.policy.maxSessionHours = 1;
  const person = summarize(advance(initial, event(1, 'start', at(8)), event(2, 'stop', at(10)), event(3, 'start', at(11)))).people[0];
  assert.equal(person.totalMilliseconds, 0);
  assert.deepEqual(person.incomplete.map((entry) => entry.reason), ['session_too_long', 'still_open']);
});

test('same timestamps produce a zero-length observed interval', () => {
  const person = summarize(advance(state(), event(1, 'start', at(8)), event(2, 'stop', at(8)))).people[0];
  assert.equal(person.intervals[0].milliseconds, 0);
});

test('invalid timestamps and impossible calendar dates fail', () => {
  for (const invalid of ['tomorrow', '2026-02-30T00:00:00Z', '2026-01-01T25:00:00Z', '2026-01-01T00:00:00+04:00', 0]) assert.throws(() => timestamp(invalid));
  assert.equal(timestamp('2026-01-01T00:00:00.123456Z'), '2026-01-01T00:00:00.123Z');
});

test('malformed cursor order and contradictory duplicate IDs fail', () => {
  const one = event(1, 'start', at(8)), two = event(2, 'stop', at(9));
  const saved = advance(state(), one);
  assert.throws(() => advance(saved, { ...one, created_at: at(10) }), /changed/);
  assert.throws(() => advance(saved, { ...one, origin_agent: {} }), /changed/);
  assert.throws(() => advance(state(), two, one), /order/);
  assert.throws(() => applyBatch(saved, { notifications: [], cursor: id(0) }), /backwards/);
  assert.throws(() => applyBatch(state(), { notifications: [one], cursor: id(2) }), /Malformed/);
});

test('eligible unknown old event cannot slip behind committed cursor', () => {
  const saved = advance(state(), event(3, 'start', at(8), { trigger_source: 'webhook' }));
  assert.throws(() => advance(saved, event(2, 'start', at(9)), event(4, 'stop', at(10))), /Unexpected old/);
});

test('state corruption, scope changes and duplicate trusted people are rejected', async (t) => {
  const directory = await temp(t);
  const feed = mockFeed([{ notifications: [], cursor: id(0) }]);
  const journal = await openJournal(options(feed.client, directory)); await journal.close();
  await assert.rejects(openJournal(options(feed.client, directory, { connectionKey: hash('other') })), /another connection/);
  assert.throws(() => validatePolicy({ ...POLICY, people: [POLICY.people[0], POLICY.people[0]] }), /Duplicate/);
  assert.throws(() => validatePolicy({ ...POLICY, startAction: '1' }));
  assert.throws(() => validatePolicy({ ...POLICY, unexpected: true }));
  const broken = state(); broken.events = [{ id: id(1) }];
  assert.throws(() => validateState(broken), /Invalid saved/);
});

test('failed write retains old cursor; replay commits all accepted events together', async (t) => {
  const directory = await temp(t);
  const events = batch(event(1, 'start', at(8)), event(2, 'stop', at(9)));
  const feed = mockFeed([{ notifications: [], cursor: id(0) }, events, events]);
  let fail = false;
  const journal = await openJournal(options(feed.client, directory, { write: async (...args) => { if (fail) throw new Error('disk full'); return atomicJson(...args); } }));
  fail = true; await assert.rejects(journal.poll(), /disk full/);
  assert.equal(journal.snapshot().cursor, id(0));
  assert.equal((await readJson(join(directory, 'state.json'))).cursor, id(0));
  fail = false; await journal.poll(); await journal.close();
  assert.equal((await exportJournal(directory)).report.eventCount, 2);
});

test('API failure and malformed eligible event preserve on-disk cursor', async (t) => {
  const directory = await temp(t);
  const feed = mockFeed([{ notifications: [], cursor: id(0) }, new Error('mock network failure'), batch(event(1, 'start', 'bad'))]);
  const journal = await openJournal(options(feed.client, directory));
  await assert.rejects(journal.poll()); await assert.rejects(journal.poll());
  assert.equal((await readJson(join(directory, 'state.json'))).cursor, id(0));
  await journal.close();
});

test('lock excludes another listener and exporter', async (t) => {
  const directory = await temp(t);
  const feed = mockFeed([{ notifications: [], cursor: id(0) }]);
  const journal = await openJournal(options(feed.client, directory));
  await assert.rejects(openJournal(options(feed.client, directory)), /lock exists/);
  await assert.rejects(exportJournal(directory), /lock exists/);
  await journal.close();
  await exportJournal(directory);
});

test('2,000 worst-case events fit bounded files; overflow preserves cursor', async (t) => {
  const directory = await temp(t);
  let saved = state(); saved.policy.people[0].label = 'A'.repeat(60);
  for (let offset = 0; offset < 2000; offset += 50) {
    saved = advance(saved, ...Array.from({ length: 50 }, (_, index) => event(offset + index + 1, 'start', at(8))));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2)) < 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(summarize(saved), null, 2)) < 1024 * 1024);
  await atomicJson(directory, 'state.json', saved);
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  assert.throws(() => advance(saved, event(2001, 'stop', at(9))), /capacity/);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
  await exportJournal(directory);
});

test('bounded local reads reject oversized, malformed, UTF8 and symlink data without echoing it', async (t) => {
  const directory = await temp(t), path = join(directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",broken');
  await assert.rejects(readJson(path), (error) => error.message.includes('malformed') && !error.message.includes('PRIVATE_TOKEN'));
  await writeFile(path, 'x'.repeat(101)); await assert.rejects(readJson(path, 100), /size/);
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await symlink(path, join(directory, 'link.json')); await assert.rejects(readJson(join(directory, 'link.json')));
});

test('export refuses conflicting output rather than overwriting it', async (t) => {
  const directory = await temp(t);
  await atomicJson(directory, 'state.json', state());
  const result = await exportJournal(directory);
  await writeFile(result.path, '{"tampered":true}');
  await assert.rejects(exportJournal(directory), /Conflicting/);
  assert.equal(await readFile(result.path, 'utf8'), '{"tampered":true}');
});

test('blank/partial environment overrides fail and full values override saved credentials', async (t) => {
  const directory = await temp(t);
  await atomicJson(directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(directory, { PINGROOM_TOKEN: '' }));
  await assert.rejects(loadConnection(directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.deepEqual(await loadConnection(directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() }), { token: 'explicit', room: ROOM_CODE });
});

test('preflight rejects public rooms, missing humans, wrong slots and input actions', () => {
  const room = { invite_code: ROOM_CODE, type: 'standard', is_public: false, members: [{ user_id: PERSON }, { user_id: SECOND_PERSON }] };
  assertRoom([room], ROOM_CODE, POLICY);
  assert.throws(() => assertRoom([{ ...room, is_public: true }], ROOM_CODE, POLICY));
  assert.throws(() => assertRoom([{ ...room, members: [{ user_id: SECOND_PERSON }] }], ROOM_CODE, POLICY));
  const actions = [{ action_number: 1, label: 'Start', input_type: 'none' }, { action_number: 2, label: 'Stop', input_type: null }];
  assertActions(actions, POLICY);
  assert.throws(() => assertActions([actions[0]], POLICY));
  assert.throws(() => assertActions([{ ...actions[0], input_type: 'text' }, actions[1]], POLICY));
});

test('transport uses fixed API, refuses writes and redirects, and bounds response bytes', async () => {
  let calls = 0;
  const client = makeClient({ token: 'fixture', fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://other.invalid' } }); } });
  await assert.rejects(client.notifications.wait({ timeout: 0 }));
  assert.equal(calls, 1);
  await assert.rejects(client.rooms.create({ name: 'Never create' }));
  assert.equal(calls, 1);
  const big = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) });
  await assert.rejects(big.notifications.wait({ timeout: 0 }));
});

test('transport deadline bounds stalled fetch and stalled body', async () => {
  const fetchHang = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(fetchHang.notifications.wait({ timeout: 0 }));
  const streamHang = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) });
  await assert.rejects(streamHang.notifications.wait({ timeout: 0 }));
});

test('transport yields on infinitely ready empty chunks and respects cancellation', async () => {
  const controller = new AbortController();
  const client = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (output) => output.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(client.notifications.wait({ timeout: 0 })); }
  finally { clearTimeout(timer); }
});

test('aborted journal polling retains the saved cursor and releases the lock', async (t) => {
  const directory = await temp(t), controller = new AbortController();
  const source = mockFeed([{ notifications: [], cursor: id(0) }]);
  const journal = await openJournal(options(source.client, directory, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(journal.poll());
  assert.equal(journal.snapshot().cursor, id(0));
  await journal.close(); await exportJournal(directory);
});
