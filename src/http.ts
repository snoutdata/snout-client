/**
 * What every product shares: one fetch, and the headers each request carries.
 *
 * The headers are asked for per request rather than fixed at construction, because the
 * `Authorization` a request carries is whoever is signed in at the moment it is sent, and
 * that changes under the client's feet (sign-in, refresh, sign-out).
 */

export type Fetch = typeof fetch;

/** Resolves the headers one request carries: the key, and the bearer of the moment. */
export type HeaderSource = () => Promise<Record<string, string>>;

export interface Transport {
	fetch: Fetch;
	headers: HeaderSource;
}

/** Reads a body as JSON when it says it is JSON, as text otherwise, and never throws. */
export async function readBody(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => '');
	if (text === '') {
		return null;
	}
	const type = response.headers.get('content-type') ?? '';
	if (type.includes('json')) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

/** The first human sentence in an error body, whichever server and whichever shape wrote it. */
export function messageOf(body: unknown, fallback: string): string {
	if (typeof body === 'string' && body.trim() !== '') {
		return body.trim();
	}
	if (body !== null && typeof body === 'object') {
		const record = body as Record<string, unknown>;
		for (const field of ['message', 'msg', 'error_description', 'error']) {
			const value = record[field];
			if (typeof value === 'string' && value !== '') {
				return value;
			}
		}
	}
	return fallback;
}

/** `https://x` + `/a/b` with no doubled or missing slash. */
export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** An object path with each segment encoded and the slashes kept. */
export function encodePath(path: string): string {
	return path
		.replace(/^\/+|\/+$/g, '')
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined';
}
