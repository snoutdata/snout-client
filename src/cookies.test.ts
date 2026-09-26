import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cookieStorage, type CookieJar } from './cookies.js';

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

// Written by @supabase/ssr 0.12.6's own stringToBase64URL for this value, so a site moving off
// it reads the sessions its visitors already hold.
const SSR_VALUE = 'base64-eyJhY2Nlc3NfdG9rZW4iOiJ0w7ZrIiwidXNlciI6eyJpZCI6Iua8ovCfmIAifX0';
const SSR_JSON = JSON.stringify({ access_token: 'tök', user: { id: '漢😀' } });

test('reads a session @supabase/ssr wrote, and writes the same bytes it would', () => {
	const cookies = jar();
	cookies.store.set('sb-accounts-auth-token', SSR_VALUE);
	const storage = cookieStorage({}, cookies);
	assert.equal(storage.getItem('sb-accounts-auth-token'), SSR_JSON);
	cookies.store.clear();
	storage.setItem('sb-accounts-auth-token', SSR_JSON);
	assert.equal(cookies.store.get('sb-accounts-auth-token'), SSR_VALUE);
});

test('a long value is split where ssr splits it, and read back whole', () => {
	const cookies = jar();
	const storage = cookieStorage({}, cookies);
	const value = JSON.stringify({ access_token: 'x'.repeat(4000) });
	storage.setItem('k', value);
	// ssr 0.12.6 splits this exact value into 3180 + 2186 characters.
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
