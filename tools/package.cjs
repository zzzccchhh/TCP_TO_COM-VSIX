const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
const result = spawnSync(
    process.execPath,
    [
        require.resolve('@vscode/vsce/vsce'),
        'package',
        '--target',
        'win32-x64',
        '--out',
        `artifacts/tcp2com-${require('../package.json').version}-win32-x64.vsix`,
        '--allow-missing-repository',
    ],
    { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);
process.exit(result.status ?? 1);
