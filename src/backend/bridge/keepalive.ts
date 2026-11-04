import net from 'node:net';
import { join } from 'node:path';
import { Data, assert } from '../../shared/model';
export function configureKeepalive(socket: net.Socket, settings: Data) {
    socket.setKeepAlive(settings.keepalive_idle > 0, settings.keepalive_idle * 1000);
    if (process.platform === 'win32') {
        const native = require(join(__dirname, '../../../../native/build/Release/tcp2com_native.node'));
        const result = native.configureKeepalive(
            socket.localAddress,
            socket.localPort,
            socket.remoteAddress,
            socket.remotePort,
            Math.round(settings.keepalive_idle * 1000),
            Math.max(1, Math.round(settings.keepalive_interval * 1000)),
            settings.keepalive_count,
        );
        assert(result.found && result.intervalApplied, '无法应用 Windows TCP Keepalive 参数');
        return result;
    }
    return { found: true, intervalApplied: false, countApplied: false };
}
