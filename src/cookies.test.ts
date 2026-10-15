/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COOKIE_VALUE_LIMIT, cookieStorage, splitCookieValue, type CookieJar, type CookiePiece } from './cookies.js';

/** A browser's cookie jar, reduced to what matters: names, values, and Max-Age=0 deleting. */
function jar(): CookieJar & { store: Map<string, string>; writes: string[] } {
	const store = new Map<string, string>();
	const writes: string[] = [];
	return {
		store,
		writes,
		get cookie() {
			return [...store].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
		},
		set cookie(line: string) {
			writes.push(line);
			const [pair, ...attributes] = line.split('; ');
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq);
			if (attributes.includes('Max-Age=0')) {
				store.delete(name);
			} else {
				store.set(name, decodeURIComponent(pair.slice(eq + 1)));
			}
		}
	};
}

// A session as the sites already store it: `base64-` and the base64url of its UTF-8 bytes.
const STORED_VALUE = 'base64-eyJhY2Nlc3NfdG9rZW4iOiJ0w7ZrIiwidXNlciI6eyJpZCI6Iua8ovCfmIAifX0';
const STORED_JSON = JSON.stringify({ access_token: 'tök', user: { id: '漢😀' } });

test('reads a stored session, and writes the same bytes back', () => {
	const cookies = jar();
	cookies.store.set('sb-accounts-auth-token', STORED_VALUE);
	const storage = cookieStorage({}, cookies);
	assert.equal(storage.getItem('sb-accounts-auth-token'), STORED_JSON);
	cookies.store.clear();
	storage.setItem('sb-accounts-auth-token', STORED_JSON);
	assert.equal(cookies.store.get('sb-accounts-auth-token'), STORED_VALUE);
});

test('a long value is cut at the limit, and read back whole', () => {
	const cookies = jar();
	const storage = cookieStorage({}, cookies);
	const value = JSON.stringify({ access_token: 'x'.repeat(4000) });
	storage.setItem('k', value);
	assert.deepEqual([...cookies.store].map(([name, v]) => `${name}:${v.length}`), ['k.0:3180', 'k.1:2186']);
	assert.equal(storage.getItem('k'), value);
});

test('a value that shrinks clears the chunks it no longer needs', () => {
	const cookies = jar();
	const storage = cookieStorage({}, cookies);
	storage.setItem('k', JSON.stringify({ t: 'x'.repeat(9000) }));
	assert.ok(cookies.store.has('k.2'));
	storage.setItem('k', JSON.stringify({ t: 'short' }));
	assert.deepEqual([...cookies.store.keys()], ['k']);
	assert.equal(storage.getItem('k'), JSON.stringify({ t: 'short' }));
});

test('at a parent domain, a clear also clears the host-only copy, host-only first', () => {
	const cookies = jar();
	const storage = cookieStorage({ domain: '.snoutdata.com', secure: true }, cookies);
	storage.setItem('k', '{"a":1}');
	assert.match(cookies.writes[0], /^k=base64-[^;]+; Max-Age=34560000; Domain=\.snoutdata\.com; Path=\/; Secure; SameSite=Lax$/);
	cookies.writes.length = 0;
	storage.removeItem('k');
	assert.equal(cookies.writes.length, 2);
	assert.doesNotMatch(cookies.writes[0], /Domain=/);
	assert.match(cookies.writes[1], /Domain=\.snoutdata\.com/);
	assert.equal(storage.getItem('k'), null);
});

test('chunks from two different writes read as absent, not as a corrupt session', () => {
	const cookies = jar();
	cookies.store.set('k.0', 'base64-eyJhIjox');
	cookies.store.set('k.1', 'ZZZZ');
	assert.equal(cookieStorage({}, cookies).getItem('k'), null);
});

test('a value from before base64 encoding is returned as it is', () => {
	const cookies = jar();
	cookies.store.set('k', '{"access_token":"a"}');
	assert.equal(cookieStorage({}, cookies).getItem('k'), '{"access_token":"a"}');
});

test('a PKCE sign-in round-trips through the cookie store: verifier out, code back, session in', async () => {
	const { createClient } = await import('./index.js');
	const { fakeFetch } = await import('./testing.js');
	const cookies = jar();
	const { fetch, sent } = fakeFetch((request) =>
		request.url.includes('/sso')
			? { body: { url: 'https://idp.example.com/login' } }
			: { body: { access_token: 'a1', refresh_token: 'r1', token_type: 'bearer', expires_in: 3600, user: { id: 'u1' } } }
	);
	const options = { global: { fetch }, auth: { storage: cookieStorage({}, cookies), storageKey: 'sb-accounts-auth-token', autoRefreshToken: false, detectSessionInUrl: false } };
	await createClient('https://accounts.snoutdata.com', 'anon', options).auth.signInWithSSO({ domain: 'example.com', options: { skipBrowserRedirect: true } });
	// The page navigates away and comes back: a new client, reading the same cookies.
	const { data, error } = await createClient('https://accounts.snoutdata.com', 'anon', options).auth.exchangeCodeForSession('code-1');
	assert.equal(error, null);
	assert.equal(data.session?.access_token, 'a1');
	assert.ok((JSON.parse(sent.at(-1)?.body ?? '{}').code_verifier ?? '').length >= 43);
	assert.equal(cookies.store.has('sb-accounts-auth-token-code-verifier'), false);
});

/**
 * Fixtures: what the writer this one replaced produced for these values (generated by running it,
 * 2026-10-14), so the cookies already in visitors' browsers keep the shape this writer gives.
 */
const LAID_OUT: { value: string; limit: number; pieces: CookiePiece[] }[] = [
	{ value: "abcdefghijklmnopqrstuvwxyz0123456789", limit: 10, pieces: [{ name: "k.0", value: "abcdefghij" }, { name: "k.1", value: "klmnopqrst" }, { name: "k.2", value: "uvwxyz0123" }, { name: "k.3", value: "456789" }] },
	{ value: "añb漢c😀dé漢😀xyz", limit: 14, pieces: [{ name: "k.0", value: "añb" }, { name: "k.1", value: "漢c" }, { name: "k.2", value: "😀d" }, { name: "k.3", value: "é" }, { name: "k.4", value: "漢" }, { name: "k.5", value: "😀xy" }, { name: "k.6", value: "z" }] },
	{ value: "a b&c=d;e,f/g?h", limit: 7, pieces: [{ name: "k.0", value: "a b" }, { name: "k.1", value: "&c=" }, { name: "k.2", value: "d;e" }, { name: "k.3", value: ",f/" }, { name: "k.4", value: "g?h" }] },
	{ value: "abcdefgh ijklmnop", limit: 10, pieces: [{ name: "k.0", value: "abcdefgh" }, { name: "k.1", value: " ijklmno" }, { name: "k.2", value: "p" }] },
	{ value: "abcdefghi jklmnop", limit: 10, pieces: [{ name: "k.0", value: "abcdefghi" }, { name: "k.1", value: " jklmnop" }] },
	{ value: "abcdefg😀hij😀😀😀", limit: 13, pieces: [{ name: "k.0", value: "abcdefg" }, { name: "k.1", value: "😀h" }, { name: "k.2", value: "ij" }, { name: "k.3", value: "😀" }, { name: "k.4", value: "😀" }, { name: "k.5", value: "😀" }] },
	{ value: "fits", limit: 10, pieces: [{ name: "k", value: "fits" }] },
	{ value: "abcdefghij", limit: 10, pieces: [{ name: "k", value: "abcdefghij" }] }
];

test('lays values out exactly as the cookies already in browsers are laid out', () => {
	for (const fixture of LAID_OUT) {
		assert.deepEqual(splitCookieValue('k', fixture.value, fixture.limit), fixture.pieces, fixture.value);
	}
});

/** A signed-in session, as the previous writer left it in a browser at the default limit. */
const STORED_SESSION = "{\"access_token\":\"eyJabcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019abcXYZ019\",\"refresh_token\":\"r-1\",\"user\":{\"id\":\"u1\",\"email\":\"ada@example.com\",\"name\":\"Zoë 漢 😀\"}}";
const STORED_COOKIES: Record<string, string> = {
	"sb-accounts-auth-token.0": "base64-eyJhY2Nlc3NfdG9rZW4iOiJleUphYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhY",
	"sb-accounts-auth-token.1": "mNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTlhYmNYWVowMTkiLCJyZWZyZXNoX3Rva2VuIjoici0xIiwidXNlciI6eyJpZCI6InUxIiwiZW1haWwiOiJhZGFAZXhhbXBsZS5jb20iLCJuYW1lIjoiWm_DqyDmvKIg8J-YgCJ9fQ"
};

test('reads a chunked session the previous writer stored, and writes the same cookies', () => {
	const cookies = jar();
	for (const [name, value] of Object.entries(STORED_COOKIES)) {
		cookies.store.set(name, value);
	}
	const storage = cookieStorage({}, cookies);
	assert.equal(storage.getItem('sb-accounts-auth-token'), STORED_SESSION);
	cookies.store.clear();
	storage.setItem('sb-accounts-auth-token', STORED_SESSION);
	assert.deepEqual(Object.fromEntries(cookies.store), STORED_COOKIES);
});

/** Every piece fits once encoded, no piece is empty, and the pieces join to the value. */
function assertLaidOut(value: string, limit: number): CookiePiece[] {
	const pieces = splitCookieValue('k', value, limit);
	assert.equal(pieces.map((piece) => piece.value).join(''), value);
	for (const piece of pieces) {
		assert.ok(piece.value.length > 0);
		assert.ok(encodeURIComponent(piece.value).length <= limit, `${piece.name} is over ${limit} encoded`);
	}
	if (pieces.length > 1) {
		assert.deepEqual(pieces.map((piece) => piece.name), pieces.map((_, i) => `k.${i}`));
	}
	return pieces;
}

test('round-trips ASCII, multibyte text and long values through the cookie store', () => {
	// The store holds sessions, which are JSON.
	const values = [
		JSON.stringify('plain ascii, with spaces; and = signs & more'),
		JSON.stringify('Zoë, 漢字, 😀🎉 and a ü'),
		JSON.stringify('😀'.repeat(2000)),
		JSON.stringify({ token: 'tök'.repeat(3000), user: { name: '漢😀'.repeat(500) } })
	];
	for (const value of values) {
		const cookies = jar();
		const storage = cookieStorage({}, cookies);
		storage.setItem('k', value);
		assert.equal(storage.getItem('k'), value);
		for (const stored of cookies.store.values()) {
			assert.ok(encodeURIComponent(stored).length <= COOKIE_VALUE_LIMIT);
		}
	}
	assert.ok(assertLaidOut('😀'.repeat(2000), COOKIE_VALUE_LIMIT).length >= 8);
});

test('never cuts through an escape, wherever the limit falls', () => {
	// A space is `%20` and 'é' is `%C3%A9`: shifting the value by one character at a time puts the
	// limit on every offset of an escape.
	for (let shift = 0; shift < 12; shift += 1) {
		const value = 'a'.repeat(shift) + ' é😀 b'.repeat(40);
		for (const limit of [12, 13, 14, 20, 31]) {
			assertLaidOut(value, limit);
		}
	}
});

test('a value that fits is one cookie named as the key, and a limit too small for a character is refused', () => {
	assert.deepEqual(splitCookieValue('k', 'abc', 12), [{ name: 'k', value: 'abc' }]);
	assert.throws(() => splitCookieValue('k', 'ab😀', 11), RangeError);
});

test('reads numbered pieces up to the first gap, and ignores names that only look like pieces', () => {
	const cookies = jar();
	cookies.store.set('k.01', 'ignored');
	cookies.store.set('k.0', 'base64-eyJh');
	cookies.store.set('k.1', 'Ijox');
	cookies.store.set('k.2', 'fQ');
	cookies.store.set('k.4', 'after a gap');
	const storage = cookieStorage({}, cookies);
	assert.equal(storage.getItem('k'), '{"a":1}');
	storage.removeItem('k');
	assert.deepEqual([...cookies.store.keys()], ['k.01']);
});
