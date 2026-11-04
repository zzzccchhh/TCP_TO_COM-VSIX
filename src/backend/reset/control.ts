import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { Device, assert } from '../../shared/model';
import { OutcomeUnknown, ipv4 } from '../config/schema';
export class ResetControl {
    count = 0;
    busy = false;
    message = '3 秒内连续点击 5 次，复位外部主控';
    private started = 0;
    private context = '';
    private socket?: net.Socket;
    expire() {
        if (!this.busy && Date.now() - this.started > 3000) this.count = 0;
    }
    click(device: Device, host: string, port: number, owner: string) {
        ipv4(host);
        assert(Number.isInteger(port) && port >= 1 && port <= 65535, '复位端口无效');
        assert(!this.busy, '复位正在进行');
        this.expire();
        const context = JSON.stringify([device, host, port, owner]);
        if (context !== this.context) {
            this.count = 0;
            this.context = context;
        }
        if (!this.count) this.started = Date.now();
        this.count++;
        if (this.count < 5) {
            this.message = `已点击 ${this.count}/5（从首次点击起 3 秒内完成）`;
            return { count: this.count };
        }
        this.count = 0;
        this.busy = true;
        this.message = '正在发送复位请求…';
        void this.perform(device, host, port)
            .then(
                () => (this.message = '复位输出已释放；请检查主控状态'),
                (e) => (this.message = e.message),
            )
            .finally(() => (this.busy = false));
        return { count: 0 };
    }
    perform(device: Device, host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host, port });
            this.socket = socket;
            let buffer = '',
                sent = false,
                done = false;
            const id = randomBytes(16).toString('hex');
            const fail = (reason: string) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                socket.destroy();
                reject(
                    sent
                        ? new OutcomeUnknown(`复位结果未知：${reason}；不会自动重发，请检查设备状态`)
                        : new Error(`复位未发送：${reason}`),
                );
            };
            const timer = setTimeout(() => fail('等待控制响应超时'), 5000);
            socket.on('error', () => fail('控制连接失败'));
            socket.on('close', () => fail('控制连接已断开'));
            socket.on('data', (data) => {
                buffer += data.toString('ascii');
                while (buffer.includes('\n')) {
                    const at = buffer.indexOf('\n'),
                        line = buffer.slice(0, at).replace(/\r$/, '');
                    buffer = buffer.slice(at + 1);
                    if (line.length > 79) {
                        fail('控制响应过长');
                        return;
                    }
                    if (!sent) {
                        if (line !== { c5: 'C5', s3: 'S3', esp01s: 'ESP01S' }[device] + '-RESET/1 READY') {
                            fail('控制协议不匹配');
                            return;
                        }
                        sent = true;
                        socket.write(`RESET ${id}\n`);
                    } else if (line === `BUSY ${id}`) {
                        sent = false;
                        fail('ESP 正在执行其他复位');
                        return;
                    } else if (line === `STARTED ${id}`) this.message = '设备已开始复位';
                    else if (line === `DONE ${id}`) {
                        done = true;
                        clearTimeout(timer);
                        socket.destroy();
                        resolve();
                        return;
                    } else {
                        fail('控制响应无效或请求编号不匹配');
                        return;
                    }
                }
                if (buffer.length > 79) fail('控制响应过长');
            });
        });
    }
    close() {
        this.socket?.destroy();
    }
}
