import type { SiteTransport, TcpSocket, TlsStream } from './safe-fetch.ts';

/**
 * The only code that touches Deno networking, and it decides nothing.
 *
 * Every policy — which addresses are acceptable, what the remote address must
 * be, what a response may contain — lives in safe-fetch.ts and is tested there.
 * This adapter maps three Deno calls onto the transport interface:
 *
 *   Deno.resolveDns(hostname, 'A' | 'AAAA')
 *   Deno.connect({ hostname: <validated IP>, port: 443, transport: 'tcp' })
 *   Deno.startTls(conn, { hostname: <original hostname> })  then handshake()
 *
 * `startTls` receives the hostname and NOTHING else: no caCerts, no option that
 * could weaken verification. Deno.connectTls is not used, because it couples
 * the address it connects to with the name it validates, which is exactly what
 * pinning must keep apart.
 *
 * Typed against the members it uses rather than the Deno namespace, so it
 * compiles and is tested under Node with a fake.
 */

export type DenoNetAddrLike = { transport: string; hostname?: string; port?: number };

export type DenoTcpConnLike = {
  readonly remoteAddr: DenoNetAddrLike;
  close(): void;
};

export type DenoTlsConnLike = {
  handshake(): Promise<unknown>;
  read(buffer: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  close(): void;
};

export type DenoNetApi<Tcp extends DenoTcpConnLike> = {
  resolveDns(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]>;
  connect(options: { hostname: string; port: number; transport: 'tcp' }): Promise<Tcp>;
  startTls(conn: Tcp, options: { hostname: string }): Promise<DenoTlsConnLike>;
};

export function createDenoTransport<Tcp extends DenoTcpConnLike>(api: DenoNetApi<Tcp>): SiteTransport {
  return {
    async resolve(hostname, recordType) {
      let answers: unknown;
      try {
        answers = await api.resolveDns(hostname, recordType);
      } catch (error) {
        // NXDOMAIN or no record of this type: an empty answer, not a failure.
        // Every other error propagates, and safe-fetch fails closed on it.
        if (errorName(error) === 'NotFound') {
          return [];
        }
        throw error;
      }
      if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== 'string')) {
        throw new Error('unexpected DNS answer shape');
      }
      return answers as string[];
    },

    async connect(ip, port) {
      const tcp = await api.connect({ hostname: ip, port, transport: 'tcp' });
      const remote = tcp.remoteAddr;

      const socket: TcpSocket = {
        remoteAddress:
          remote && remote.transport === 'tcp' && typeof remote.hostname === 'string'
            ? remote.hostname
            : null,

        async upgradeToTls(hostname) {
          const tls = await api.startTls(tcp, { hostname });
          try {
            await tls.handshake();
          } catch (error) {
            closeQuietly(tls);
            throw error;
          }
          const stream: TlsStream = {
            read: (buffer) => tls.read(buffer),
            write: (data) => tls.write(data),
            close: () => closeQuietly(tls),
          };
          return stream;
        },

        close: () => closeQuietly(tcp),
      };
      return socket;
    },
  };
}

function errorName(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : null;
}

function closeQuietly(resource: { close(): void }): void {
  try {
    resource.close();
  } catch {
    // Already closed, or consumed by the TLS upgrade.
  }
}
