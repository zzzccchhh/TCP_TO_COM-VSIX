import { autoDetect } from '@serialport/bindings-cpp';
import { SerialPortStream } from '@serialport/stream';
import { Data, assert } from '../../shared/model';
export type Port = SerialPortStream<any>;
export type OpenPort = (options: Data) => Promise<Port>;
export const binding = autoDetect();
export const openPort: OpenPort = async (options) => {
    const configuredBinding = {
        list: () => binding.list(),
        open: async (o: any) => {
            const handle = await binding.open(o);
            if (process.platform === 'win32')
                try {
                    require('./windows').configureWindows(handle.fd, options);
                } catch (error) {
                    await handle.close();
                    throw error;
                }
            return handle;
        },
    };
    const port = new SerialPortStream({ binding: configuredBinding, ...options, autoOpen: false } as any);
    await new Promise<void>((resolve, reject) => {
        port.once('error', reject);
        port.open((error) => {
            port.removeListener('error', reject);
            error ? reject(error) : resolve();
        });
    });
    return port;
};
export async function closePort(port?: Port) {
    if (!port?.isOpen) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
}
export function writePort(port: Port, data: Buffer, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('串口写入超时')), timeout);
        port.write(data, (error) => {
            clearTimeout(timer);
            error ? reject(new Error('串口写入失败')) : resolve();
        });
    });
}
export async function ports() {
    return (await binding.list()).map((p) => ({
        device: p.path,
        description: [p.manufacturer, p.serialNumber].filter(Boolean).join(' · ') || p.path,
    }));
}
export function serialOptions(s: Data): Data {
    assert(s.flow !== 'dsrdtr' || process.platform === 'win32', 'DSR/DTR 流控目前仅支持 Windows');
    return {
        path: s.com,
        baudRate: Number(s.baud),
        dataBits: Number(s.bytesize),
        parity: ({ N: 'none', E: 'even', O: 'odd', M: 'mark', S: 'space' } as Data)[s.parity],
        stopBits: Number(s.stopbits),
        rtscts: s.flow === 'rtscts',
        dsrdtr: s.flow === 'dsrdtr',
        xon: false,
        xoff: false,
        xany: false,
        highWaterMark: Number(s.bufsize),
    };
}
