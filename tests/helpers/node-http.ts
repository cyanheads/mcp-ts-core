/**
 * @fileoverview `node:http` requests on a socket of their own, for integration
 * tests that drive a server subprocess from the test runner under real Node.
 *
 * Global `fetch` there is Node's bundled undici, which sets the IP type of
 * service on every socket it writes to. On macOS that call can fail with an
 * uncatchable `setTypeOfService EINVAL` when the socket is already torn down —
 * a booting child, or a pool reused right after an aborted request
 * (nodejs/undici#5544) — and Vitest then exits 1 with every test passing.
 * `node:http` with `agent: false` opens one socket per request and never makes
 * that call. Node/Bun only: the Worker lanes import nothing from here.
 * @module tests/helpers/node-http
 */
import { type ClientRequest, type IncomingMessage, request } from 'node:http';

/** One request against `127.0.0.1:<port>`. */
export interface NodeHttpRequest {
  body?: string;
  headers?: Record<string, string>;
  method: 'DELETE' | 'GET' | 'POST';
  path: string;
}

/** A fully read response. */
export interface NodeHttpResponse {
  body: string;
  headers: IncomingMessage['headers'];
  status: number;
}

/** Starts `spec` on a fresh socket and hands the response to `onResponse`. */
export function openRequest(
  port: number,
  spec: NodeHttpRequest,
  onResponse: (response: IncomingMessage, request: ClientRequest) => void,
  onError: (error: Error) => void,
): ClientRequest {
  const headers =
    spec.body === undefined
      ? spec.headers
      : { ...spec.headers, 'Content-Length': String(Buffer.byteLength(spec.body)) };
  const req = request(
    { agent: false, headers, host: '127.0.0.1', method: spec.method, path: spec.path, port },
    (response) => onResponse(response, req),
  );
  req.on('error', onError);
  req.end(spec.body);
  return req;
}

/** Sends `spec` on a fresh socket and reads the whole response. */
export function exchange(port: number, spec: NodeHttpRequest): Promise<NodeHttpResponse> {
  return new Promise((resolve, reject) => {
    openRequest(
      port,
      spec,
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ body, headers: response.headers, status: response.statusCode ?? 0 }),
        );
        response.on('error', reject);
      },
      reject,
    );
  });
}
