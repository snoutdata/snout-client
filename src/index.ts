/**
 * `@snoutdata/client`: one project's data API, auth, storage, realtime and functions, from
 * its URL and a key.
 *
 *     import { createClient } from '@snoutdata/client'
 *     const db = createClient('https://<ref>.api.snoutdata.com', '<anon key>')
 *
 * Every product lives under that one URL at a fixed prefix (`/rest/v1`, `/auth/v1`,
 * `/storage/v1`, `/realtime/v1`, `/functions/v1`). Every request carries the key as
 * `apikey`, and as `Authorization` the signed-in user's access token, or the key itself when
 * nobody is signed in. Row-level security reads that token, which is why the anon key is
 * safe in a browser: it grants what your policies grant the `anon` role, and nothing else.
 */

import { AuthClient, type AuthOptions } from './auth.js';
import { FunctionsClient } from './functions.js';
import { joinUrl, type Fetch, type Transport } from './http.js';
import { RealtimeClient, type ChannelOptions, type RealtimeChannel, type RealtimeOptions, type SendStatus } from './realtime.js';
import { rpc, TableBuilder, type CountMethod, type QueryBuilder, type Row } from './rest.js';
import { StorageClient } from './storage.js';

export * from './auth.js';
export * from './cookies.js';
export * from './functions.js';
export * from './realtime.js';
export * from './rest.js';
export * from './storage.js';

/**
 * The shape `snoutdata gen types typescript` writes. With it, `from('todos')` knows the
 * table's columns; without it, rows are plain records.
 */
export interface Database {
	[schema: string]: {
		Tables: Record<string, { Row: Row; Insert?: Row; Update?: Row }>;
		Views?: Record<string, { Row: Row }>;
		Functions?: Record<string, { Args: Row; Returns: unknown }>;
	};
}

type Schema<DB, S extends string> = DB extends Database ? DB[S] : never;
type Relations<DB, S extends string> = Schema<DB, S> extends never
	? Record<string, { Row: Row }>
	: Schema<DB, S>['Tables'] & NonNullable<Schema<DB, S>['Views']>;
type RelationName<DB, S extends string> = Extract<keyof Relations<DB, S>, string>;
type RowOf<DB, S extends string, N extends string> = N extends keyof Relations<DB, S>
	? Relations<DB, S>[N] extends { Row: infer R }
		? R
		: Row
	: Row;

export interface ClientOptions<S extends string> {
	db?: { schema?: S };
	auth?: AuthOptions;
	realtime?: RealtimeOptions;
	global?: {
		headers?: Record<string, string>;
		fetch?: Fetch;
	};
}

export class SnoutClient<DB = Database, S extends string = 'public'> {
	readonly url: string;
	readonly restUrl: string;
	readonly authUrl: string;
	readonly storageUrl: string;
	readonly functionsUrl: string;
	readonly realtimeUrl: string;
	readonly auth: AuthClient;
	readonly storage: StorageClient;
	readonly functions: FunctionsClient;
	readonly realtime: RealtimeClient;
	/** The data API's base, for code that checks where it points. */
	readonly rest: { url: string };
	private readonly transport: Transport;
	private readonly schemaName: string | undefined;

	constructor(url: string, key: string, options: ClientOptions<S> = {}) {
		if (!url) {
			throw new Error('createClient needs the project URL, https://<ref>.api.snoutdata.com');
		}
		if (!key) {
			throw new Error('createClient needs a key: the anon key in a browser, the service key on a server');
		}
		const base = new URL(url).toString().replace(/\/+$/, '');
		this.url = base;
		this.restUrl = joinUrl(base, 'rest/v1');
		this.authUrl = joinUrl(base, 'auth/v1');
		this.storageUrl = joinUrl(base, 'storage/v1');
		this.functionsUrl = joinUrl(base, 'functions/v1');
		this.realtimeUrl = joinUrl(base.replace(/^http/, 'ws'), 'realtime/v1');
		this.rest = { url: this.restUrl };
		this.schemaName = options.db?.schema;

		const fetchImpl: Fetch = options.global?.fetch ?? ((...args) => fetch(...args));
		const globalHeaders = { 'X-Client-Info': 'snoutdata-js/0.2.1', ...options.global?.headers };
		const ref = new URL(base).hostname.split('.')[0];
		this.auth = new AuthClient(this.authUrl, key, fetchImpl, globalHeaders, ref, options.auth);

		// A caller who set Authorization themselves (a server acting as a known user) keeps it.
		const fixedBearer = Object.keys(globalHeaders).some((name) => name.toLowerCase() === 'authorization');
		this.transport = {
			fetch: fetchImpl,
			headers: async () => ({
				...globalHeaders,
				apikey: key,
				...(fixedBearer ? {} : { Authorization: `Bearer ${await this.auth.getAccessToken()}` })
			})
		};

		this.storage = new StorageClient(this.storageUrl, this.transport);
		this.functions = new FunctionsClient(this.functionsUrl, this.transport);
		this.realtime = new RealtimeClient(this.realtimeUrl, key, this.transport, () => this.auth.getAccessToken(), options.realtime);

		this.auth.onAuthStateChange((event, session) => {
			if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
				this.realtime.setAuth(session?.access_token ?? null);
			}
		});
	}

	/** A table or view. Awaiting the builder it returns sends the request. */
	from<N extends RelationName<DB, S>>(relation: N): TableBuilder<RowOf<DB, S, N>> {
		return new TableBuilder(this.transport, joinUrl(this.restUrl, encodeURIComponent(relation)), this.schemaName);
	}

	/** The same client, pointed at another schema (which must be exposed to the data API). */
	schema<T extends string>(name: T): SnoutClient<DB, T> {
		const view = Object.create(this) as SnoutClient<DB, T>;
		Object.defineProperty(view, 'schemaName', { value: name });
		return view;
	}

	/** Calls a Postgres function. Filters and modifiers apply to what it returns: `any` unless typed, as in supabase-js. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rpc<T = any>(fn: string, args: Record<string, unknown> = {}, options: { head?: boolean; get?: boolean; count?: CountMethod } = {}): QueryBuilder<T> {
		return rpc<T>(this.transport, this.restUrl, this.schemaName, fn, args, options);
	}

	/** A realtime channel. Nothing is sent until `subscribe()`. */
	channel(name: string, options: ChannelOptions = {}): RealtimeChannel {
		return this.realtime.channel(name, options);
	}

	getChannels(): RealtimeChannel[] {
		return this.realtime.getChannels();
	}

	removeChannel(channel: RealtimeChannel): Promise<SendStatus> {
		return this.realtime.removeChannel(channel);
	}

	removeAllChannels(): Promise<SendStatus[]> {
		return this.realtime.removeAllChannels();
	}
}

export function createClient<DB = Database, S extends string = 'public'>(url: string, key: string, options: ClientOptions<S> = {}): SnoutClient<DB, S> {
	return new SnoutClient<DB, S>(url, key, options);
}
