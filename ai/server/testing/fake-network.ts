import type { SiteTransport, TcpSocket, TlsStream } from '../site/safe-fetch.ts';

/**
 * A scripted network for tests. No socket, no DNS, no Internet.
 *
 * Records every lookup, connection, TLS hostname and request, and tracks every
 * TCP socket and TLS stream it hands out, so a test can assert that nothing
 * was left open — including after a timeout.
 */

export const CRLF = String.fromCharCode(13, 10);

export type FakeRequest = { ip: string; hostname: string; path: string; raw: string };
export type FakeReply = string | { hang: true };

export type FakeServerOptions = {
  /** Reported remote address. Defaults to the IP that was dialled. */
  remoteAddress?: string | null;
  connectError?: Error;
  tlsError?: Error;
  /** Bytes returned per read. */
  chunkSize?: number;
  reply: (request: FakeRequest) => FakeReply;
};

type Records = { A?: string[] | Error; AAAA?: string[] | Error };

export class FakeNetwork implements SiteTransport {
  readonly lookups: string[] = [];
  readonly connections: string[] = [];
  readonly tlsHostnames: string[] = [];
  readonly requests: FakeRequest[] = [];

  private readonly dns = new Map<string, Records>();
  private readonly servers = new Map<string, FakeServerOptions>();
  private readonly resources: { kind: 'tcp' | 'tls'; closed: boolean }[] = [];

  host(hostname: string, records: Records): this {
    this.dns.set(hostname, records);
    return this;
  }

  server(ip: string, options: FakeServerOptions): this {
    this.servers.set(ip, options);
    return this;
  }

  get openResources(): number {
    return this.resources.filter((resource) => !resource.closed).length;
  }

  get resourceCount(): number {
    return this.resources.length;
  }

  async resolve(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]> {
    this.lookups.push(`${recordType} ${hostname}`);
    const answer = this.dns.get(hostname)?.[recordType];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ? [...answer] : [];
  }

  async connect(ip: string, port: number): Promise<TcpSocket> {
    this.connections.push(`${ip} ${port}`);
    const server = this.servers.get(ip);
    if (!server) {
      throw new Error('connection refused');
    }
    if (server.connectError) {
      throw server.connectError;
    }
    const tcp = { kind: 'tcp' as const, closed: false };
    this.resources.push(tcp);

    return {
      remoteAddress: server.remoteAddress === undefined ? ip : server.remoteAddress,
      upgradeToTls: async (hostname: string) => {
        this.tlsHostnames.push(hostname);
        if (server.tlsError) {
          throw server.tlsError;
        }
        return this.stream(ip, hostname, server);
      },
      close: () => {
        tcp.closed = true;
      },
    };
  }

  private stream(ip: string, hostname: string, server: FakeServerOptions): TlsStream {
    const tls = { kind: 'tls' as const, closed: false };
    this.resources.push(tls);
    const chunkSize = server.chunkSize ?? 1024;
    let written = '';
    let pending: Uint8Array | null = null;
    let hang = false;
    let offset = 0;
    let waiters: (() => void)[] = [];

    return {
      write: async (data: Uint8Array) => {
        written += new TextDecoder().decode(data);
        return data.length;
      },
      read: async (buffer: Uint8Array) => {
        if (pending === null) {
          const requestLine = written.split(CRLF)[0] ?? '';
          const request: FakeRequest = { ip, hostname, path: requestLine.split(' ')[1] ?? '', raw: written };
          this.requests.push(request);
          const reply = server.reply(request);
          if (typeof reply === 'string') {
            pending = new TextEncoder().encode(reply);
          } else {
            hang = true;
            pending = new Uint8Array(0);
          }
        }
        if (hang) {
          return new Promise<number | null>((resolve) => {
            if (tls.closed) {
              resolve(null);
              return;
            }
            waiters.push(() => resolve(null));
          });
        }
        if (offset >= pending.length) {
          return null;
        }
        const count = Math.min(chunkSize, buffer.length, pending.length - offset);
        buffer.set(pending.subarray(offset, offset + count));
        offset += count;
        return count;
      },
      close: () => {
        tls.closed = true;
        for (const waiter of waiters) waiter();
        waiters = [];
      },
    };
  }
}

/** A raw HTTP/1.1 response. Adds Content-Length unless framing is given or suppressed. */
export function httpResponse(
  status: number,
  headers: Record<string, string>,
  body = '',
  options: { noLength?: boolean } = {}
): string {
  const lines = [`HTTP/1.1 ${status} Test`];
  const framed = Object.keys(headers).some((name) =>
    ['content-length', 'transfer-encoding'].includes(name.toLowerCase())
  );
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  if (!framed && !options.noLength) {
    lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  }
  return `${lines.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** A chunked body from parts, sizes in bytes. */
export function chunkedBody(parts: readonly string[]): string {
  return (
    parts
      .map((part) => `${new TextEncoder().encode(part).length.toString(16)}${CRLF}${part}${CRLF}`)
      .join('') + `0${CRLF}${CRLF}`
  );
}

export function htmlPage(body: string, headers: Record<string, string> = {}): string {
  return httpResponse(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body);
}
