import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient } from './index.js';
import { fakeFetch, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function client(answer: (request: Sent) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
	const { fetch, sent } = fakeFetch(answer);
	const db = createClient(URL_, 'anon-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
	return { db, sent };
}

test('upload posts the bytes to the object path with its type and upsert flag', async () => {
	const { db, sent } = client(() => ({ body: { Id: 'o1', Key: 'documents/invoices/7 a.pdf' } }));
	const { data, error } = await db.storage.from('documents').upload('invoices/7 a.pdf', 'pdf-bytes', { contentType: 'application/pdf', upsert: true });
	assert.equal(error, null);
	assert.deepEqual(data, { id: 'o1', path: 'invoices/7 a.pdf', fullPath: 'documents/invoices/7 a.pdf' });
	assert.equal(new URL(sent[0].url).pathname, '/storage/v1/object/documents/invoices/7%20a.pdf');
	assert.equal(sent[0].method, 'POST');
	assert.equal(sent[0].headers['content-type'], 'application/pdf');
	assert.equal(sent[0].headers['x-upsert'], 'true');
});

test('a signed URL comes back absolute, with download when asked', async () => {
	const { db } = client(() => ({ body: { signedURL: '/object/sign/documents/a.pdf?token=t1' } }));
	const { data } = await db.storage.from('documents').createSignedUrl('a.pdf', 60, { download: 'invoice.pdf' });
	const url = new URL(data?.signedUrl ?? '');
	assert.equal(url.origin + url.pathname, `${URL_}/storage/v1/object/sign/documents/a.pdf`);
	assert.equal(url.searchParams.get('token'), 't1');
	assert.equal(url.searchParams.get('download'), 'invoice.pdf');
});

test('getPublicUrl builds the public or render URL and sends nothing', () => {
	const { db, sent } = client(() => ({}));
	assert.equal(db.storage.from('avatars').getPublicUrl('ada.png').data.publicUrl, `${URL_}/storage/v1/object/public/avatars/ada.png`);
	assert.equal(
		db.storage.from('avatars').getPublicUrl('ada.png', { transform: { width: 64, height: 64 } }).data.publicUrl,
		`${URL_}/storage/v1/render/image/public/avatars/ada.png?width=64&height=64`
	);
	assert.equal(sent.length, 0);
});

test('a storage refusal is an error with the status the server gave', async () => {
	const { db } = client(() => ({ status: 400, body: { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' } }));
	const { data, error } = await db.storage.from('documents').remove(['a.pdf']);
	assert.equal(data, null);
	assert.equal(error?.status, 403);
	assert.match(error?.message ?? '', /row-level security/);
});

test('functions.invoke sends JSON and decodes the answer by its type', async () => {
	const { db, sent } = client(() => ({ body: { echoed: true } }));
	const { data, error } = await db.functions.invoke('echo', { body: { run: 1 } });
	assert.equal(error, null);
	assert.deepEqual(data, { echoed: true });
	assert.equal(new URL(sent[0].url).pathname, '/functions/v1/echo');
	assert.equal(sent[0].headers['content-type'], 'application/json');
});

test('a function that answers 500 is an HTTP error whose response can still be read', async () => {
	const { db } = client(() => ({ status: 500, body: { reason: 'boom' } }));
	const { error } = await db.functions.invoke('echo');
	assert.equal(error?.name, 'FunctionsHttpError');
	assert.deepEqual(await error?.context?.json(), { reason: 'boom' });
});

test('a redirect to another origin is followed without the key or the bearer', async () => {
	const { db, sent } = client((request) =>
		request.url.startsWith(URL_) ? { status: 307, body: '', headers: { location: 'https://evil.example/steal' } } : { body: { ok: true } }
	);
	const { data, error } = await db.functions.invoke('x', { body: { a: 1 } });
	assert.equal(error, null);
	assert.deepEqual(data, { ok: true });
	assert.equal(sent.length, 2);
	assert.equal(sent[0].headers.apikey, 'anon-key');
	assert.equal(sent[1].url, 'https://evil.example/steal');
	assert.equal(sent[1].method, 'POST');
	assert.equal(sent[1].headers.apikey, undefined);
	assert.equal(sent[1].headers.authorization, undefined);
	assert.equal(sent[1].body, '{"a":1}');
});

test('a redirect within the project keeps the key, and a 303 becomes a GET', async () => {
	const { db, sent } = client((request) =>
		request.url.endsWith('/functions/v1/x') ? { status: 303, body: '', headers: { location: '/functions/v1/y' } } : { body: { ok: true } }
	);
	const { error } = await db.functions.invoke('x', { body: { a: 1 } });
	assert.equal(error, null);
	assert.equal(sent[1].url, `${URL_}/functions/v1/y`);
	assert.equal(sent[1].method, 'GET');
	assert.equal(sent[1].body, undefined);
	assert.equal(sent[1].headers.apikey, 'anon-key');
});

test('a storage download redirected to a presigned URL reaches it without the key', async () => {
	const { db, sent } = client((request) =>
		request.url.startsWith(URL_) ? { status: 302, body: '', headers: { location: 'https://bucket.r2.example/obj?sig=1' } } : { body: 'bytes' }
	);
	const { error } = await db.storage.from('docs').download('a.txt');
	assert.equal(error, null);
	assert.equal(sent[1].url, 'https://bucket.r2.example/obj?sig=1');
	assert.equal(sent[1].headers.apikey, undefined);
});

test('a "." or ".." path segment is refused, encoded or not, before anything is sent', async () => {
	const { db, sent } = client(() => ({ body: {} }));
	await assert.rejects(async () => db.storage.from('docs').download('../../../rest/v1/rpc/f'), /may not contain/);
	await assert.rejects(async () => db.storage.from('docs').upload('a/%2e%2e/b', 'x'), /may not contain/);
	await assert.rejects(async () => db.storage.from('..').list(), /may not contain/);
	assert.throws(() => db.from('..'), /may not contain/);
	assert.throws(() => db.rpc('.'), /may not contain/);
	const { error } = await db.functions.invoke('../../rest/v1/rpc/f');
	assert.match(error?.message ?? '', /may not contain/);
	assert.equal(sent.length, 0);
	// A dot inside a name is still a name.
	await db.storage.from('docs').download('a/..b/.c');
	assert.equal(new URL(sent[0].url).pathname, '/storage/v1/object/docs/a/..b/.c');
});
