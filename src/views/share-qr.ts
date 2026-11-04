import QRCode from 'qrcode';
import { Data } from '../shared/model';
export class ShareQR {
    private link = '';
    private pending?: Promise<string>;
    constructor(
        private encode = (link: string) =>
            QRCode.toDataURL(link, {
                width: 208,
                margin: 3,
                errorCorrectionLevel: 'M',
                color: { dark: '#111111', light: '#ffffff' },
            }),
    ) {}
    async image(state: Data): Promise<{ image: string; message: string }> {
        if (!state.running) return { image: '', message: '开启后端后自动显示连接二维码' };
        if (!state.selected?.shareable || !state.localLink)
            return { image: '', message: '请选择可用的局域网网卡' };
        if (state.selected.ip.startsWith('127.') || state.selected.ip === '::1')
            return { image: '', message: '本机地址仅限本机访问；手机扫码请选择局域网网卡' };
        if (this.link !== state.localLink || !this.pending) {
            this.link = state.localLink;
            const promise = this.encode(state.localLink);
            this.pending = promise;
            void promise.catch(() => {
                if (this.pending === promise) this.pending = undefined;
            });
        }
        return { image: await this.pending, message: '手机扫码连接工作台' };
    }
}
