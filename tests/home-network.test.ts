import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { defaultConfig } from '../src/shared/model';
import { addresses, choose, windowsInventory, Address } from '../src/backend/lan/network';
import { BackendOwner } from '../src/host/broker';
import { Service } from '../src/backend/service/service';
import { Store } from '../src/backend/storage/state';
import { BridgeEngine } from '../src/backend/bridge/engine';
import { MockBinding } from '@serialport/binding-mock';
import { SerialPortStream } from '@serialport/stream';

const nativeRows: Address[] = [
    { id: 'wlan', name: 'WLAN', ip: '192.168.1.2', status: 'Up', family: 4, addressState: 'Preferred' },
    { id: 'wlan', name: 'WLAN', ip: '192.168.1.3', status: 'Up', family: 4, addressState: 'Preferred' },
    { id: 'hyper', name: 'vEthernet', ip: '172.20.0.1', status: 'Up', family: 4 },
    { id: 'off', name: 'Ethernet', ip: '', status: 'Disconnected', family: 4 },
    { id: 'six', name: 'IPv6 only', ip: 'fe80::1', status: 'Up', family: 6 },
    { id: 'vpn', name: 'VPN', ip: '100.64.0.1', status: 'Up', family: 4 },
];
test('inventory preserves every adapter, multiple addresses and reasons', async () => {
    const result = await addresses('0.0.0.0', {
        native: async () => structuredClone(nativeRows),
        node: () => [],
    });
    assert.equal(result.items.length, 7);
    assert.equal(result.warning, '');
    assert.equal(result.items.filter((x) => x.id === 'wlan').length, 2);
    assert.match(result.items.find((x) => x.id === 'off')!.reason!, /未连接/);
    assert.match(result.items.find((x) => x.id === 'six')!.reason!, /IPv4/);
    assert.match(result.items.find((x) => x.id === 'vpn')!.reason!, /访问规则/);
});
test('fixed listen range marks incompatible rows instead of hiding adapters', async () => {
    const result = await addresses('127.0.0.1', {
        native: async () => structuredClone(nativeRows),
        node: () => [],
    });
    assert(result.items.some((x) => x.name === 'WLAN'));
    assert.equal(result.items.filter((x) => x.shareable).length, 1);
    assert.equal(choose(result.items).selected!.ip, '127.0.0.1');
});
test('failed Windows scan falls back without claiming a stable native identity', async () => {
    const result = await addresses('0.0.0.0', {
        native: async () => {
            throw Error('parser failure');
        },
        node: () => [{ id: 'interface:WLAN', name: 'WLAN', ip: '192.168.1.2', status: 'Up', family: 4 }],
    });
    assert.match(result.warning, /备用列表/);
    assert.equal(result.items.find((x) => x.name === 'WLAN')!.id, 'interface:WLAN');
    const selected = choose(result.items, { id: 'windows:old', name: 'old', ip: '192.168.1.4' });
    assert.equal(selected.selected!.id, 'loopback');
});
test('native scan merges missing active addresses using the same stable identity', async () => {
    const result = await addresses('0.0.0.0', {
        native: async () => [nativeRows[0]],
        node: () => [{ id: 'interface:WLAN', name: 'WLAN', ip: '192.168.1.9', status: 'Up', family: 4 }],
    });
    assert.equal(result.items.find((x) => x.ip === '192.168.1.9')!.id, 'wlan');
});
test(
    'real Windows inventory script parses and returns adapter metadata',
    { skip: process.platform !== 'win32' },
    async () => {
        const rows = await windowsInventory();
        assert(Array.isArray(rows));
        assert(rows.every((x) => typeof x.status === 'string'));
        const result = await addresses('0.0.0.0');
        assert.equal(result.warning, '');
        assert(result.items.some((x) => x.id === 'loopback'));
    },
);
async function ownerFixture(t: any) {
    const directory = await mkdtemp(join(tmpdir(), 'tcp2com-home-'));
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const owner = new BackendOwner(directory, join(__dirname, '../../frontend/dist'), 'test', {
        listen: '127.0.0.1',
        port,
        origins: [],
    });
    await owner.initialize();
    t.after(async () => {
        await owner.close();
        await rm(directory, { recursive: true, force: true });
    });
    return owner;
}
test('opening homepage reads state without starting HTTP, bridge or USB', async (t) => {
    const owner = await ownerFixture(t);
    const state = await owner.call('home-state', [], 'home');
    assert.equal(state.backend, false);
    assert.equal(state.snapshot.running, false);
    assert.equal(state.snapshot.usb, null);
});
test('sidebar configuration has its own read receipt, previews secrets and rejects stale saves', async (t) => {
    const owner = await ownerFixture(t);
    let posts = 0,
        saved: any;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET')
            res.end(
                JSON.stringify({
                    ...defaultConfig('c5'),
                    config_api: 'c5-config-2',
                    revision: 7,
                    http_session: '0123456789abcdef-1',
                }),
            );
        else {
            posts++;
            assert.equal(req.headers['x-c5-session'], '0123456789abcdef-1');
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                saved = JSON.parse(body);
                res.end('{"saved":true,"restart":true}');
            });
        }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const scope = 'home-' + 'a'.repeat(24);
    const configCall = (operation: string, args: any[] = [], patch = {}, revision = owner.adapter.revision) =>
        owner.call('home-config', [scope, operation, args, revision, patch], 'window');
    const { token } = await owner.call('register', [], 'window');
    await owner.adapter.dispatch(
        token,
        'update_settings',
        [
            {
                config_transport: 'http',
                config_url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`,
            },
        ],
        owner.adapter.revision,
    );
    const workbenchRead = await owner.adapter.dispatch(token, 'read_device', [], owner.adapter.revision);
    assert(workbenchRead.ok);
    await assert.rejects(configCall('preview_save', [workbenchRead.data, {}, []]), /本终端重新读取/);
    const read = await configCall('read_device');
    assert(read.ok);
    // Named-pipe JSON encodes omitted optional argument slots as null.
    const throughIPC = await owner.call(
        'home-config',
        [scope, 'preview_save', [read.data, {}, []], owner.adapter.revision, null],
        'window',
    );
    assert(throughIPC.ok);
    const edited = { ...read.data, baud: 2000000 };
    const invalid = await configCall('preview_save', [{ ...edited, tcp_port: 0 }, {}, []]);
    assert.equal(invalid.ok, false);
    const preview = await configCall('preview_save', [edited, { pc: 'test-secret-123' }, []]);
    assert(preview.ok);
    assert(!JSON.stringify(preview).includes('test-secret-123'));
    assert(preview.data.changes.some((c: any) => c.value === '（更新密码）'));
    await assert.rejects(
        configCall('save_device', [edited, {}, [], read.epoch], {}, preview.revision - 1),
        /其他终端/,
    );
    assert.equal(posts, 0);
    const result = await configCall('save_device', [edited, {}, [], read.epoch]);
    assert(result.ok && result.data.saved);
    assert.equal(saved.revision, 7);
    assert.equal(saved.baud, 2000000);
    assert.equal(posts, 1);
    await assert.rejects(configCall('save_device', [edited, {}, [], read.epoch]), /本终端重新读取/);
    await configCall('read_device');
    await owner.adapter.dispatch(token, 'read_device', [], owner.adapter.revision);
    await assert.rejects(configCall('preview_save', [edited, {}, []]), /本终端重新读取/);
    await owner.call('unregister', [scope], 'window');
    assert(owner.adapter.clients.has(token));
    assert(![...owner.adapter.clients.values()].some((c) => c.name === 'VS Code 侧栏配置'));
});
test('homepage rejects stale writes and invalid bridge settings before startup', async (t) => {
    const owner = await ownerFixture(t);
    await assert.rejects(
        owner.call('home-control', ['save-settings', { com: 'COM42' }, -1], 'home'),
        /其他终端/,
    );
    await assert.rejects(owner.call('home-control', ['bridge-start', { com: '' }, 0], 'home'), /COM/);
    assert.equal(owner.http, undefined);
    await owner.call('home-control', ['save-settings', { com: 'COM42' }, 0], 'home');
    assert.equal(owner.service.settings.com, 'COM42');
    assert.equal(owner.adapter.revision, 1);
});
test('stopping a bridge preserves independent USB; stopping backend closes both', async (t) => {
    const owner = await ownerFixture(t);
    let closed = 0;
    owner.service.usbMonitor = {
        close: async () => {
            closed++;
        },
        status: () => ({ connected: true }),
    } as any;
    await owner.call('home-control', ['bridge-stop', {}, 0], 'home');
    assert.equal(closed, 0);
    assert(owner.service.usbMonitor);
    await owner.call('start', [], 'home');
    await owner.call('stop', [], 'home');
    assert.equal(closed, 1);
    assert.equal(owner.service.usbMonitor, undefined);
    assert.equal(owner.http, undefined);
});
test('homepage starts backend and simulated bridge, restarts and stops via shared dispatcher', async (t) => {
    const owner = await ownerFixture(t);
    const { LANAdapter } = await import('../src/backend/lan/adapter');
    const path = 'HOME-MOCK';
    MockBinding.createPort(path, { record: true });
    owner.service = new Service(
        new Store(owner.directory),
        (log) =>
            new BridgeEngine(log, async (options) => {
                const port = new SerialPortStream({
                    binding: MockBinding,
                    ...options,
                    path,
                    autoOpen: false,
                } as any);
                await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
                return port;
            }),
    );
    await owner.service.init();
    owner.adapter = new LANAdapter(owner.service);
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await owner.call(
        'home-control',
        ['bridge-start', { com: path, listen: '127.0.0.1', port: String(port) }, 0],
        'home',
    );
    const running = await owner.call('home-state', [], 'home');
    assert.equal(running.backend, true);
    assert.equal(running.snapshot.running, true);
    const engine = owner.service.engine;
    owner.service.usbMonitor = { port: path } as any;
    await assert.rejects(
        owner.call('home-control', ['bridge-restart', {}, owner.adapter.revision], 'home'),
        /USB/,
    );
    assert.equal(owner.service.engine, engine);
    assert(engine.running);
    owner.service.usbMonitor = undefined;
    await owner.call('home-control', ['bridge-restart', {}, owner.adapter.revision], 'home');
    assert.notEqual(owner.service.engine, engine);
    assert(owner.service.engine.running);
    await owner.call('home-control', ['bridge-stop', {}, owner.adapter.revision], 'home');
    assert.equal(owner.service.engine.running, false);
    assert(owner.http);
});
test('chosen adapter must be shareable and listener changes apply after restart', async (t) => {
    const owner = await ownerFixture(t);
    const before = await owner.call('status', [true], 'home');
    const blocked = before.addresses.find((x: Address) => x.shareable === false);
    if (blocked) await assert.rejects(owner.call('choose', [blocked.id, blocked.ip], 'home'));
    await owner.call('start', [], 'home');
    await owner.call('configure', [{ listen: '0.0.0.0', port: owner.options.port, origins: [] }], 'home');
    assert.equal((await owner.call('home-state', [], 'home')).listen, '127.0.0.1');
    await owner.call('stop', [], 'home');
    await owner.call('start', [], 'home');
    assert.equal((await owner.call('home-state', [], 'home')).listen, '0.0.0.0');
});
test('scan finishing after listener reconfiguration uses the current sharing range', async (t) => {
    const owner = await ownerFixture(t);
    const pending = owner.call('status', [true], 'home');
    await owner.call('configure', [{ listen: '0.0.0.0', port: owner.options.port, origins: [] }], 'home');
    await owner.call('start', [], 'home');
    const current = await pending;
    assert.equal(current.listen, '0.0.0.0');
    assert(!current.addresses.some((row: Address) => row.reason?.includes('监听范围')));
});
