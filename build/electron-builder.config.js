const fs = require('node:fs');
const path = require('node:path');

function resolveFromRepo(relativePath) {
  return path.resolve(__dirname, '..', relativePath);
}

function optionalPath(value) {
  if (!value) return null;
  return path.resolve(value);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function buildExtraResource(fromPath, toPath) {
  return {
    from: fromPath,
    to: toPath,
    filter: ['**/*']
  };
}

const macDaemonPath = optionalPath(process.env.IOC_DAEMON_MAC_PATH);
const winDaemonDir = optionalPath(process.env.IOC_DAEMON_WIN_DIR);
const linuxDaemonPath = optionalPath(process.env.IOC_DAEMON_LINUX_PATH);
const argv = process.argv.slice(2).join(' ');
const wantsMac = /(?:^|\s)--mac(?:\s|$)|\bdmg\b/.test(argv);
const wantsWin = /(?:^|\s)--win(?:\s|$)|\bnsis\b/.test(argv);
const wantsLinux = /(?:^|\s)--linux(?:\s|$)|\bAppImage\b|\bdeb\b/.test(argv);

const config = {
  appId: 'io.iocoin.wallet',
  productName: 'I/O Coin Widget Wallet',
  files: [
    'src/**/*',
    'assets/**/*',
    'package.json',
    '!src/**/*.bak',
    '!src/**/*.bak.*',
    '!src/**/*.backup-*',
    '!src/**/*.hotfix-*',
    '!src/**/*.revert-*',
    '!src/renderer/lock_fix.js',
    '!src/renderer/renderer_poll_fix.js',
    '!src/renderer/status_bus.js',
    '!src/renderer/wallet-tools.js'
  ],
  mac: {
    icon: 'assets/icon.icns',
    category: 'public.app-category.finance',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64']
      }
    ],
    extraResources: []
  },
  win: {
    icon: 'assets/icon.ico',
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ],
    extraResources: []
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'I/O Coin Widget Wallet',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico'
  },
  linux: {
    icon: 'assets/icon.png',
    category: 'Finance',
    target: [
      {
        target: 'AppImage',
        arch: ['x64']
      },
      {
        target: 'deb',
        arch: ['x64']
      }
    ],
    extraResources: []
  },
  dmg: {
    sign: false,
    background: 'assets/img/dmg-background.png',
    iconSize: 80,
    window: {
      width: 540,
      height: 380
    },
    contents: [
      {
        x: 140,
        y: 190
      },
      {
        x: 400,
        y: 190,
        type: 'link',
        path: '/Applications'
      }
    ]
  }
};

if (macDaemonPath) {
  config.mac.extraResources.push(buildExtraResource(macDaemonPath, 'daemon'));
  config.afterSign = resolveFromRepo('build/notarize.js');
}

if (winDaemonDir) {
  config.win.extraResources.push(buildExtraResource(winDaemonDir, 'daemon'));
}

if (linuxDaemonPath) {
  config.linux.extraResources.push(buildExtraResource(linuxDaemonPath, 'daemon'));
}

if (wantsMac && !macDaemonPath) {
  throw new Error('Missing IOC_DAEMON_MAC_PATH for macOS build.');
}

if (wantsWin && !winDaemonDir) {
  throw new Error('Missing IOC_DAEMON_WIN_DIR for Windows build. Point it to a folder containing iocoind.exe and all required DLL dependencies.');
}

if (wantsWin && winDaemonDir) {
  if (!isDirectory(winDaemonDir)) {
    throw new Error(`IOC_DAEMON_WIN_DIR must point to a directory. Received: ${winDaemonDir}`);
  }
  const winDaemonExe = path.join(winDaemonDir, 'iocoind.exe');
  if (!pathExists(winDaemonExe)) {
    throw new Error(`Windows daemon runtime is missing iocoind.exe: ${winDaemonExe}`);
  }
}

if (wantsLinux && !linuxDaemonPath) {
  throw new Error('Missing IOC_DAEMON_LINUX_PATH for Linux build.');
}

module.exports = config;
