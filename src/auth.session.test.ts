/**
 * The auth half our own apps lean on: SSO, ID-token sign-in, pausing the refresh, a session
 * shared through storage with another tab, origin or app instance, and reading what
 * supabase-js wrote (a desktop app updated from a supabase-js build keeps its sign-in, and one
 * rolled back still reads what this client saved).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient, type AuthEvent } from './index.js';
import { fakeFetch, jwt, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function tokenBody(accessToken: string, refreshToken: string, expiresIn = 3600) {
	return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: expiresIn, user: { id: 'u1', email: 'ada@example.com' } };
}

function mapStorage(store: Map<string, string>) {
	return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
}

function client(answer: (request: Sent) => { status?: number; body?: unknown }, storage?: Map<string, string>) {
	const { fetch, sent } = fakeFetch(answer);
	const store = storage ?? new Map<string, string>();
	const db = createClient(URL_, 'anon-key', { global: { fetch }, auth: { autoRefreshToken: false, detectSessionInUrl: false, storage: mapStorage(store) } });
	return { db, sent, store };
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

test('SSO asks the server for the IdP URL by domain, with a PKCE challenge, and keeps the verifier', async () => {
	const { db, sent, store } = client(() => ({ body: { url: 'https://idp.example.com/saml?x=1' } }));
	const { data, error } = await db.auth.signInWithSSO({ domain: 'example.com', options: { redirectTo: 'https://app.example.com/cb', skipBrowserRedirect: true } });
	assert.equal(error, null);
	assert.equal(data.url, 'https://idp.example.com/saml?x=1');
	assert.equal(new URL(sent[0].url).pathname, '/auth/v1/sso');
	const body = JSON.parse(sent[0].body ?? '{}');
	assert.equal(body.domain, 'example.com');
	assert.equal(body.skip_http_redirect, true);
	assert.equal(body.redirect_to, 'https://app.example.com/cb');
	assert.equal(body.code_challenge_method, 's256');
	assert.ok(store.get('snoutdata-abc123-auth-code-verifier'));
});

test('SSO that the server refuses drops the verifier it stored', async () => {
	const { db, store } = client(() => ({ status: 404, body: { error_code: 'sso_provider_not_found', msg: 'No SSO provider assigned for this domain' } }));
	const { data, error } = await db.auth.signInWithSSO({ providerId: 'p1', options: { skipBrowserRedirect: true } });
	assert.equal(data.url, null);
	assert.equal(error?.code, 'sso_provider_not_found');
	assert.equal(store.get('snoutdata-abc123-auth-code-verifier'), undefined);
});

test('an ID token is exchanged at grant_type=id_token and becomes the session', async () => {
	const access = jwt({ sub: 'u1', exp: inAnHour() });
	const { db, sent } = client(() => ({ body: tokenBody(access, 'r1') }));
	const { data, error } = await db.auth.signInWithIdToken({ provider: 'google', token: 'google-id-token', nonce: 'n1' });
	assert.equal(error, null);
	assert.equal(data.session?.access_token, access);
	assert.equal(new URL(sent[0].url).searchParams.get('grant_type'), 'id_token');
	const body = JSON.parse(sent[0].body ?? '{}');
	assert.equal(body.provider, 'google');
	assert.equal(body.id_token, 'google-id-token');
	assert.equal(body.nonce, 'n1');
});

test('getUser() with no session asks about the bearer the client was made with', async () => {
	const { fetch, sent } = fakeFetch(() => ({ body: { id: 'u9' } }));
	const asUser = createClient(URL_, 'anon-key', { global: { fetch, headers: { Authorization: 'Bearer user-jwt' } }, auth: { persistSession: false, autoRefreshToken: false } });
	const { data, error } = await asUser.auth.getUser();
	assert.equal(error, null);
	assert.equal(data.user?.id, 'u9');
	assert.equal(sent[0].headers.authorization, 'Bearer user-jwt');
});

test('a session another holder refreshed in shared storage is adopted, not refreshed again', async () => {
	const store = new Map<string, string>();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a1', 'r1'), expires_at: inAnHour() }));
	const { db, sent } = client(() => ({ body: [] }), store);
	const events: AuthEvent[] = [];
	db.auth.onAuthStateChange((event) => events.push(event));
	await db.auth.getSession();
	// Another tab, origin or app instance rotated it.
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a2', 'r2'), expires_at: inAnHour() }));
	await db.from('t').select();
	assert.equal(sent.at(-1)?.headers.authorization, 'Bearer a2');
	assert.equal(sent.filter((s) => s.url.includes('/token')).length, 0);
	assert.deepEqual(events, ['INITIAL_SESSION', 'TOKEN_REFRESHED']);
});

test('a refresh presents the token storage holds now, never the spent one in memory', async () => {
	const store = new Map<string, string>();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a1', 'r1'), expires_at: inAnHour() }));
	const { db, sent } = client((request) => (request.url.includes('refresh_token') ? { body: tokenBody('a3', 'r3') } : { body: [] }), store);
	await db.auth.getSession();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a2', 'r2'), expires_at: Math.floor(Date.now() / 1000) - 10 }));
	await db.auth.refreshSession();
	const refresh = sent.find((s) => s.url.includes('refresh_token'));
	assert.equal(JSON.parse(refresh?.body ?? '{}').refresh_token, 'r2');
});

test('a session removed from shared storage signs this client out too', async () => {
	const store = new Map<string, string>();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a1', 'r1'), expires_at: inAnHour() }));
	const { db } = client(() => ({ body: [] }), store);
	await db.auth.getSession();
	store.delete('snoutdata-abc123-auth');
	assert.equal((await db.auth.getSession()).data.session, null);
});

test('a session supabase-js saved (an older desktop, the same key) is used as it is', async () => {
	const store = new Map<string, string>();
	const access = jwt({ sub: 'u1', exp: inAnHour() });
	// The exact shape supabase-js 2.x persists: its Session, JSON-encoded, under the storageKey.
	store.set(
		'positron-db-auth',
		JSON.stringify({
			access_token: access,
			token_type: 'bearer',
			expires_in: 3600,
			expires_at: inAnHour(),
			refresh_token: 'r1',
			user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'ada@example.com', app_metadata: { provider: 'google' }, user_metadata: {}, identities: [] },
			weak_password: null
		})
	);
	const { fetch, sent } = fakeFetch(() => ({ body: [] }));
	const db = createClient(URL_, 'anon-key', {
		global: { fetch },
		auth: { autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'positron-db-auth', storage: mapStorage(store) }
	});
	const { data } = await db.auth.getSession();
	assert.equal(data.session?.user.id, 'u1');
	await db.from('profiles').select();
	assert.equal(sent[0].headers.authorization, `Bearer ${access}`);
	assert.ok(store.has('positron-db-auth'));
});

test('what a refresh saves carries every field supabase-js needs to read it back (a rollback)', async () => {
	const store = new Map<string, string>();
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('old', 'r1'), expires_at: Math.floor(Date.now() / 1000) - 10 }));
	const { db } = client(() => ({ body: tokenBody('new', 'r2') }), store);
	await db.auth.getSession();
	const saved = JSON.parse(store.get('snoutdata-abc123-auth') ?? '{}');
	for (const field of ['access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type', 'user']) {
		assert.ok(saved[field] !== undefined, field);
	}
	assert.equal(saved.refresh_token, 'r2');
	assert.equal(typeof saved.expires_at, 'number');
});

test('a PKCE verifier supabase-js stored (JSON, with a recovery suffix) still finishes the sign-in', async () => {
	const access = jwt({ sub: 'u1', exp: inAnHour() });
	const { db, sent, store } = client(() => ({ body: tokenBody(access, 'r1') }));
	store.set('snoutdata-abc123-auth-code-verifier', JSON.stringify('the-verifier/PASSWORD_RECOVERY'));
	const { error } = await db.auth.exchangeCodeForSession('code-1');
	assert.equal(error, null);
	assert.equal(JSON.parse(sent[0].body ?? '{}').code_verifier, 'the-verifier');
});

test('stopAutoRefresh holds a due refresh until startAutoRefresh, and debug says why a session ended', async () => {
	const store = new Map<string, string>();
	const lines: string[] = [];
	store.set('snoutdata-abc123-auth', JSON.stringify({ ...tokenBody('a1', 'r1'), expires_at: Math.floor(Date.now() / 1000) + 61 }));
	const { fetch, sent } = fakeFetch(() => ({ status: 400, body: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } }));
	const db = createClient(URL_, 'anon-key', {
		global: { fetch },
		auth: { autoRefreshToken: true, detectSessionInUrl: false, debug: (...parts) => lines.push(parts.join(' ')), storage: mapStorage(store) }
	});
	await db.auth.getSession();
	db.auth.stopAutoRefresh();
	// Due in about a second. Paused, it must not go.
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(sent.length, 0);
	await db.auth.startAutoRefresh();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(sent.filter((s) => s.url.includes('refresh_token')).length, 1);
	assert.ok(lines.some((line) => /refresh refused \(400 refresh_token_not_found/.test(line)));
	assert.ok(lines.every((line) => !line.includes('a1') && !line.includes('r1')));
	db.auth.stopAutoRefresh();
});
