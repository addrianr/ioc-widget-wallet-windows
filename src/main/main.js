const COMPACT_WINDOW_SIZE = { width: 480, height: 360 };
const RUNTIME_COMPACT_WIDGET_SIZE = { width: 320, height: 300 };
const FULL_WINDOW_SIZE = { width: 960, height: 720 };
const SPLASH_DEBUG_WINDOW_SIZE = { width: 688, height: 584 };
const DAEMON_STARTUP_POLL_MS = 1000;
const INITIAL_DAEMON_RPC_TIMEOUT_MS = 45000;
const POST_BOOTSTRAP_DAEMON_RPC_TIMEOUT_MS = 60000;
const EARLY_CRASH_GRACE_MS = 3000;

function registerStartupWindowSizeLock() {
  try {
    if (global.__IOC_LOCKED_WINDOW__) return;
    const { app, BrowserWindow } = require('electron');
    app.on('browser-window-created', (_evt, win) => {
      win.once('ready-to-show', () => {
        try {
          win.setResizable(false);
          win.setMinimumSize(COMPACT_WINDOW_SIZE.width, COMPACT_WINDOW_SIZE.height);
          win.setMaximumSize(COMPACT_WINDOW_SIZE.width, COMPACT_WINDOW_SIZE.height);
          win.setSize(COMPACT_WINDOW_SIZE.width, COMPACT_WINDOW_SIZE.height, true);
        } catch {}
      });
    });
    global.__IOC_LOCKED_WINDOW__ = true;
  } catch {}
}

registerStartupWindowSizeLock();

try { require('./ipc-ui'); } catch {}
try { require('./rpc-compat').init(); } catch {}
const {app, BrowserWindow, ipcMain, screen, powerMonitor, Menu} = require('electron');
const path = require('path');
const fs = require('fs');
const {execFile} = require('child_process');

let win;

function clampWindowTopToVisibleArea(targetWin) {
  if (!targetWin || targetWin.isDestroyed()) return false;
  const bounds = targetWin.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display?.workArea || { x: 0, y: 0 };
  if (bounds.y >= workArea.y) return false;
  targetWin.setBounds({ ...bounds, y: workArea.y }, true);
  return true;
}

function findCli() {
  const { findCliBinary } = require('./daemon');
  const result = findCliBinary();
  if (result.found) return result.path;
  // Fallback: bare command name, let PATH resolve it
  return process.platform === 'win32' ? 'iocoind.exe' : 'iocoin-cli';
}

function callCli(method, params = []) {
  return new Promise((resolve, reject) => {
    const cli = findCli();
    const args = [method, ...params.map(v => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return JSON.stringify(v);
    })];
    const child = execFile(cli, args, {timeout: 10000}, (err, stdout) => {
      if (err) return reject(new Error('cli not connected'));
      const out = (stdout || '').trim();
      try {
        if (!out) return resolve(null);
        return resolve(JSON.parse(out));
      } catch {
        const num = Number(out);
        if (!Number.isNaN(num)) return resolve(num);
        return resolve(out);
      }
    });
    child.on('error', () => reject(new Error('cli not connected')));
  });
}

async function safeRpc(method, params = [], fallback = null) {
  try {
    const { rpc: httpRpc } = require('./rpc');
    return await httpRpc(method, params);
  } catch { return fallback; }
}

ipcMain.handle('ioc:rpc', async (_e, {method, params}) => {
  const { rpc: httpRpc } = require('./rpc');
  return await httpRpc(method, params);
});

ipcMain.handle('ioc:tryRpc', async (_e, {method, params}) => {
  try {
    const { rpcDirect } = require('./rpc');
    return { ok: true, result: await rpcDirect(method, params) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ===== First-run and data directory IPC handlers =====
const { DATA_DIR, isFirstRun } = require('../shared/constants');

// Splash-only: read latest block height from debug.log (received blocks,
// ahead of getblockcount which returns validated blocks).
const _debugLogPath = require('path').join(DATA_DIR, 'debug.log');
ipcMain.handle('ioc/logheight', async () => {
  try {
    const fs = require('fs');
    const fd = fs.openSync(_debugLogPath, 'r');
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const re = /height=(\d+)/g;
    let m, h = 0;
    while ((m = re.exec(buf.toString('utf8'))) !== null) h = parseInt(m[1], 10);
    return h || null;
  } catch { return null; }
});

const { ensureConf, findDaemonBinary, findCliBinary, isDaemonRunning,
        startDetached, clearChild, ensureDaemon, DAEMON_PATH } = require('./daemon');

ipcMain.handle('ioc:getDataDir', async () => {
  return DATA_DIR;
});

ipcMain.handle('ioc:isFirstRun', async () => {
  return isFirstRun();
});

// ===== Daemon status and control IPC =====
let daemonState = { running: false, pid: null, error: null, binaryPath: null, startedByUs: false };

function daemonStartupTimeoutMessage() {
  if (process.platform === 'win32') {
    return 'Daemon failed to become responsive. Ensure the bundled Windows daemon runtime is complete (DLL dependencies beside iocoind.exe) and install Microsoft Visual C++ Redistributable (x64) if needed.';
  }
  return 'Daemon failed to become responsive before timeout.';
}

ipcMain.handle('ioc:daemonStatus', async () => {
  const status = await isDaemonRunning();
  daemonState.running = status.running;
  daemonState.error = status.error || null;
  return {
    running: daemonState.running,
    pid: daemonState.pid,
    error: daemonState.error,
    binaryPath: daemonState.binaryPath,
    startedByUs: daemonState.startedByUs,
    needsBootstrap: daemonState.needsBootstrap || false,
    blockCount: status.blockCount || 0
  };
});

/**
 * Auto-start daemon on app launch if not already running.
 * RC3-stable pattern: RPC check → if not running, ensure binary → start.
 */
async function initDaemon() {
  ensureConf();

  // Step 1: Ensure daemon binary is installed and verified
  try {
    await ensureDaemon((step, msg) => {
      console.log(`[daemon] ${step}: ${msg}`);
      daemonState.statusMessage = msg;
    });
  } catch (err) {
    console.error('[daemon] ensureDaemon failed:', err.message);
    daemonState.error = err.message;
    return { ok: false, error: err.message };
  }

  daemonState.binaryPath = DAEMON_PATH;

  // Step 2: Check if daemon is already running via RPC
  const status = await isDaemonRunning();
  if (status.running) {
    console.log('[daemon] Already running, attaching...');
    daemonState.running = true;
    daemonState.startedByUs = false;
    return { ok: true, attached: true };
  }

  // Step 2b: RPC failed — but the process may still be alive (busy syncing).
  // Check pidfile / pgrep before spawning to avoid double-spawn.
  const existingPid = findDaemonPid();
  if (existingPid) {
    console.log('[daemon] RPC unresponsive but process alive (PID', existingPid + '), attaching...');
    daemonState.running = true;
    daemonState.startedByUs = false;
    daemonState.pid = existingPid;
    return { ok: true, attached: true };
  }

  // Step 3: Check if bootstrap is needed BEFORE starting daemon
  if (bootstrap.needsBootstrap()) {
    console.log('[daemon] Bootstrap needed — deferring daemon start to renderer flow');
    daemonState.needsBootstrap = true;
    return { ok: true, deferred: true, needsBootstrap: true };
  }

  // Step 4: Start daemon
  console.log('[daemon] Starting daemon from:', DAEMON_PATH);
  const started = startDetached(DAEMON_PATH);
  if (!started) {
    daemonState.error = 'Failed to start daemon';
    return { ok: false, error: 'Failed to start daemon' };
  }
  daemonState.startedByUs = true;

  // Step 5: Quick health check — wait for RPC to respond.
  // If the daemon crashes immediately (missing VC++ runtime, corrupt binary),
  // we catch it here instead of leaving the splash stuck indefinitely.
  const initAttempts = Math.ceil(INITIAL_DAEMON_RPC_TIMEOUT_MS / DAEMON_STARTUP_POLL_MS);
  for (let i = 0; i < initAttempts; i++) {
    await new Promise(r => setTimeout(r, DAEMON_STARTUP_POLL_MS));
    const check = await isDaemonRunning();
    if (check.running) {
      console.log('[daemon] Daemon is responsive');
      return { ok: true, started: true, path: DAEMON_PATH };
    }
    const pid = findDaemonPid();
    if (!pid && ((i + 1) * DAEMON_STARTUP_POLL_MS) >= EARLY_CRASH_GRACE_MS) {
      console.error('[daemon] Daemon process died shortly after spawn');
      daemonState.error = 'Daemon crashed on startup — check VC++ runtime';
      return { ok: false, error: 'Daemon crashed on startup. Install Microsoft Visual C++ Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe' };
    }
  }
  const timeoutError = daemonStartupTimeoutMessage();
  console.error('[daemon] Daemon not responsive after startup timeout');
  daemonState.error = timeoutError;
  return { ok: false, error: timeoutError };
}
// ===== End daemon IPC =====

// ===== Open external URL IPC =====
const { shell } = require('electron');
ipcMain.handle('ioc:openExternal', async (_e, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'Invalid URL' };
});
// ===== End openExternal IPC =====

// ===== Bootstrap IPC handlers =====
const bootstrap = require('./bootstrap');

ipcMain.handle('ioc:needsBootstrap', async () => {
  return bootstrap.needsBootstrap();
});

ipcMain.handle('ioc:getDailyBootstrapMetadata', async () => {
  return bootstrap.fetchDailyBootstrapMetadata();
});

ipcMain.handle('ioc:createRebootstrapBackup', async (_event, context = {}) => {
  return bootstrap.createRebootstrapBackup(context);
});

// Track download state for progress events
let bootstrapDownloadAbort = null;

ipcMain.handle('ioc:downloadBootstrap', async (event) => {
  // Send progress events to the renderer
  const sendProgress = (progress) => {
    try {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('bootstrap:progress', progress);
      }
    } catch (_) {}
  };

  const result = await bootstrap.downloadBootstrap(sendProgress);
  return result;
});

async function stopDaemonForBootstrapApply() {
  const running = await isDaemonRunning();
  const existingPid = findDaemonPid();
  if (!running.running && !existingPid) return { ok: true, stopped: false };

  const { stopViaCli, stopViaHttp, findCliBinary } = require('./daemon');
  const cli = findCliBinary();

  // Try graceful RPC stop first when daemon is reachable.
  if (running.running) {
    try {
      if (cli.found) {
        await stopViaCli(cli.path);
      } else {
        await stopViaHttp();
      }
    } catch (err) {
      console.warn('[bootstrap] Graceful daemon stop failed, will try forced stop:', err?.message || err);
    }
  }

  // Wait for RPC to go down (best-effort).
  await waitForDaemonStop(12000, 400);

  // Ensure process is fully gone; if not, escalate to forced stop.
  let processGone = await waitForProcessExit(12000, 300);
  if (!processGone) {
    let pid = findDaemonPid();
    if (pid) {
      killDaemonByPid(pid, 'SIGTERM');
      processGone = await waitForProcessExit(5000, 250);
    }
  }
  if (!processGone) {
    let pid = findDaemonPid();
    if (pid) {
      killDaemonByPid(pid, 'SIGKILL');
      processGone = await waitForProcessExit(5000, 250);
    }
  }
  if (!processGone) {
    killDaemonByName('SIGKILL');
    processGone = await waitForProcessExit(5000, 250);
  }
  if (!processGone) {
    return { ok: false, error: 'Daemon process did not fully exit before bootstrap apply' };
  }

  // Safety buffer requested: leave enough time for OS file handles to release.
  await new Promise(r => setTimeout(r, 10000));

  clearChild();
  return { ok: true, stopped: true };
}

ipcMain.handle('ioc:applyBootstrap', async (event, options = {}) => {
  const sendProgress = (step, message) => {
    try {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('bootstrap:progress', { step, message });
      }
    } catch (_) {}
  };

  try {
    const shouldStopDaemonFirst = !!options.stopDaemonFirst;
    if (shouldStopDaemonFirst) {
      sendProgress('stopping', 'Stopping daemon for bootstrap refresh...');
      const stopResult = await stopDaemonForBootstrapApply();
      if (!stopResult.ok) {
        sendProgress('error', stopResult.error || 'Could not stop daemon before bootstrap apply');
        return { ok: false, error: stopResult.error || 'Could not stop daemon before bootstrap apply' };
      }
      sendProgress('stopping', 'Daemon stopped. Waiting for file locks to release...');
    }

    // 1. Extract the bootstrap
    console.log('[bootstrap] Extracting bootstrap zip...');
    sendProgress('extracting', 'Extracting blockchain data (this may take a few minutes)...');
    const extractResult = await bootstrap.extractBootstrap();
    if (!extractResult.ok) {
      console.error('[bootstrap] Extraction failed:', extractResult.error);
      sendProgress('error', `Extraction failed: ${extractResult.error}`);
      return extractResult;
    }

    // 2. Apply bootstrap files
    console.log('[bootstrap] Installing bootstrap files to DATA_DIR...');
    sendProgress('applying', 'Copying blockchain files...');
    const applyResult = await bootstrap.applyBootstrapFiles();
    if (!applyResult.ok) {
      console.error('[bootstrap] Apply failed:', applyResult.error);
      sendProgress('error', `Install failed: ${applyResult.error}`);
      return applyResult;
    }

    // 3. Clean up temp files
    console.log('[bootstrap] Cleaning up temp files...');
    sendProgress('cleanup', 'Cleaning up...');
    bootstrap.cleanupBootstrap();

    // 4. Start daemon
    console.log('[bootstrap] Starting daemon with bootstrap data...');
    sendProgress('starting', 'Starting daemon...');
    const started = startDetached(DAEMON_PATH);
    if (!started) {
      console.error('[bootstrap] Failed to start daemon after bootstrap');
      sendProgress('error', 'Failed to start daemon');
      return { ok: false, error: 'Failed to start daemon after bootstrap install' };
    }
    daemonState.startedByUs = true;
    daemonState.binaryPath = DAEMON_PATH;
    daemonState.needsBootstrap = false;

    // 5. Wait for daemon to become responsive after bootstrap.
    //    The daemon needs a few seconds to load the block index.
    //    If it crashes immediately (missing VC++ runtime, DLL error),
    //    we detect it here instead of leaving the splash stuck forever.
    console.log('[bootstrap] Waiting for daemon to become responsive...');
    sendProgress('starting', 'Waiting for daemon to start...');
    let alive = false;
    const bootstrapAttempts = Math.ceil(POST_BOOTSTRAP_DAEMON_RPC_TIMEOUT_MS / DAEMON_STARTUP_POLL_MS);
    for (let i = 0; i < bootstrapAttempts; i++) {
      await new Promise(r => setTimeout(r, DAEMON_STARTUP_POLL_MS));
      const check = await isDaemonRunning();
      if (check.running) {
        alive = true;
        console.log('[bootstrap] Daemon is responsive (block', check.blockCount + ')');
        break;
      }
      // Check if the process is still alive (not crashed)
      const pid = findDaemonPid();
      if (!pid && ((i + 1) * DAEMON_STARTUP_POLL_MS) >= EARLY_CRASH_GRACE_MS) {
        // Process gone after grace period — daemon crashed
        console.error('[bootstrap] Daemon process died — binary may be broken or missing VC++ runtime');
        sendProgress('error', 'Daemon crashed on startup. Install Microsoft Visual C++ Redistributable (x64) and retry.');
        return { ok: false, error: 'Daemon crashed on startup. Install Microsoft Visual C++ Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe' };
      }
    }
    if (!alive) {
      const timeoutError = daemonStartupTimeoutMessage();
      console.error('[bootstrap] Daemon not responsive after bootstrap startup timeout');
      sendProgress('error', timeoutError);
      return { ok: false, error: timeoutError };
    }

    return { ok: true, restarted: true };
  } catch (err) {
    console.error('[bootstrap] Apply error:', err);
    sendProgress('error', `Setup failed: ${err.message || String(err)}`);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('ioc:bootstrapCleanup', async () => {
  return bootstrap.cleanupBootstrap();
});
// ===== End Bootstrap IPC =====

// ===== Exit Confirmation Dialog (Step D) =====
const { dialog, nativeImage } = require('electron');
const { execSync } = require('child_process');

// Track if we should skip the confirmation (user already chose)
let exitConfirmed = false;

// Path to IOCoin icon for dialog
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

/**
 * Show exit confirmation dialog.
 * Returns: 0 = Close Wallet Completely, 1 = Close UI Only, 2 = Cancel
 */
async function showExitConfirmation(win) {
  const iconImage = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
  const result = await dialog.showMessageBox(win, {
    type: 'none',
    icon: iconImage,
    buttons: ['Close Wallet Completely', 'Close UI Only', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
    message: 'How would you like to close?'
  });
  return result.response;
}

/**
 * Poll isDaemonRunning until it returns false or timeout.
 */
async function waitForDaemonStop(timeoutMs, intervalMs = 500) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const status = await isDaemonRunning();
    if (!status.running) {
      console.log('[exit] Daemon confirmed stopped');
      return true;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Wait for daemon process to fully exit (PID gone from OS).
 * RPC may be down but the process can still be flushing to disk,
 * holding the data-dir lock. Starting a new daemon before the
 * lock is released causes "Cannot obtain a lock on data directory".
 */
async function waitForProcessExit(timeoutMs, intervalMs = 300) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const pid = findDaemonPid();
    if (!pid) {
      console.log('[exit] Daemon process fully exited');
      return true;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Find daemon PID from pidfile or pgrep.
 */
function findDaemonPid() {
  // Check iocoind.pid (daemon's own pidfile)
  const pidFile = path.join(DATA_DIR, 'iocoind.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid > 0) {
        console.log('[exit] Found daemon PID from pidfile:', pid);
        return pid;
      }
    } catch (_) {}
  }

  // Fallback: use pgrep on unix, tasklist on Windows
  if (process.platform === 'win32') {
    try {
      const output = execSync('tasklist /FI "IMAGENAME eq iocoind.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
      // CSV output: "iocoind.exe","1234","Console","1","12,345 K"
      const match = /"iocoind\.exe","(\d+)"/.exec(output);
      if (match) {
        const pid = parseInt(match[1], 10);
        if (pid > 0) {
          console.log('[exit] Found daemon PID from tasklist:', pid);
          return pid;
        }
      }
    } catch (_) {}
  } else {
    try {
      const output = execSync('pgrep -x iocoind', { encoding: 'utf8', timeout: 3000 });
      const pid = parseInt(output.trim().split('\n')[0], 10);
      if (pid > 0) {
        console.log('[exit] Found daemon PID from pgrep:', pid);
        return pid;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Force kill daemon by PID.
 */
function killDaemonByPid(pid, signal) {
  try {
    console.log(`[exit] Sending ${signal} to PID ${pid}`);
    process.kill(pid, signal);
    return true;
  } catch (err) {
    console.error(`[exit] Failed to kill PID ${pid}:`, err.message);
    return false;
  }
}

/**
 * Force kill daemon by process name (last resort).
 */
function killDaemonByName(signal) {
  if (process.platform === 'win32') {
    // Windows: use taskkill to force-kill iocoind.exe
    try {
      console.log('[exit] Running taskkill /IM iocoind.exe /F');
      execSync('taskkill /IM iocoind.exe /F', { timeout: 5000 });
      return true;
    } catch (_) {
      return false;
    }
  }
  const sigFlag = signal === 'SIGKILL' ? '-KILL' : '-TERM';
  try {
    console.log(`[exit] Running pkill ${sigFlag} iocoind`);
    execSync(`pkill ${sigFlag} iocoind`, { timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Hard guarantee stop daemon and quit.
 * RC3-stable: CLI stop → SIGTERM by PID → SIGKILL by PID → pkill last resort.
 */
async function stopDaemonAndQuitHard() {
  const { stopViaCli, stopViaHttp, findCliBinary } = require('./daemon');

  console.log('[exit] Starting hard shutdown sequence...');

  // Step A: Attempt graceful stop via CLI (or HTTP RPC if CLI unavailable)
  const cli = findCliBinary();
  if (cli.found) {
    console.log('[exit] Sending stop command via CLI...');
    try {
      await stopViaCli(cli.path);
    } catch (err) {
      console.error('[exit] CLI stop failed:', err.message);
    }
  } else {
    // No CLI binary (common on Windows) — use HTTP RPC stop
    console.log('[exit] CLI not found, sending stop via HTTP RPC...');
    try {
      await stopViaHttp();
    } catch (err) {
      console.error('[exit] HTTP RPC stop failed:', err.message);
    }
  }

  {
    const stopped = await waitForDaemonStop(20000, 500);
    if (stopped) {
      console.log('[exit] Daemon stopped gracefully');
      app.exit(0);
      return;
    }
  }

  // Step B: Try SIGTERM by PID
  let pid = findDaemonPid();
  if (pid) {
    killDaemonByPid(pid, 'SIGTERM');
    const stopped = await waitForDaemonStop(10000, 500);
    if (stopped) {
      console.log('[exit] Daemon stopped after SIGTERM');
      app.exit(0);
      return;
    }

    // Try SIGKILL
    killDaemonByPid(pid, 'SIGKILL');
    const stoppedKill = await waitForDaemonStop(5000, 500);
    if (stoppedKill) {
      console.log('[exit] Daemon stopped after SIGKILL');
      app.exit(0);
      return;
    }
  }

  // Step C: Last resort - pkill by name
  const status = await isDaemonRunning();
  if (status.running) {
    console.log('[exit] Daemon still running, using pkill...');
    killDaemonByName('SIGTERM');
    let stopped = await waitForDaemonStop(5000, 500);
    if (!stopped) {
      killDaemonByName('SIGKILL');
      stopped = await waitForDaemonStop(3000, 500);
    }
  }

  // Step D: Quit regardless
  console.log('[exit] Exiting Electron...');
  app.exit(0);
}

ipcMain.handle('ioc:quitApp', async (event, stopDaemon) => {
  exitConfirmed = true;
  if (stopDaemon) {
    await stopDaemonAndQuitHard();
  } else {
    app.exit(0);
  }
  return { ok: true };
});

ipcMain.handle('ioc:hideWindow', async (event) => {
  // Exit Electron process, keep daemon running
  exitConfirmed = true;
  app.exit(0);
  return { ok: true };
});

ipcMain.handle('ioc:restartDaemon', async () => {
  // Wait for daemon to fully stop (encryptwallet shuts it down)
  console.log('[daemon] Waiting for daemon to stop after encryption...');
  const stopped = await waitForDaemonStop(15000, 500);
  if (!stopped) {
    console.warn('[daemon] Daemon did not stop within timeout, attempting start anyway');
  }
  // RPC is down, but the process may still be flushing to disk.
  // Wait for the actual process to exit so the data-dir lock is released.
  console.log('[daemon] Waiting for process to fully exit...');
  const processGone = await waitForProcessExit(10000, 300);
  if (!processGone) {
    console.warn('[daemon] Process still alive after timeout');
  }
  // Invalidate wallet cache so fresh lockst is fetched
  if (global.__iocWalletCache) global.__iocWalletCache.ts = 0;
  if (statusCache) statusCache.ts = 0;
  // Clear stale child reference so startDetached spawns a new process
  clearChild();
  // Start daemon fresh
  console.log('[daemon] Restarting daemon...');
  const ok = startDetached(DAEMON_PATH);
  daemonState.startedByUs = true;
  daemonState.running = ok;
  return { ok };
});
// ===== End Exit Confirmation =====

/** ---- Remote tip cache (network block height from explorer) ---- */
const remoteTipCache = { ts: 0, height: 0 };
async function fetchRemoteTip() {
  const now = Date.now();
  // Refresh every 30s while syncing, 60s when synced
  const cacheAge = now - remoteTipCache.ts;
  if (remoteTipCache.height > 0 && cacheAge < 30000) {
    return remoteTipCache.height;
  }

  try {
    // Use cryptoid.info IOC explorer API
    const https = require('https');
    const height = await new Promise((resolve, reject) => {
      const req = https.get('https://chainz.cryptoid.info/ioc/api.dws?q=getblockcount', {
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const h = parseInt(data.trim(), 10);
          if (h > 0) {
            resolve(h);
          } else {
            reject(new Error('Invalid response'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    remoteTipCache.height = height;
    remoteTipCache.ts = now;
    console.log('[status] Remote tip updated:', height);
    return height;
  } catch (err) {
    console.warn('[status] Failed to fetch remote tip:', err.message);
    // Return cached value if available, otherwise 0
    return remoteTipCache.height || 0;
  }
}

/** ---- Coalesced, cached status snapshot ---- */
const statusCache = { ts: 0, data: null, inflight: null };
async function computeStatus() {
  const now = Date.now();

  // ---- SLOW wallet cache (5s) — never blocks the fast path ----
  if (!global.__iocWalletCache) global.__iocWalletCache = { ts: 0, data: { info: {}, staking: {}, lockst: {} }, refreshing: false };
  const wc = global.__iocWalletCache;
  const walletFresh = wc.data && (now - wc.ts) < 5000;

  // Kick off background wallet refresh if stale (don't await it)
  if (!walletFresh && !wc.refreshing) {
    wc.refreshing = true;
    (async () => {
      try {
        const info = (await safeRpc('getinfo', [], {})) || {};
        const stake = (await safeRpc('getstakinginfo', [], {})) || {};
        const lockst = (await safeRpc('walletlockstatus', [], null)) || {};
        wc.data = { info, staking: stake, lockst };
        wc.ts = Date.now();
      } catch {}
      wc.refreshing = false;
    })();
  }

  // ---- FAST path: chain, peers, balance, remoteTip in parallel ----
  // Use rpcDirect (bypasses serialization queue) for speed during sync.
  // getblockcount is lightweight; getblockchaininfo is heavy and slow.
  const { rpcDirect: directRpc } = require('./rpc');
  const safeDirect = (m, p=[], fb=null) => directRpc(m, p).catch(() => fb);

  // Use getblockcount (fast) while far from tip; switch to getblockchaininfo
  // (has verificationprogress) once close so splash can detect sync complete.
  const prevBlocks = statusCache.data?.chain?.blocks || 0;
  const prevRemoteTip = remoteTipCache.height || 0;
  const nearTip = prevRemoteTip > 0 && prevBlocks > 0 && (prevRemoteTip - prevBlocks) < 100;
  const chainPromise = nearTip
    ? safeDirect('getblockchaininfo').then(r => r || { blocks: 0, headers: 0, verificationprogress: 0 })
    : safeDirect('getblockcount').then(b => ({ blocks: b || 0, headers: 0, verificationprogress: 0 }));

  // Kick off remote tip refresh in background — NEVER blocks the fast path.
  fetchRemoteTip().catch(() => {});

  const [chain, peers, balance, unconfBal] = await Promise.all([
    chainPromise,
    safeDirect('getconnectioncount', [], null),
    safeDirect('getbalance', [], null),
    safeDirect('getunconfirmedbalance', [], 0)
  ]);

  // Merge fast balance into info so renderer always gets current balance
  // Pending balance comes from getinfo's "pending" field (IOCoin daemon
  // does not support getunconfirmedbalance or getwalletinfo)
  const info = { ...wc.data.info };
  if (typeof balance === 'number') info.balance = balance;
  if (typeof unconfBal === 'number') info.unconfirmedbalance = unconfBal;

  // Use cached remote tip (refreshed in background).
  const remoteTip = remoteTipCache.height || 0;
  return { info, chain, peers, staking: wc.data.staking, lockst: wc.data.lockst, remoteTip };
}
ipcMain.handle('ioc/status', async () => {
  const now = Date.now();
  if (statusCache.inflight) {
    console.log('[ioc/status] Coalescing request (in-flight)');
    return await statusCache.inflight;
  }
  // During sync: no cache (0ms) so block height updates instantly.
  // Once synced: 3s cache to reduce load.
  const cachedBlocks = statusCache.data?.chain?.blocks || 0;
  const cachedTip = remoteTipCache.height || 0;
  const synced = cachedTip > 0 && cachedBlocks > 0 && (cachedTip - cachedBlocks) < 25;
  const maxAge = synced ? 3000 : 0;
  if (statusCache.data && (now - statusCache.ts) < maxAge) {
    return statusCache.data;
  }
  const startTime = Date.now();
  console.log('[ioc/status] Starting new RPC batch');
  statusCache.inflight = computeStatus()
    .then(data => {
      const elapsed = Date.now() - startTime;
      console.log(`[ioc/status] RPC batch completed in ${elapsed}ms`);
      statusCache.data = data;
      statusCache.ts = Date.now();
      return data;
    })
    .catch(err => {
      const elapsed = Date.now() - startTime;
      console.error(`[ioc/status] RPC batch failed after ${elapsed}ms:`, err && err.message ? err.message : err);
      throw err;
    })
    .finally(() => { statusCache.inflight = null; });
  return await statusCache.inflight;
});
/** ------------------------------------------- */

ipcMain.handle('ioc/listaddrs', async () => {
  const { rpcDirect } = require('./rpc');
  const safe = (m, p=[], fb=null) => rpcDirect(m, p).catch(() => fb);

  // 3 fast RPC calls in parallel — bypasses serialization queue
  // listreceivedbyaddress returns addresses and labels (account field)
  // getaddressesbyaccount catches default-account keypool addresses
  // listunspent provides actual per-address balances from UTXOs
  const [received, defaultAddrs, unspent] = await Promise.all([
    safe('listreceivedbyaddress', [0, true], []),
    safe('getaddressesbyaccount', [''], []),
    safe('listunspent', [0], [])
  ]);

  // Build per-address balance from UTXOs (actual spendable balance)
  const utxoBalance = {};
  if (Array.isArray(unspent)) {
    for (const u of unspent) {
      if (u.address) {
        utxoBalance[u.address] = (utxoBalance[u.address] || 0) + (u.amount || 0);
      }
    }
  }

  const rows = [];
  const seen = new Set();

  // 1. listreceivedbyaddress 0 true — all addresses with labels
  if (Array.isArray(received)) {
    for (const entry of received) {
      const addr = entry.address;
      if (addr && !seen.has(addr)) {
        seen.add(addr);
        rows.push({address: addr, amount: utxoBalance[addr] || 0, label: entry.account || ''});
      }
    }
  }

  // 2. getaddressesbyaccount '' — remaining default keypool addresses
  if (Array.isArray(defaultAddrs)) {
    for (const a of defaultAddrs) {
      if (a && !seen.has(a)) {
        seen.add(a);
        rows.push({address: a, amount: utxoBalance[a] || 0, label: ''});
      }
    }
  }

  // 3. Change addresses — UTXOs not seen in received or default keypool
  for (const [addr, bal] of Object.entries(utxoBalance)) {
    if (!seen.has(addr) && bal > 0) {
      seen.add(addr);
      rows.push({address: addr, amount: bal, label: '', change: true});
    }
  }

  // Hide unused keypool addresses (no label, zero balance, no tx history)
  return rows.filter(r => r.label || r.amount > 0 || r.change);
});

ipcMain.handle('ioc/setlabel', async (_e, address, label) => {
  try {
    // Try setlabel first (newer RPC), fall back to setaccount (legacy)
    const r1 = await safeRpc('setlabel', [address, label], '__FAIL__');
    if (r1 === '__FAIL__') {
      await safeRpc('setaccount', [address, label], null);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'failed' };
  }
});

ipcMain.handle('ioc/listtx', async (_e, n = 50) => {
  const tx = await safeRpc('listtransactions', ['*', n], []);
  return Array.isArray(tx) ? tx : [];
});

/** Create a new receiving address and label it.
 *  getnewaddress already assigns the account/label — no separate setaccount needed.
 */
async function createLabeledAddress(label='') {
  const addr = await safeRpc('getnewaddress', label ? [label] : [], null);
  if (!addr || typeof addr !== 'string') throw new Error('could not create address');
  return {address: addr, label};
}

ipcMain.handle('ioc/newaddr', async (_e, label) => {
  try {
    const res = await createLabeledAddress((label || '').trim());
    return {ok: true, ...res};
  } catch (e) {
    return {ok: false, error: e?.message || 'failed'};
  }
});

function createWindow() {
  // Start in compact widget size - will expand when user clicks stars icon
  win = new BrowserWindow({
    width: COMPACT_WINDOW_SIZE.width,
    height: COMPACT_WINDOW_SIZE.height,
    title: 'I/O Coin Widget Wallet',
    backgroundColor: '#050A12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: {x: 14, y: 14},
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Handle window close with confirmation dialog
  win.on('close', async (e) => {
    if (exitConfirmed) return;

    e.preventDefault();

    const response = await showExitConfirmation(win);

    if (response === 0) {
      // Close Wallet Completely - stop daemon and quit
      exitConfirmed = true;
      await stopDaemonAndQuitHard();
      return;
    }

    if (response === 1) {
      // Close UI Only - exit Electron, keep daemon running
      exitConfirmed = true;
      app.exit(0);
      return;
    }

    // response === 2: Cancel - do nothing, app continues
  });

  // Keep title/menu bar reachable without sticky behavior while dragging.
  // Clamp during drag intent (will-move) and on move as fallback.
  win.on('will-move', (event, newBounds) => {
    const display = screen.getDisplayMatching(newBounds);
    const workArea = display?.workArea || { x: 0, y: 0 };
    if (newBounds.y < workArea.y) {
      event.preventDefault();
      win.setPosition(newBounds.x, workArea.y, true);
    }
  });
  win.on('move', () => {
    clampWindowTopToVisibleArea(win);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Ensure consistent startup proportions across displays / DPI by
  // resetting any persisted Chromium zoom level on each launch.
  win.webContents.on('did-finish-load', () => {
    try {
      win.webContents.setZoomLevel(0);
      win.webContents.setZoomFactor(1);
    } catch {}
  });
}

function applyMainMenu() {
  if (process.platform !== 'win32') return;
  const openHelpCenterFromMenu = () => {
    const targetWin =
      BrowserWindow.getFocusedWindow() ||
      BrowserWindow.getAllWindows().find(w => w && !w.isDestroyed());
    if (!targetWin || targetWin.isDestroyed()) return;
    try {
      targetWin.webContents.send('ioc:open-help-center');
    } catch {}
  };
  const template = [
    {
      label: 'File',
      submenu: [
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Wallet Help Center',
          accelerator: 'F1',
          click: () => {
            openHelpCenterFromMenu();
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Deny ALL permission requests (eliminates Location Services prompt)
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('[permissions] Denied request for:', permission);
    callback(false);
  });

  // Set dock icon on macOS (shows IOCoin icon instead of Electron in dev mode)
  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    if (fs.existsSync(dockIconPath)) {
      const dockIcon = nativeImage.createFromPath(dockIconPath);
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
      }
    }
  }

  // Show window IMMEDIATELY so user sees the app launched
  // Splash screen will display while daemon initializes
  applyMainMenu();
  createWindow();

  // Notify renderer when OS resumes from sleep/hibernate so UI can
  // run a short recovery flow (reconnect peers + resume sync view).
  if (!global.__iocPowerResumeHookInstalled) {
    powerMonitor.on('resume', () => {
      const payload = { resumedAt: Date.now() };
      console.log('[power] System resume detected');
      for (const w of BrowserWindow.getAllWindows()) {
        if (w && !w.isDestroyed()) {
          try { w.webContents.send('ioc:system-resume', payload); } catch {}
        }
      }
    });
    global.__iocPowerResumeHookInstalled = true;
  }

  // Initialize daemon in background (install+verify, check bootstrap, start if ready)
  const daemonResult = await initDaemon();
  console.log('[app] Daemon init result:', daemonResult);

  // If daemon install/verify failed with a blocking error, show dialog
  if (!daemonResult.ok && daemonResult.error) {
    const isRosetta = daemonResult.error.includes('Rosetta');
    const response = dialog.showMessageBoxSync({
      type: 'error',
      title: isRosetta ? 'Rosetta 2 Required' : 'Daemon Error',
      message: daemonResult.error,
      buttons: isRosetta ? ['Quit'] : ['Retry', 'Quit'],
      defaultId: isRosetta ? 0 : 1
    });
    if (isRosetta || response === 1) {
      app.quit();
      return;
    }
    // Retry
    const retryResult = await initDaemon();
    if (!retryResult.ok) {
      dialog.showErrorBox('Daemon Error', retryResult.error || 'Failed to initialize daemon');
      app.quit();
      return;
    }
  }
});
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    if (exitConfirmed) app.quit();
    return;
  }
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ===== Compact Widget Mode IPC =====
function resizeWindowFromCenter(targetWin, size, animate = true) {
  const bounds = targetWin.getBounds();
  const centerX = bounds.x + Math.round(bounds.width / 2);
  const centerY = bounds.y + Math.round(bounds.height / 2);
  const nextX = centerX - Math.round(size.width / 2);
  const nextY = centerY - Math.round(size.height / 2);
  targetWin.setBounds({
    x: nextX,
    y: nextY,
    width: size.width,
    height: size.height
  }, animate);
  clampWindowTopToVisibleArea(targetWin);
}

function broadcastCompactModeChange(isCompact) {
  for (const candidate of BrowserWindow.getAllWindows()) {
    if (!candidate || candidate.isDestroyed()) continue;
    try {
      candidate.webContents.send('compact-mode-changed', !!isCompact);
    } catch {}
  }
}

function resolveSizeFromHelpContext(rawContext) {
  const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
  if (context.splashActive) {
    return context.splashDebugOpen ? SPLASH_DEBUG_WINDOW_SIZE : COMPACT_WINDOW_SIZE;
  }
  if (context.compactMode) {
    return RUNTIME_COMPACT_WIDGET_SIZE;
  }
  return FULL_WINDOW_SIZE;
}

function registerCompactModeIpc() {
  if (global.__iocCompactRegistered) return;
  global.__iocCompactRegistered = true;

  ipcMain.handle('ioc:setCompactMode', (event, isCompact) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender);
    if (!targetWin) return false;

    const size = isCompact ? RUNTIME_COMPACT_WIDGET_SIZE : FULL_WINDOW_SIZE;
    targetWin.setResizable(true);
    targetWin.setMinimumSize(size.width, size.height);
    targetWin.setMaximumSize(size.width, size.height);
    resizeWindowFromCenter(targetWin, size);
    targetWin.setResizable(false);

    broadcastCompactModeChange(isCompact);
    return true;
  });

  ipcMain.handle('ioc:setSplashDebugExpanded', (event, expanded) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender);
    if (!targetWin) return false;

    const size = expanded ? SPLASH_DEBUG_WINDOW_SIZE : COMPACT_WINDOW_SIZE;
    targetWin.setResizable(true);
    targetWin.setMinimumSize(size.width, size.height);
    targetWin.setMaximumSize(size.width, size.height);
    resizeWindowFromCenter(targetWin, size, false);
    targetWin.setResizable(false);
    return true;
  });

  ipcMain.handle('ioc:setHelpCenterWindow', (event, payload = {}) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender);
    if (!targetWin) return false;

    const nextSize = payload.open
      ? FULL_WINDOW_SIZE
      : resolveSizeFromHelpContext(payload.context);

    targetWin.setResizable(true);
    targetWin.setMinimumSize(nextSize.width, nextSize.height);
    targetWin.setMaximumSize(nextSize.width, nextSize.height);
    resizeWindowFromCenter(targetWin, nextSize, true);
    targetWin.setResizable(false);
    return true;
  });

  ipcMain.handle('ioc:getVersion', () => app.getVersion());
}

function registerSystemFolderIpc() {
  if (global.__iocSysRegistered) return;
  global.__iocSysRegistered = true;
  ipcMain.on('sys:openFolder', () => {
    shell.openPath(DATA_DIR);
  });
}

function registerDiagnosticTailIpc() {
  if (global.__iocDiagRegistered) return;
  global.__iocDiagRegistered = true;

  const cp = require('child_process');
  const procs = new Map();
  const debugLog = path.join(DATA_DIR, 'debug.log');

  function readRecent(n) {
    try {
      if (!fs.existsSync(debugLog)) return '';
      const wantedLines = Math.max(1, Number(n) || 240);
      const stat = fs.statSync(debugLog);
      if (!stat.size || stat.size <= 0) return '';

      const chunkSize = 256 * 1024;
      const fd = fs.openSync(debugLog, 'r');
      try {
        let offset = Math.max(0, stat.size - chunkSize);
        while (true) {
          const bytesToRead = stat.size - offset;
          const buf = Buffer.allocUnsafe(bytesToRead);
          fs.readSync(fd, buf, 0, bytesToRead, offset);
          const lines = buf.toString('utf8').split(/\r?\n/);
          if (offset === 0 || lines.length >= (wantedLines + 1)) {
            return lines.slice(Math.max(0, lines.length - wantedLines)).join('\n');
          }
          const nextOffset = Math.max(0, offset - chunkSize);
          if (nextOffset === offset) {
            return lines.slice(Math.max(0, lines.length - wantedLines)).join('\n');
          }
          offset = nextOffset;
        }
      } finally {
        try { fs.closeSync(fd); } catch (_) {}
      }
    } catch (error) {
      return String(error?.message || error);
    }
  }

  function start(sender) {
    if (procs.has(sender.id)) return;

    let child;
    if (process.platform === 'win32') {
      const psPath = debugLog.replace(/'/g, "''");
      const psCmd = `$p='${psPath}'; while (-not (Test-Path -LiteralPath $p)) { Start-Sleep -Milliseconds 500 }; Get-Content -LiteralPath $p -Wait -Tail 240`;
      child = cp.spawn('powershell.exe', ['-Command', psCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      child = cp.spawn('sh', ['-lc', `while [ ! -f "$1" ]; do sleep 0.5; done; tail -F -n240 "$1"`, 'sh', debugLog], { stdio: ['ignore', 'pipe', 'pipe'] });
    }

    procs.set(sender.id, child);
    const forward = (chunk) => {
      try { sender.send('diag:data', String(chunk)); } catch {}
    };

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('close', () => {
      procs.delete(sender.id);
    });
    sender.once('destroyed', () => {
      try { child.kill(); } catch {}
      procs.delete(sender.id);
    });
  }

  function stop(sender) {
    const child = procs.get(sender.id);
    if (!child) return;
    try { child.kill(); } catch {}
    procs.delete(sender.id);
  }

  ipcMain.handle('diag:recent', (_event, n) => readRecent(n));
  ipcMain.on('diag:start', (event) => start(event.sender));
  ipcMain.on('diag:stop', (event) => stop(event.sender));
}

function resolveWalletDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'IOCoin');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'IOCoin');
  return path.join(home, '.IOCoin');
}

function resolveWalletDatPath() {
  const base = resolveWalletDataDir();
  const primary = path.join(base, 'wallet.dat');
  const nested = path.join(base, 'wallets', 'wallet.dat');
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(nested)) return nested;
  return primary;
}

function registerWalletBackupIpc() {
  if (global.__iocBackupRegistered) return;
  global.__iocBackupRegistered = true;

  ipcMain.handle('ioc:wallet:getPath', async () => resolveWalletDatPath());

  ipcMain.handle('ioc:wallet:backup', async () => {
    try {
      const sourcePath = resolveWalletDatPath();
      if (!fs.existsSync(sourcePath)) {
        return { ok: false, error: `wallet.dat not found at ${sourcePath}` };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const defaultPath = path.join(app.getPath('downloads'), `wallet-${timestamp}.dat`);
      const focusedWin = BrowserWindow.getFocusedWindow();

      const { canceled, filePath } = await dialog.showSaveDialog(focusedWin, {
        title: 'Save wallet backup',
        defaultPath,
        buttonLabel: 'Save Backup',
        filters: [{ name: 'Wallet Dat', extensions: ['dat'] }]
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      fs.copyFileSync(sourcePath, filePath);
      return { ok: true, src: sourcePath, savedTo: filePath };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });
}

registerCompactModeIpc();
registerSystemFolderIpc();
registerDiagnosticTailIpc();
registerWalletBackupIpc();
// ===== end IPC =====

// ===== IOC_CONTEXT_EDIT_MENU_V2 =====
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('context-menu', (_evt, params) => {
    const tpl = [
      { role: 'cut',   enabled: params.isEditable },
      { role: 'copy',  enabled: (params.selectionText || '').length > 0 },
      { role: 'paste', enabled: params.isEditable },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.isEditable }
    ];
    const menu = Menu.buildFromTemplate(tpl);
    menu.popup({ window: win });
  });
});
// ===== /IOC_CONTEXT_EDIT_MENU_V2 =====
