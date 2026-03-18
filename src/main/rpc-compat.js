const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

function macDirs() {
  const h = os.homedir();
  return [
    path.join(h, 'Library', 'IOCoin'),
    path.join(h, 'Library', 'Application Support', 'IOCoin')
  ];
}

function dataDir() {
  if (process.platform === 'darwin') {
    const [legacy, appsup] = macDirs();
    if (fs.existsSync(legacy)) return legacy;
    if (fs.existsSync(appsup)) return appsup;
    return legacy;
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'IOCoin');
  }
  const A = path.join(os.homedir(), '.IOCoin');
  const B = path.join(os.homedir(), '.iocoin');
  return fs.existsSync(A) ? A : B;
}

function readConf() {
  const f = path.join(dataDir(), 'iocoin.conf');
  const cfg = { user: '', pass: '', port: 33765, host: '127.0.0.1' };

  if (!fs.existsSync(f)) {
    return cfg;
  }

  try {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(l => {
      l = String(l || '').trim();
      if (!l || l[0] === '#') return;
      const i = l.indexOf('=');
      if (i <= 0) return;
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      if (k === 'rpcuser') cfg.user = v;
      else if (k === 'rpcpassword') cfg.pass = v;
      else if (k === 'rpcport') {
        const p = parseInt(v, 10);
        if (!Number.isNaN(p)) cfg.port = p;
      } else if (k === 'rpcbind' && v) {
        cfg.host = v;
      }
    });
  } catch (e) {
    // ignore read errors
  }
  return cfg;
}

const CONF = readConf();

function tryOnce({ host, port, auth }, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'ioc-ui', method, params });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (auth) headers.Authorization = 'Basic ' + auth;

    const req = http.request({ hostname: host, port, method: 'POST', path: '/', headers, timeout: 5000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        if ((res.statusCode === 401 || res.statusCode === 403) && !auth) {
          return reject(Object.assign(new Error('unauth'), { code: 'EUNAUTH' }));
        }
        try {
          const j = JSON.parse(data);
          if (Object.prototype.hasOwnProperty.call(j, 'result')) return resolve(j.result);
          return reject(new Error(j && j.error ? (j.error.message || 'rpc error') : 'rpc no result'));
        } catch {
          return reject(new Error('rpc parse error'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpc timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function compatCallRpc(method, params = []) {
  const hosts = [CONF.host || '127.0.0.1', '::1', 'localhost'];
  const ports = [CONF.port || 33765, 7332];
  const auth = (CONF.user && CONF.pass) ? Buffer.from(`${CONF.user}:${CONF.pass}`).toString('base64') : null;

  for (const host of hosts) {
    for (const port of ports) {
      try {
        return await tryOnce({ host, port, auth: null }, method, params);
      } catch (e) {
        if (e && e.code === 'EUNAUTH') {
          hosts.unshift(host);
          ports.unshift(port);
          break;
        }
      }
    }
  }

  if (auth) {
    for (const host of hosts) {
      for (const port of ports) {
        try {
          return await tryOnce({ host, port, auth }, method, params);
        } catch {
          // ignore
        }
      }
    }
  }

  throw new Error('RPC unreachable on localhost');
}

function init() {
  if (process.env.IOC_RPC_COMPAT === '1') {
    if (!global.callRpc) global.callRpc = compatCallRpc;
    global.__IOC_COMPAT_READY = true;
  }
}

module.exports = {
  init,
  compatCallRpc,
  compatConfig: CONF,
  // Exported for testing purposes
  _private: {
    macDirs,
    dataDir,
    readConf,
  }
};
