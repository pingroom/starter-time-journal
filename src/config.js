import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readText, readJson } from './storage.js';
import { ROOM, hash, isId, validatePolicy } from './model.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialDirectory = join(root, '.pingroom');
export const journalDirectory = join(root, '.journal');

export async function loadEnvironment(env = process.env) {
  const text = await readText(join(root, '.env'), 16 * 1024);
  if (text !== null) for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function validateConnection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(raw.token)
    || typeof raw.room !== 'string' || !ROOM.test(raw.room.toUpperCase())) throw new Error('Invalid connection. Set both PINGROOM_TOKEN and PINGROOM_ROOM, or connect first.');
  return { token: raw.token, room: raw.room.toUpperCase() };
}

export async function loadConnection(directory = credentialDirectory, env = process.env) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    return validateConnection({ token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM });
  }
  return validateConnection(await readJson(join(directory, 'credentials.json'), 32 * 1024));
}

export async function loadPolicy() {
  const policy = await readJson(join(root, 'config.json'), 16 * 1024);
  if (policy === null) throw new Error('Copy config.example.json to config.json and configure trusted people and action slots.');
  return validatePolicy(policy);
}

export const connectionKey = (token) => hash({ credential: token });

export function assertRoom(rooms, room, policy) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((entry) => entry?.invite_code === room);
  const entry = matches[0];
  if (matches.length !== 1 || entry.type !== 'standard' || entry.is_public !== false || !Array.isArray(entry.members)
    || entry.members.length > 1000) throw new Error('Use a granted standard private room with a visible human roster.');
  const humans = new Set(entry.members.filter((member) => isId(member?.user_id)).map((member) => member.user_id));
  if (humans.size < 2 || policy && policy.people.some((person) => !humans.has(person.id))) throw new Error('Every trusted person must be a member of the shared room.');
}

export function assertActions(actions, policy) {
  if (!Array.isArray(actions) || actions.length > 16) throw new Error('Invalid action inventory.');
  for (const slot of [policy.startAction, policy.stopAction]) {
    const matches = actions.filter((action) => action?.action_number === slot);
    if (matches.length !== 1 || typeof matches[0].label !== 'string' || !matches[0].label.trim()
      || ![null, undefined, 'none'].includes(matches[0].input_type)) throw new Error('Start and Stop must be existing labeled actions requiring no input.');
  }
}
