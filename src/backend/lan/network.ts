import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Data } from '../../shared/model';
import { privateIP } from './server';
export type Address = { id: string; name: string; ip: string };
export async function addresses(host: string): Promise<{ items: Address[]; warning: string }> {
    let found: Address[] = [];
    let warning = '';
    try {
        if (process.platform === 'win32') {
            const script =
                "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $adapters=@{}; Get-NetAdapter -IncludeHidden | ForEach-Object { $adapters[[int]$_.ifIndex]=$_ }; @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | ForEach-Object { $a=$adapters[[int]$_.InterfaceIndex]; if($a) { [pscustomobject]@{id=('windows:'+('{'+$a.InterfaceGuid.ToString().Trim('{}').ToLower()+'}'));name=$a.Name;ip=$_.IPAddress} }) | ConvertTo-Json -Compress";
            const result = await promisify(execFile)(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                { windowsHide: true, timeout: 10000, maxBuffer: 262144, encoding: 'utf8' },
            );
            const data = JSON.parse(result.stdout.trim() || '[]');
            found = Array.isArray(data) ? data : [data];
        } else
            for (const [name, list] of Object.entries(networkInterfaces()))
                for (const row of list ?? [])
                    if (row.family === 'IPv4') found.push({ id: 'interface:' + name, name, ip: row.address });
    } catch {
        warning = '无法读取网卡信息，已保留首选网卡记录';
    }
    found = found.filter((x) => privateIP(x.ip) && !x.ip.startsWith('127.'));
    if (host !== '0.0.0.0') found = found.filter((x) => x.ip === host);
    if (host === '0.0.0.0' || host.startsWith('127.'))
        found.push({ id: 'loopback', name: '本机专用', ip: host === '0.0.0.0' ? '127.0.0.1' : host });
    else if (!found.length) found.push({ id: 'ip:' + host, name: '固定监听地址', ip: host });
    return { items: found, warning };
}
export function choose(items: Address[], preferred?: Address) {
    if (preferred) {
        const same = items.filter((x) => x.id === preferred.id);
        if (same.length) {
            const selected = same.find((x) => x.ip === preferred.ip) ?? same[0];
            return {
                selected,
                warning: selected.ip === preferred.ip ? '' : '首选网卡 IP 已变化，链接和二维码已更新',
            };
        }
        return {
            selected: items.find((x) => x.id === 'loopback') ?? items[0],
            warning: `首选网卡 ${preferred.name} 暂不可用；已保留记录`,
        };
    }
    return { selected: items[0], warning: '' };
}
export function shareLink(address: string, invite: string, online = true) {
    return (
        (online ? 'https://zzzccchhh.github.io/TCP2COM/' : address.replace(/\/$/, '') + '/') +
        '#' +
        new URLSearchParams({ service: address, invite })
    );
}
