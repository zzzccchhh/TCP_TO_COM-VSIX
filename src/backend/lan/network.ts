import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { assert, object } from '../../shared/model';
import { privateIP } from './server';

export type Address = {
    id: string;
    name: string;
    ip: string;
    family?: number;
    description?: string;
    status?: string;
    addressState?: string;
    shareable?: boolean;
    reason?: string;
    kind?: string;
};
export async function windowsInventory(): Promise<Address[]> {
    const script = await readFile(join(__dirname, '../../../../media/network-scan.ps1'), 'utf8');
    const result = await promisify(execFile)(
        'powershell.exe',
        [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 10000, maxBuffer: 1048576, encoding: 'utf8' },
    );
    const data = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '') || '[]');
    assert(
        Array.isArray(data) &&
            data.every((x) => object(x) && ['id', 'name', 'ip'].every((k) => typeof x[k] === 'string')),
        '网卡扫描返回格式不正确',
    );
    return data;
}
export function nodeInventory(): Address[] {
    return Object.entries(networkInterfaces()).flatMap(([name, rows]) =>
        (rows ?? []).map((row) => ({
            id: row.internal ? 'loopback' : 'interface:' + name,
            name: row.internal ? '本机专用' : name,
            ip: row.address,
            family: row.family === 'IPv4' ? 4 : 6,
            status: 'Up',
            addressState: 'Preferred',
        })),
    );
}
export function annotate(row: Address, host: string): Address {
    const family = row.family ?? isIP(row.ip);
    const loopback = row.ip.startsWith('127.') || row.ip === '::1';
    let reason = '';
    if (row.status && row.status !== 'Up') reason = '网卡未连接';
    else if (!row.ip) reason = '没有可用地址';
    else if (family !== 4) reason = '当前服务仅支持 IPv4';
    else if (row.addressState && row.addressState !== 'Preferred') reason = '地址尚未就绪';
    else if (!isIP(row.ip) || !privateIP(row.ip)) reason = '当前网页访问规则不支持此地址';
    else if (host !== '0.0.0.0' && row.ip !== host) reason = '不在当前监听范围内，请调整监听设置';
    return {
        ...row,
        family,
        id: loopback ? 'loopback' : row.id,
        name: loopback ? '本机专用' : row.name,
        kind: loopback
            ? '本机'
            : /virtual|hyper-v|vethernet|zerotier|vpn|tap|tun|wsl|wan miniport/i.test(
                    row.name + ' ' + row.description,
                )
              ? '虚拟网卡'
              : '网络接口',
        shareable: !reason,
        reason,
    };
}
export async function addresses(
    host: string,
    dependencies?: { native: () => Promise<Address[]>; node: () => Address[] },
): Promise<{ items: Address[]; warning: string }> {
    const fallback = dependencies?.node ?? nodeInventory;
    const native =
        dependencies?.native ?? (process.platform === 'win32' ? windowsInventory : async () => fallback());
    let found: Address[] = [];
    let warning = '';
    try {
        found = await native();
    } catch {
        warning = 'Windows 网卡扫描失败，已使用系统备用列表；部分断开网卡信息可能不完整';
    }
    let backup: Address[] = [];
    try {
        backup = fallback();
    } catch {
        warning = warning || '系统备用网卡列表不可用，已保留可读取的信息';
    }
    for (const row of backup) {
        if (
            found.some(
                (x) => x.ip === row.ip && (x.name === row.name || (row.id === 'loopback' && x.ip === row.ip)),
            )
        )
            continue;
        const matching = found.find((x) => x.name === row.name);
        found.push({ ...row, ...(matching ? { id: matching.id, description: matching.description } : {}) });
    }
    if (!found.some((x) => x.ip === '127.0.0.1'))
        found.push({ id: 'loopback', name: '本机专用', ip: '127.0.0.1', status: 'Up', family: 4 });
    const unique = new Map<string, Address>();
    for (const row of found) unique.set(row.id + '|' + row.ip, annotate(row, host));
    return {
        items: [...unique.values()].sort(
            (a, b) =>
                Number(!!b.shareable) - Number(!!a.shareable) ||
                Number(a.id === 'loopback') - Number(b.id === 'loopback') ||
                Number(a.kind === '虚拟网卡') - Number(b.kind === '虚拟网卡') ||
                a.name.localeCompare(b.name) ||
                a.ip.localeCompare(b.ip),
        ),
        warning,
    };
}
export function choose(items: Address[], preferred?: Address) {
    const usable = items.filter((x) => x.shareable !== false);
    if (preferred) {
        const same = usable.filter((x) => x.id === preferred.id);
        if (same.length) {
            const selected = same.find((x) => x.ip === preferred.ip) ?? same[0];
            return {
                selected,
                warning: selected.ip === preferred.ip ? '' : '首选网卡 IP 已变化，链接和二维码已更新',
            };
        }
        return {
            selected: usable.find((x) => x.id === 'loopback') ?? usable[0],
            warning: `首选网卡 ${preferred.name} 暂不可用；已保留记录`,
        };
    }
    return {
        selected: usable[0],
        warning: usable.length ? '' : '没有可用于分享的 IPv4 地址，请检查网卡与监听设置',
    };
}
export function shareLink(address: string, invite: string, online = true) {
    return (
        (online ? 'https://zzzccchhh.github.io/TCP2COM/' : address.replace(/\/$/, '') + '/') +
        '#' +
        new URLSearchParams({ service: address, invite })
    );
}
