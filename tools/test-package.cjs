const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const yauzl = require('yauzl');
const root = path.join(__dirname, '..');
(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tcp2com-package-'));
    try {
        const vsix = path.join(
            root,
            'artifacts',
            `tcp2com-${require('../package.json').version}-win32-x64.vsix`,
        );
        const files = [];
        await new Promise((resolve, reject) =>
            yauzl.open(vsix, { lazyEntries: true }, (error, zip) => {
                if (error) return reject(error);
                zip.on('error', reject);
                zip.on('end', resolve);
                zip.on('entry', (entry) => {
                    const file = path.resolve(directory, entry.fileName);
                    if (!file.startsWith(directory + path.sep)) {
                        zip.close();
                        reject(Error('Unsafe package path'));
                        return;
                    }
                    files.push(entry.fileName);
                    if (entry.fileName.endsWith('/')) {
                        zip.readEntry();
                        return;
                    }
                    zip.openReadStream(entry, async (error, stream) => {
                        if (error) return reject(error);
                        try {
                            const chunks = [];
                            for await (const chunk of stream) chunks.push(chunk);
                            await fs.mkdir(path.dirname(file), { recursive: true });
                            await fs.writeFile(file, Buffer.concat(chunks));
                            zip.readEntry();
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                zip.readEntry();
            }),
        );
        if (
            files.some((f) => /(^|\/)(tests|tools|test-results|\.vscode-test)\//.test(f) || f.endsWith('.py'))
        )
            throw Error('Development files leaked into VSIX');
        const extensionRoot = path.join(directory, 'extension');
        const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
        await fs.access(path.join(extensionRoot, manifest.main));
        const check = `const p=${JSON.stringify(extensionRoot)};const path=require('node:path');(async()=>{const {binding}=require(path.join(p,'dist/src/backend/serial/ports'));await binding.list();require(path.join(p,'dist/src/backend/serial/windows')).configureWindows;require(path.join(p,'native/build/Release/tcp2com_native.node'));const {Service}=require(path.join(p,'dist/src/backend/service/service'));console.log('ISOLATED_PACKAGE_OK');})().catch(e=>{console.error(e.message);process.exit(1)});`;
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', check], {
                cwd: directory,
                env: { ...process.env, NODE_PATH: '' },
                windowsHide: true,
                stdio: 'inherit',
            });
            child.once('exit', (code) =>
                code === 0 ? resolve() : reject(Error('Isolated native module check failed')),
            );
            child.once('error', reject);
        });
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(root, 'tools', 'test-extension.cjs')], {
                cwd: directory,
                env: { ...process.env, TCP2COM_EXTENSION_ROOT: extensionRoot },
                windowsHide: true,
                stdio: 'inherit',
            });
            child.once('exit', (code) =>
                code === 0 ? resolve() : reject(Error('Packaged extension host check failed')),
            );
            child.once('error', reject);
        });
        await fs.writeFile(
            path.join(root, 'artifacts', 'package-test.json'),
            JSON.stringify(
                {
                    isolated: true,
                    nativeDependencies: true,
                    actualExtensionHost: true,
                    noPython: true,
                    noDevelopmentFixtures: true,
                    fileCount: files.length,
                },
                null,
                2,
            ),
        );
    } finally {
        const actual = await fs.realpath(directory);
        const temp = await fs.realpath(os.tmpdir());
        if (!actual.startsWith(temp + path.sep)) throw Error('Unexpected temporary directory');
        await fs.rm(actual, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
