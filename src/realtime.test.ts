import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient, type PostgresChangesPayload, type PresenceJoin, type SubscribeStatus } from './index.js';
import { fakeFetch, fakeSocket, tick, type FakeSocket, type Frame } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

/** A Phoenix server that accepts every join and echoes broadcasts to the channel. */
function server(extra: (frame: Frame, socket: FakeSocket) => boolean = () => false) {
	return fakeSocket((frame, socket) => {
		if (extra(frame, socket)) {
			return;
		}
		if (frame.event === 'phx_join') {
			const config = (frame.payload.config ?? {}) as { postgres_changes?: Record<string, unknown>[] };
			const changes = config.postgres_changes ?? [];
			socket.reply(frame, { postgres_changes: changes.map((f, i) => ({ ...f, id: 100 + i })) });
			if (changes.length > 0) {
				// What Realtime sends once it has actually started capturing the changes.
				queueMicrotask(() =>
					socket.serve({ topic: frame.topic, event: 'system', payload: { status: 'ok', extension: 'postgres_changes', message: 'Subscribed to PostgreSQL' }, ref: null })
				);
			}
		} else if (frame.event === 'broadcast') {
			socket.serve({ topic: frame.topic, event: 'broadcast', payload: frame.payload, ref: null });
		} else if (frame.event === 'phx_leave' || frame.event === 'heartbeat' || frame.event === 'presence') {
			socket.reply(frame);
		}
	});
}

function client(transport: typeof WebSocket, fetchImpl?: typeof fetch) {
	return createClient(URL_, 'anon-key', {
		global: { fetch: fetchImpl ?? fakeFetch().fetch },
		auth: { persistSession: false, autoRefreshToken: false },
		realtime: { transport, timeoutMs: 200 }
	});
}

function subscribed(channel: { subscribe(cb: (status: SubscribeStatus, error?: Error) => void): unknown }): Promise<SubscribeStatus> {
	return new Promise((resolve) => {
		channel.subscribe((status) => resolve(status));
	});
}

test('the socket opens on subscribe, with the key and protocol version, and joins the topic', async () => {
	const { transport, sockets } = server();
	const db = client(transport);
	const channel = db.channel('room:42');
	assert.equal(sockets.length, 0);
	assert.equal(await subscribed(channel), 'SUBSCRIBED');
	const url = new URL(sockets[0].url);
	assert.equal(url.origin + url.pathname, 'wss://abc123.api.snoutdata.com/realtime/v1/websocket');
	assert.equal(url.searchParams.get('apikey'), 'anon-key');
	assert.equal(url.searchParams.get('vsn'), '1.0.0');
	const join = sockets[0].frames.find((f) => f.event === 'phx_join');
	assert.equal(join?.topic, 'realtime:room:42');
	assert.equal(join?.payload.access_token, 'anon-key');
	await db.removeChannel(channel);
});

test('a broadcast with self: true comes back to its sender', async () => {
	const { transport } = server();
	const db = client(transport);
	const channel = db.channel('room:1', { config: { broadcast: { self: true } } });
	const received = new Promise((resolve) => channel.on('broadcast', { event: 'ping' }, (message) => resolve(message.payload)));
	await subscribed(channel);
	assert.equal(await channel.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } }), 'ok');
	assert.deepEqual(await received, { n: 1 });
	await db.removeChannel(channel);
});

test('a broadcast from a channel that is not joined goes over HTTP', async () => {
	const { transport } = server();
	const { fetch, sent } = fakeFetch(() => ({ status: 202 }));
	const db = client(transport, fetch);
	const status = await db.channel('room:9').send({ type: 'broadcast', event: 'hi', payload: { a: 1 } });
	assert.equal(status, 'ok');
	assert.equal(sent[0].url, `${URL_}/realtime/v1/api/broadcast`);
	assert.deepEqual(JSON.parse(sent[0].body ?? ''), { messages: [{ topic: 'room:9', event: 'hi', payload: { a: 1 }, private: false }] });
});

test('table changes are routed by the ids the server granted, and reshaped', async () => {
	const { transport, sockets } = server();
	const db = client(transport);
	const inserts: PostgresChangesPayload[] = [];
	const deletes: PostgresChangesPayload[] = [];
	const channel = db
		.channel('feed')
		.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, (p) => inserts.push(p))
		.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'todos' }, (p) => deletes.push(p));
	await subscribed(channel);
	const join = sockets[0].frames.find((f) => f.event === 'phx_join');
	assert.equal((join?.payload.config as { postgres_changes: unknown[] }).postgres_changes.length, 2);
	sockets[0].serve({
		topic: 'realtime:feed',
		event: 'postgres_changes',
		payload: { ids: [100], data: { schema: 'public', table: 'todos', commit_timestamp: 't', type: 'INSERT', record: { id: 1 }, errors: null } },
		ref: null
	});
	assert.equal(inserts.length, 1);
	assert.equal(deletes.length, 0);
	assert.equal(inserts[0].eventType, 'INSERT');
	assert.deepEqual(inserts[0].new, { id: 1 });
	assert.deepEqual(inserts[0].old, {});
	await db.removeChannel(channel);
});

test('with table changes, SUBSCRIBED waits for Realtime to say they are live, and a refusal there is an error', async () => {
	let refuse = false;
	const { transport } = fakeSocket((frame, socket) => {
		if (frame.event === 'phx_join') {
			socket.reply(frame, { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 't', id: 1 }] });
			setTimeout(() => {
				socket.serve({
					topic: frame.topic,
					event: 'system',
					payload: refuse
						? { status: 'error', extension: 'postgres_changes', message: 'Unable to subscribe to changes' }
						: { status: 'ok', extension: 'postgres_changes', message: 'Subscribed to PostgreSQL' },
					ref: null
				});
			}, 20);
		} else if (frame.event === 'phx_leave') {
			socket.reply(frame);
		}
	});
	const db = client(transport);
	const statuses: string[] = [];
	const live = db.channel('a').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 't' }, () => {});
	await new Promise<void>((resolve) => live.subscribe((status) => { statuses.push(status); resolve(); }));
	assert.deepEqual(statuses, ['SUBSCRIBED']);
	assert.equal(live.state, 'joined');
	refuse = true;
	const refused = db.channel('b').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 't' }, () => {});
	const outcome = await new Promise<[string, Error | undefined]>((resolve) => refused.subscribe((s, e) => resolve([s, e])));
	assert.equal(outcome[0], 'CHANNEL_ERROR');
	assert.match(outcome[1]?.message ?? '', /Unable to subscribe/);
	await db.removeAllChannels();
});

test('a refused join is CHANNEL_ERROR with the server\'s reason', async () => {
	const { transport } = server((frame, socket) => {
		if (frame.event === 'phx_join') {
			socket.reply(frame, { reason: 'Unauthorized: you do not have permissions to read from this Channel topic' }, 'error');
			return true;
		}
		return false;
	});
	const db = client(transport);
	const channel = db.channel('secret', { config: { private: true } });
	const outcome = await new Promise<[SubscribeStatus, Error | undefined]>((resolve) => channel.subscribe((s, e) => resolve([s, e])));
	assert.equal(outcome[0], 'CHANNEL_ERROR');
	assert.match(outcome[1]?.message ?? '', /Unauthorized/);
	await db.removeAllChannels();
});

test('presence: joins and leaves update the state and reach their listeners', async () => {
	const { transport, sockets } = server();
	const db = client(transport);
	const joins: PresenceJoin[] = [];
	let syncs = 0;
	const channel = db
		.channel('lobby', { config: { presence: { key: 'ada' } } })
		.on('presence', { event: 'join' }, (join) => joins.push(join))
		.on('presence', { event: 'sync' }, () => void (syncs += 1));
	await subscribed(channel);
	const join = sockets[0].frames.find((f) => f.event === 'phx_join');
	assert.deepEqual((join?.payload.config as { presence: unknown }).presence, { key: 'ada', enabled: true });
	assert.equal(await channel.track({ online_at: 1 }), 'ok');
	sockets[0].serve({ topic: 'realtime:lobby', event: 'presence_state', payload: { ada: { metas: [{ phx_ref: 'p1', online_at: 1 }] } }, ref: null });
	sockets[0].serve({ topic: 'realtime:lobby', event: 'presence_diff', payload: { joins: { bob: { metas: [{ phx_ref: 'p2' }] } }, leaves: {} }, ref: null });
	assert.deepEqual(Object.keys(channel.presenceState()).sort(), ['ada', 'bob']);
	assert.deepEqual(channel.presenceState().ada, [{ online_at: 1, presence_ref: 'p1' }]);
	assert.deepEqual(joins.map((j) => j.key), ['ada', 'bob']);
	sockets[0].serve({ topic: 'realtime:lobby', event: 'presence_diff', payload: { joins: {}, leaves: { bob: { metas: [{ phx_ref: 'p2' }] } } }, ref: null });
	assert.deepEqual(Object.keys(channel.presenceState()), ['ada']);
	assert.equal(syncs, 3);
	await db.removeChannel(channel);
});

test('a dropped socket is reopened and the channel joined again', async () => {
	const { transport, sockets } = server();
	const db = client(transport);
	const statuses: SubscribeStatus[] = [];
	const channel = db.channel('room:2');
	await new Promise<void>((resolve) =>
		channel.subscribe((status) => {
			statuses.push(status);
			if (statuses.filter((s) => s === 'SUBSCRIBED').length === 2) {
				resolve();
			} else if (status === 'SUBSCRIBED') {
				sockets[0].close();
			}
		})
	);
	assert.equal(sockets.length, 2);
	assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED']);
	await db.removeChannel(channel);
});

test('removing the last channel closes the socket', async () => {
	const { transport, sockets } = server();
	const db = client(transport);
	const channel = db.channel('room:3');
	await subscribed(channel);
	assert.equal(await db.removeChannel(channel), 'ok');
	await tick();
	assert.equal(sockets[0].readyState, 3);
	assert.equal(db.getChannels().length, 0);
});
