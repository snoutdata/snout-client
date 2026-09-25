/**
 * Realtime: one websocket at `/realtime/v1`, carrying broadcast, presence and table changes.
 *
 * The wire is Phoenix channels (protocol 1.0.0): every frame is JSON
 * `{ topic, event, payload, ref, join_ref }`. A channel named `room:42` is the topic
 * `realtime:room:42`; it is joined with a `phx_join` whose payload says what it wants
 * (broadcast options, a presence key, which table changes), answered by a `phx_reply`
 * carrying the same `ref`. The socket is kept alive by a `heartbeat` on the `phoenix` topic
 * every 25 seconds, and when it drops it is reopened and every channel that was joined is
 * joined again, so a subscriber survives a network blip without writing any code for it.
 *
 * The socket opens on the first `subscribe()`, not before: a page that never subscribes
 * never holds a connection.
 */

import { joinUrl, type Transport } from './http.js';

export type ChannelState = 'closed' | 'joining' | 'joined' | 'leaving' | 'errored';

export type SubscribeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export type SendStatus = 'ok' | 'error' | 'timed out';

export interface ChannelOptions {
	config?: {
		/** `self`: hear your own broadcasts. `ack`: `send()` waits for the server to confirm. */
		broadcast?: { self?: boolean; ack?: boolean; replay?: { since: number; limit?: number } };
		/** The key this client is tracked under. A random one when omitted. */
		presence?: { key?: string; enabled?: boolean };
		/** Authorised by RLS on `realtime.messages` rather than open to anyone with the key. */
		private?: boolean;
	};
}

export interface PostgresChangesFilter {
	event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
	schema: string;
	table?: string;
	/** One condition in PostgREST syntax, `id=eq.7`. */
	filter?: string;
}

export interface PostgresChangesPayload<T = Record<string, unknown>> {
	schema: string;
	table: string;
	commit_timestamp: string;
	eventType: 'INSERT' | 'UPDATE' | 'DELETE';
	/** The row after the change; `{}` for a delete. */
	new: Partial<T>;
	/** The row before it: the primary key only, unless the table is REPLICA IDENTITY FULL. */
	old: Partial<T>;
	errors: string[] | null;
}

export interface BroadcastMessage<T = Record<string, unknown>> {
	type: 'broadcast';
	event: string;
	payload: T;
}

export type Presence<T = Record<string, unknown>> = T & { presence_ref: string };

export interface PresenceJoin<T = Record<string, unknown>> {
	event: 'join';
	key: string;
	currentPresences: Presence<T>[];
	newPresences: Presence<T>[];
}

export interface PresenceLeave<T = Record<string, unknown>> {
	event: 'leave';
	key: string;
	currentPresences: Presence<T>[];
	leftPresences: Presence<T>[];
}

interface Frame {
	topic: string;
	event: string;
	payload: Record<string, unknown>;
	ref: string | null;
	join_ref?: string | null;
}

interface Binding {
	type: string;
	filter: Record<string, unknown>;
	callback: (payload: never) => void;
	/** The id the server gave a postgres_changes subscription in its join reply. */
	id?: number;
}

type Reply = { status: string; response: Record<string, unknown> };

export interface RealtimeOptions {
	/** A WebSocket constructor, where the platform has none. Node 22 and every browser do. */
	transport?: typeof WebSocket;
	heartbeatIntervalMs?: number;
	/** How long a join, leave or acknowledged send may wait for its reply. */
	timeoutMs?: number;
	params?: Record<string, string>;
}

const PROTOCOL = '1.0.0';
const BACKOFF = [1000, 2000, 5000, 10000];

function backoff(tries: number): number {
	return BACKOFF[Math.min(tries, BACKOFF.length - 1)];
}

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => void }).unref?.();
}

export class RealtimeClient {
	/** The `wss://` URL, for inspection. */
	readonly url: string;
	private readonly key: string;
	private readonly options: RealtimeOptions;
	private readonly transport: Transport;
	private readonly httpUrl: string;
	private readonly tokenSource: () => Promise<string>;
	private socket: WebSocket | null = null;
	private readonly channels = new Set<RealtimeChannel>();
	private readonly pending = new Map<string, { resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> }>();
	private buffer: string[] = [];
	private ref = 0;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private heartbeatRef: string | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTries = 0;
	private closedByUs = false;
	/** @internal */ accessToken: string | null = null;

	constructor(url: string, key: string, transport: Transport, tokenSource: () => Promise<string>, options: RealtimeOptions = {}) {
		this.url = url;
		this.httpUrl = url.replace(/^ws/, 'http');
		this.key = key;
		this.transport = transport;
		this.tokenSource = tokenSource;
		this.options = options;
	}

	/** @internal */
	get timeoutMs(): number {
		return this.options.timeoutMs ?? 10_000;
	}

	/** @internal */
	nextRef(): string {
		this.ref += 1;
		return String(this.ref);
	}

	channel(name: string, options: ChannelOptions = {}): RealtimeChannel {
		const channel = new RealtimeChannel(name, options, this);
		this.channels.add(channel);
		return channel;
	}

	getChannels(): RealtimeChannel[] {
		return [...this.channels];
	}

	async removeChannel(channel: RealtimeChannel): Promise<SendStatus> {
		const status = await channel.unsubscribe();
		this.channels.delete(channel);
		if (this.channels.size === 0) {
			this.disconnect();
		}
		return status;
	}

	async removeAllChannels(): Promise<SendStatus[]> {
		const statuses = await Promise.all([...this.channels].map((channel) => channel.unsubscribe()));
		this.channels.clear();
		this.disconnect();
		return statuses;
	}

	isConnected(): boolean {
		return this.socket?.readyState === 1;
	}

	/** Re-authorise every joined channel with a new access token, after a sign-in or refresh. */
	setAuth(token: string | null): void {
		const next = token ?? this.key;
		if (next === this.accessToken) {
			return;
		}
		this.accessToken = next;
		for (const channel of this.channels) {
			if (channel.state === 'joined') {
				this.push({ topic: channel.topic, event: 'access_token', payload: { access_token: next }, ref: this.nextRef(), join_ref: channel.joinRef });
			}
		}
	}

	/** @internal */
	async token(): Promise<string> {
		this.accessToken = await this.tokenSource();
		return this.accessToken;
	}

	/** @internal Opens the socket if it is not open or opening. */
	connect(): void {
		if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
			return;
		}
		const Socket = this.options.transport ?? globalThis.WebSocket;
		if (typeof Socket !== 'function') {
			throw new Error('This platform has no WebSocket. Pass one as `realtime.transport`.');
		}
		this.closedByUs = false;
		const params = new URLSearchParams({ ...this.options.params, apikey: this.key, vsn: PROTOCOL });
		const socket = new Socket(`${joinUrl(this.url, 'websocket')}?${params}`);
		this.socket = socket;
		socket.onopen = () => this.opened();
		socket.onmessage = (event: MessageEvent) => this.received(event.data);
		socket.onclose = () => this.closed(socket);
		socket.onerror = () => {
			// Every error is followed by a close, which is where it is handled.
		};
	}

	/** Closes the socket and keeps it closed. */
	disconnect(): void {
		this.closedByUs = true;
		clearTimeout(this.reconnectTimer);
		this.stopHeartbeat();
		const socket = this.socket;
		this.socket = null;
		if (socket && socket.readyState < 2) {
			socket.close(1000, 'client disconnect');
		}
		this.buffer = [];
	}

	/** @internal */
	push(frame: Frame): void {
		const text = JSON.stringify(frame);
		if (this.socket?.readyState === 1) {
			this.socket.send(text);
		} else {
			this.buffer.push(text);
		}
	}

	/** @internal A frame that expects a `phx_reply` with its ref. */
	request(frame: Frame, timeoutMs = this.timeoutMs): Promise<Reply> {
		return new Promise((resolve) => {
			const ref = frame.ref ?? this.nextRef();
			const timer = setTimeout(() => {
				this.pending.delete(ref);
				resolve({ status: 'timeout', response: {} });
			}, timeoutMs);
			unref(timer);
			this.pending.set(ref, { resolve, timer });
			this.push({ ...frame, ref });
		});
	}

	/** @internal Broadcast over HTTP, for a channel that is not joined. */
	async broadcastOverHttp(topic: string, event: string, payload: unknown, isPrivate: boolean): Promise<SendStatus> {
		try {
			const headers = { ...(await this.transport.headers()), 'Content-Type': 'application/json' };
			const response = await this.transport.fetch(joinUrl(this.httpUrl, 'api/broadcast'), {
				method: 'POST',
				headers,
				body: JSON.stringify({ messages: [{ topic, event, payload, private: isPrivate }] })
			});
			await response.body?.cancel();
			return response.ok ? 'ok' : 'error';
		} catch {
			return 'error';
		}
	}

	private opened(): void {
		this.reconnectTries = 0;
		const queued = this.buffer;
		this.buffer = [];
		for (const text of queued) {
			this.socket?.send(text);
		}
		this.startHeartbeat();
		for (const channel of this.channels) {
			channel.socketOpened();
		}
	}

	private closed(socket: WebSocket): void {
		if (socket !== this.socket && this.socket !== null) {
			return;
		}
		this.stopHeartbeat();
		for (const [ref, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve({ status: 'error', response: { reason: 'the socket closed' } });
			this.pending.delete(ref);
		}
		for (const channel of this.channels) {
			channel.socketClosed();
		}
		if (this.closedByUs || ![...this.channels].some((channel) => channel.wanted)) {
			return;
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTries += 1;
			this.connect();
		}, backoff(this.reconnectTries));
		// Not unref'd: a Node process whose only job is to listen must survive the gap.
	}

	private received(data: unknown): void {
		if (typeof data !== 'string') {
			return;
		}
		let frame: Frame;
		try {
			frame = JSON.parse(data) as Frame;
		} catch {
			return;
		}
		if (frame.topic === 'phoenix' && frame.ref === this.heartbeatRef) {
			this.heartbeatRef = null;
		}
		if (frame.event === 'phx_reply' && frame.ref !== null) {
			const entry = this.pending.get(frame.ref);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(frame.ref);
				entry.resolve(frame.payload as unknown as Reply);
			}
		}
		for (const channel of this.channels) {
			if (channel.topic === frame.topic) {
				channel.receive(frame);
			}
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			if (this.heartbeatRef !== null) {
				// The last one was never answered: the connection is dead even if it looks open.
				this.heartbeatRef = null;
				this.socket?.close(4000, 'heartbeat timeout');
				return;
			}
			this.heartbeatRef = this.nextRef();
			this.push({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.heartbeatRef });
		}, this.options.heartbeatIntervalMs ?? 25_000);
		unref(this.heartbeat);
	}

	private stopHeartbeat(): void {
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.heartbeatRef = null;
	}
}

export class RealtimeChannel {
	/** `realtime:<name>`, the Phoenix topic. */
	readonly topic: string;
	/** The name it was created with. */
	readonly name: string;
	state: ChannelState = 'closed';
	/** @internal */ joinRef: string | null = null;
	/** @internal Whether the caller wants this joined; a dropped socket rejoins only these. */
	wanted = false;
	private readonly options: ChannelOptions;
	private readonly client: RealtimeClient;
	private readonly bindings: Binding[] = [];
	private presence: Record<string, Presence[]> = {};
	private statusCallback: ((status: SubscribeStatus, error?: Error) => void) | undefined;
	private rejoinTimer: ReturnType<typeof setTimeout> | undefined;
	private rejoinTries = 0;
	/** Set while a joined channel waits for Realtime to say its table changes are live. */
	private awaitingChanges: ReturnType<typeof setTimeout> | undefined;

	constructor(name: string, options: ChannelOptions, client: RealtimeClient) {
		this.name = name;
		this.topic = `realtime:${name}`;
		this.options = options;
		this.client = client;
	}

	on(type: 'broadcast', filter: { event: string }, callback: (message: BroadcastMessage) => void): this;
	on(type: 'presence', filter: { event: 'sync' }, callback: () => void): this;
	on(type: 'presence', filter: { event: 'join' }, callback: (join: PresenceJoin) => void): this;
	on(type: 'presence', filter: { event: 'leave' }, callback: (leave: PresenceLeave) => void): this;
	on<T extends Record<string, unknown> = Record<string, unknown>>(
		type: 'postgres_changes',
		filter: PostgresChangesFilter,
		callback: (payload: PostgresChangesPayload<T>) => void
	): this;
	on(type: 'system', filter: Record<string, never>, callback: (message: Record<string, unknown>) => void): this;
	on(type: string, filter: object, callback: (payload: never) => void): this {
		this.bindings.push({ type, filter: filter as Record<string, unknown>, callback });
		return this;
	}

	/**
	 * Joins. `callback` hears SUBSCRIBED, and afterwards CHANNEL_ERROR, TIMED_OUT or CLOSED;
	 * after an error the channel keeps trying to rejoin on its own.
	 */
	subscribe(callback?: (status: SubscribeStatus, error?: Error) => void): this {
		if (this.wanted) {
			throw new Error(`channel ${this.name} is already subscribed; create a new channel to subscribe again`);
		}
		this.wanted = true;
		this.statusCallback = callback;
		this.client.connect();
		if (this.client.isConnected()) {
			void this.join();
		}
		return this;
	}

	/** Leaves. The channel can be discarded afterwards; `removeChannel` also forgets it. */
	async unsubscribe(): Promise<SendStatus> {
		this.wanted = false;
		clearTimeout(this.rejoinTimer);
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state !== 'joined' && this.state !== 'joining') {
			this.state = 'closed';
			return 'ok';
		}
		this.state = 'leaving';
		const reply = await this.client.request({ topic: this.topic, event: 'phx_leave', payload: {}, ref: null, join_ref: this.joinRef });
		this.state = 'closed';
		this.statusCallback?.('CLOSED');
		return reply.status === 'ok' ? 'ok' : reply.status === 'timeout' ? 'timed out' : 'error';
	}

	/**
	 * Sends a broadcast, or a presence track/untrack. On a joined channel it goes over the
	 * socket; on one that is not joined, a broadcast goes over HTTP instead, so a server can
	 * broadcast without holding a socket open.
	 */
	async send(message: { type: 'broadcast' | 'presence'; event: string; payload?: unknown; [field: string]: unknown }): Promise<SendStatus> {
		if (this.state !== 'joined' || !this.client.isConnected()) {
			if (message.type !== 'broadcast') {
				return 'error';
			}
			return this.client.broadcastOverHttp(this.name, message.event, message.payload ?? {}, this.options.config?.private ?? false);
		}
		const frame: Frame = { topic: this.topic, event: message.type, payload: message as Record<string, unknown>, ref: null, join_ref: this.joinRef };
		const acknowledged = message.type === 'presence' || this.options.config?.broadcast?.ack === true;
		if (!acknowledged) {
			this.client.push({ ...frame, ref: this.client.nextRef() });
			return 'ok';
		}
		const reply = await this.client.request(frame);
		return reply.status === 'ok' ? 'ok' : reply.status === 'timeout' ? 'timed out' : 'error';
	}

	/** Announce this client on the channel with `state`, replacing what it announced before. */
	track(state: Record<string, unknown>): Promise<SendStatus> {
		return this.send({ type: 'presence', event: 'track', payload: state });
	}

	untrack(): Promise<SendStatus> {
		return this.send({ type: 'presence', event: 'untrack' });
	}

	/** Everyone present, by key. Each key may be present more than once (two tabs). */
	presenceState<T extends Record<string, unknown> = Record<string, unknown>>(): Record<string, Presence<T>[]> {
		return structuredClone(this.presence) as Record<string, Presence<T>[]>;
	}

	// ---- driven by the client ----

	/** @internal */
	socketOpened(): void {
		if (this.wanted && this.state !== 'joined' && this.state !== 'joining') {
			void this.join();
		}
	}

	/** @internal */
	socketClosed(): void {
		clearTimeout(this.rejoinTimer);
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state === 'joined' || this.state === 'joining') {
			this.state = 'errored';
			this.statusCallback?.('CHANNEL_ERROR', new Error('the realtime connection dropped; rejoining'));
		}
	}

	private async join(): Promise<void> {
		this.state = 'joining';
		const joinRef = this.client.nextRef();
		this.joinRef = joinRef;
		const changes = this.bindings.filter((binding) => binding.type === 'postgres_changes');
		const config = this.options.config ?? {};
		const payload = {
			config: {
				broadcast: { self: false, ack: false, ...config.broadcast },
				presence: {
					key: config.presence?.key ?? '',
					enabled: config.presence?.enabled ?? this.bindings.some((binding) => binding.type === 'presence')
				},
				postgres_changes: changes.map((binding) => binding.filter),
				private: config.private ?? false
			},
			access_token: await this.client.token()
		};
		if (this.joinRef !== joinRef || !this.wanted) {
			return;
		}
		const reply = await this.client.request({ topic: this.topic, event: 'phx_join', payload, ref: joinRef, join_ref: joinRef });
		if (this.joinRef !== joinRef || !this.wanted) {
			return;
		}
		if (reply.status === 'ok') {
			const granted = (reply.response.postgres_changes ?? []) as (PostgresChangesFilter & { id: number })[];
			for (let i = 0; i < changes.length; i++) {
				const server = granted[i];
				const asked = changes[i].filter as unknown as PostgresChangesFilter;
				if (!server || server.event !== asked.event || server.schema !== asked.schema || (server.table ?? undefined) !== (asked.table ?? undefined) || (server.filter ?? undefined) !== (asked.filter ?? undefined)) {
					this.state = 'errored';
					this.wanted = false;
					void this.client.request({ topic: this.topic, event: 'phx_leave', payload: {}, ref: null, join_ref: joinRef });
					this.statusCallback?.('CHANNEL_ERROR', new Error('the server granted different table changes than were asked for'));
					return;
				}
				changes[i].id = server.id;
			}
			this.state = 'joined';
			this.rejoinTries = 0;
			if (changes.length === 0) {
				this.statusCallback?.('SUBSCRIBED');
				return;
			}
			// The join reply comes BEFORE Realtime has started capturing this channel's table
			// changes; that is announced a moment later as a `system` message. A row written in
			// between is never delivered, so SUBSCRIBED waits for it, and it means "every change
			// from now on arrives". A server that never says it is not left hanging.
			clearTimeout(this.awaitingChanges);
			this.awaitingChanges = setTimeout(() => this.changesLive(null), this.client.timeoutMs);
			unref(this.awaitingChanges);
			return;
		}
		this.state = 'errored';
		if (reply.status === 'timeout') {
			this.statusCallback?.('TIMED_OUT');
		} else {
			const reason = reply.response.reason;
			this.statusCallback?.('CHANNEL_ERROR', new Error(typeof reason === 'string' ? reason : JSON.stringify(reply.response)));
		}
		this.scheduleRejoin();
	}

	private changesLive(refusal: string | null): void {
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state !== 'joined') {
			return;
		}
		if (refusal === null) {
			this.statusCallback?.('SUBSCRIBED');
			return;
		}
		this.state = 'errored';
		this.statusCallback?.('CHANNEL_ERROR', new Error(refusal));
		this.scheduleRejoin();
	}

	private scheduleRejoin(): void {
		clearTimeout(this.rejoinTimer);
		if (!this.wanted) {
			return;
		}
		this.rejoinTimer = setTimeout(() => {
			this.rejoinTries += 1;
			if (this.wanted && this.client.isConnected()) {
				void this.join();
			}
		}, backoff(this.rejoinTries));
	}

	/** @internal */
	receive(frame: Frame): void {
		// A frame for an earlier join of this topic belongs to a channel that no longer exists.
		if (frame.join_ref && this.joinRef && frame.join_ref !== this.joinRef && frame.event.startsWith('phx_')) {
			return;
		}
		switch (frame.event) {
			case 'phx_reply':
				return;
			case 'phx_error':
				if (this.state === 'joined' || this.state === 'joining') {
					this.state = 'errored';
					this.statusCallback?.('CHANNEL_ERROR', new Error('the channel crashed on the server; rejoining'));
					this.scheduleRejoin();
				}
				return;
			case 'phx_close':
				this.state = 'closed';
				if (this.wanted) {
					this.statusCallback?.('CLOSED');
					this.scheduleRejoin();
				}
				return;
			case 'broadcast':
				this.dispatch('broadcast', (filter) => filter.event === '*' || filter.event === frame.payload.event, frame.payload);
				return;
			case 'presence_state':
				this.presenceSync(frame.payload as Record<string, { metas: Record<string, unknown>[] }>);
				return;
			case 'presence_diff':
				this.presenceDiff(frame.payload as { joins: Record<string, { metas: Record<string, unknown>[] }>; leaves: Record<string, { metas: Record<string, unknown>[] }> });
				return;
			case 'system':
				if (frame.payload.extension === 'postgres_changes' && this.awaitingChanges !== undefined) {
					this.changesLive(frame.payload.status === 'ok' ? null : String(frame.payload.message ?? 'Realtime refused the table changes'));
				}
				this.dispatch('system', () => true, frame.payload);
				return;
			case 'postgres_changes':
				this.postgresChange(frame.payload as { ids?: number[]; data: Record<string, unknown> });
				return;
			default:
				this.dispatch(frame.event, () => true, frame.payload);
		}
	}

	private dispatch(type: string, matches: (filter: Record<string, unknown>) => boolean, payload: unknown): void {
		for (const binding of this.bindings) {
			if (binding.type === type && matches(binding.filter)) {
				(binding.callback as (payload: unknown) => void)(payload);
			}
		}
	}

	private postgresChange(message: { ids?: number[]; data: Record<string, unknown> }): void {
		const data = message.data;
		const change: PostgresChangesPayload = {
			schema: String(data.schema),
			table: String(data.table),
			commit_timestamp: String(data.commit_timestamp),
			eventType: (data.type ?? data.eventType) as PostgresChangesPayload['eventType'],
			new: (data.record ?? {}) as Record<string, unknown>,
			old: (data.old_record ?? {}) as Record<string, unknown>,
			errors: (data.errors ?? null) as string[] | null
		};
		for (const binding of this.bindings) {
			if (binding.type !== 'postgres_changes') {
				continue;
			}
			const filter = binding.filter as unknown as PostgresChangesFilter;
			const byId = message.ids !== undefined && binding.id !== undefined;
			const matches = byId
				? message.ids!.includes(binding.id!)
				: (filter.event === '*' || filter.event === change.eventType) &&
					filter.schema === change.schema &&
					(filter.table === undefined || filter.table === '*' || filter.table === change.table);
			if (matches) {
				(binding.callback as (payload: PostgresChangesPayload) => void)(change);
			}
		}
	}

	private presenceSync(state: Record<string, { metas: Record<string, unknown>[] }>): void {
		const next: Record<string, Presence[]> = {};
		for (const [key, entry] of Object.entries(state)) {
			next[key] = entry.metas.map(toPresence);
		}
		const previous = this.presence;
		this.presence = next;
		for (const [key, presences] of Object.entries(next)) {
			const known = new Set((previous[key] ?? []).map((p) => p.presence_ref));
			const joined = presences.filter((p) => !known.has(p.presence_ref));
			if (joined.length > 0) {
				this.emitPresence({ event: 'join', key, currentPresences: previous[key] ?? [], newPresences: joined });
			}
		}
		for (const [key, presences] of Object.entries(previous)) {
			const still = new Set((next[key] ?? []).map((p) => p.presence_ref));
			const left = presences.filter((p) => !still.has(p.presence_ref));
			if (left.length > 0) {
				this.emitPresence({ event: 'leave', key, currentPresences: next[key] ?? [], leftPresences: left });
			}
		}
		this.dispatch('presence', (filter) => filter.event === 'sync', undefined);
	}

	private presenceDiff(diff: { joins: Record<string, { metas: Record<string, unknown>[] }>; leaves: Record<string, { metas: Record<string, unknown>[] }> }): void {
		for (const [key, entry] of Object.entries(diff.joins ?? {})) {
			const current = this.presence[key] ?? [];
			const incoming = entry.metas.map(toPresence);
			const refs = new Set(incoming.map((p) => p.presence_ref));
			this.presence[key] = [...current.filter((p) => !refs.has(p.presence_ref)), ...incoming];
			this.emitPresence({ event: 'join', key, currentPresences: current, newPresences: incoming });
		}
		for (const [key, entry] of Object.entries(diff.leaves ?? {})) {
			const leaving = entry.metas.map(toPresence);
			const refs = new Set(leaving.map((p) => p.presence_ref));
			const remaining = (this.presence[key] ?? []).filter((p) => !refs.has(p.presence_ref));
			if (remaining.length > 0) {
				this.presence[key] = remaining;
			} else {
				delete this.presence[key];
			}
			this.emitPresence({ event: 'leave', key, currentPresences: remaining, leftPresences: leaving });
		}
		this.dispatch('presence', (filter) => filter.event === 'sync', undefined);
	}

	private emitPresence(event: PresenceJoin | PresenceLeave): void {
		this.dispatch('presence', (filter) => filter.event === event.event, event);
	}
}

function toPresence(meta: Record<string, unknown>): Presence {
	const { phx_ref, phx_ref_prev: _previous, ...rest } = meta;
	return { ...rest, presence_ref: String(phx_ref) };
}
