/**
 * Bootstrap module for first-run chain data download.
 * Downloads and extracts bootstrap.zip to speed up initial sync.
 *
 * IMPORTANT: Downloads to temp folder (not DATA_DIR) to avoid corruption.
 * Bootstrap contains: blk0001.dat, blk0002.dat, txleveldb/
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { createWriteStream, createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { DATA_DIR, CONF_PATH, isFirstRun } = require('../shared/constants');

const BOOTSTRAP_URL = 'https://iocbootstrap.s3.us-east-2.amazonaws.com/bootstrap.zip';
const DAILY_BOOTSTRAP_RELEASE_API_URL = 'https://api.github.com/repos/IOCoin/DIONS/releases/tags/DIONS-BootStrap';
// Download to temp folder to avoid corrupting wallet data
const BOOTSTRAP_TEMP_DIR = path.join(os.tmpdir(), 'ioc-bootstrap');
const BOOTSTRAP_ZIP_PATH = path.join(BOOTSTRAP_TEMP_DIR, 'bootstrap.zip');
const BOOTSTRAP_EXTRACT_DIR = path.join(BOOTSTRAP_TEMP_DIR, 'extracted');

/**
 * Check if bootstrap is needed.
 * Returns true if:
 * - This is a first run (no iocoin.conf), OR
 * - Chain data is missing/empty (no blk*.dat files)
 *
 * Does NOT return true if user already has chain data.
 */
function needsBootstrap() {
  // If first run (no config), definitely needs bootstrap
  if (isFirstRun()) {
    return true;
  }

  // Check if chain data exists
  if (!fs.existsSync(DATA_DIR)) {
    return true;
  }

  // Look for block files (blk0001.dat, blk0002.dat, etc.)
  try {
    const files = fs.readdirSync(DATA_DIR);
    const hasBlockFiles = files.some(f => /^blk\d+\.dat$/i.test(f));
    if (!hasBlockFiles) {
      return true;
    }

    // Check if blk0001.dat has meaningful size (> 1MB means synced)
    const blk1Path = path.join(DATA_DIR, 'blk0001.dat');
    if (fs.existsSync(blk1Path)) {
      const stats = fs.statSync(blk1Path);
      // If blk0001.dat is > 1MB, user has started syncing
      if (stats.size > 1024 * 1024) {
        return false;
      }
    }

    return true;
  } catch (_) {
    return true;
  }
}

/**
 * Check if a bootstrap download is already in progress or completed.
 */
function hasBootstrapZip() {
  return fs.existsSync(BOOTSTRAP_ZIP_PATH);
}

/**
 * Download bootstrap.zip with progress callback.
 * Downloads to temp folder to avoid corrupting wallet during download.
 * @param {Function} onProgress - Called with { downloaded, total, percent }
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
function downloadBootstrap(onProgress) {
  return new Promise((resolve) => {
    // Ensure temp dir exists (NOT data dir - we download to temp first)
    if (!fs.existsSync(BOOTSTRAP_TEMP_DIR)) {
      fs.mkdirSync(BOOTSTRAP_TEMP_DIR, { recursive: true });
    }

    const file = createWriteStream(BOOTSTRAP_ZIP_PATH);

    https.get(BOOTSTRAP_URL, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(BOOTSTRAP_ZIP_PATH);
          // Recursively follow redirect
          https.get(redirectUrl, handleResponse).on('error', handleError);
          return;
        }
      }

      handleResponse(response);
    }).on('error', handleError);

    function handleResponse(response) {
      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(BOOTSTRAP_ZIP_PATH); } catch (_) {}
        resolve({ ok: false, error: `HTTP ${response.statusCode}` });
        return;
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (onProgress && totalSize > 0) {
          onProgress({
            downloaded: downloadedSize,
            total: totalSize,
            percent: Math.round((downloadedSize / totalSize) * 100)
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve({ ok: true, path: BOOTSTRAP_ZIP_PATH });
      });

      file.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(BOOTSTRAP_ZIP_PATH); } catch (_) {}
        resolve({ ok: false, error: err.message });
      });
    }

    function handleError(err) {
      file.close();
      try { fs.unlinkSync(BOOTSTRAP_ZIP_PATH); } catch (_) {}
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * Extract bootstrap.zip to temp folder first.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function extractBootstrap() {
  if (!fs.existsSync(BOOTSTRAP_ZIP_PATH)) {
    return { ok: false, error: 'Bootstrap zip not found' };
  }

  try {
    const { execFile } = require('node:child_process');

    // Clean and create extract directory
    if (fs.existsSync(BOOTSTRAP_EXTRACT_DIR)) {
      fs.rmSync(BOOTSTRAP_EXTRACT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BOOTSTRAP_EXTRACT_DIR, { recursive: true });

    // Log zip file size for debugging
    const zipStats = fs.statSync(BOOTSTRAP_ZIP_PATH);
    console.log(`[bootstrap] Zip size: ${(zipStats.size / (1024*1024)).toFixed(1)} MB`);

    return new Promise((resolve) => {
      // Extract to temp folder first — platform-aware
      if (process.platform === 'win32') {
        // Windows: use tar (built into Windows 10+, much faster than Expand-Archive)
        console.log('[bootstrap] Extracting with tar (Windows)...');
        execFile('tar', ['-xf', BOOTSTRAP_ZIP_PATH, '-C', BOOTSTRAP_EXTRACT_DIR], { timeout: 600000 }, (tarErr) => {
          if (tarErr) {
            // Fallback: try PowerShell Expand-Archive (slower but always available)
            console.log('[bootstrap] tar failed, falling back to Expand-Archive...');
            console.log('[bootstrap] tar error:', tarErr.message);
            const psCmd = `Expand-Archive -LiteralPath '${BOOTSTRAP_ZIP_PATH}' -DestinationPath '${BOOTSTRAP_EXTRACT_DIR}' -Force`;
            execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 900000 }, (psErr, _stdout, stderr) => {
              if (psErr) {
                const detail = stderr ? String(stderr).substring(0, 200) : psErr.message;
                console.error('[bootstrap] Expand-Archive failed:', detail);
                resolve({ ok: false, error: `Extract failed: ${detail}` });
              } else {
                console.log('[bootstrap] Expand-Archive succeeded');
                resolve({ ok: true });
              }
            });
          } else {
            console.log('[bootstrap] tar extraction succeeded');
            resolve({ ok: true });
          }
        });
      } else {
        const unzipArgs = ['-o', BOOTSTRAP_ZIP_PATH, '-d', BOOTSTRAP_EXTRACT_DIR];
        execFile('unzip', unzipArgs, { timeout: 600000 }, (err) => {
          if (err) {
            // Try ditto on macOS as fallback
            if (process.platform === 'darwin') {
              execFile('ditto', ['-xk', BOOTSTRAP_ZIP_PATH, BOOTSTRAP_EXTRACT_DIR], { timeout: 600000 }, (err2) => {
                if (err2) {
                  resolve({ ok: false, error: `Extract failed: ${err2.message}` });
                } else {
                  resolve({ ok: true });
                }
              });
            } else {
              resolve({ ok: false, error: `Extract failed: ${err.message}` });
            }
          } else {
            resolve({ ok: true });
          }
        });
      }
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Copy extracted bootstrap files to DATA_DIR.
 * Replaces existing blk*.dat and txleveldb/ files.
 * MUST be called AFTER daemon is stopped!
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function applyBootstrapFiles() {
  try {
    // Ensure DATA_DIR exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Delete existing chain data files in DATA_DIR
    const filesToDelete = ['blk0001.dat', 'blk0002.dat', 'txleveldb'];
    for (const file of filesToDelete) {
      const filePath = path.join(DATA_DIR, file);
      if (fs.existsSync(filePath)) {
        console.log(`[bootstrap] Removing old ${file}`);
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }

    // Find the actual extract root — zip may contain nested folder
    let extractRoot = BOOTSTRAP_EXTRACT_DIR;
    const topLevel = fs.readdirSync(BOOTSTRAP_EXTRACT_DIR);
    console.log(`[bootstrap] Extracted contents (top-level): ${topLevel.join(', ')}`);

    // If the zip contained a single subfolder, look inside it
    if (topLevel.length === 1) {
      const single = path.join(BOOTSTRAP_EXTRACT_DIR, topLevel[0]);
      if (fs.statSync(single).isDirectory()) {
        const innerFiles = fs.readdirSync(single);
        if (innerFiles.some(f => /^blk\d+\.dat$/i.test(f))) {
          console.log(`[bootstrap] Found chain data inside subfolder: ${topLevel[0]}`);
          extractRoot = single;
        }
      }
    }

    // Also check one more level deep (e.g. bootstrap/data/blk0001.dat)
    if (extractRoot === BOOTSTRAP_EXTRACT_DIR) {
      const hasBlk = topLevel.some(f => /^blk\d+\.dat$/i.test(f));
      if (!hasBlk) {
        // Search subdirectories for blk files
        for (const dir of topLevel) {
          const dirPath = path.join(BOOTSTRAP_EXTRACT_DIR, dir);
          if (fs.statSync(dirPath).isDirectory()) {
            const subFiles = fs.readdirSync(dirPath);
            if (subFiles.some(f => /^blk\d+\.dat$/i.test(f))) {
              console.log(`[bootstrap] Found chain data in nested folder: ${dir}`);
              extractRoot = dirPath;
              break;
            }
            // Check one more level
            for (const sub of subFiles) {
              const subPath = path.join(dirPath, sub);
              try {
                if (fs.statSync(subPath).isDirectory()) {
                  const deepFiles = fs.readdirSync(subPath);
                  if (deepFiles.some(f => /^blk\d+\.dat$/i.test(f))) {
                    console.log(`[bootstrap] Found chain data in deep folder: ${dir}/${sub}`);
                    extractRoot = subPath;
                    break;
                  }
                }
              } catch (_) {}
            }
            if (extractRoot !== BOOTSTRAP_EXTRACT_DIR) break;
          }
        }
      }
    }

    // Copy new files from extracted folder
    const extractedFiles = fs.readdirSync(extractRoot);
    let copiedCount = 0;
    for (const file of extractedFiles) {
      const srcPath = path.join(extractRoot, file);
      const destPath = path.join(DATA_DIR, file);

      // SAFETY: never overwrite wallet.dat — it may contain user keys
      if (file === 'wallet.dat') {
        console.log('[bootstrap] SKIPPING wallet.dat — protecting user keys');
        continue;
      }

      // Only copy chain data files (blk*.dat and txleveldb)
      if (/^blk\d+\.dat$/i.test(file) || file === 'txleveldb') {
        console.log(`[bootstrap] Copying ${file} to DATA_DIR`);
        if (fs.statSync(srcPath).isDirectory()) {
          // Copy directory recursively
          copyDirSync(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
        copiedCount++;
      }
    }

    if (copiedCount === 0) {
      console.error('[bootstrap] No chain data files found in extracted archive!');
      console.error('[bootstrap] Extract root:', extractRoot);
      console.error('[bootstrap] Files found:', extractedFiles.join(', '));
      return { ok: false, error: 'No blockchain files found in bootstrap archive' };
    }

    console.log(`[bootstrap] Successfully copied ${copiedCount} chain data items`);
    return { ok: true };
  } catch (err) {
    console.error('[bootstrap] Apply error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Recursively copy directory.
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clean up all bootstrap temp files (zip and extracted folder).
 */
function cleanupBootstrap() {
  try {
    if (fs.existsSync(BOOTSTRAP_TEMP_DIR)) {
      fs.rmSync(BOOTSTRAP_TEMP_DIR, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get bootstrap zip path for external use.
 */
function getBootstrapZipPath() {
  return BOOTSTRAP_ZIP_PATH;
}

/**
 * Get bootstrap extract directory path.
 */
function getBootstrapExtractDir() {
  return BOOTSTRAP_EXTRACT_DIR;
}

function parseBootstrapHeightFromReleaseTitle(title) {
  if (!title || typeof title !== 'string') return null;
  // Preferred legacy format: "... = 5552309"
  const eq = /=(\s*)(\d{4,})/.exec(title);
  if (eq) {
    const h = parseInt(eq[2], 10);
    if (Number.isFinite(h) && h > 0) return h;
  }

  // Flexible formats:
  // - "DIONS-BootStrap 5552309"
  // - "Height 5,552,309"
  // - "Checkpoint 5.552.309"
  const tokens = title.match(/\d[\d.,\s]{4,}\d/g) || [];
  const heights = tokens
    .map(t => parseInt(String(t).replace(/[^\d]/g, ''), 10))
    .filter(n => Number.isFinite(n) && n > 0);

  if (!heights.length) return null;

  // IOC chain height should be in the low millions (not dates).
  // Prefer values in a realistic window first.
  const realistic = heights.filter(n => n >= 1000000 && n <= 20000000);
  if (realistic.length) return realistic[realistic.length - 1];

  return heights[heights.length - 1] || null;
}

function fetchDailyBootstrapMetadata() {
  return new Promise((resolve) => {
    const req = https.get(DAILY_BOOTSTRAP_RELEASE_API_URL, {
      headers: {
        'User-Agent': 'ioc-widget-wallet',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `GitHub HTTP ${res.statusCode || 0}` });
            return;
          }
          const json = JSON.parse(data || '{}');
          const title = String(json.name || '');
          const tag = String(json.tag_name || '');
          const body = String(json.body || '');
          const height =
            parseBootstrapHeightFromReleaseTitle(title) ||
            parseBootstrapHeightFromReleaseTitle(tag) ||
            parseBootstrapHeightFromReleaseTitle(body);
          if (!height) {
            resolve({ ok: false, error: 'Could not parse bootstrap height from release title' });
            return;
          }
          resolve({
            ok: true,
            height,
            title,
            tag,
            publishedAt: String(json.published_at || ''),
            htmlUrl: String(json.html_url || ''),
            apiUrl: DAILY_BOOTSTRAP_RELEASE_API_URL
          });
        } catch (err) {
          resolve({ ok: false, error: err.message || 'Invalid release metadata response' });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message || 'Metadata fetch failed' }));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      resolve({ ok: false, error: 'Metadata fetch timeout' });
    });
  });
}

function createRebootstrapBackup(context = {}) {
  try {
    const backupRoot = path.join(DATA_DIR, 'wallet_backup.rebootstrap');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupRoot, stamp);
    fs.mkdirSync(backupDir, { recursive: true });

    const files = [];
    const copyIfExists = (src, filename) => {
      if (!src || !filename || !fs.existsSync(src)) return;
      const dest = path.join(backupDir, filename);
      fs.copyFileSync(src, dest);
      const stats = fs.statSync(dest);
      files.push({
        name: filename,
        source: src,
        bytes: stats.size
      });
    };

    copyIfExists(path.join(DATA_DIR, 'wallet.dat'), 'wallet.dat');
    copyIfExists(CONF_PATH, 'iocoin.conf');

    const manifest = {
      createdAt: new Date().toISOString(),
      backupDir,
      dataDir: DATA_DIR,
      files,
      context
    };
    const manifestPath = path.join(backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return { ok: true, backupDir, manifestPath, files };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  BOOTSTRAP_URL,
  DAILY_BOOTSTRAP_RELEASE_API_URL,
  needsBootstrap,
  hasBootstrapZip,
  downloadBootstrap,
  extractBootstrap,
  applyBootstrapFiles,
  cleanupBootstrap,
  getBootstrapZipPath,
  getBootstrapExtractDir,
  fetchDailyBootstrapMetadata,
  createRebootstrapBackup
};
