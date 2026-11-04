import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareQR } from '../src/views/share-qr';
const state = {
    running: true,
    selected: { shareable: true, ip: '192.168.1.2' },
    localLink: 'http://192.168.1.2:8765/#service=local&invite=test',
};
test('inline QR does not encode stopped, unusable or loopback addresses', async () => {
    let calls = 0;
    const qr = new ShareQR(async () => {
        calls++;
        return 'image';
    });
    assert.equal((await qr.image({ ...state, running: false })).image, '');
    assert.equal((await qr.image({ ...state, selected: { shareable: false, ip: '192.168.1.2' } })).image, '');
    assert.match(
        (await qr.image({ ...state, selected: { shareable: true, ip: '127.0.0.1' } })).message,
        /本机/,
    );
    assert.equal(calls, 0);
});
test('inline QR reuses in-flight encoding and rebuilds when invitation changes', async () => {
    const calls: string[] = [];
    const qr = new ShareQR(async (link) => {
        calls.push(link);
        return 'image:' + link;
    });
    const values = await Promise.all([qr.image(state), qr.image(state)]);
    assert.equal(calls.length, 1);
    assert.equal(values[0].image, values[1].image);
    await qr.image({ ...state, localLink: state.localLink + '&new=1' });
    assert.equal(calls.length, 2);
});
test('old failed QR request cannot erase a newer cached image', async () => {
    let fail!: (e: Error) => void,
        calls = 0;
    const qr = new ShareQR(async (link) => {
        calls++;
        if (link === state.localLink)
            return new Promise<string>((_resolve, reject) => {
                fail = reject;
            });
        return 'new image';
    });
    const old = qr.image(state);
    const rejected = assert.rejects(old);
    const next = { ...state, localLink: state.localLink + '&new=1' };
    assert.equal((await qr.image(next)).image, 'new image');
    fail(new Error('old failure'));
    await rejected;
    await qr.image(next);
    assert.equal(calls, 2);
});
test('QR encoder produces a real PNG with an intact quiet zone size', async () => {
    const result = await new ShareQR().image(state);
    assert.match(result.image, /^data:image\/png;base64,/);
    const png = Buffer.from(result.image.split(',')[1], 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 208);
    assert.equal(png.readUInt32BE(20), 208);
});
