/**
 * A session store in browser cookies, so two sites under one parent domain share one sign-in:
 *
 *     createClient(url, key, { auth: { storage: cookieStorage({ domain: '.example.com' }) } })
 *
 * A session does not fit in one cookie (a JWT, a refresh token and the user is ~4 kB against a
 * 4,096-byte limit per cookie), so a value is split across numbered cookies and joined again,
 * and chunks left over from a longer value are cleared when it shrinks.
 *
 * **The format is `@supabase/ssr`'s (0.12) byte for byte**, so a site moving to this client
 * reads the sessions its visitors already have, and a site still on ssr under the same domain
 * reads ours: the value is `base64-` + base64url(UTF-8) without padding; a value of 3,180
 * characters or fewer (URI-encoded) is one cookie named as the key, a longer one is `<key>.0`,
 * `<key>.1`, …; and a clear at a parent domain also clears the host-only copy, which a site that
 * once stored host-only would otherwise resurrect after sign-out.
 */

import type { SessionStorage } from './auth.js';

export interface CookieOptions {
	/** `.example.com` to share between subdomains. Leave unset for host-only. */
	domain?: string;
	path?: string;
	sameSite?: 'lax' | 'strict' | 'none';
	secure?: boolean;
	/** Seconds. 400 days by default, the most a browser honours. */
	maxAge?: number;
}

/** What `document` offers; a test passes its own. */
export interface CookieJar {
	cookie: string;
}

export const MAX_CHUNK_SIZE = 3180;
const BASE64_PREFIX = 'base64-';
const DEFAULTS: Required<Omit<CookieOptions, 'domain' | 'secure'>> = { path: '/', sameSite: 'lax', maxAge: 400 * 24 * 60 * 60 };

function toBase64Url(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[\s=]/g, '');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Splits a value the way ssr does: by URI-encoded length, never through an escape or a code point. */
export function createChunks(key: string, value: string, chunkSize = MAX_CHUNK_SIZE): { name: string; value: string }[] {
	let encoded = encodeURIComponent(value);
	if (encoded.length <= chunkSize) {
		return [{ name: key, value }];
	}
	const chunks: string[] = [];
	while (encoded.length > 0) {
		let head = encoded.slice(0, chunkSize);
		const lastEscape = head.lastIndexOf('%');
		if (lastEscape > chunkSize - 3) {
			head = head.slice(0, lastEscape);
		}
		let decoded = '';
		while (head.length > 0) {
			try {
				decoded = decodeURIComponent(head);
				break;
			} catch (error) {
				if (error instanceof URIError && head.at(-3) === '%' && head.length > 3) {
					head = head.slice(0, head.length - 3);
				} else {
					throw error;
				}
			}
		}
		chunks.push(decoded);
		encoded = encoded.slice(head.length);
	}
	return chunks.map((chunk, i) => ({ name: `${key}.${i}`, value: chunk }));
}

function isChunkOf(name: string, key: string): boolean {
	if (name === key) {
		return true;
	}
	const match = /^(.*)[.](0|[1-9][0-9]*)$/.exec(name);
	return match !== null && match[1] === key;
}

function parse(header: string): Map<string, string> {
	const cookies = new Map<string, string>();
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) {
			continue;
		}
		const name = part.slice(0, eq).trim();
		let value = part.slice(eq + 1).trim();
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value.slice(1, -1);
		}
		if (!name || cookies.has(name)) {
			continue; // the first of two same-named cookies is the more specific one
		}
		try {
			cookies.set(name, value.includes('%') ? decodeURIComponent(value) : value);
		} catch {
			cookies.set(name, value);
		}
	}
	return cookies;
}

function serialize(name: string, value: string, options: CookieOptions & { maxAge: number }): string {
	const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${Math.floor(options.maxAge)}`];
	if (options.domain) {
		parts.push(`Domain=${options.domain}`);
	}
	parts.push(`Path=${options.path ?? DEFAULTS.path}`);
	if (options.secure) {
		parts.push('Secure');
	}
	const sameSite = options.sameSite ?? DEFAULTS.sameSite;
	parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`);
	return parts.join('; ');
}

export function cookieStorage(options: CookieOptions = {}, jar?: CookieJar): SessionStorage {
	const doc = (): CookieJar => {
		const target = jar ?? (typeof document === 'undefined' ? undefined : document);
		if (!target) {
			throw new Error('cookieStorage needs a document: it is for browsers');
		}
		return target;
	};
	const remove = (names: string[]): void => {
		const gone = { ...options, maxAge: 0 };
		for (const name of names) {
			if (options.domain) {
				// The host-only copy first, then the one at the domain: see the header.
				doc().cookie = serialize(name, '', { ...gone, domain: undefined });
			}
			doc().cookie = serialize(name, '', gone);
		}
	};
	const namesFor = (key: string): string[] => [...parse(doc().cookie).keys()].filter((name) => isChunkOf(name, key));

	return {
		getItem(key) {
			const cookies = parse(doc().cookie);
			let value = cookies.get(key) || null;
			if (!value) {
				const chunks: string[] = [];
				for (let i = 0; cookies.get(`${key}.${i}`); i += 1) {
					chunks.push(cookies.get(`${key}.${i}`) as string);
				}
				value = chunks.length > 0 ? chunks.join('') : null;
			}
			if (!value || !value.startsWith(BASE64_PREFIX)) {
				return value;
			}
			try {
				const decoded = fromBase64Url(value.slice(BASE64_PREFIX.length));
				JSON.parse(decoded);
				return decoded;
			} catch {
				// Chunks from two different writes: treat it as absent, as ssr does.
				return null;
			}
		},
		setItem(key, value) {
			const chunks = createChunks(key, BASE64_PREFIX + toBase64Url(value));
			const keep = new Set(chunks.map((chunk) => chunk.name));
			remove(namesFor(key).filter((name) => !keep.has(name)));
			const set = { ...options, maxAge: options.maxAge ?? DEFAULTS.maxAge };
			for (const chunk of chunks) {
				doc().cookie = serialize(chunk.name, chunk.value, set);
			}
		},
		removeItem(key) {
			remove(namesFor(key));
		}
	};
}
