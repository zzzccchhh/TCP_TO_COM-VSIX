import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Data, assert } from '../../shared/model';
import { Service } from '../service/service';
const secret = (n = 32) => randomBytes(n).toString('base64url');
export class Unauthorized extends Error {}
export const methods = new Set(
    'initial ports poll update_settings bridge usb network_log remember_draft read_device preview_save save_device import_config backup_config clear_logs export_logs reset_click peers revoke'.split(
        ' ',
    ),
);
const reads = new Set('initial ports poll peers export_logs'.split(' '));
type Client = { id: string; name: string; address: string; read_epoch: number | null; join_id?: string };
export class LANAdapter {
    invite = secret(24);
    revision = 0;
    clients = new Map<string, Client>();
    pending = new Map<string, Data>();
    revoked = new Set<string>();
    private attempts = new Map<string, number[]>();
    private failures = new Map<string, number[]>();
    private queue = Promise.resolve();
    private waiting = 0;
    constructor(readonly service: Service) {}
    rotate() {
        this.invite = secret(24);
        return true;
    }
    private name(name: any) {
        assert(typeof name === 'string' && name.trim() && name.length <= 60, '配对终端名称应为 1～60 个字符');
        return name.trim();
    }
    private throttle(map: Map<string, number[]>, address: string, limit: number) {
        const now = Date.now();
        for (const [ip, times] of map) if (!times.some((t) => now - t < 60000)) map.delete(ip);
        const times = (map.get(address) ?? []).filter((t) => now - t < 60000);
        assert(times.length < limit, '配对连接过于频繁，请稍后重试');
        map.set(address, [...times, now]);
    }
    connect(invite: any, name: any, address: string, join: any) {
        if (
            typeof invite !== 'string' ||
            Buffer.byteLength(invite) !== Buffer.byteLength(this.invite) ||
            !timingSafeEqual(Buffer.from(invite), Buffer.from(this.invite))
        )
            throw new Unauthorized('连接链接已失效，请从服务端重新复制网址或扫码');
        assert(typeof join === 'string' && join.length >= 24 && join.length <= 128, '配对连接标识不正确');
        if (this.revoked.has(join)) throw new Unauthorized('终端已撤销，请重新打开服务端连接链接');
        const label = this.name(name);
        for (const [token, c] of this.clients) if (c.join_id === join) return { token };
        this.throttle(this.attempts, address, 20);
        assert(this.clients.size < 32, '已配对终端达到上限，请先撤销终端');
        const token = secret();
        this.clients.set(token, {
            id: randomBytes(8).toString('hex'),
            name: label,
            address,
            read_epoch: null,
            join_id: join,
        });
        return { token };
    }
    private expire() {
        for (const [key, p] of this.pending) if (p.until < Date.now()) this.pending.delete(key);
    }
    requestPair(name: any, address: string) {
        this.expire();
        const label = this.name(name);
        assert(this.pending.size < 64, '配对申请过多');
        this.throttle(this.failures, address, 5);
        const request = secret(),
            id = randomBytes(4).toString('hex').toUpperCase();
        this.pending.set(request, {
            id,
            name: label,
            address,
            created: new Date().toLocaleTimeString(),
            until: Date.now() + 120000,
            state: 'pending',
        });
        return { request, id, expires_in: 120 };
    }
    pairStatus(request: any, cancel = false) {
        this.expire();
        const p = this.pending.get(request);
        if (!p) return { state: 'expired' };
        if (cancel) {
            if (p.token) this.clients.delete(p.token);
            p.state = 'cancelled';
        }
        return { state: p.state, ...(p.state === 'approved' ? { token: p.token } : {}) };
    }
    decide(id: string, allow: boolean) {
        this.expire();
        const p = [...this.pending.values()].find((p) => p.id === id);
        assert(p && p.state === 'pending', '申请已取消、过期或处理');
        if (allow) {
            assert(this.clients.size < 32, '已配对终端达到上限');
            const token = secret();
            this.clients.set(token, {
                id: randomBytes(8).toString('hex'),
                name: p.name,
                address: p.address,
                read_epoch: null,
            });
            p.state = 'approved';
            p.token = token;
        } else p.state = 'rejected';
        return true;
    }
    revoke(id: string) {
        for (const [token, c] of this.clients)
            if (c.id === id) {
                this.clients.delete(token);
                if (c.join_id) this.revoked.add(c.join_id);
                for (const p of this.pending.values()) if (p.token === token) p.state = 'cancelled';
            }
        return true;
    }
    snapshot() {
        this.expire();
        return {
            pending: [...this.pending.values()]
                .filter((p) => p.state === 'pending')
                .map(({ id, name, address, created }) => ({ id, name, address, created })),
            clients: [...this.clients.values()].map(({ id, name, address }) => ({ id, name, address })),
        };
    }
    async dispatch(token: string, method: any, args: any, revision?: number): Promise<Data> {
        if (!this.clients.has(token)) throw new Unauthorized('配对已失效，请重新配对');
        assert(methods.has(method) && Array.isArray(args), '未知操作');
        assert(this.waiting < 64, '其他终端正在操作，请稍后重试');
        this.waiting++;
        let release!: () => void;
        const previous = this.queue;
        this.queue = new Promise<void>((r) => (release = r));
        await previous;
        try {
            const client = this.clients.get(token);
            if (!client) throw new Unauthorized('终端已撤销');
            const mutating = !reads.has(method);
            assert(!mutating || revision === this.revision, '其他终端已更新设置，请同步后检查并重试');
            let reply: Data;
            if (['preview_save', 'save_device'].includes(method)) {
                this.service.poll(0);
                assert(
                    client.read_epoch === this.service.epoch && this.service.baseline,
                    '请在本终端重新读取设备，再检查修改',
                );
            }
            try {
                let data: any;
                if (method === 'peers')
                    data = [...this.clients.entries()].map(([t, c]) => ({
                        id: c.id,
                        name: c.name,
                        self: t === token,
                    }));
                else if (method === 'revoke') {
                    assert(typeof args[0] === 'string', '终端标识无效');
                    data = this.revoke(args[0]);
                } else if (method === 'remember_draft') data = true;
                else {
                    data = await this.service.execute(method, args, token);
                    if (method === 'read_device') client.read_epoch = this.service.epoch;
                    if (method === 'initial') data.drafts = {};
                    if (method === 'poll') data.settings = { ...this.service.settings };
                }
                reply = { ok: true, data };
            } catch (error: any) {
                reply = { ok: false, error: error instanceof Error ? error.message : '操作未完成' };
            }
            if (mutating) this.revision++;
            return { ...reply, revision: this.revision };
        } finally {
            this.waiting--;
            release();
        }
    }
}
