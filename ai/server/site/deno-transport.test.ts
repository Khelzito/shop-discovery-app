import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDenoTransport } from './deno-transport.ts';
import type { DenoTcpConnLike, DenoTlsConnLike } from './deno-transport.ts';

type FakeTcp = DenoTcpConnLike & { closed: boolean };

function fakeTls(overrides: Partial<DenoTlsConnLike> = {}): DenoTlsConnLike & { closed: boolean } {
  const tls = {
    closed: false,
    handshake: async () => undefined,
    read: async () => null,
    write: async (data: Uint8Array) => data.length,
    close() {
      tls.closed = true;
    },
    ...overrides,
  };
  return tls;
}

function fakeApi(options: {
  answers?: string[] | Error;
  remote?: { transport: string; hostname?: string };
  tls?: DenoTlsConnLike;
} = {}) {
  const calls = { connect: [] as unknown[], startTls: [] as { conn: unknown; options: unknown }[] };
  const tcp: FakeTcp = {
    remoteAddr: options.remote ?? { transport: 'tcp', hostname: '93.184.215.14', port: 443 },
    closed: false,
    close() {
      tcp.closed = true;
    },
  };
  const api = {
    resolveDns: async () => {
      if (options.answers instanceof Error) throw options.answers;
      return options.answers ?? ['93.184.215.14'];
    },
    connect: async (connectOptions: { hostname: string; port: number; transport: 'tcp' }) => {
      calls.connect.push(connectOptions);
      return tcp;
    },
    startTls: async (conn: FakeTcp, tlsOptions: { hostname: string }) => {
      calls.startTls.push({ conn, options: tlsOptions });
      return options.tls ?? fakeTls();
    },
  };
  return { api, calls, tcp };
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('deno transport — DNS', () => {
  it('returns the runtime answers', async () => {
    const { api } = fakeApi({ answers: ['93.184.215.14', '151.101.1.140'] });
    assert.deepEqual(await createDenoTransport(api).resolve('shop.fr', 'A'), ['93.184.215.14', '151.101.1.140']);
  });

  it('turns NotFound into an empty answer', async () => {
    const { api } = fakeApi({ answers: named('NotFound') });
    assert.deepEqual(await createDenoTransport(api).resolve('shop.fr', 'AAAA'), []);
  });

  it('propagates every other error, so safe-fetch fails closed', async () => {
    const { api } = fakeApi({ answers: named('TimedOut') });
    await assert.rejects(createDenoTransport(api).resolve('shop.fr', 'A'), /TimedOut/);
  });

  it('refuses an answer that is not a list of strings', async () => {
    const { api } = fakeApi({ answers: [{ address: '1.1.1.1' }] as unknown as string[] });
    await assert.rejects(createDenoTransport(api).resolve('shop.fr', 'A'), /shape/);
  });
});

describe('deno transport — pinned connection', () => {
  it('connects to the IP it is given, over TCP port 443, and reports the peer address', async () => {
    const { api, calls } = fakeApi();
    const socket = await createDenoTransport(api).connect('93.184.215.14', 443);
    assert.deepEqual(calls.connect, [{ hostname: '93.184.215.14', port: 443, transport: 'tcp' }]);
    assert.equal(socket.remoteAddress, '93.184.215.14');
  });

  it('reports no address for a non-TCP peer', async () => {
    const { api } = fakeApi({ remote: { transport: 'unix' } });
    assert.equal((await createDenoTransport(api).connect('93.184.215.14', 443)).remoteAddress, null);
  });

  it('starts TLS on that same connection with the original hostname and NO other option', async () => {
    const { api, calls, tcp } = fakeApi();
    const socket = await createDenoTransport(api).connect('93.184.215.14', 443);
    await socket.upgradeToTls('shop.fr');
    assert.equal(calls.startTls.length, 1);
    assert.equal(calls.startTls[0]!.conn, tcp);
    assert.deepEqual(calls.startTls[0]!.options, { hostname: 'shop.fr' });
    assert.deepEqual(Object.keys(calls.startTls[0]!.options as object), ['hostname']);
  });

  it('completes the handshake before returning, and closes the stream when it fails', async () => {
    const tls = fakeTls({ handshake: async () => { throw new Error('invalid peer certificate: Expired'); } });
    const { api } = fakeApi({ tls });
    const socket = await createDenoTransport(api).connect('93.184.215.14', 443);
    await assert.rejects(socket.upgradeToTls('expired.shop.fr'), /Expired/);
    assert.equal(tls.closed, true);
  });

  it('proxies reads and writes, and closes quietly', async () => {
    const tls = fakeTls({ read: async () => 7, write: async () => 3, close: () => { throw new Error('BadResource'); } });
    const { api, tcp } = fakeApi({ tls });
    const socket = await createDenoTransport(api).connect('93.184.215.14', 443);
    const stream = await socket.upgradeToTls('shop.fr');
    assert.equal(await stream.read(new Uint8Array(8)), 7);
    assert.equal(await stream.write(new Uint8Array(3)), 3);
    assert.doesNotThrow(() => stream.close());
    socket.close();
    assert.equal(tcp.closed, true);
  });
});
