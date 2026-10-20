import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { makeClient } from './client.js';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { loadEnvironment, loadConnection, loadPolicy, validateConnection, connectionKey, credentialDirectory, journalDirectory, assertRoom, assertActions } from './config.js';
import { openJournal, exportJournal } from './journal.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Stopped.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);

async function connect() {
  const release = await acquireLock(credentialDirectory);
  try {
    if (await readJson(join(credentialDirectory, 'credentials.json'), 32 * 1024)) throw new Error('Saved connection already exists; inspect it or archive it deliberately before reconnecting.');
    const client = makeClient({ signal: controller.signal, pairing: true });
    let pending = await readJson(join(credentialDirectory, 'pairing.json'), 64 * 1024);
    if (pending === null) {
      const pairing = await client.auth.startPairing({ agent_label: 'Time journal' });
      pending = { pairing, token: client.getToken(), createdAt: Date.now() };
      await atomicJson(credentialDirectory, 'pairing.json', pending, 64 * 1024);
    }
    if (typeof pending.token !== 'string' || !pending.token || !Number.isSafeInteger(pending.createdAt)
      || !Number.isInteger(pending.pairing?.expires_in) || pending.pairing.expires_in < 1 || pending.pairing.expires_in > 3600) throw new Error('Invalid saved pairing; inspect it before reconnecting.');
    const remaining = Math.floor((pending.createdAt + pending.pairing.expires_in * 1000 - Date.now()) / 1000);
    if (remaining <= 0) throw new Error('Saved pairing expired. Remove only .pingroom/pairing.json after confirming it is no longer usable, then reconnect.');
    const url = new URL(pending.pairing.pair_browser_url);
    if (url.origin !== 'https://pingroom.io' || url.username || url.password) throw new Error('Unexpected pairing URL.');
    client.setToken(pending.token);
    console.log('Install PingRoom: https://pingroom.io/i');
    console.log(`Approve the time journal and select your shared private room: ${url.href}`);
    const active = await client.auth.waitForPairing({ ...pending.pairing, expires_in: remaining }, { signal: controller.signal });
    // Save an approved credential before further network checks, so interrupted
    // setup does not force another robot registration.
    const connection = validateConnection({ token: active.credential, room: (active.home_room ?? active.room)?.invite_code });
    await atomicJson(credentialDirectory, 'credentials.json', connection, 32 * 1024);
    await rm(join(credentialDirectory, 'pairing.json'));
    console.log('Saved private credentials. Run npm run inspect, then configure config.json.');
  } finally { await release(); }
}

async function inspect() {
  const connection = await loadConnection();
  const client = makeClient({ token: connection.token, signal: controller.signal });
  const rooms = await client.rooms.list(); assertRoom(rooms, connection.room);
  const actions = await client.actions.list(connection.room);
  if (!Array.isArray(actions) || actions.length > 16) throw new Error('Invalid action inventory.');
  const recent = await client.notifications.list({ limit: 25 });
  if (!Array.isArray(recent?.data) || recent.data.length > 25) throw new Error('Invalid recent feed.');
  console.log(JSON.stringify({
    room: connection.room,
    actions: actions.map((action) => ({ slot: action.action_number, label: action.label, input_type: action.input_type ?? 'none' })),
    recent: recent.data.filter((event) => event.room?.code === connection.room).map((event) => ({
      id: event.id, senderId: event.sender?.id, slot: event.action_number, at: event.created_at,
      manualHuman: event.trigger_source === 'manual' && event.origin_agent === null && event.question === null && event.is_handoff === false,
    })),
  }, null, 2));
  console.log('Verify each test tap with its sender. Use exact sender UUIDs; names alone are insufficient. The listener excludes your own taps.');
}

async function listen() {
  const connection = await loadConnection();
  const policy = await loadPolicy();
  const client = makeClient({ token: connection.token, signal: controller.signal });
  assertRoom(await client.rooms.list(), connection.room, policy);
  assertActions(await client.actions.list(connection.room), policy);
  const journal = await openJournal({ client, directory: journalDirectory, ...connection, policy, connectionKey: connectionKey(connection.token), signal: controller.signal });
  try {
    console.log('Ready. Recording trusted teammates’ future Start/Stop taps; Ctrl+C stops safely.');
    while (!controller.signal.aborted) {
      await journal.poll();
      // Empty mock or early server replies must not create a tight polling loop.
      await delay(250, undefined, { signal: controller.signal });
    }
  } finally { await journal.close(); }
}

try {
  await loadEnvironment();
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('No additional arguments are supported.');
  if (command === 'connect') await connect();
  else if (command === 'inspect') await inspect();
  else if (command === 'listen') await listen();
  else if (command === 'export') {
    const result = await exportJournal(journalDirectory);
    console.log(`Saved ${result.report.eventCount} recorded events to ${result.path}`);
  } else throw new Error('Use npm start, npm run connect, npm run inspect, or npm run export.');
} catch (error) {
  if (controller.signal.aborted) console.log('Stopped. Saved cursor and journal retained.');
  else {
    // SDK errors can contain server text: never echo tokens, bodies, or raw errors.
    const safeLocal = error instanceof Error && !('code' in error) && error.name === 'Error';
    console.error(safeLocal ? error.message : 'Operation failed. Check configuration, credentials, granted room/scopes, network, and saved state. No cursor was deliberately discarded.');
    process.exitCode = 1;
  }
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
