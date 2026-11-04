import net from 'node:net';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { Data, assert, runtimeSettings } from '../../shared/model';
import { Port, OpenPort, openPort, closePort, serialOptions, writePort } from '../serial/ports';
import { configureKeepalive } from './keepalive';
type Block = { generation: number; data: Buffer };
export class BridgeEngine {
    settings: Data | null = null;
    serial?: Port;
    socket?: net.Socket;
    server?: net.Server;
    udp?: dgram.Socket;
    running = false;
    connected = false;
    generation = 0;
    address = '业务桥接已停止';
    stats: Data = {};
    peak = 0;
    queued = 0;
    private queue: Block[] = [];
    private writing = false;
    private toNetwork: Block[] = [];
    private networkWriting = false;
    private networkBytes = 0;
    private retry?: NodeJS.Timeout;
    private expected = '';
    private stopping = false;
    private maxQueue = 4 * 1024 * 1024;
    private writeStarted = 0;
    constructor(
        private log: (text: string) => void,
        private opener: OpenPort = openPort,
    ) {}
    count(key: string, n: number) {
        this.stats[key] = (this.stats[key] ?? 0) + n;
    }
    async start(input: Data) {
        assert(!this.running, '桥接已运行');
        const s = runtimeSettings(input);
        this.settings = s;
        this.stopping = false;
        this.stats = {};
        this.peak = 0;
        try {
            this.serial = await this.opener(serialOptions(s));
            this.serial.on('error', () => this.fail('串口异常，桥接已停止'));
            this.serial.on('close', () => {
                if (!this.stopping) this.fail('串口已断开，桥接已停止');
            });
            this.serial.on('data', (data: Buffer) => this.serialData(Buffer.from(data)));
            this.expected = s.host ? (await lookup(s.host, { family: 4 })).address : '';
            this.running = true;
            if (s.mode === 'tcp-server') {
                this.server = net.createServer((sock) => {
                    if (
                        this.stopping ||
                        this.socket ||
                        (this.expected && sock.remoteAddress !== this.expected)
                    ) {
                        sock.destroy();
                        return;
                    }
                    void this.install(sock);
                });
                this.server.on('error', () => this.fail('TCP 监听异常，桥接已停止'));
                await new Promise<void>((resolve, reject) => {
                    this.server!.once('error', reject);
                    this.server!.listen(s.port, s.listen, () => {
                        this.server!.removeListener('error', reject);
                        resolve();
                    });
                });
                this.address = '等待设备连接';
            } else if (s.mode === 'udp') {
                this.udp = dgram.createSocket('udp4');
                this.udp.on('error', () => this.fail('UDP 异常，桥接已停止'));
                this.udp.on('message', (data, peer) => {
                    if (peer.address !== this.expected || peer.port !== s.peer_port) {
                        this.count('udp_rejected', 1);
                        return;
                    }
                    this.count('udp_rx_packets', 1);
                    if (!data.length) {
                        this.count('udp_empty', 1);
                        return;
                    }
                    this.receive(data);
                });
                await new Promise<void>((resolve, reject) => {
                    this.udp!.once('error', reject);
                    this.udp!.bind(s.port, s.listen, () => {
                        this.udp!.removeListener('error', reject);
                        resolve();
                    });
                });
                this.generation++;
                this.address = `UDP 已绑定 ${s.listen}:${s.port} · 固定对端 ${this.expected}:${s.peer_port}（不代表设备在线）`;
            } else this.connect();
            this.log('业务桥接已启动');
        } catch (error) {
            await this.stop();
            throw error;
        }
    }
    private connect() {
        if (this.stopping || !this.running) return;
        const s = this.settings!;
        const socket = net.createConnection({ host: this.expected, port: s.port, family: 4 });
        this.socket = socket;
        this.address = '连接中 / 重试中';
        const timer = setTimeout(() => socket.destroy(new Error('timeout')), s.connect_timeout * 1000);
        socket.once('connect', () => {
            clearTimeout(timer);
            void this.install(socket);
        });
        socket.on('error', () => {});
        socket.once('close', () => {
            clearTimeout(timer);
            this.disconnected(socket);
        });
    }
    private async install(sock: net.Socket) {
        this.socket = sock;
        sock.pause();
        sock.on('error', () => {});
        if (this.settings!.mode === 'tcp-server') sock.once('close', () => this.disconnected(sock));
        this.generation++;
        this.clearQueues();
        this.serial?.pause();
        const generation = this.generation;
        try {
            await new Promise<void>((resolve, reject) =>
                this.serial!.flush((e) => (e ? reject(e) : resolve())),
            );
            // Purge buffers retained by Node as well as the native driver's queue.
            while (this.serial?.readableLength) this.serial.read();
        } catch {
            this.fail('串口会话隔离失败，桥接已停止');
            return;
        }
        if (this.stopping || this.socket !== sock || generation !== this.generation || sock.destroyed) return;
        sock.setNoDelay(true);
        try {
            configureKeepalive(sock, this.settings!);
        } catch {
            this.fail('无法设置 TCP Keepalive，桥接已停止');
            return;
        }
        this.connected = true;
        this.serial?.resume();
        this.address = `本地 ${sock.localAddress}:${sock.localPort} → 对端 ${sock.remoteAddress}:${sock.remotePort}`;
        sock.on('data', (data) => {
            if (this.socket === sock && generation === this.generation) this.receive(Buffer.from(data));
        });
        sock.resume();
        this.log('网络已连接');
    }
    private disconnected(sock: net.Socket) {
        if (this.socket !== sock) return;
        this.socket = undefined;
        this.connected = false;
        this.generation++;
        this.clearQueues();
        if (this.stopping) return;
        this.log('网络会话已结束');
        const s = this.settings!;
        this.address = s.mode === 'tcp-server' ? '等待设备连接' : '连接中 / 重试中';
        if (s.mode === 'tcp-client') {
            if (s.reconnect > 0) this.retry = setTimeout(() => this.connect(), s.reconnect * 1000);
            else void this.stop();
        }
    }
    private receive(data: Buffer) {
        if (!this.running || this.stopping) return;
        this.count('tcp_rx_bytes', data.length);
        if (this.queued + data.length > this.maxQueue) {
            this.count('tcp_to_com_drop', data.length);
            if (!this.udp) this.socket?.destroy();
            return;
        }
        this.queue.push({ generation: this.generation, data });
        this.queued += data.length;
        this.peak = Math.max(this.peak, this.queued);
        if (this.queued > this.maxQueue / 2) this.socket?.pause();
        void this.pump();
    }
    private async pump() {
        if (this.writing) return;
        this.writing = true;
        try {
            while (this.queue.length && !this.stopping) {
                const block = this.queue.shift()!;
                this.queued -= block.data.length;
                if (block.generation !== this.generation) {
                    this.count('tcp_to_com_drop', block.data.length);
                    continue;
                }
                // The write callback completes before moving to the next block. Pending writes are
                // flushed on a new generation; a timeout terminates the bridge rather than replaying.
                this.writeStarted = performance.now();
                this.stats.serial_write_pending_bytes = block.data.length;
                try {
                    await writePort(this.serial!, block.data, this.settings!.write_timeout * 1000);
                } finally {
                    const elapsed = Math.round((performance.now() - this.writeStarted) * 1000);
                    this.count('serial_write_calls', 1);
                    this.count('serial_write_us', elapsed);
                    this.stats.serial_write_max_us = Math.max(this.stats.serial_write_max_us ?? 0, elapsed);
                    this.stats.serial_write_pending_bytes = 0;
                    this.writeStarted = 0;
                }
                if (block.generation === this.generation) this.count('tcp_to_com_bytes', block.data.length);
                else this.count('tcp_to_com_drop', block.data.length);
                if (this.queued < this.maxQueue / 4 && this.connected) this.socket?.resume();
            }
        } catch (error: any) {
            this.count('serial_write_errors', 1);
            if (error.message === '串口写入超时') this.count('serial_write_timeouts', 1);
            this.fail('串口写入失败或超时，桥接已停止');
        } finally {
            this.writing = false;
        }
    }
    snapshot() {
        return {
            ...Object.fromEntries(
                [
                    'tcp_rx_bytes',
                    'tcp_to_com_bytes',
                    'com_to_tcp_bytes',
                    'tcp_to_com_drop',
                    'com_to_tcp_drop',
                    'udp_rx_packets',
                    'udp_tx_packets',
                    'udp_rejected',
                    'udp_empty',
                    'enqueue_wait_us',
                    'serial_write_calls',
                    'serial_write_us',
                    'serial_write_max_us',
                    'serial_write_short',
                    'serial_write_timeouts',
                ].map((k) => [k, 0]),
            ),
            ...this.stats,
            serial_write_pending_us: this.writeStarted
                ? Math.round((performance.now() - this.writeStarted) * 1000)
                : 0,
        };
    }
    private serialData(data: Buffer) {
        if (!this.running || this.stopping) return;
        this.count('com_rx_bytes', data.length);
        if ((!this.connected && !this.udp) || this.networkBytes + data.length > this.maxQueue) {
            this.count('com_to_tcp_drop', data.length);
            return;
        }
        this.toNetwork.push({ generation: this.generation, data });
        this.networkBytes += data.length;
        if (this.networkBytes > this.maxQueue / 2) this.serial?.pause();
        void this.pumpNetwork();
    }
    private async pumpNetwork() {
        if (this.networkWriting) return;
        this.networkWriting = true;
        let operationGeneration = this.generation;
        try {
            while (this.toNetwork.length && !this.stopping) {
                const block = this.toNetwork.shift()!;
                operationGeneration = block.generation;
                this.networkBytes -= block.data.length;
                if (block.generation !== this.generation) {
                    this.count('com_to_tcp_drop', block.data.length);
                    continue;
                }
                if (this.udp) {
                    for (let i = 0; i < block.data.length; i += this.settings!.udp_payload) {
                        const part = block.data.subarray(i, i + this.settings!.udp_payload);
                        await new Promise<void>((resolve, reject) =>
                            this.udp!.send(part, this.settings!.peer_port, this.expected, (e) =>
                                e ? reject(e) : resolve(),
                            ),
                        );
                        this.count('udp_tx_packets', 1);
                        this.count('com_to_tcp_bytes', part.length);
                    }
                } else {
                    const socket = this.socket;
                    if (!socket || socket.destroyed) {
                        this.count('com_to_tcp_drop', block.data.length);
                        continue;
                    }
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(() => {
                            socket.destroy();
                            reject(new Error('网络写入超时'));
                        }, this.settings!.write_timeout * 1000);
                        socket.write(block.data, (e) => {
                            clearTimeout(timer);
                            e ? reject(e) : resolve();
                        });
                    });
                    this.count('com_to_tcp_bytes', block.data.length);
                }
                if (this.networkBytes < this.maxQueue / 4) this.serial?.resume();
            }
        } catch {
            if (operationGeneration === this.generation && !this.stopping) {
                this.socket?.destroy();
                if (this.udp) this.fail('UDP 发送失败，桥接已停止');
            }
        } finally {
            this.networkWriting = false;
            if (this.toNetwork.length && !this.stopping) void this.pumpNetwork();
        }
    }
    private clearQueues() {
        for (const b of this.queue) this.count('tcp_to_com_drop', b.data.length);
        for (const b of this.toNetwork) this.count('com_to_tcp_drop', b.data.length);
        this.queue = [];
        this.toNetwork = [];
        this.queued = 0;
        this.networkBytes = 0;
        this.serial?.resume();
    }
    private fail(message: string) {
        this.log(message);
        void this.stop();
    }
    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        this.running = false;
        this.connected = false;
        clearTimeout(this.retry);
        this.generation++;
        this.clearQueues();
        this.socket?.destroy();
        this.socket = undefined;
        const server = this.server;
        this.server = undefined;
        if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
        const udp = this.udp;
        this.udp = undefined;
        if (udp)
            try {
                udp.close();
            } catch {}
        const serial = this.serial;
        this.serial = undefined;
        await closePort(serial);
        this.address = '业务桥接已停止';
    }
}
