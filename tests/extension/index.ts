import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export async function run() {
    const extension = vscode.extensions.getExtension('tcp2com-local.tcp2com');
    assert(extension, 'extension manifest is discoverable');
    const testPort = Number(process.env.TCP2COM_TEST_PORT);
    assert(Number.isInteger(testPort) && testPort > 0 && testPort <= 65535, 'isolated HTTP test port');
    await vscode.workspace
        .getConfiguration('tcp2com')
        .update('port', testPort, vscode.ConfigurationTarget.Global);
    await vscode.workspace
        .getConfiguration('tcp2com')
        .update('listen', '0.0.0.0', vscode.ConfigurationTarget.Global);
    await extension.activate();
    assert(extension.isActive);
    const commands = await vscode.commands.getCommands();
    assert(commands.includes('tcp2com.open'));
    await vscode.commands.executeCommand('tcp2com.controls.focus');
    if (process.env.TCP2COM_VISUAL_REPORT) {
        let verified = false;
        for (let i = 0; i < 60; i++) {
            try {
                const report = JSON.parse(
                    await require('node:fs/promises').readFile(process.env.TCP2COM_VISUAL_REPORT, 'utf8'),
                );
                if (report.homepage && report.configVerified && report.panelsVerified) {
                    verified = true;
                    break;
                }
            } catch {}
            await new Promise((r) => setTimeout(r, 1000));
        }
        assert(verified, 'homepage controls and complete network inventory');
    }
    await vscode.commands.executeCommand('tcp2com.open');
    await new Promise((r) => setTimeout(r, 6000));
    if (process.env.TCP2COM_VISUAL_REPORT) {
        let verified = false;
        for (let i = 0; i < 45; i++) {
            try {
                const report = JSON.parse(
                    await require('node:fs/promises').readFile(process.env.TCP2COM_VISUAL_REPORT, 'utf8'),
                );
                if (report.homepage && report.connected && report.synchronized) {
                    verified = true;
                    break;
                }
            } catch {}
            await new Promise((r) => setTimeout(r, 1000));
        }
        assert(verified, 'real Webview loaded and synchronized via message transport');
    }
    const response = await fetch(`http://127.0.0.1:${testPort}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert(html.includes('window.__WIFI_BRIDGE__'));
    // Windows native binaries load inside the actual Electron extension host.
    const { binding } = require(join(extension.extensionPath, 'dist/src/backend/serial/ports'));
    assert(Array.isArray(await binding.list()));
    const { configureWindows } = require(join(extension.extensionPath, 'dist/src/backend/serial/windows'));
    assert.throws(() => configureWindows(-1, {}));
    const net = require('node:net');
    const server = net.createServer((socket: any) => socket.on('end', () => socket.end()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const socket = net.connect(server.address().port, '127.0.0.1');
    await new Promise<void>((r) => socket.once('connect', r));
    const native = require(join(extension.extensionPath, 'native/build/Release/tcp2com_native.node'));
    const tuned = native.configureKeepalive(
        socket.localAddress,
        socket.localPort,
        socket.remoteAddress,
        socket.remotePort,
        3000,
        2000,
        5,
    );
    assert.equal(tuned.found, true);
    assert.equal(tuned.intervalApplied, true);
    assert.equal(tuned.countApplied, true);
    socket.end();
    await new Promise<void>((r) => server.close(() => r()));
    await vscode.commands.executeCommand('tcp2com.stop');
    const report = process.env.TCP2COM_TEST_REPORT;
    if (report)
        await writeFile(
            report,
            JSON.stringify(
                {
                    activated: true,
                    commands: true,
                    http: true,
                    nativeBinding: true,
                    koffi: true,
                    stopped: true,
                },
                null,
                2,
            ),
        );
}
