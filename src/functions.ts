/**
 * Snout Functions: your own TypeScript, at `/functions/v1/<name>`.
 *
 * `invoke` sends the signed-in user's token, so a function can act as them, and decodes the
 * answer by its content type. A function that answers with a status of 400 or above is an
 * `error` whose `context` is the Response, so its own body can still be read.
 */

import { joinUrl, type Transport } from './http.js';

export class FunctionsError extends Error {
	/** The function's own response, when it answered at all. */
	readonly context: Response | undefined;

	constructor(message: string, name: 'FunctionsHttpError' | 'FunctionsFetchError' | 'FunctionsRelayError', context?: Response) {
		super(message);
		this.name = name;
		this.context = context;
	}
}

export type FunctionsResult<T> = { data: T; error: null } | { data: null; error: FunctionsError };

export interface InvokeOptions {
	body?: unknown;
	headers?: Record<string, string>;
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	signal?: AbortSignal;
}

export class FunctionsClient {
	constructor(
		/** @internal */ readonly url: string,
		private readonly transport: Transport
	) {}

	async invoke<T = unknown>(name: string, options: InvokeOptions = {}): Promise<FunctionsResult<T>> {
		const headers: Record<string, string> = { ...(await this.transport.headers()) };
		const given = options.body;
		let body: BodyInit | undefined;
		if (given !== undefined) {
			if (typeof given === 'string') {
				headers['Content-Type'] = 'text/plain';
				body = given;
			} else if (
				(typeof Blob !== 'undefined' && given instanceof Blob) ||
				given instanceof ArrayBuffer ||
				ArrayBuffer.isView(given)
			) {
				headers['Content-Type'] = 'application/octet-stream';
				body = given as BodyInit;
			} else if (given instanceof FormData || given instanceof URLSearchParams) {
				body = given;
			} else {
				headers['Content-Type'] = 'application/json';
				body = JSON.stringify(given);
			}
		}
		Object.assign(headers, options.headers);

		let response: Response;
		try {
			response = await this.transport.fetch(joinUrl(this.url, name), {
				method: options.method ?? 'POST',
				headers,
				body,
				signal: options.signal
			});
		} catch (cause) {
			return { data: null, error: new FunctionsError(cause instanceof Error ? cause.message : String(cause), 'FunctionsFetchError') };
		}
		if (response.headers.get('x-relay-error') === 'true') {
			return { data: null, error: new FunctionsError('The function could not be reached', 'FunctionsRelayError', response) };
		}
		if (!response.ok) {
			return { data: null, error: new FunctionsError(`The function answered ${response.status}`, 'FunctionsHttpError', response) };
		}

		const type = (response.headers.get('content-type') ?? 'text/plain').split(';')[0].trim();
		let data: unknown;
		if (type === 'application/json') {
			data = await response.json();
		} else if (type === 'application/octet-stream' || type.startsWith('image/') || type === 'application/pdf') {
			data = await response.blob();
		} else if (type === 'text/event-stream') {
			// A stream is handed over unread, so the caller reads it as it arrives.
			data = response;
		} else if (type === 'multipart/form-data') {
			data = await response.formData();
		} else {
			data = await response.text();
		}
		return { data: data as T, error: null };
	}
}
