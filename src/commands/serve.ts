import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { saveConfig, VALID_COUNTRIES } from '../config.js';
import { performLogin } from './login.js';
import { performSearch, type FullSearchResult } from './search.js';

const BODY_LIMIT = 8192;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface HandlerResult {
  status: number;
  body: unknown;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { success: false, error });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  sendError(res, 405, `Method not allowed. Use ${allow}.`);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) {
      throw new HttpError(413, 'Request body too large.');
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function parseCountry(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Country must be a string.');
  }
  const country = value.toLowerCase();
  if (!(VALID_COUNTRIES as readonly string[]).includes(country)) {
    throw new HttpError(
      400,
      `Invalid country "${value}". Valid options: ${VALID_COUNTRIES.join(', ')}`,
    );
  }
  return country;
}

async function handleLogin(
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  const country = parseCountry(body.country);
  const apiKey = await performLogin(country, (msg) => console.error(msg));
  return { status: 200, body: { success: true, apiKey } };
}

async function handleSetZip(
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  const zipCode = body.zipCode;
  if (typeof zipCode !== 'string' || zipCode.trim() === '') {
    throw new HttpError(
      400,
      'Request body must include a non-empty "zipCode" string.',
    );
  }
  await saveConfig({ zipCode });
  return { status: 200, body: { success: true, zipCode } };
}

async function handleSearch(url: URL): Promise<HandlerResult> {
  const q = url.searchParams.get('q');
  if (!q) {
    throw new HttpError(400, 'Missing required query parameter: q.');
  }
  const limitParam = url.searchParams.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new HttpError(
        400,
        'Query parameter "limit" must be a positive integer.',
      );
    }
    limit = parsed;
  }
  const full: FullSearchResult = await performSearch(q, {
    zip: url.searchParams.get('zip') ?? undefined,
    country: parseCountry(url.searchParams.get('country') ?? undefined),
    limit,
    retailer: url.searchParams.get('retailer') ?? undefined,
    log: (msg) => console.error(msg),
  });
  return { status: 200, body: full };
}

function statusForError(error: Error): number {
  if (error instanceof HttpError) return error.status;
  if (error.message.includes('API key invalid or expired')) return 401;
  if (error.message.startsWith('API error:')) return 502;
  return 500;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  try {
    if (url.pathname === '/login') {
      if (method !== 'POST') return sendMethodNotAllowed(res, 'POST');
      const result = await handleLogin(await readJsonBody(req));
      return sendJson(res, result.status, result.body);
    }
    if (url.pathname === '/set-zip') {
      if (method !== 'POST') return sendMethodNotAllowed(res, 'POST');
      const result = await handleSetZip(await readJsonBody(req));
      return sendJson(res, result.status, result.body);
    }
    if (url.pathname === '/search') {
      if (method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      const result = await handleSearch(url);
      return sendJson(res, result.status, result.body);
    }
    sendError(res, 404, `Not found: ${method} ${url.pathname}`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    sendError(res, statusForError(err), err.message);
  }
}

export function createRequestHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => void {
  return (req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, (error as Error).message ?? 'Internal error.');
      } else {
        res.end();
      }
    });
  };
}

export function createServer(): Server {
  return createHttpServer(createRequestHandler());
}

export interface ServeOptions {
  host?: string;
  port?: number;
}

export async function serve(options: ServeOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : port;
  console.log(
    `Listening on http://${host}:${actualPort} (POST /login, POST /set-zip, GET /search)`,
  );
}
