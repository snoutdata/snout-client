/**
 * Auth: accounts, sessions and the token every other product sends.
 *
 * The auth server is at `/auth/v1`. A session is an access token (a short-lived JWT that
 * row-level security reads) plus a refresh token that buys the next one. This module keeps
 * the session, stores it where the caller said to (the browser's localStorage by default),
 * refreshes it before it expires, and tells every listener when it changes, which is how
 * realtime learns to re-authorise its channels.
 */

import { encodePath, isBrowser, joinUrl, messageOf, readBody, type Fetch } from './http.js';

export interface User {
	id: string;
	aud: string;
	role?: string;
	email?: string;
	phone?: string;
	email_confirmed_at?: string | null;
	phone_confirmed_at?: string | null;
	confirmed_at?: string | null;
	last_sign_in_at?: string | null;
	app_metadata: Record<string, unknown>;
	user_metadata: Record<string, unknown>;
	identities?: Record<string, unknown>[];
	created_at: string;
	updated_at?: string;
	is_anonymous?: boolean;
	[field: string]: unknown;
}

export interface Session {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	/** Seconds since the epoch. */
	expires_at: number;
	user: User;
	provider_token?: string | null;
	provider_refresh_token?: string | null;
}

export class AuthError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = 'AuthError';
		this.status = status;
		this.code = code;
	}
}

export type AuthEvent =
	| 'INITIAL_SESSION'
	| 'SIGNED_IN'
	| 'SIGNED_OUT'
	| 'TOKEN_REFRESHED'
	| 'USER_UPDATED'
	| 'PASSWORD_RECOVERY';

export type AuthResult<T> = { data: T; error: null } | { data: { [K in keyof T]: null }; error: AuthError };

/** Where a session is kept between page loads. `localStorage` fits; so does anything async. */
export interface SessionStorage {
	getItem(key: string): string | null | Promise<string | null>;
	setItem(key: string, value: string): void | Promise<void>;
	removeItem(key: string): void | Promise<void>;
}

export interface AuthOptions {
	/** Keep the session between page loads. Default: true in a browser, false elsewhere. */
	persistSession?: boolean;
	/** Refresh the access token before it expires. Default: true. */
	autoRefreshToken?: boolean;
	/** Finish a sign-in from the URL a redirect landed on. Default: true in a browser. */
	detectSessionInUrl?: boolean;
	/** `pkce` (the default) or `implicit`, for magic links and OAuth redirects. */
	flowType?: 'pkce' | 'implicit';
	storage?: SessionStorage;
	storageKey?: string;
}

type Listener = (event: AuthEvent, session: Session | null) => void;

/** Refresh this many seconds before expiry. */
const REFRESH_MARGIN = 60;

function memoryStorage(): SessionStorage {
	const items = new Map<string, string>();
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
		removeItem: (key) => void items.delete(key)
	};
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** A token response from the auth server, as a session with `expires_at` filled in. */
function toSession(body: Record<string, unknown>): Session | null {
	if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
		return null;
	}
	const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
	return {
		...(body as unknown as Session),
		expires_in: expiresIn,
		expires_at: typeof body.expires_at === 'number' ? body.expires_at : nowSeconds() + expiresIn
	};
}

export class AuthClient {
	private readonly url: string;
	private readonly key: string;
	private readonly fetch: Fetch;
	private readonly headers: Record<string, string>;
	private readonly storage: SessionStorage;
	private readonly storageKey: string;
	private readonly persist: boolean;
	private readonly autoRefresh: boolean;
	private readonly flowType: 'pkce' | 'implicit';
	private readonly listeners = new Set<Listener>();
	private session: Session | null = null;
	private refreshing: Promise<Session | null> | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly ready: Promise<void>;

	/** The admin half: managing other people's accounts. Needs the service key. */
	readonly admin: AuthAdmin;

	constructor(url: string, key: string, fetchImpl: Fetch, headers: Record<string, string>, ref: string, options: AuthOptions = {}) {
		this.url = url;
		this.key = key;
		this.fetch = fetchImpl;
		this.headers = headers;
		const browser = isBrowser();
		this.persist = options.persistSession ?? browser;
		this.autoRefresh = options.autoRefreshToken ?? true;
		this.flowType = options.flowType ?? 'pkce';
		this.storage =
			options.storage ?? (this.persist && typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
		this.storageKey = options.storageKey ?? `snoutdata-${ref}-auth`;
		this.admin = new AuthAdmin(this);
		this.ready = this.initialize(options.detectSessionInUrl ?? browser);
	}

	// ---- plumbing ----

	/** @internal */
	async call(path: string, init: { method?: string; body?: unknown; token?: string; query?: Record<string, string | undefined> } = {}): Promise<{ body: Record<string, unknown>; error: AuthError | null }> {
		const url = new URL(joinUrl(this.url, path));
		for (const [name, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(name, value);
			}
		}
		const headers: Record<string, string> = {
			...this.headers,
			apikey: this.key,
			Authorization: `Bearer ${init.token ?? this.key}`
		};
		if (init.body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		let response: Response;
		try {
			response = await this.fetch(url.toString(), {
				method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body)
			});
		} catch (cause) {
			return { body: {}, error: new AuthError(cause instanceof Error ? cause.message : String(cause), 0) };
		}
		const payload = await readBody(response);
		const body = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
		if (!response.ok) {
			const code = typeof body.error_code === 'string' ? body.error_code : typeof body.code === 'string' ? body.code : undefined;
			return { body, error: new AuthError(messageOf(payload, `${response.status} ${response.statusText}`), response.status, code) };
		}
		return { body, error: null };
	}

	private async initialize(detectInUrl: boolean): Promise<void> {
		const stored = await this.storage.getItem(this.storageKey);
		if (stored) {
			try {
				this.session = JSON.parse(stored) as Session;
			} catch {
				await this.storage.removeItem(this.storageKey);
			}
		}
		if (detectInUrl && typeof location !== 'undefined') {
			await this.fromUrl().catch(() => undefined);
		}
		if (this.session && this.session.expires_at - REFRESH_MARGIN <= nowSeconds()) {
			await this.refresh(this.session.refresh_token);
		}
		this.schedule();
	}

	/** Finishes a redirect: `?code=` (PKCE) or `#access_token=` (implicit). */
	private async fromUrl(): Promise<void> {
		const url = new URL(location.href);
		const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
		const code = url.searchParams.get('code');
		if (code) {
			const { error } = await this.exchangeCodeForSession(code);
			if (!error) {
				url.searchParams.delete('code');
				history.replaceState(history.state, '', url.toString());
			}
			return;
		}
		const accessToken = hash.get('access_token');
		const refreshToken = hash.get('refresh_token');
		if (accessToken && refreshToken) {
			const { body, error } = await this.call('user', { token: accessToken });
			if (error) {
				return;
			}
			const expiresIn = Number(hash.get('expires_in') ?? 3600);
			await this.save({
				access_token: accessToken,
				refresh_token: refreshToken,
				token_type: hash.get('token_type') ?? 'bearer',
				expires_in: expiresIn,
				expires_at: Number(hash.get('expires_at') ?? nowSeconds() + expiresIn),
				user: body as unknown as User,
				provider_token: hash.get('provider_token'),
				provider_refresh_token: hash.get('provider_refresh_token')
			}, hash.get('type') === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN');
			history.replaceState(history.state, '', `${url.pathname}${url.search}`);
		}
	}

	private async save(session: Session | null, event: AuthEvent): Promise<void> {
		this.session = session;
		if (session) {
			await this.storage.setItem(this.storageKey, JSON.stringify(session));
		} else {
			await this.storage.removeItem(this.storageKey);
		}
		this.schedule();
		this.emit(event);
	}

	private emit(event: AuthEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event, this.session);
			} catch {
				// A listener that throws does not get to stop the others hearing.
			}
		}
	}

	private schedule(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.autoRefresh || !this.session) {
			return;
		}
		const due = Math.max(0, (this.session.expires_at - REFRESH_MARGIN - nowSeconds()) * 1000);
		const refreshToken = this.session.refresh_token;
		this.timer = setTimeout(() => void this.refresh(refreshToken), due);
		// In Node, a pending refresh must not be what keeps a script from exiting.
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** One refresh at a time: two callers asking together share the one request. */
	private refresh(refreshToken: string): Promise<Session | null> {
		if (!this.refreshing) {
			this.refreshing = (async () => {
				const { body, error } = await this.call('token', { query: { grant_type: 'refresh_token' }, body: { refresh_token: refreshToken } });
				const session = error ? null : toSession(body);
				if (session) {
					await this.save(session, 'TOKEN_REFRESHED');
				} else if (error && error.status >= 400 && error.status < 500) {
					// The refresh token is spent or revoked: the session is over.
					await this.save(null, 'SIGNED_OUT');
				}
				return session;
			})().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async signedIn(body: Record<string, unknown>, error: AuthError | null): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		if (error) {
			return { data: { user: null, session: null }, error };
		}
		const session = toSession(body);
		if (session) {
			await this.save(session, 'SIGNED_IN');
			return { data: { user: session.user, session }, error: null };
		}
		// Signed up but not signed in: the address has to be confirmed first.
		const user = (body.user ?? body) as User;
		return { data: { user, session: null }, error: null };
	}

	// ---- the session ----

	/** The token to send as `Authorization`: the session's, or the project key when signed out. */
	async getAccessToken(): Promise<string> {
		const { data } = await this.getSession();
		return data.session?.access_token ?? this.key;
	}

	/** The current session, refreshed first if it has expired. Read locally, not verified. */
	async getSession(): Promise<AuthResult<{ session: Session | null }>> {
		await this.ready;
		if (this.session && this.session.expires_at - REFRESH_MARGIN <= nowSeconds()) {
			await this.refresh(this.session.refresh_token);
		}
		return { data: { session: this.session }, error: null };
	}

	/** The signed-in user, as the auth server says it is now. Use this, not the session, to decide. */
	async getUser(jwt?: string): Promise<AuthResult<{ user: User | null }>> {
		const token = jwt ?? (await this.getSession()).data.session?.access_token;
		if (!token) {
			return { data: { user: null }, error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const { body, error } = await this.call('user', { token });
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	/** Adopt a session obtained elsewhere (a server, another tab). */
	async setSession(tokens: { access_token: string; refresh_token: string }): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const { body, error } = await this.call('user', { token: tokens.access_token });
		if (error) {
			const refreshed = await this.refresh(tokens.refresh_token);
			return refreshed
				? { data: { user: refreshed.user, session: refreshed }, error: null }
				: { data: { user: null, session: null }, error };
		}
		const payload = JSON.parse(atob(tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
		const expiresAt = payload.exp ?? nowSeconds() + 3600;
		const session: Session = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			token_type: 'bearer',
			expires_in: expiresAt - nowSeconds(),
			expires_at: expiresAt,
			user: body as unknown as User
		};
		await this.save(session, 'SIGNED_IN');
		return { data: { user: session.user, session }, error: null };
	}

	/** Force a refresh now, with the stored refresh token or the one given. */
	async refreshSession(current?: { refresh_token: string }): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const refreshToken = current?.refresh_token ?? this.session?.refresh_token;
		if (!refreshToken) {
			return { data: { user: null, session: null }, error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const session = await this.refresh(refreshToken);
		return session
			? { data: { user: session.user, session }, error: null }
			: { data: { user: null, session: null }, error: new AuthError('The session could not be refreshed', 401, 'refresh_token_not_found') };
	}

	/** Called with every change of session. Returns the handle that stops it. */
	onAuthStateChange(listener: Listener): { data: { subscription: { unsubscribe: () => void } } } {
		this.listeners.add(listener);
		// A listener added after start-up still hears where things stand.
		void this.ready.then(() => {
			if (this.listeners.has(listener)) {
				listener('INITIAL_SESSION', this.session);
			}
		});
		return { data: { subscription: { unsubscribe: () => void this.listeners.delete(listener) } } };
	}

	// ---- signing in ----

	async signUp(credentials: {
		email?: string;
		phone?: string;
		password: string;
		options?: { data?: Record<string, unknown>; emailRedirectTo?: string; captchaToken?: string };
	}): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const { email, phone, password, options = {} } = credentials;
		const { body, error } = await this.call('signup', {
			query: { redirect_to: options.emailRedirectTo },
			body: { email, phone, password, data: options.data ?? {}, gotrue_meta_security: { captcha_token: options.captchaToken } }
		});
		return this.signedIn(body, error);
	}

	async signInWithPassword(credentials: { email?: string; phone?: string; password: string }): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const { body, error } = await this.call('token', { query: { grant_type: 'password' }, body: credentials });
		return this.signedIn(body, error);
	}

	/** An account with no email or password, which can be upgraded later with `updateUser`. */
	async signInAnonymously(options: { data?: Record<string, unknown> } = {}): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const { body, error } = await this.call('signup', { body: { data: options.data ?? {} } });
		return this.signedIn(body, error);
	}

	/** Sends a magic link or a one-time code. The session arrives by `verifyOtp` or the redirect. */
	async signInWithOtp(credentials: {
		email?: string;
		phone?: string;
		options?: { emailRedirectTo?: string; shouldCreateUser?: boolean; data?: Record<string, unknown>; channel?: 'sms' | 'whatsapp' };
	}): Promise<AuthResult<{ user: null; session: null }>> {
		await this.ready;
		const { email, phone, options = {} } = credentials;
		let challenge: string | undefined;
		if (email && this.flowType === 'pkce') {
			challenge = await this.startPkce();
		}
		const { error } = await this.call('otp', {
			query: { redirect_to: options.emailRedirectTo },
			body: {
				email,
				phone,
				data: options.data ?? {},
				create_user: options.shouldCreateUser ?? true,
				channel: options.channel,
				code_challenge: challenge,
				code_challenge_method: challenge ? 's256' : undefined
			}
		});
		return error ? { data: { user: null, session: null }, error } : { data: { user: null, session: null }, error: null };
	}

	async verifyOtp(params: {
		email?: string;
		phone?: string;
		token?: string;
		token_hash?: string;
		type: 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' | 'sms' | 'phone_change';
	}): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		await this.ready;
		const { body, error } = await this.call('verify', { body: params });
		const result = await this.signedIn(body, error);
		if (!result.error && params.type === 'recovery') {
			this.emit('PASSWORD_RECOVERY');
		}
		return result;
	}

	/**
	 * The URL that signs in with a provider (GitHub, Google, …). In a browser it navigates
	 * there unless `skipBrowserRedirect`; elsewhere it only returns it.
	 */
	async signInWithOAuth(credentials: {
		provider: string;
		options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string>; skipBrowserRedirect?: boolean };
	}): Promise<AuthResult<{ provider: string; url: string }>> {
		await this.ready;
		const options = credentials.options ?? {};
		const url = new URL(joinUrl(this.url, 'authorize'));
		url.searchParams.set('provider', credentials.provider);
		if (options.redirectTo) {
			url.searchParams.set('redirect_to', options.redirectTo);
		}
		if (options.scopes) {
			url.searchParams.set('scopes', options.scopes);
		}
		for (const [name, value] of Object.entries(options.queryParams ?? {})) {
			url.searchParams.set(name, value);
		}
		if (this.flowType === 'pkce') {
			url.searchParams.set('code_challenge', await this.startPkce());
			url.searchParams.set('code_challenge_method', 's256');
		}
		if (isBrowser() && !options.skipBrowserRedirect) {
			location.assign(url.toString());
		}
		return { data: { provider: credentials.provider, url: url.toString() }, error: null };
	}

	/** Finishes a PKCE sign-in with the `code` the redirect carried. */
	async exchangeCodeForSession(code: string): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
		const key = `${this.storageKey}-code-verifier`;
		const verifier = await this.storage.getItem(key);
		if (!verifier) {
			return { data: { user: null, session: null }, error: new AuthError('No code verifier is stored for this sign-in', 400, 'pkce_verifier_missing') };
		}
		const { body, error } = await this.call('token', { query: { grant_type: 'pkce' }, body: { auth_code: code, code_verifier: verifier } });
		await this.storage.removeItem(key);
		return this.signedIn(body, error);
	}

	private async startPkce(): Promise<string> {
		const { verifier, challenge } = await pkcePair();
		await this.storage.setItem(`${this.storageKey}-code-verifier`, verifier);
		return challenge;
	}

	/** Ends the session here (`local`), everywhere (`global`) or everywhere else (`others`). */
	async signOut(options: { scope?: 'global' | 'local' | 'others' } = {}): Promise<{ error: AuthError | null }> {
		await this.ready;
		const scope = options.scope ?? 'global';
		const token = this.session?.access_token;
		if (token) {
			const { error } = await this.call('logout', { method: 'POST', token, query: { scope } });
			// A token the server no longer knows is as signed out as it gets.
			if (error && error.status !== 401 && error.status !== 403 && error.status !== 404) {
				return { error };
			}
		}
		if (scope !== 'others') {
			await this.save(null, 'SIGNED_OUT');
		}
		return { error: null };
	}

	// ---- the account ----

	async resetPasswordForEmail(email: string, options: { redirectTo?: string; captchaToken?: string } = {}): Promise<{ data: Record<string, never>; error: AuthError | null }> {
		await this.ready;
		let challenge: string | undefined;
		if (this.flowType === 'pkce') {
			challenge = await this.startPkce();
		}
		const { error } = await this.call('recover', {
			query: { redirect_to: options.redirectTo },
			body: {
				email,
				gotrue_meta_security: { captcha_token: options.captchaToken },
				code_challenge: challenge,
				code_challenge_method: challenge ? 's256' : undefined
			}
		});
		return { data: {}, error };
	}

	/** Changes the signed-in user's email, phone, password or metadata. */
	async updateUser(
		attributes: { email?: string; phone?: string; password?: string; nonce?: string; data?: Record<string, unknown> },
		options: { emailRedirectTo?: string } = {}
	): Promise<AuthResult<{ user: User | null }>> {
		const { data } = await this.getSession();
		if (!data.session) {
			return { data: { user: null }, error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const { body, error } = await this.call('user', {
			method: 'PUT',
			token: data.session.access_token,
			query: { redirect_to: options.emailRedirectTo },
			body: attributes
		});
		if (error) {
			return { data: { user: null }, error };
		}
		const user = body as unknown as User;
		await this.save({ ...data.session, user }, 'USER_UPDATED');
		return { data: { user }, error: null };
	}

	/** Re-sends a confirmation or change email, or a code. */
	async resend(params: { type: 'signup' | 'email_change' | 'sms' | 'phone_change'; email?: string; phone?: string; options?: { emailRedirectTo?: string } }): Promise<{ error: AuthError | null }> {
		const { options, ...body } = params;
		const { error } = await this.call('resend', { query: { redirect_to: options?.emailRedirectTo }, body });
		return { error };
	}

	/** Stops the refresh timer. For scripts and tests that want to exit cleanly. */
	stopAutoRefresh(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

/** Account management with the service key. Never ship that key to a browser. */
export class AuthAdmin {
	constructor(private readonly auth: AuthClient) {}

	async createUser(attributes: {
		email?: string;
		phone?: string;
		password?: string;
		email_confirm?: boolean;
		phone_confirm?: boolean;
		user_metadata?: Record<string, unknown>;
		app_metadata?: Record<string, unknown>;
		ban_duration?: string;
	}): Promise<AuthResult<{ user: User | null }>> {
		const { body, error } = await this.auth.call('admin/users', { body: attributes });
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	async listUsers(params: { page?: number; perPage?: number } = {}): Promise<AuthResult<{ users: User[] }>> {
		const { body, error } = await this.auth.call('admin/users', {
			query: { page: params.page?.toString(), per_page: params.perPage?.toString() }
		});
		return error ? { data: { users: null }, error } : { data: { users: (body.users ?? []) as User[] }, error: null };
	}

	async getUserById(id: string): Promise<AuthResult<{ user: User | null }>> {
		const { body, error } = await this.auth.call(`admin/users/${encodePath(id)}`);
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	async updateUserById(id: string, attributes: Record<string, unknown>): Promise<AuthResult<{ user: User | null }>> {
		const { body, error } = await this.auth.call(`admin/users/${encodePath(id)}`, { method: 'PUT', body: attributes });
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	/** `shouldSoftDelete` keeps the row and scrubs it, so foreign keys to it still hold. */
	async deleteUser(id: string, shouldSoftDelete = false): Promise<AuthResult<{ user: User | null }>> {
		const { body, error } = await this.auth.call(`admin/users/${encodePath(id)}`, {
			method: 'DELETE',
			body: { should_soft_delete: shouldSoftDelete }
		});
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	async inviteUserByEmail(email: string, options: { data?: Record<string, unknown>; redirectTo?: string } = {}): Promise<AuthResult<{ user: User | null }>> {
		const { body, error } = await this.auth.call('invite', {
			query: { redirect_to: options.redirectTo },
			body: { email, data: options.data ?? {} }
		});
		return error ? { data: { user: null }, error } : { data: { user: body as unknown as User }, error: null };
	}

	/** A sign-in, invite or recovery link, returned instead of emailed. */
	async generateLink(params: {
		type: 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change_current' | 'email_change_new';
		email: string;
		password?: string;
		newEmail?: string;
		options?: { data?: Record<string, unknown>; redirectTo?: string };
	}): Promise<AuthResult<{ properties: Record<string, unknown>; user: User }>> {
		const { options, newEmail, ...rest } = params;
		const { body, error } = await this.auth.call('admin/generate_link', {
			body: { ...rest, new_email: newEmail, data: options?.data, redirect_to: options?.redirectTo }
		});
		if (error) {
			return { data: { properties: null, user: null }, error };
		}
		const { action_link, email_otp, hashed_token, redirect_to, verification_type, ...user } = body;
		return {
			data: { properties: { action_link, email_otp, hashed_token, redirect_to, verification_type }, user: user as unknown as User },
			error: null
		};
	}
}
