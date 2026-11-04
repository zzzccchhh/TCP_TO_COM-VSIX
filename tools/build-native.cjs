const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('Native build currently targets Windows x64');
let include =
    process.env.TCP2COM_NODE_INCLUDE ||
    path.join(process.env.LOCALAPPDATA, 'node-gyp', 'Cache', process.versions.node, 'include', 'node');
if (!fs.existsSync(path.join(include, 'node_api.h'))) {
    const setup = spawnSync(
        process.execPath,
        [require.resolve('node-gyp/bin/node-gyp'), 'install', '--ensure'],
        { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (setup.status !== 0) process.exit(setup.status || 1);
}
fs.mkdirSync(path.join(root, 'native', 'build', 'Release'), { recursive: true });
const result = spawnSync(
    process.env.CXX || 'g++',
    [
        '-shared',
        '-O2',
        '-std=c++17',
        '-DNAPI_VERSION=8',
        '-DNODE_GYP_MODULE_NAME=tcp2com_native',
        '-I',
        include,
        'native/tcp2com_native.cc',
        '-lws2_32',
        '-static-libgcc',
        '-static-libstdc++',
        '-o',
        'native/build/Release/tcp2com_native.node',
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (result.error) {
    console.error('Install MinGW-w64 g++ or set CXX to its compiler path.');
    console.error(result.error.message);
}
process.exit(result.status ?? 1);
