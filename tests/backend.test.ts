import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { MockBinding } from '@serialport/binding-mock';
import { SerialPortStream } from '@serialport/stream';
import { defaults, defaultConfig, parseJSON, runtimeSettings } from '../src/shared/model';
import { changedConfig, publicConfig, validateConfig, OutcomeUnknown } from '../src/backend/config/schema';
import { HTTPConfig, USBConfig } from '../src/backend/config/client';
import { Store, cleanState, stateDocument } from '../src/backend/storage/state';
import { Service } from '../src/backend/service/service';
import { LANAdapter } from '../src/backend/lan/adapter';
import { LANServer } from '../src/backend/lan/server';
import { BridgeEngine } from '../src/backend/bridge/engine';
import { USBMonitor, parseStats } from '../src/backend/usb/monitor';
import { ResetControl } from '../src/backend/reset/control';
import { dcbFlags, configureWindows } from '../src/backend/serial/windows';
import { choose } from '../src/backend/lan/network';
import { Broker } from '../src/host/broker';
import { configureKeepalive } from '../src/backend/bridge/keepalive';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await sleep();
    }
    assert.fail('condition timed out');
}
async function fixture(t: any) {
    const directory = await mkdtemp(join(tmpdir(), 'tcp2com-test-'));
    const service = new Service(new Store(directory));
    await service.init();
    t.after(async () => {
        await service.close();
        await rm(directory, { recursive: true, force: true });
    });
    return { service, adapter: new LANAdapter(service), directory };
}
function enroll(adapter: LANAdapter, name = 'test') {
    return adapter.connect(adapter.invite, name, '127.0.0.1', name.padEnd(24, 'x')).token;
}
function invoke(
    adapter: LANAdapter,
    token: string,
    method: string,
    args: any[] = [],
    revision = adapter.revision,
) {
    return adapter.dispatch(token, method, args, revision);
}
let portCounter = 0;
function mockPort(echo = false) {
    const name = `MOCK-${++portCounter}`;
    MockBinding.createPort(name, { echo, record: true });
    return {
        name,
        open: async (options: any) => {
            const port = new SerialPortStream({
                binding: MockBinding,
                ...options,
                path: name,
                autoOpen: false,
            });
            await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
            return port;
        },
    };
}
async function listen(server: net.Server | http.Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
}
test('settings rejects unknown, malformed and nonfinite values', () => {
    for (const patch of [
        { port: 'NaN' },
        { baud: '0' },
        { bufsize: '1' },
        { keepalive_interval: '0' },
        { listen: 'localhost' },
        { device: 'x' },
    ])
        assert.throws(() => runtimeSettings({ ...defaults, ...patch }));
    assert.equal(runtimeSettings({ ...defaults }).baud, 1152000);
});
test('frozen legacy frontend hashes match the original artifact', async () => {
    const root = join(__dirname, '../../tests/compatibility');
    const manifest = JSON.parse(
        (await readFile(join(root, 'legacy-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''),
    );
    for (const file of manifest) {
        const bytes = await readFile(join(root, 'legacy-frontend', file.path));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
});
test(
    'Windows Keepalive applies custom interval and probe count to exact endpoint',
    { skip: process.platform !== 'win32' },
    async (t) => {
        const server = net.createServer((s) => s.on('end', () => s.end()));
        const port = await listen(server);
        const socket = net.connect(port, '127.0.0.1');
        await new Promise<void>((r) => socket.once('connect', r));
        t.after(async () => {
            socket.destroy();
            await new Promise<void>((r) => server.close(() => r()));
        });
        assert.deepEqual(
            configureKeepalive(socket, { keepalive_idle: 3, keepalive_interval: 2, keepalive_count: 5 }),
            { found: true, intervalApplied: true, countApplied: true },
        );
    },
);
test('USB lost save acknowledgement is unknown and never replayed', async (t) => {
    const mock = mockPort(false);
    const monitor = new USBMonitor(mock.name, 115200, 'c5', () => {}, '', mock.open);
    await monitor.start();
    t.after(() => monitor.close());
    const request = monitor.request('save', { baud: 2000000 }, monitor.identity());
    const rejected = assert.rejects(request, OutcomeUnknown);
    await sleep();
    await monitor.close();
    await rejected;
    const written = (monitor.serial!.port as any).recording.toString();
    assert.equal(written.split('"op":"save"').length - 1, 1);
});
test('JSON protocol rejects duplicate and prototype fields', () => {
    assert.throws(() => parseJSON('{"a":1,"a":2}'));
    assert.throws(() => parseJSON('{"pc":{"ssid":"x","ssid":"y"}}'));
    assert.throws(() => parseJSON('{"__proto__":{}}'));
    assert.deepEqual(parseJSON('{"a":[{"a":1},{"a":2}]}'), { a: [{ a: 1 }, { a: 2 }] });
});
test('public snapshots and persisted drafts strip passwords and sessions', () => {
    const c = {
        ...defaultConfig('c5'),
        ap_password: 'private-password',
        http_session: 'private-session',
        pc: { ...defaultConfig('c5').pc, password: 'private-password' },
    };
    const p = publicConfig(c, 'c5');
    assert(!JSON.stringify(p).includes('private'));
    const saved = cleanState({
        version: 1,
        forms: {},
        device_drafts: {
            c5: { common: { baud: 1152000, password: 'private' }, pc: { ssid: 'x', password: 'private' } },
        },
    });
    assert(!JSON.stringify(saved).includes('private'));
});
test('configuration rejects bad IP subnet, GPIO conflict and overflow', () => {
    for (const patch of [
        { ap_ip: '192.168.004.1' },
        { ap_netmask: '255.0.255.0' },
        { link_mode: 3, flow_pin: 1, reset_pin: 1 },
        { up_kb: 6000, down_kb: 1024 },
        { ap_channel: 36, band: 0 },
    ])
        assert.throws(() => validateConfig({ ...defaultConfig('c5'), ...patch }, 'c5'));
});
test('device capabilities distinguish C5 SPI and S3 bands', () => {
    assert.throws(() => validateConfig({ ...defaultConfig('s3'), band: 1 }, 's3'));
    assert.throws(() => validateConfig({ ...defaultConfig('c5'), link_mode: 1 }, 'c5'));
    assert.equal(publicConfig({ ...defaultConfig('c5'), link_mode: 1 }, 'c5', true).link_mode, -1);
});
test('password diff preserves blank, permits explicit STA clear and never clears AP', () => {
    const c = defaultConfig('c5');
    assert.deepEqual(changedConfig(c, c, { ap: '', pc: '' }, [], 'c5'), {});
    assert.deepEqual(changedConfig(c, c, {}, ['pc'], 'c5'), { pc: { password: '' } });
    assert.throws(() => changedConfig(c, c, {}, ['ap'], 'c5'));
    assert.throws(() => changedConfig(c, { ...c, link_mode: 4 }, {}, [], 'c5'));
});
test('DSR/DTR control flags preserve unrelated DCB bits', () => {
    assert.equal(dcbFlags(1, { dsrdtr: true }) & (8 | 48), 8 | 32);
    assert.equal(
        dcbFlags(0xffff, { hupcl: false, rts: false, dsrdtr: false, rtscts: false }) & (8 | 48 | 12288),
        0,
    );
    assert.equal(dcbFlags(1, { rtscts: true }) & 12288, 8192);
    if (process.platform === 'win32') assert.throws(() => configureWindows(-1, {}), /无法读取/);
});
test('USB stats parse independent repeated fields', () => {
    assert.deepEqual(parseStats('I (12) stats: queues local->net=2/4 peak=8 net->local=3/4 peak=9'), {
        'queue.local_to_net': '2/4',
        'queue.local_to_net.peak': '8',
        'queue.net_to_local': '3/4',
        'queue.net_to_local.peak': '9',
    });
    assert.deepEqual(parseStats('not stats'), {});
});
test('missing preferred adapter falls back without overwriting identity', () => {
    const preferred = { id: 'windows:missing', name: 'old', ip: '192.168.1.2' };
    const result = choose([{ id: 'loopback', name: 'local', ip: '127.0.0.1' }], preferred);
    assert.equal(result.selected.id, 'loopback');
    assert.equal(preferred.id, 'windows:missing');
});
test('auto enrollment is idempotent and never opens hardware', async (t) => {
    const { adapter, service } = await fixture(t);
    const token = enroll(adapter);
    assert.equal(enroll(adapter), token);
    const reply = await invoke(adapter, token, 'poll');
    assert.equal(reply.data.running, false);
    assert.equal(reply.data.usb, null);
    assert.equal(service.engine.serial, undefined);
    assert.throws(() => adapter.connect('invalid', 'x', '127.0.0.1', 'x'.repeat(24)));
});
test('rotation retains sessions while revoked join cannot replay', async (t) => {
    const { adapter } = await fixture(t);
    const token = enroll(adapter);
    const invite = adapter.invite;
    adapter.rotate();
    assert.notEqual(invite, adapter.invite);
    assert.equal((await invoke(adapter, token, 'poll')).ok, true);
    adapter.revoke(adapter.clients.get(token)!.id);
    await assert.rejects(invoke(adapter, token, 'poll'));
    assert.throws(() => enroll(adapter));
});
test('shared settings reject stale writers and synchronize via poll', async (t) => {
    const { adapter } = await fixture(t);
    const a = enroll(adapter, 'a'),
        b = enroll(adapter, 'b');
    const rev = adapter.revision;
    assert.equal((await invoke(adapter, a, 'update_settings', [{ com: 'COM88' }])).ok, true);
    await assert.rejects(invoke(adapter, b, 'update_settings', [{ com: 'COM99' }], rev));
    assert.equal((await invoke(adapter, b, 'poll')).data.settings.com, 'COM88');
});
test('concurrent writes with the same revision allow just one writer', async (t) => {
    const { adapter } = await fixture(t);
    const a = enroll(adapter, 'a'),
        b = enroll(adapter, 'b');
    const result = await Promise.allSettled([
        invoke(adapter, a, 'update_settings', [{ com: 'COM88' }], 0),
        invoke(adapter, b, 'update_settings', [{ com: 'COM99' }], 0),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
});
test('drafts and read receipts are per terminal', async (t) => {
    const { adapter, service } = await fixture(t);
    const a = enroll(adapter, 'a'),
        b = enroll(adapter, 'b');
    await invoke(adapter, a, 'remember_draft', ['c5', { baud: 99999 }]);
    assert.deepEqual((await invoke(adapter, b, 'initial')).data.drafts, {});
    service.baseline = defaultConfig('c5');
    await assert.rejects(invoke(adapter, b, 'preview_save', [defaultConfig('c5'), {}, []]), /请在本终端/);
});
test('reset clicks from separate terminals never accumulate', async (t) => {
    const { adapter } = await fixture(t);
    const a = enroll(adapter, 'a'),
        b = enroll(adapter, 'b');
    assert.equal((await invoke(adapter, a, 'reset_click', ['192.168.4.1', 8081])).data.count, 1);
    assert.equal((await invoke(adapter, b, 'reset_click', ['192.168.4.1', 8081])).data.count, 1);
});
test('legacy pair approval, cancellation, expiry and management secrecy', async (t) => {
    const { adapter } = await fixture(t);
    const p = adapter.requestPair('test', '127.0.0.1');
    assert.equal(adapter.pairStatus(p.request).state, 'pending');
    adapter.decide(p.id, true);
    const approved = adapter.pairStatus(p.request);
    assert.equal(approved.state, 'approved');
    assert(!JSON.stringify(adapter.snapshot()).includes(approved.token));
    adapter.pairStatus(p.request, true);
    await assert.rejects(invoke(adapter, approved.token, 'poll'));
    assert.throws(() => adapter.decide(p.id, true));
    const expired = adapter.requestPair('expire', '127.0.0.1');
    adapter.pending.get(expired.request)!.until = 0;
    assert.equal(adapter.pairStatus(expired.request).state, 'expired');
});
test('state restore does not start I/O and logs use stable cursors', async (t) => {
    const { service, directory } = await fixture(t);
    await service.importState(JSON.stringify(stateDocument({ ...defaults, com: 'COM77' }, {})));
    assert.equal(service.engine.running, false);
    assert.equal(service.settings.com, 'COM77');
    service.log('first');
    const cursor = service.cursor;
    assert.equal(service.poll(cursor).logs.length, 0);
    await service.execute('clear_logs', []);
    service.log('second');
    assert.equal(service.poll(cursor).logs[0].text, 'second');
    assert.equal(service.poll(0).log_generation, 1);
    await service.close();
    assert.equal(
        cleanState(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).settings.com,
        'COM77',
    );
});
test('HTTP adapter preserves CORS auth routing and local bootstrap', async (t) => {
    const { adapter } = await fixture(t);
    const root = join(__dirname, '..', '..', 'frontend', 'dist');
    const server = new LANServer(adapter, root, ['http://127.0.0.1:4173']);
    const port = await server.listen('127.0.0.1', 0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(base)).text(), /window.__WIFI_BRIDGE__/);
    assert.equal(
        (
            await fetch(base + '/api/call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'poll', args: [] }),
            })
        ).status,
        401,
    );
    assert.equal((await fetch(base, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal(
        (
            await fetch(base + '/api/call', {
                method: 'OPTIONS',
                headers: { Origin: 'http://127.0.0.1:4173' },
            })
        ).headers.get('access-control-allow-private-network'),
        'true',
    );
    const token = enroll(adapter);
    const res = await fetch(base + '/api/call', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            Origin: 'http://127.0.0.1:4173',
        },
        body: JSON.stringify({ method: 'poll', args: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
    assert.equal((await res.json()).ok, true);
    assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 404);
});
test('HTTP config binds revision and session and never persists passwords', async (t) => {
    let saved: any;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET')
            res.end(
                JSON.stringify({
                    ...defaultConfig('c5'),
                    config_api: 'c5-config-2',
                    revision: 5,
                    http_session: '0123456789abcdef-1',
                }),
            );
        else {
            assert.equal(req.headers['x-c5-session'], '0123456789abcdef-1');
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                saved = JSON.parse(body);
                res.end('{"saved":true,"restart":true}');
            });
        }
    });
    const port = await listen(server);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const client = new HTTPConfig(`http://127.0.0.1:${port}/`, 'c5');
    await client.read();
    await client.save({ baud: 2000000 });
    assert.equal(saved.revision, 5);
    assert.equal(saved.baud, 2000000);
});
test('lost HTTP save response is unknown and never retried', async (t) => {
    let posts = 0;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET')
            res.end(JSON.stringify({ ...defaultConfig('c5'), http_session: '0123456789abcdef-1' }));
        else {
            posts++;
            req.socket.destroy();
        }
    });
    const port = await listen(server);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const client = new HTTPConfig(`http://127.0.0.1:${port}/`, 'c5');
    await client.read();
    await assert.rejects(client.save({ baud: 2000000 }), OutcomeUnknown);
    assert.equal(posts, 1);
});
test('TCP server bridge forwards exact binary bytes and rejects second client', async (t) => {
    const mock = mockPort(true),
        engine = new BridgeEngine(() => {}, mock.open);
    t.after(() => engine.stop());
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    await engine.start({ ...defaults, com: mock.name, listen: '127.0.0.1', port: String(port) });
    const socket = net.createConnection({ host: '127.0.0.1', port });
    t.after(() => socket.destroy());
    await until(() => engine.connected);
    const payload = Buffer.from([0, 255, 0, 128, 13, 10, 1, 2]);
    const reply = new Promise<Buffer>((resolve) => socket.once('data', resolve));
    socket.write(payload);
    assert.deepEqual(await reply, payload);
    const extra = net.createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => extra.once('close', () => resolve()));
    assert.equal(engine.connected, true);
    assert.equal(engine.stats.tcp_to_com_bytes, payload.length);
});
test('TCP client reconnect clears old generation data', async (t) => {
    const mock = mockPort(true),
        engine = new BridgeEngine(() => {}, mock.open);
    let current: net.Socket | undefined;
    let count = 0;
    const server = net.createServer((s) => {
        current = s;
        count++;
    });
    const port = await listen(server);
    t.after(async () => {
        await engine.stop();
        current?.destroy();
        await new Promise<void>((r) => server.close(() => r()));
    });
    await engine.start({
        ...defaults,
        com: mock.name,
        mode: 'tcp-client',
        host: '127.0.0.1',
        port: String(port),
        reconnect: '0.02',
    });
    await until(() => engine.connected);
    const generation = engine.generation;
    current!.destroy();
    await until(() => count >= 2 && engine.connected);
    assert(engine.generation > generation);
    const result = new Promise<Buffer>((r) => current!.once('data', r));
    current!.write(Buffer.from('new-session'));
    assert.equal((await result).toString(), 'new-session');
});
test('TCP bridge preserves a fragmented multi-megabyte binary stream', async (t) => {
    const mock = mockPort(true),
        engine = new BridgeEngine(() => {}, mock.open);
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    await engine.start({ ...defaults, com: mock.name, listen: '127.0.0.1', port: String(port) });
    const socket = net.connect(port, '127.0.0.1');
    t.after(async () => {
        socket.destroy();
        await engine.stop();
    });
    await until(() => engine.connected);
    const payload = randomBytes(2 * 1024 * 1024),
        chunks: Buffer[] = [];
    let count = 0;
    const returned = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('binary stream timed out')), 10000);
        socket.on('data', (data) => {
            chunks.push(data);
            count += data.length;
            if (count === payload.length) {
                clearTimeout(timer);
                resolve();
            }
        });
        socket.once('error', reject);
    });
    socket.write(payload);
    await returned;
    assert.equal(
        createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
        createHash('sha256').update(payload).digest('hex'),
    );
    assert.equal(engine.stats.tcp_to_com_drop ?? 0, 0);
    assert.equal(engine.stats.com_to_tcp_drop ?? 0, 0);
});
test('UDP bridge filters peers and splits serial payloads', async (t) => {
    const mock = mockPort(false),
        engine = new BridgeEngine(() => {}, mock.open);
    const peer = dgram.createSocket('udp4');
    await new Promise<void>((r) => peer.bind(0, '127.0.0.1', r));
    const peerPort = (peer.address() as net.AddressInfo).port;
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    t.after(async () => {
        await engine.stop();
        peer.close();
    });
    await engine.start({
        ...defaults,
        com: mock.name,
        mode: 'udp',
        host: '127.0.0.1',
        listen: '127.0.0.1',
        port: String(port),
        peer_port: String(peerPort),
        udp_payload: '3',
    });
    const chunks: Buffer[] = [];
    peer.on('message', (b) => chunks.push(b));
    (engine.serial!.port as any).emitData(Buffer.from('1234567'));
    await until(() => chunks.length === 3);
    assert.deepEqual(
        chunks.map((x) => x.toString()),
        ['123', '456', '7'],
    );
    peer.send(Buffer.from('peer'), port, '127.0.0.1');
    await until(() => engine.stats.tcp_to_com_bytes === 4);
    const other = dgram.createSocket('udp4');
    await new Promise<void>((r) => other.send(Buffer.from('reject'), port, '127.0.0.1', () => r()));
    await until(() => engine.stats.udp_rejected === 1);
    other.close();
});
test('USB configuration shares a single reader with diagnostic logs', async (t) => {
    const mock = mockPort(false),
        logs: string[] = [];
    const monitor = new USBMonitor(mock.name, 115200, 'c5', (s) => logs.push(s), '', mock.open);
    t.after(() => monitor.close());
    await monitor.start();
    const binding = monitor.serial!.port as any;
    let handled = 0;
    const timer = setInterval(() => {
        const text = binding.recording.toString();
        const lines = text.split('\n').filter((s: string) => s.startsWith('C5CFG '));
        while (handled < lines.length) {
            const req = JSON.parse(lines[handled++].slice(6));
            const result =
                req.op === 'hello'
                    ? { device: 'ESP32-C5', protocol: 2 }
                    : req.op === 'read'
                      ? { ...defaultConfig('c5'), config_api: 'c5-config-2', revision: 7 }
                      : req.op === 'validate'
                        ? { valid: true }
                        : { saved: true, restart: true };
            binding.emitData(
                'C5CFG ' +
                    JSON.stringify({
                        v: 2,
                        id: req.id,
                        boot: '0123456789abcdef',
                        session: 1,
                        ok: true,
                        result,
                    }) +
                    '\n',
            );
        }
    }, 5);
    t.after(() => clearInterval(timer));
    const client = new USBConfig(monitor, 'c5');
    const config = await client.read();
    assert.equal(config.revision, 7);
    await client.save({ baud: 2000000 });
    binding.emitData('C5CFG malformed secret\nI (2) stats: IP=192.168.4.1 ch=1 RSSI=-30 session=1\n');
    await until(() => !!monitor.fields.IP);
    assert(!logs.some((x) => x.includes('malformed secret')));
    assert.equal(handled, 4);
});
test('reset requires matching DONE and never sends RESET to wrong protocol', async (t) => {
    let requests = 0;
    const server = net.createServer((socket) => {
        socket.write('C5-RESET/1 READY\n');
        socket.on('data', (data) => {
            requests++;
            const id = data.toString().trim().split(' ')[1];
            socket.end(`STARTED ${id}\nDONE ${id}\n`);
        });
    });
    const port = await listen(server);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const reset = new ResetControl();
    await reset.perform('c5', '127.0.0.1', port);
    assert.equal(requests, 1);
    await assert.rejects(reset.perform('s3', '127.0.0.1', port), /协议不匹配/);
    assert.equal(requests, 1);
});
test('two plugin windows share one broker and release resources on exit', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'tcp2com-broker-'));
    const options = { listen: '127.0.0.1', port: 18769, origins: [] };
    const a = new Broker(directory, join(__dirname, '..', '..', 'frontend', 'dist'), options),
        b = new Broker(directory, join(__dirname, '..', '..', 'frontend', 'dist'), options);
    t.after(async () => {
        await b.close();
        await a.close();
        await rm(directory, { recursive: true, force: true });
    });
    const first = await a.call('register'),
        second = await b.call('register');
    assert.notEqual(first.token, second.token);
    assert(a.owner);
    assert(!b.owner);
    const res = await a.call('call', first.token, 'update_settings', [{ com: 'COM66' }], 0);
    assert(res.ok);
    const status = await b.call('call', second.token, 'poll', [], undefined);
    assert.equal(status.data.settings.com, 'COM66');
});
