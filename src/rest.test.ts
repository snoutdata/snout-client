import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient } from './index.js';
import { fakeFetch } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function client(answer?: Parameters<typeof fakeFetch>[0]) {
	const { fetch, sent } = fakeFetch(answer);
	const db = createClient(URL_, 'anon-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
	return { db, sent };
}

test('the five prefixes come from one URL', () => {
	const { db } = client();
	assert.equal(db.restUrl, `${URL_}/rest/v1`);
	assert.equal(db.rest.url, `${URL_}/rest/v1`);
	assert.equal(db.authUrl, `${URL_}/auth/v1`);
	assert.equal(db.storageUrl, `${URL_}/storage/v1`);
	assert.equal(db.functionsUrl, `${URL_}/functions/v1`);
	assert.equal(db.realtimeUrl, 'wss://abc123.api.snoutdata.com/realtime/v1');
});

test('a select sends the key twice and the filters in PostgREST syntax', async () => {
	const { db, sent } = client(() => ({ body: [{ id: 1 }] }));
	const { data, error } = await db
		.from('todos')
		.select('id, note')
		.eq('done', false)
		.in('tag', ['a', 'b,c'])
		.order('id', { ascending: false })
		.limit(5);
	assert.equal(error, null);
	assert.deepEqual(data, [{ id: 1 }]);
	const url = new URL(sent[0].url);
	assert.equal(url.pathname, '/rest/v1/todos');
	assert.equal(url.searchParams.get('select'), 'id,note');
	assert.equal(url.searchParams.get('done'), 'eq.false');
	assert.equal(url.searchParams.get('tag'), 'in.(a,"b,c")');
	assert.equal(url.searchParams.get('order'), 'id.desc');
	assert.equal(url.searchParams.get('limit'), '5');
	assert.equal(sent[0].headers.apikey, 'anon-key');
	assert.equal(sent[0].headers.authorization, 'Bearer anon-key');
});

test('nothing is sent until the builder is awaited', async () => {
	const { db, sent } = client();
	const query = db.from('todos').select().eq('id', 1);
	assert.equal(sent.length, 0);
	await query;
	assert.equal(sent.length, 1);
});

test('insert then select asks for the rows back, single asks for an object', async () => {
	const { db, sent } = client(() => ({ status: 201, body: { id: 9, note: 'x' } }));
	const { data } = await db.from('todos').insert({ note: 'x' }).select().single();
	assert.deepEqual(data, { id: 9, note: 'x' });
	assert.equal(sent[0].method, 'POST');
	assert.equal(sent[0].body, '{"note":"x"}');
	assert.equal(sent[0].headers.prefer, 'return=representation');
	assert.equal(sent[0].headers.accept, 'application/vnd.pgrst.object+json');
});

test('upsert names its conflict target and resolution; a bulk write names its columns', async () => {
	const { db, sent } = client(() => ({ status: 201 }));
	await db.from('todos').upsert([{ id: 1 }, { id: 2, note: 'n' }], { onConflict: 'id', count: 'exact' });
	const url = new URL(sent[0].url);
	assert.equal(url.searchParams.get('on_conflict'), 'id');
	assert.equal(url.searchParams.get('columns'), '"id","note"');
	assert.equal(sent[0].headers.prefer, 'resolution=merge-duplicates,count=exact');
});

test('a refusal is an error value carrying PostgREST\'s code, not a throw', async () => {
	const { db } = client(() => ({ status: 403, body: { code: '42501', message: 'permission denied for table todos', details: null, hint: null } }));
	const { data, error, status } = await db.from('todos').delete().eq('id', 1);
	assert.equal(data, null);
	assert.equal(status, 403);
	assert.equal(error?.code, '42501');
	assert.match(error?.message ?? '', /permission denied/);
});

test('throwOnError throws the same error', async () => {
	const { db } = client(() => ({ status: 400, body: { code: 'PGRST100', message: 'bad filter' } }));
	await assert.rejects(async () => await db.from('todos').select().throwOnError(), /bad filter/);
});

test('maybeSingle is null on no rows and an error on two', async () => {
	let rows: unknown[] = [];
	const { db } = client(() => ({ body: rows }));
	assert.deepEqual((await db.from('todos').select().maybeSingle()).data, null);
	rows = [{ id: 1 }, { id: 2 }];
	assert.equal((await db.from('todos').select().maybeSingle()).error?.code, 'PGRST116');
});

test('count comes from Content-Range, and head sends no body back', async () => {
	const { db, sent } = client(() => ({ headers: { 'content-range': '0-0/42' } }));
	const { count } = await db.from('todos').select('*', { count: 'exact', head: true });
	assert.equal(count, 42);
	assert.equal(sent[0].method, 'HEAD');
	assert.equal(sent[0].headers.prefer, 'count=exact');
});

test('another schema is named in the profile header', async () => {
	const { db, sent } = client();
	await db.schema('billing').from('invoices').select();
	await db.schema('billing').from('invoices').insert({ id: 1 });
	assert.equal(sent[0].headers['accept-profile'], 'billing');
	assert.equal(sent[1].headers['content-profile'], 'billing');
});

test('rpc posts its arguments, or puts them in the URL for get', async () => {
	const { db, sent } = client(() => ({ body: 3 }));
	const { data } = await db.rpc('add', { a: 1, b: 2 });
	assert.equal(data, 3);
	assert.equal(new URL(sent[0].url).pathname, '/rest/v1/rpc/add');
	assert.equal(sent[0].body, '{"a":1,"b":2}');
	await db.rpc('add', { a: 1 }, { get: true });
	assert.equal(new URL(sent[1].url).searchParams.get('a'), '1');
});

test('or, not, contains and text search encode as PostgREST expects', () => {
	const { db } = client();
	const url = new URL(
		db.from('t').select().or('a.eq.1,b.gt.2').not('c', 'is', null).contains('tags', ['x', 'y']).textSearch('body', 'cat & dog', { type: 'websearch', config: 'english' }).toUrl()
	);
	assert.equal(url.searchParams.get('or'), '(a.eq.1,b.gt.2)');
	assert.equal(url.searchParams.get('c'), 'not.is.null');
	assert.equal(url.searchParams.get('tags'), 'cs.{x,y}');
	assert.equal(url.searchParams.get('body'), 'wfts(english).cat & dog');
});

// These two are about TYPES, so what they assert is that this file compiles: an app written
// against supabase-js moves over by changing its import (untyped rows are `any`, as there), and a
// write followed by select() gives the table's rows, never `null`.
test('untyped rows read like supabase-js, and insert().select() returns rows, not null', async () => {
	const { db } = client(() => ({ body: [{ id: 7, name: 'ada' }] }));
	const read = await db.from('people').select('id, name');
	const names: string[] = (read.data ?? []).map((row: { name: string }) => row.name);
	assert.deepEqual(names, ['ada']);

	interface Db {
		public: { Tables: { people: { Row: { id: number; name: string } } } };
	}
	const typed = createClient<Db>(URL_, 'anon-key', { global: { fetch: fakeFetch(() => ({ body: { id: 7, name: 'ada' } })).fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
	const { data } = await typed.from('people').insert({ name: 'ada' }).select().single();
	const id: number | undefined = data?.id;
	assert.equal(id, 7);
});
