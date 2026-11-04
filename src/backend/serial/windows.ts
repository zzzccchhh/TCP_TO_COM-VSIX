import koffi from 'koffi';
import { Data, assert } from '../../shared/model';
let api: Data | undefined;
function functions() {
    if (api) return api;
    const dll = koffi.load('kernel32.dll');
    return (api = {
        get: dll.func('int __stdcall GetCommState(intptr_t handle, void *dcb)'),
        set: dll.func('int __stdcall SetCommState(intptr_t handle, void *dcb)'),
    });
}
export function dcbFlags(previous: number, options: Data) {
    // fOutxDsrFlow (bit 3), fDtrControl (bits 4..5), fRtsControl (12..13).
    let flags = previous & ~((1 << 3) | (3 << 4) | (3 << 12));
    if (options.dsrdtr) flags |= (1 << 3) | (2 << 4);
    else if (options.hupcl !== false) flags |= 1 << 4;
    if (options.rtscts) flags |= 2 << 12;
    else if (options.rts === true) flags |= 1 << 12;
    return flags >>> 0;
}
export function configureWindows(fd: number | null, options: Data) {
    assert(Number.isInteger(fd), 'Windows 串口句柄无效');
    const api = functions();
    const dcb = Buffer.alloc(28);
    dcb.writeUInt32LE(28, 0);
    assert(api.get(fd, dcb), '无法读取 Windows 串口控制状态');
    dcb.writeUInt32LE(dcbFlags(dcb.readUInt32LE(8), options), 8);
    assert(api.set(fd, dcb), '无法设置 Windows DSR/DTR 和控制线状态');
}
