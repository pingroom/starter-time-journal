# PingRoom time journal

Let trusted teammates tap **Start** and **Stop** in a shared room, then export their observed intervals as a private JSON timesheet. Use it for a small team's voluntary work log.

The listener connects as account A and records other members' taps. **PingRoom's wait feed excludes A's own pings.** The export measures time between server-recorded events; it does not verify attendance, physical presence, productive work, or billable hours.

## Try it offline

Requires Node.js 22 or newer on macOS/Linux. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo runs the real pinned SDK through an in-memory HTTP transport. It records a 90-minute interval, replays a duplicate, restarts, and shows an unfinished session. It needs no credentials, makes no network requests, and removes its temporary files. Installation requires npm access.

## Connect and configure

1. Install [PingRoom](https://pingroom.io/i). Account A and the teammates being recorded must share a **standard private room**. Teammates need permission to press its actions.
2. In the app, configure two existing action slots as **Start** and **Stop**, with no required input. This starter never changes room actions.
3. Run `npm run connect`, approve the printed link, and select that room. The connection needs notification read and room read access, including action reads: `pingroom:notifications:read` and `pingroom:rooms:read`.
4. Have each participating teammate press a harmless setup action. Run `npm run inspect`; it prints action slots and at most 25 recent notification metadata records across the visible feed. Verify each test tap with its sender and copy its exact `senderId`. A display name is insufficient.
5. Copy `config.example.json` to ignored `config.json`. Set the Start/Stop slot numbers and 1–10 trusted people. Labels are local names; sender UUIDs establish identity. Do not add account A to this roster.
6. Run `npm start`. Wait for **Ready**, then have teammates start their sessions.

```json
{
  "startAction": 1,
  "stopAction": 2,
  "maxSessionHours": 16,
  "people": [
    { "id": "11111111-1111-4111-8111-111111111111", "label": "Teammate" }
  ]
}
```

Replace the sample UUID. Slot numbers are 1–16, maximum session length is 1–24 hours, and labels use 1–60 plain letters, digits, spaces, `.`, `_`, or `-`. Keep these settings and the meaning of the room's slots stable while a journal is active.

Pairing saves private credentials in `.pingroom/credentials.json`. Interrupted pairing reuses `.pingroom/pairing.json` and its existing link. An existing saved connection is never overwritten automatically.

Before registration, setup saves a private creation intent. A lost registration or pairing response leaves that intent in place; rerunning setup sends no new request. If creation is uncertain or the link expires, inspect Connected Agents and resolve or revoke the old robot before deliberately archiving `.pingroom/pairing.json` for a new setup. Do not discard the record just to obtain another link.

Alternatively, copy `.env.example` to `.env` and supply **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank values fail. Shell variables override `.env`. Configuration, credentials, and state paths are relative to this project regardless of the current shell directory.

## Export and interpret

Stop the listener with Ctrl+C, then:

```sh
npm run export
```

The command reads only local state and writes `.journal/exports/timesheet-<snapshot-hash>.json`. The same state reuses the same export. It includes each person's completed intervals, integer millisecond total, incomplete sessions, anomalies, and source event IDs. It contains no message bodies or attachments.

- Start followed by Stop records their server timestamps and elapsed milliseconds. Sub-millisecond timestamp precision is truncated; matching timestamps yield zero.
- Another Start marks the earlier session incomplete and opens a new session.
- Stop without Start is an anomaly. A backward timestamp invalidates any currently open session and is not used to calculate time.
- A session longer than the configured maximum is incomplete. Open sessions contribute no time; the current clock never supplies a missing Stop.

Only events with the exact room, trusted sender UUID, and configured numeric slot qualify. They must explicitly have `trigger_source: "manual"`, `origin_agent: null`, `question: null`, and `is_handoff: false`. Missing or different provenance is ignored. Message text, URLs, structured data, and attachments never become commands or paths.

## Resume and limits

The first run captures the current feed head and skips all earlier events, including setup taps. Later runs resume the saved cursor. Keep the process running to observe events promptly; the feed is subject to access and retention limits. The timesheet does not claim complete history.

Each batch's accepted events and cursor are saved together using a temporary file, file sync, rename, and directory sync. Duplicate IDs do not add time; conflicting copies, malformed batches, storage errors, and API errors stop processing. Rerun after addressing the cause. A crash can leave the latest whole saved batch; it cannot intentionally save its cursor separately from its events. This is a local file journal, without a distributed exactly-once guarantee.

One process may use `.journal/` at a time; export also takes its lock. After a crash, inspect `.journal/.lock/owner.json` and confirm that process has stopped before removing the lock. A PID alone does not establish ownership. Restore corrupt state from a valid backup instead of resetting its cursor.

The journal holds at most **2,000 accepted events**; an over-capacity batch fails without advancing the cursor. To start a new journal, pause teammates' taps, stop the listener, export, and archive the whole `.journal/` directory privately. Resolve open sessions first. Restarting without state begins at the current head and skips the gap; it is not a recovery method for missed events. Changing the token, room, or configuration also requires a deliberate new journal.

JSON state and exports are bounded to 1 MiB, configuration to 16 KiB, and each HTTP response to 512 KiB. Long-poll reads have a 30-second deadline; other requests allow five seconds. POSIX directories use `0700` and files `0600`. Credentials, roster, events, and exports are ignored by Git. Preserve equivalent access controls and private backups.

## Adapt

`src/model.js` contains the interval rules; `src/journal.js` handles durable ingestion and export. Read the JSON export in your reporting workflow. Add billing, payroll, or external writes only with your own review and identity mapping; this starter implements none of those actions.

Unlike the [room action runner](https://github.com/pingroom/starter-room-action-runner), which starts a report for each button press, this project pairs events over time and preserves ambiguous sessions for review.

SDK **0.6.0** is pinned with a lockfile and a 14-day minimum release age. CI checks Node 22 and 24. Tests cover SDK requests, replay, restart, provenance, interval anomalies, failed writes, bounds, cancellation, locks, and private files. No live phone delivery is tested.

[Official SDK](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
