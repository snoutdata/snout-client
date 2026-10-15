/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snout, type AuthEvent } from './index.js';
import { fakeFetch, jwt, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function tokenBody(accessToken: string, refreshToken: string, expiresIn = 3600) {
	return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: expiresIn, user: { id: 'u1', email: 'ada@example.com' } };
}

function client(answer: (request: Sent) => { status?: number; body?: unknown }, storage?: Map<string, string>) {
	const { fetch, sent } = fakeFetch(answer);
	const store = storage ?? new Map<string, string>();
	const db = snout(URL_, 'app-key', { vocabulary: 'old',
		global: { fetch },
		auth: {
			autoRefreshToken: false,
			detectSessionInUrl: false,
			storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }
		}
	});
	return { db, sent, store };
}

test('after signing in, every request carries the user\'s token instead of the key', async () => {
	const access = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
	const { db, sent } = client((request) => (request.url.includes('/v1/identity/token') ? { body: tokenBody(access, 'r1') } : { body: [] }));
	const { data, error } = await db.identity.passwordSignIn({ email: 'ada@example.com', password: 'pw' });
	assert.equal(error, null);
	assert.equal(data.user?.id, 'u1');
	assert.equal(new URL(sent[0].url).searchParams.get('grant_type'), 'password');
	await db.from('todos').select();
	assert.equal(sent[1].headers.authorization, `Bearer ${access}`);
	assert.equal(sent[1].headers.apikey, 'app-key');
});

test('a sign-up that needs confirming returns the user and no session', async () => {
	const { db } = client(() => ({ body: { id: 'u2', email: 'bob@example.com', confirmation_sent_at: 'now' } }));
	const { data, error } = await db.identity.register({ email: 'bob@example.com', password: 'pw' });
	assert.equal(error, null);
	assert.equal(data.session, null);
	assert.equal(data.user?.id, 'u2');
});

test('a guest sign-in posts its metadata from options.data, or a bare data, and keeps the session', async () => {
	const access = jwt({ sub: 'g1', is_anonymous: true, exp: Math.floor(Date.now() / 1000) + 3600 });
	const { db, sent } = client(() => ({ body: tokenBody(access, 'r1') }));
	const { data, error } = await db.identity.guestSignIn({ options: { data: { name: 'Sleepy Otter' } } });
	assert.equal(error, null);
	assert.equal(data.session?.access_token, access);
	assert.ok(sent[0].url.endsWith('/v1/identity/register'));
	assert.deepEqual(JSON.parse(String(sent[0].body)), { data: { name: 'Sleepy Otter' } });
	await db.identity.guestSignIn({ data: { name: 'Fuzzy Llama' } });
	assert.deepEqual(JSON.parse(String(sent[1].body)), { data: { name: 'Fuzzy Llama' } });
	await db.identity.guestSignIn();
	assert.deepEqual(JSON.parse(String(sent[2].body)), { data: {} });
});

test('a refused sign-in is an AuthError with the server\'s sentence and code', async () => {
	const { db } = client(() => ({ status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }));
	const { data, error } = await db.identity.passwordSignIn({ email: 'a@b.c', password: 'no' });
	assert.equal(data.session, null);
	assert.equal(error?.message, 'Invalid login credentials');
	assert.equal(error?.code, 'invalid_credentials');
	assert.equal(error?.status, 400);
});

test('an expired stored session is refreshed before it is used, once for concurrent callers', async () => {
	const store = new Map<string, string>();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('old', 'r1'), expires_at: Math.floor(Date.now() / 1000) - 10 }));
	let refreshes = 0;
	const { db, sent } = client((request) => {
		if (request.url.includes('grant_type=refresh_token')) {
			refreshes += 1;
			return { body: tokenBody('fresh', 'r2') };
		}
		return { body: [] };
	}, store);
	await Promise.all([db.from('a').select(), db.from('b').select()]);
	assert.equal(refreshes, 1);
	const reads = sent.filter((s) => s.url.includes('/v1/data/'));
	assert.deepEqual(reads.map((s) => s.headers.authorization), ['Bearer fresh', 'Bearer fresh']);
	assert.equal(JSON.parse(store.get('snoutdata-abc123-auth') ?? '{}').refresh_token, 'r2');
});

test('listeners hear the initial session, then sign-in and sign-out', async () => {
	const { db, store } = client((request) => (request.url.includes('/token') ? { body: tokenBody('t', 'r') } : { status: 204 }));
	const events: AuthEvent[] = [];
	db.identity.onSessionChange((event) => events.push(event));
	await db.identity.currentSession();
	await db.identity.passwordSignIn({ email: 'a@b.c', password: 'pw' });
	await db.identity.signOff();
	assert.deepEqual(events, ['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT']);
	assert.equal(store.size, 0);
	assert.equal((await db.identity.currentSession()).data.session, null);
});

test('OAuth builds the authorize URL with a PKCE challenge and keeps the verifier', async () => {
	const { db, store } = client(() => ({ body: {} }));
	const { data } = await db.identity.providerSignIn({ provider: 'github', options: { redirectTo: 'https://app.example.com/cb' } });
	const url = new URL(data.url ?? '');
	assert.equal(url.pathname, '/v1/identity/provider/start');
	assert.equal(url.searchParams.get('provider'), 'github');
	assert.equal(url.searchParams.get('code_challenge_method'), 's256');
	assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43);
	assert.ok(store.get('snoutdata-abc123-auth-code-verifier'));
});

test('admin.deleteUser sends DELETE to the admin route with the key it was made with', async () => {
	const { fetch, sent } = fakeFetch(() => ({ body: {} }));
	const admin = snout(URL_, 'service-key', { vocabulary: 'old', global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
	const { error } = await admin.identity.operator.deleteUser('u1');
	assert.equal(error, null);
	assert.equal(sent[0].method, 'DELETE');
	assert.equal(new URL(sent[0].url).pathname, '/v1/identity/operator/people/u1');
	assert.equal(sent[0].headers.authorization, 'Bearer service-key');
});
