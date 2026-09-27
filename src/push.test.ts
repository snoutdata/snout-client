import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient, deliveryIdOf, webNotification } from './index.js';
import { fakeFetch, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function client(answer: (request: Sent) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
	const { fetch, sent } = fakeFetch(answer);
	const db = createClient(URL_, 'anon-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
	return { db, sent };
}

test('register posts the installation to /push/v1/devices with the key', async () => {
	const { db, sent } = client(() => ({ status: 201, body: { id: 'd1' } }));
	const { data, error } = await db.push.register({ transport: 'apns', token: 'a1b2', environment: 'sandbox' });
	assert.equal(error, null);
	assert.deepEqual(data, { id: 'd1' });
	assert.equal(new URL(sent[0].url).pathname, '/push/v1/devices');
	assert.equal(sent[0].method, 'POST');
	assert.equal(sent[0].headers.apikey, 'anon-key');
	assert.deepEqual(JSON.parse(String(sent[0].body)), { transport: 'apns', token: 'a1b2', environment: 'sandbox' });
});

test('send speaks the wire names and a Date becomes ISO', async () => {
	const { db, sent } = client(() => ({ status: 202, body: { id: 7 } }));
	const at = new Date('2026-10-01T09:00:00Z');
	const { data } = await db.push.send({
		notification: { title: 'Hi' },
		userIds: ['u1'],
		sendAt: at,
		collapseKey: 'inbox',
		ttl: 0
	});
	assert.deepEqual(data, { id: 7 });
	assert.equal(new URL(sent[0].url).pathname, '/push/v1/send');
	assert.deepEqual(JSON.parse(String(sent[0].body)), {
		notification: { title: 'Hi' },
		user_ids: ['u1'],
		send_at: '2026-10-01T09:00:00.000Z',
		ttl: 0,
		collapse_key: 'inbox'
	});
});

test("a refusal is an error with the server's own sentence and status", async () => {
	const { db } = client(() => ({ status: 403, body: { error: 'The project\'s policies do not allow this caller to do that.' } }));
	const { data, error } = await db.push.send({ notification: { title: 'x' }, topic: 'news' });
	assert.equal(data, null);
	assert.equal(error?.status, 403);
	assert.match(error?.message ?? '', /policies/);
});

test('subscribeWeb subscribes with the project key and registers the subscription', async () => {
	const { db, sent } = client((request) =>
		request.url.endsWith('/vapid-public-key') ? { body: { id: 'v1', key: 'BAAB' } } : { status: 201, body: { id: 'w1' } }
	);
	let asked: { userVisibleOnly: boolean; applicationServerKey: Uint8Array } | undefined;
	const registration = {
		pushManager: {
			subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
				asked = options;
				return {
					endpoint: 'https://fcm.googleapis.com/fcm/send/x',
					toJSON: () => ({ keys: { p256dh: 'pk', auth: 'au' } })
				};
			}
		}
	};
	const { data, error } = await db.push.subscribeWeb(registration);
	assert.equal(error, null);
	assert.deepEqual(data, { id: 'w1' });
	assert.equal(asked?.userVisibleOnly, true, 'every browser requires a push to show something');
	assert.deepEqual([...(asked?.applicationServerKey ?? [])], [4, 0, 1]);
	assert.deepEqual(JSON.parse(String(sent[1].body)), {
		transport: 'web',
		token: 'https://fcm.googleapis.com/fcm/send/x',
		p256dh: 'pk',
		auth: 'au'
	});
});

test('topics, receipts, credentials and unregister reach their paths', async () => {
	const { db, sent } = client(() => ({ status: 204 }));
	await db.push.join('team:42');
	await db.push.leave('team:42');
	await db.push.receipt(9, 'opened');
	await db.push.unregister('d1');
	await db.push.credentials.set('fcm', { service_account: '{}' });
	await db.push.credentials.remove('apns');
	assert.deepEqual(
		sent.map((s) => `${s.method} ${new URL(s.url).pathname}`),
		[
			'PUT /push/v1/topics/team%3A42/members',
			'DELETE /push/v1/topics/team%3A42/members',
			'POST /push/v1/receipts',
			'DELETE /push/v1/devices/d1',
			'PUT /push/v1/credentials/fcm',
			'DELETE /push/v1/credentials/apns'
		]
	);
	assert.deepEqual(JSON.parse(String(sent[2].body)), { delivery_id: 9, event: 'opened' });
});

test('the delivery id is read from each transport\'s shape', () => {
	assert.equal(deliveryIdOf({ aps: {}, snout_push_delivery: 12 }), 12);
	assert.equal(deliveryIdOf({ snout_push_delivery: '12' }), 12, 'FCM data values are strings');
	assert.equal(deliveryIdOf({ title: 't', data: { snout_push_delivery: 12 } }), 12, 'a web payload keeps it in data');
	assert.equal(deliveryIdOf({}), null);
	assert.equal(deliveryIdOf(null), null);
});

test('a web payload becomes showNotification arguments, count and link kept in data', () => {
	const { title, options } = webNotification({
		title: 'Hi',
		body: 'There',
		url: '/inbox',
		badge: 3,
		data: { snout_push_delivery: 5 },
		requireInteraction: true
	});
	assert.equal(title, 'Hi');
	assert.deepEqual(options, {
		requireInteraction: true,
		body: 'There',
		data: { snout_push_delivery: 5, url: '/inbox', badge: 3 }
	});
});
