// Loopback-only test supervisor. This file is excluded from the VSIX.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Service } = require('../dist/src/backend/service/service');
const { Store } = require('../dist/src/backend/storage/state');
const { LANAdapter } = require('../dist/src/backend/lan/adapter');
const { LANServer } = require('../dist/src/backend/lan/server');
const { shareLink } = require('../dist/src/backend/lan/network');
(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tcp2com-browser-'));
    const service = new Service(new Store(directory));
    await service.init();
    const adapter = new LANAdapter(service);
    const frontend = path.join(__dirname, '..', 'frontend', 'dist');
    const legacy = path.join(__dirname, '..', 'tests', 'compatibility', 'legacy-frontend');
    const servers = [
        new LANServer(adapter, frontend, ['http://127.0.0.1:4173', 'http://127.0.0.1:4174']),
        new LANServer(adapter, legacy, ['http://127.0.0.1:4173', 'http://127.0.0.1:4174']),
    ];
    await servers[0].listen('127.0.0.1', 8766);
    await servers[1].listen('127.0.0.1', 4174);
    const supervisor = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json');
                res.end(
                    JSON.stringify({
                        online:
                            'http://127.0.0.1:4173/' +
                            shareLink('http://127.0.0.1:8766/', adapter.invite).split('/TCP2COM/')[1],
                        local: shareLink('http://127.0.0.1:8766/', adapter.invite, false),
                        legacy:
                            'http://127.0.0.1:4174/' +
                            shareLink('http://127.0.0.1:8766/', adapter.invite).split('/TCP2COM/')[1],
                        invite: adapter.invite,
                    }),
                );
                return;
            }
            let body = '';
            for await (const chunk of req) body += chunk.toString();
            const data = JSON.parse(body);
            if (data.action === 'rotate') adapter.rotate();
            else if (data.action === 'reset') {
                adapter.clients.clear();
                adapter.pending.clear();
                adapter.revoked.clear();
                adapter.rotate();
            } else if (data.action === 'mock-config') {
                // Deterministic firmware substitute exercises the real HTTP transport/client.
                service.settings.config_transport = 'http';
                service.settings.config_url = 'http://127.0.0.1:8769/';
            } else {
                const p = adapter.snapshot().pending.find((p) => p.name === data.name);
                if (!p) throw Error('pending not found');
                if (data.expire) {
                    for (const item of adapter.pending.values()) if (item.id === p.id) item.until = 0;
                } else adapter.decide(p.id, data.allow !== false);
            }
            res.end('{}');
        } catch (e) {
            res.statusCode = 400;
            res.end('{}');
        }
    });
    await new Promise((r) => supervisor.listen(8767, '127.0.0.1', r));
    const firmware = http.createServer((req, res) => {
        if (req.method === 'GET') {
            const { defaultConfig } = require('../dist/src/shared/model');
            res.end(
                JSON.stringify({
                    ...defaultConfig('c5'),
                    config_api: 'c5-config-2',
                    revision: 7,
                    http_session: '0123456789abcdef-1',
                }),
            );
        } else {
            req.resume();
            req.on('end', () => res.end('{"saved":true,"restart":true}'));
        }
    });
    await new Promise((r) => firmware.listen(8769, '127.0.0.1', r));
    const close = async () => {
        await Promise.all(servers.map((s) => s.close()));
        supervisor.close();
        firmware.close();
        await service.close();
        await fs.rm(directory, { recursive: true, force: true });
        process.exit(0);
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
