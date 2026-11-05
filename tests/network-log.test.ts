import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logTarget, NetworkLogMonitor } from '../src/backend/service/network-log';
import { defaultConfig, fromDraft, toDraft } from '../src/shared/model';
import { changedConfig, publicConfig } from '../src/backend/config/schema';
import { Service } from '../src/backend/service/service';
import { Store } from '../src/backend/storage/state';
import { LANAdapter } from '../src/backend/lan/adapter';

const pause = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
    for (let i = 0; i < 500; i++) { if (check()) return; await pause(); }
    assert.fail('condition timed out');
}

test('network log config whitelists, changes, conflicts, old firmware and drafts', () => {
    const old = defaultConfig('c5');
    const base = { ...old, log_enabled: true, log_port: 8082 };
    assert.equal(publicConfig(base, 'c5').log_port, 8082);
    assert.deepEqual(changedConfig(base, { ...base, log_port: 19082 }, {}, [], 'c5'), { log_port: 19082 });
    for (const patch of [{ log_port: true }, { log_port: '8082' }, { log_port: 65536 },
        { log_port: 8081 }, { log_port: 8080 }, { log_enabled: 1 }, { net_role: 1, local_port: 8082 }])
        assert.throws(() => publicConfig({ ...base, ...patch }, 'c5'));
    publicConfig({ ...base, net_role: 2, local_port: 8082 }, 'c5');
    assert.deepEqual(changedConfig(base, old, {}, [], 'c5'), {});
    assert.throws(() => changedConfig(old, base, {}, [], 'c5'));
    assert.equal(fromDraft(toDraft({ ...base, log_port: '19082' }), 'c5').log_port, 19082);
    assert.throws(() => logTarget('invalid', '8082'));
    assert.throws(() => logTarget('127.0.0.1', '1'));
});

test('real TCP logs decode fragmented UTF8, bound lines, recover, reset stats and reconnect', async () => {
    const peers: net.Socket[] = [];
    const server = net.createServer((peer) => peers.push(peer));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const lines: string[] = [];
    const monitor = new NetworkLogMonitor('127.0.0.1', (server.address() as net.AddressInfo).port, (s) => lines.push(s));
    try {
        monitor.start();
        await until(() => peers.length === 1);
        const data = Buffer.from('E (4) 中文日志\nI (5) stats: IP=192.168.4.1 ch=6 RSSI=-50 session=1 local->net=10 net->local=20\n');
        for (const b of data) peers[0].write(Buffer.from([b]));
        peers[0].write('x'.repeat(10000) + '\nC5CFG private\nI (6) recovered\n');
        await until(() => lines.includes('I (6) recovered'));
        assert(lines.includes('E (4) 中文日志'));
        assert(!lines.some((s) => s.includes('private')));
        assert.equal(monitor.status().dropped, 1);
        assert.equal(monitor.fields.IP, '192.168.4.1');
        peers[0].destroy();
        await until(() => peers.length === 2 && monitor.connected);
        assert.deepEqual(monitor.fields, {});
        peers[1].write('W (7) reconnected\n');
        await until(() => lines.includes('W (7) reconnected'));
    } finally {
        await monitor.close();
        peers.forEach((s) => s.destroy());
        await new Promise<void>((r) => server.close(() => r()));
    }
    assert.equal(monitor.connected, false);
});

test('LAN API network logs need no COM, preserve sources, export, clear and restore without connecting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tcp2com-net-log-'));
    const service = new Service(new Store(directory));
    const server = net.createServer((peer) => peer.write('E (1) service regression\n'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
        await service.init();
        service.baseline = { ...defaultConfig('c5'), log_enabled: false, log_port: 19082 };
        const imported = await service.execute('import_config', [JSON.stringify({ format: 'wifi-bridge-user-config-v1', config: defaultConfig('c5') })]);
        assert.equal(imported.log_port, 19082);
        assert.equal(imported.log_enabled, false);
        service.baseline = null;
        const adapter = new LANAdapter(service);
        const token = adapter.connect(adapter.invite, 'test', '127.0.0.1', 'x'.repeat(24)).token;
        const call = (method: string, args: any[]) => adapter.dispatch(token, method, args, adapter.revision);
        assert((await call('update_settings', [{ net_log_host: '127.0.0.1', net_log_port: String((server.address() as net.AddressInfo).port) }])).ok);
        assert((await call('network_log', [true])).ok);
        await until(() => service.logs.some((r) => r.source === 'net'));
        const snapshot = service.poll();
        assert.equal(snapshot.running, false);
        assert.equal(snapshot.usb, null);
        assert(snapshot.net_log?.connected);
        assert(service.logs.some((r) => r.source === 'net' && r.level === 'E'));
        assert.match(await service.execute('export_logs', []), /网络 \/ ESP/);
        await service.execute('clear_logs', []);
        assert.equal(service.logs.length, 0);
        await service.close();
        const restored = new Service(new Store(directory));
        await restored.init();
        assert.equal(restored.settings.net_log_host, '127.0.0.1');
        assert.equal(restored.poll().net_log, null);
        await restored.close();
    } finally {
        await service.close();
        await new Promise<void>((r) => server.close(() => r()));
        await rm(directory, { recursive: true, force: true });
    }
});
