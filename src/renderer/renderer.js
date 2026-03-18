const $ = id => document.getElementById(id);

/** Extract a human-readable error from an RPC/IPC failure. */
function extractRpcError(e) {
  if (!e) return '';
  const msg = e.message || String(e);
  // Electron IPC wraps: "Error invoking remote method 'ioc:rpc': Error: <actual message>"
  const ipcMatch = /Error invoking remote method '[^']+': (?:Error: )?(.+)/.exec(msg);
  if (ipcMatch) return ipcMatch[1];
  // Axios wraps: "Request failed with status code 500" â€” but daemon msg may be in response
  if (/status code 500/i.test(msg)) return 'Insufficient funds';
  return msg;
}

let state = { unlocked: false, encrypted: null, peers: 0, synced: false, blocks: 0 };
let lockOverrideUntil = 0; // timestamp â€” suppress polling lock overwrite until this time
let refreshing = false;
let nextTimer = null;
let last = { bal: null, stakeAmt: null, stakeOn: null, vp: 0, blocks: 0, headers: 0 };

// ===== Splash State =====
let splashState = {
  visible: true,
  validStatusReceived: false,
  startTime: Date.now(),
  initialBlocks: null,  // Track initial blocks to detect movement
  longWaitShown: false,
  blockchainIndexShown: false,
  syncStartTime: null,  // When sync phase started (for ETA calculation)
  syncStartBlocks: null, // Blocks when sync phase started
  etaReadySince: 0,
  lastBlocksPerSec: 0,
  longPhaseKey: null,   // 'daemon' | 'index' | 'waiting'
  longPhaseStartedAt: 0,
  longPhaseAttemptCurrent: 0,
  longPhaseAttemptTotal: 0,
  phase: 'connecting',   // 'connecting' | 'downloading' | 'installing' | 'syncing'
  stepFlow: 'startup',   // 'startup' | 'bootstrap'
  debugExpanded: false,
  logAutoFollow: true
};

// Constants for splash behavior
const SPLASH_BLOCKS_THRESHOLD = 0; // Hide splash only once the node reaches the network tip
const SEND_FEE_IOC = 0.001;
const SEND_ALL_EPSILON = 0.00000001;
const LOG_FOLLOW_THRESHOLD_PX = 20;
const SPLASH_STATUS_REFERENCE_TEXTS = [
  'Loading daemon... this may take a few minutes',
  'Extracting blockchain data (this may take a few minutes)...',
  'Installing blockchain files...',
  'Downloading bootstrap... 100%',
  'Syncing with the network'
];
const REBOOTSTRAP_REMOTE_LEAD_BLOCKS = 500;
const REBOOTSTRAP_NOTICE_AFTER_ETA_MS = 10 * 1000;
const REBOOTSTRAP_OVERHEAD_SECONDS = 15 * 60;
const REBOOTSTRAP_NOTICE_TTL_MS = 15 * 60 * 1000;
const REBOOTSTRAP_SNOOZE_MS = 60 * 60 * 1000;
const SPLASH_LOG_POLL_INTERVAL_MS = 1200;
const SPLASH_SYNC_REFRESH_INTERVAL_MS = 1200;
const SEND_DISABLED_SYNC_MESSAGE = 'Sending is disabled until synchronization reaches 100%.';
let _splashStatusFitRaf = null;
let _splashUniformStatusFont = { available: 0, size: null };
let _syncLockNoticeTimer = null;

let rebootstrapAdvisorState = {
  enabled: true,
  startedAt: 0,
  startBlock: 0,
  remoteCheckInFlight: false,
  remoteChecked: false,
  remoteMeta: null,
  remoteRetryAt: 0,
  remoteFailures: 0,
  applying: false,
  noticeVisible: false,
  noticeExpiresAt: 0,
  dismissedUntil: 0,
  candidate: null
};

let resumeRecoveryState = {
  active: false,
  seq: 0,
  lastAt: 0,
  watchdogTimer: null
};
const RESUME_RECOVERY_DEDUP_MS = 5000;
const RESUME_RECOVERY_STAGE_MS = 1100;
const RESUME_RECOVERY_STUCK_MS = 30000;

function isLogNearBottom(el, threshold = LOG_FOLLOW_THRESHOLD_PX) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function scrollLogToBottom(el) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function updateSplashJumpLatestVisibility() {
  const btn = $('splashDebugJump');
  const logEl = $('splashLog');
  if (!btn || !logEl) return;
  const show = splashState.debugExpanded && !isLogNearBottom(logEl) && (logEl.scrollHeight > logEl.clientHeight);
  btn.classList.toggle('hidden', !show);
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearResumeRecoveryWatchdog() {
  if (resumeRecoveryState.watchdogTimer) {
    clearTimeout(resumeRecoveryState.watchdogTimer);
    resumeRecoveryState.watchdogTimer = null;
  }
}

function startResumeRecoveryWatchdog(seq) {
  clearResumeRecoveryWatchdog();
  resumeRecoveryState.watchdogTimer = setTimeout(async () => {
    if (resumeRecoveryState.seq !== seq) return;
    if (!splashState.visible) return;
    const statusNow = ($('splashStatus')?.textContent || '').toLowerCase();
    if (!statusNow.includes('resuming sync')) return;

    console.warn('[resume] Resuming sync watchdog fired; forcing daemon restart');
    updateSplashStatus('Resuming sync is taking too long...');
    setSplashEta('Restarting daemon after system resume...');

    try {
      await window.ioc.restartDaemon();
    } catch (err) {
      console.warn('[resume] restartDaemon failed after watchdog:', err?.message || err);
    }

    if (resumeRecoveryState.seq !== seq) return;
    setSplashStepFlow('startup');
    setSplashPhase('connecting');
    updateSplashStatus('Loading daemon... this may take a few minutes');
    setSplashEta('Recovering after system resume...');
    connectionState.connected = false;
    connectionState.attempts = 0;
    refresh();
    setTimeout(() => {
      if (resumeRecoveryState.seq === seq) refresh();
    }, 2000);
    resumeRecoveryState.active = false;
    clearResumeRecoveryWatchdog();
  }, RESUME_RECOVERY_STUCK_MS);
}

async function runResumeRecoveryFlow() {
  if (bootstrapState.inProgress || rebootstrapAdvisorState.applying) return;

  const now = Date.now();
  if ((now - resumeRecoveryState.lastAt) < RESUME_RECOVERY_DEDUP_MS) return;
  resumeRecoveryState.lastAt = now;
  clearResumeRecoveryWatchdog();

  const seq = ++resumeRecoveryState.seq;
  resumeRecoveryState.active = true;

  console.log('[resume] Starting post-sleep recovery flow');

  setSplashStepFlow('startup');
  showSplash();
  setSplashPhase('connecting');
  hideRebootstrapNotice({ disable: false });
  setSplashMeta('');
  updateSplashStatus('Reconnecting daemon...');
  setSplashEta('Re-validating node after system resume...');

  // Force reconnect path and immediate status pull.
  connectionState.connected = false;
  connectionState.attempts = 0;
  refresh();

  await sleepMs(RESUME_RECOVERY_STAGE_MS);
  if (resumeRecoveryState.seq !== seq) return;
  if (!splashState.visible) {
    resumeRecoveryState.active = false;
    return;
  }

  updateSplashStatus('Refreshing peers...');
  setSplashEta('Refreshing network connections...');
  refresh();

  await sleepMs(RESUME_RECOVERY_STAGE_MS);
  if (resumeRecoveryState.seq !== seq) return;
  if (!splashState.visible) {
    resumeRecoveryState.active = false;
    return;
  }

  updateSplashStatus('Resuming sync...');
  setSplashEta('Resuming blockchain sync...');
  refresh();
  startResumeRecoveryWatchdog(seq);

  setTimeout(() => {
    if (resumeRecoveryState.seq === seq) {
      resumeRecoveryState.active = false;
    }
  }, 4000);
}

function fitSplashStatusSingleLine() {
  const status = $('splashStatus');
  const content = document.querySelector('.splash-content');
  if (!status || !content) return;
  const available = Math.max(200, content.clientWidth - 28);
  const maxFont = 56;
  const minFont = 14;

  // During sync phase we intentionally prioritize the headline hierarchy:
  // "Syncing with the network" must be the dominant text.
  if (document.body.classList.contains('splash-syncing')) {
    const computed = window.getComputedStyle(status);
    const family = computed.fontFamily || '-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    const isCompact = document.body.classList.contains('compact-mode');
    const syncMax = isCompact ? 22 : 30;
    const syncMin = isCompact ? 13 : 17;
    const text = (status.textContent || '').trim() || 'Syncing with the network';
    const measureCtx = (fitSplashStatusSingleLine._syncMeasureCtx ||= document.createElement('canvas').getContext('2d'));
    let size = syncMax;
    while (size > syncMin) {
      measureCtx.font = `700 ${size}px ${family}`;
      const measured = measureCtx.measureText(text).width;
      if (measured <= available) break;
      size -= 1;
    }
    status.style.whiteSpace = 'nowrap';
    status.style.maxWidth = '100%';
    status.style.overflow = 'hidden';
    status.style.textOverflow = 'ellipsis';
    status.style.fontWeight = '700';
    status.style.letterSpacing = '-0.005em';
    status.style.fontSize = `${size}px`;
    return;
  }

  // Compute one shared font size based on the longest startup text.
  // This keeps all splash messages visually uniform across phases.
  let uniformSize = _splashUniformStatusFont.size;
  if (!_splashUniformStatusFont.size || _splashUniformStatusFont.available !== available) {
    const measureCtx = (fitSplashStatusSingleLine._measureCtx ||= document.createElement('canvas').getContext('2d'));
    const computed = window.getComputedStyle(status);
    const weight = computed.fontWeight || '500';
    const family = computed.fontFamily || '-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    const spacingToken = computed.letterSpacing || '0px';
    let size = maxFont;
    while (size > minFont) {
      measureCtx.font = `${weight} ${size}px ${family}`;
      const spacingPx = (() => {
        if (spacingToken.endsWith('px')) return parseFloat(spacingToken) || 0;
        if (spacingToken.endsWith('em')) return (parseFloat(spacingToken) || 0) * size;
        return 0;
      })();
      const measured = SPLASH_STATUS_REFERENCE_TEXTS.reduce((longest, txt) => {
        const w = measureCtx.measureText(txt).width + Math.max(0, txt.length - 1) * spacingPx;
        return Math.max(longest, w);
      }, 0);
      if (measured <= available) break;
      size -= 1;
    }
    uniformSize = size;
    _splashUniformStatusFont = { available, size: uniformSize };
  }

  status.style.whiteSpace = 'nowrap';
  status.style.maxWidth = '100%';
  status.style.overflow = 'hidden';
  status.style.textOverflow = 'ellipsis';
  status.style.fontWeight = '';
  status.style.letterSpacing = '';
  status.style.fontSize = `${uniformSize}px`;
}

function normalizeSplashStatusText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ');

  // Never show long technical file-lock paths in splash headline.
  if (
    /(?:\bEBUSY\b|\bEPERM\b|resource busy|cannot obtain a lock|unlink)/i.test(compact) ||
    /[A-Za-z]:\\|\/Users\/|\/home\/|AppData\\|txleveldb/i.test(compact)
  ) {
    return 'Could not apply bootstrap files. Returning to local sync...';
  }

  return compact;
}

function scheduleSplashStatusFit() {
  if (_splashStatusFitRaf) cancelAnimationFrame(_splashStatusFitRaf);
  _splashStatusFitRaf = requestAnimationFrame(() => {
    _splashStatusFitRaf = null;
    fitSplashStatusSingleLine();
    requestAnimationFrame(fitSplashStatusSingleLine);
  });
}

function inferLongPhaseFromStatus(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/loading blockchain index/.test(t)) return 'index';
  if (/waiting for daemon to start|starting daemon/.test(t)) return 'waiting';
  if (/loading daemon/.test(t)) return 'daemon';
  return null;
}

function parseAttemptFromStatus(text) {
  const m = /attempt\s*(\d+)\s*\/\s*(\d+)/i.exec(String(text || ''));
  if (!m) return null;
  const current = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total };
}

function resetSplashLongPhaseProgress() {
  splashState.longPhaseKey = null;
  splashState.longPhaseStartedAt = 0;
  splashState.longPhaseAttemptCurrent = 0;
  splashState.longPhaseAttemptTotal = 0;
}

function updateSplashLongPhaseFromStatus(statusText) {
  if (!splashState.visible || splashState.phase !== 'connecting') {
    resetSplashLongPhaseProgress();
    updateSplashStepIndicator();
    return;
  }

  const nextKey = inferLongPhaseFromStatus(statusText);
  if (!nextKey) {
    resetSplashLongPhaseProgress();
    updateSplashStepIndicator();
    return;
  }

  if (splashState.longPhaseKey !== nextKey) {
    splashState.longPhaseKey = nextKey;
    splashState.longPhaseStartedAt = Date.now();
    splashState.longPhaseAttemptCurrent = 0;
    splashState.longPhaseAttemptTotal = 0;
  }

  const attempt = parseAttemptFromStatus(statusText);
  if (attempt) {
    splashState.longPhaseAttemptCurrent = attempt.current;
    splashState.longPhaseAttemptTotal = attempt.total;
  }

  updateSplashStepIndicator();
}

function ensureSplashDecorations() {
  const content = document.querySelector('.splash-content');
  const progress = document.querySelector('.splash-progress');
  const log = $('splashLog');
  const status = $('splashStatus');
  if (!content || !progress || !status || !log) return;

  if (!$('splashMeta')) {
    const meta = document.createElement('div');
    meta.id = 'splashMeta';
    meta.className = 'splash-meta hidden';
    status.insertAdjacentElement('afterend', meta);
  }

  if (!$('splashStage')) {
    const stage = document.createElement('div');
    stage.id = 'splashStage';
    stage.className = 'splash-stage';
    stage.setAttribute('aria-hidden', 'true');
    stage.innerHTML = `
      <div class="splash-stage-chain">
        <span class="splash-stage-block"></span>
        <span class="splash-stage-block"></span>
        <span class="splash-stage-block"></span>
        <span class="splash-stage-block"></span>
        <span class="splash-stage-block"></span>
      </div>`;
    $('splashMeta')?.insertAdjacentElement('afterend', stage);
  }

  if (!$('splashEta')) {
    const eta = document.createElement('div');
    eta.id = 'splashEta';
    eta.className = 'splash-eta';
    eta.textContent = 'Estimating ETA...';
    progress.appendChild(eta);
  }

  if (!$('splashStepIndicator')) {
    const step = document.createElement('div');
    step.id = 'splashStepIndicator';
    step.className = 'splash-step-indicator';
    step.textContent = '1/3';
    progress.insertAdjacentElement('afterend', step);
  }

  // Section 2 wrapper: Current block + animation + ETA bar
  if (!$('splashSyncSection2')) {
    const section2 = document.createElement('div');
    section2.id = 'splashSyncSection2';
    section2.className = 'splash-sync-section2';
    status.insertAdjacentElement('afterend', section2);
  }
  const section2 = $('splashSyncSection2');
  const meta = $('splashMeta');
  const stage = $('splashStage');
  const stepIndicator = $('splashStepIndicator');
  if (section2 && meta && meta.parentNode !== section2) section2.appendChild(meta);
  if (section2 && stage && stage.parentNode !== section2) section2.appendChild(stage);
  if (section2 && progress && progress.parentNode !== section2) section2.appendChild(progress);
  if (section2 && stepIndicator && stepIndicator.parentNode !== section2) section2.appendChild(stepIndicator);

  // Keep deterministic order once without re-appending every refresh
  // (re-appending can restart CSS animations on some platforms).
  if (section2) {
    const ordered = [meta, stage, progress, stepIndicator].filter(Boolean);
    for (let i = 0; i < ordered.length; i += 1) {
      const node = ordered[i];
      const atPos = section2.children[i] === node;
      if (!atPos) {
        section2.insertBefore(node, section2.children[i] || null);
      }
    }
  }

  if (!$('splashDebugToggle')) {
    const wrap = document.createElement('div');
    wrap.className = 'splash-debug-cta-wrap';
    wrap.innerHTML = `<button id="splashDebugToggle" class="splash-debug-toggle" type="button">Show live debug</button>`;
    if (section2) {
      section2.insertAdjacentElement('afterend', wrap);
    } else {
      progress.insertAdjacentElement('afterend', wrap);
    }
  }

  const ctaWrap = document.querySelector('.splash-debug-cta-wrap');
  if (section2 && ctaWrap && ctaWrap.parentNode === section2) {
    section2.insertAdjacentElement('afterend', ctaWrap);
  }

  if (!$('splashDebugWrap')) {
    const wrap = document.createElement('div');
    wrap.id = 'splashDebugWrap';
    wrap.className = 'splash-debug-wrap';
      wrap.innerHTML = `
        <div class="splash-debug-inner">
          <div class="splash-debug-panel">
            <div class="splash-debug-head">
              <div class="splash-debug-title">Live Debug Output</div>
              <div class="splash-debug-head-right">
                <div id="splashDebugConnections" class="splash-debug-connections">Connections: 0</div>
                <button id="splashDebugJump" class="splash-debug-jump hidden" type="button">Jump to latest</button>
                <div class="splash-debug-pill">LIVE</div>
              </div>
            </div>
          </div>
        </div>`;
    const panel = wrap.querySelector('.splash-debug-panel');
    panel.appendChild(log);
    const currentCtaWrap = document.querySelector('.splash-debug-cta-wrap');
    currentCtaWrap?.insertAdjacentElement('afterend', wrap);
  }

  const toggle = $('splashDebugToggle');
  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      setSplashDebugExpanded(!splashState.debugExpanded);
    });
  }

  const jump = $('splashDebugJump');
  if (jump && !jump.dataset.bound) {
    jump.dataset.bound = '1';
    jump.addEventListener('click', () => {
      splashState.logAutoFollow = true;
      scrollLogToBottom($('splashLog'));
      updateSplashJumpLatestVisibility();
    });
  }

  if (!log.dataset.boundScroll) {
    log.dataset.boundScroll = '1';
    log.addEventListener('scroll', () => {
      splashState.logAutoFollow = isLogNearBottom(log);
      updateSplashJumpLatestVisibility();
    });
  }

  updateSplashStepIndicator();
}

function getSplashStepInfo() {
  const flow = splashState.stepFlow || 'startup';
  const phase = splashState.phase || 'connecting';

  if (flow === 'bootstrap') {
    const map = {
      downloading: 1,
      installing: 2,
      connecting: 3,
      syncing: 4
    };
    return { current: map[phase] || 1, total: 4 };
  }

  if (phase === 'connecting') {
    const longMap = { daemon: 1, index: 2, waiting: 3 };
    return { current: longMap[splashState.longPhaseKey] || 1, total: 3 };
  }
  if (phase === 'syncing') return { current: 3, total: 3 };
  return { current: 1, total: 3 };
}

function updateSplashStepIndicator() {
  const el = $('splashStepIndicator');
  if (!el) return;
  const { current, total } = getSplashStepInfo();
  el.textContent = `${current}/${total}`;
}

function setSplashStepFlow(flow) {
  splashState.stepFlow = flow === 'bootstrap' ? 'bootstrap' : 'startup';
  updateSplashStepIndicator();
}

function setSplashMeta(text) {
  ensureSplashDecorations();
  const meta = $('splashMeta');
  if (!meta) return;
  if (text) {
    meta.textContent = text;
    meta.classList.remove('hidden');
  } else {
    meta.textContent = '';
    meta.classList.add('hidden');
  }
}

function setSplashEta(text) {
  ensureSplashDecorations();
  const eta = $('splashEta');
  if (!eta) return;
  const value = text || '';
  eta.textContent = value;
  const etaReady = !!value && !/calculating eta/i.test(value);
  if (etaReady) {
    if (!splashState.etaReadySince) splashState.etaReadySince = Date.now();
  } else {
    splashState.etaReadySince = 0;
  }
}

let _splashDebugToggleBusy = false;
let _splashLastDebugToggleAt = 0;
let _splashLogStartTimer = null;

function clearSplashLogStartTimer() {
  if (_splashLogStartTimer) {
    clearTimeout(_splashLogStartTimer);
    _splashLogStartTimer = null;
  }
}

function scheduleSplashLogStart(delayMs = 1000) {
  clearSplashLogStartTimer();
  _splashLogStartTimer = setTimeout(() => {
    _splashLogStartTimer = null;
    if (!splashState.visible || !splashState.debugExpanded) return;
    startSplashLog();
  }, Math.max(0, Number(delayMs) || 0));
}

function setSplashDebugExpanded(expanded) {
  const now = Date.now();
  if (now - _splashLastDebugToggleAt < 180) return;
  if (_splashDebugToggleBusy) return;
  _splashLastDebugToggleAt = now;
  _splashDebugToggleBusy = true;
  const wantExpanded = !!expanded;
  if (wantExpanded === splashState.debugExpanded) {
    _splashDebugToggleBusy = false;
    return;
  }
  splashState.debugExpanded = wantExpanded;
  const toggle = $('splashDebugToggle');
  if (toggle) {
    toggle.disabled = true;
    toggle.textContent = wantExpanded ? 'Hide live debug' : 'Show live debug';
  }
  if (!wantExpanded) {
    $('splashDebugJump')?.classList.add('hidden');
  }

  const applyOpenClass = () => {
    document.body.classList.add('splash-debug-open');
    updateSplashJumpLatestVisibility();
  };
  const applyCloseClass = () => {
    document.body.classList.remove('splash-debug-open');
  };
  const finishToggle = () => {
    _splashDebugToggleBusy = false;
    if (toggle) toggle.disabled = false;
  };
  const openAfterResize = () => {
    requestAnimationFrame(() => {
      applyOpenClass();
      scheduleSplashLogStart(1000);
      finishToggle();
    });
  };
  const closeAfterResize = () => {
    requestAnimationFrame(() => {
      applyCloseClass();
      finishToggle();
    });
  };

  if (window.ioc && typeof window.ioc.setSplashDebugExpanded === 'function') {
    if (wantExpanded) {
      Promise.resolve(window.ioc.setSplashDebugExpanded(true))
        .catch(() => {})
        .finally(() => {
          openAfterResize();
        });
    } else {
      clearSplashLogStartTimer();
      stopSplashLog();
      Promise.resolve(window.ioc.setSplashDebugExpanded(false))
        .catch(() => {})
        .finally(() => {
          closeAfterResize();
        });
    }
  } else {
    if (wantExpanded) {
      openAfterResize();
    } else {
      clearSplashLogStartTimer();
      stopSplashLog();
      closeAfterResize();
    }
  }
}

function setSplashPhase(phase) {
  splashState.phase = phase;
  const syncing = phase === 'syncing';
  document.body.classList.toggle('splash-syncing', syncing);
  if (phase !== 'connecting') clearResumeRecoveryWatchdog();
  if (phase !== 'connecting') resetSplashLongPhaseProgress();
  if (!syncing) {
    splashState.etaReadySince = 0;
    splashState.lastBlocksPerSec = 0;
    clearSplashLogStartTimer();
    stopSplashLog();
    hideRebootstrapNotice({ disable: false });
    setSplashMeta('');
    setSplashEta('');
    if (splashState.debugExpanded) setSplashDebugExpanded(false);
  }

  const splashBar = document.querySelector('.splash-bar');
  if (splashBar && !syncing) {
    splashBar.style.width = '30%';
    splashBar.style.animation = 'splash-indeterminate 0.84s ease-in-out infinite';
  }
  updateSplashStepIndicator();
  scheduleSplashStatusFit();
}

function showSplash(text) {
  const overlay = $('splashOverlay');
  const status = $('splashStatus');
  ensureSplashDecorations();
  if (overlay) overlay.classList.remove('hidden');
  if (status && text) status.textContent = text;
  document.body.classList.add('splash-active');
  setSplashPhase(splashState.phase);
  splashState.visible = true;
  clearSplashLogStartTimer();
  if (typeof stopSplashLog === 'function') stopSplashLog();
  scheduleSplashStatusFit();
}

function hideSplash() {
  const overlay = $('splashOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('splash-active');
  document.body.classList.remove('splash-syncing');
  splashState.visible = false;
  splashState.stepFlow = 'startup';
  if (splashState.debugExpanded) {
    setSplashDebugExpanded(false);
  } else {
    document.body.classList.remove('splash-debug-open');
  }
  splashState.debugExpanded = false;
  splashState.logAutoFollow = true;
  clearResumeRecoveryWatchdog();
  resetSplashLongPhaseProgress();
  setSplashMeta('');
  setSplashEta('');
  hideRebootstrapNotice({ disable: true });
  if (typeof _stopLogHeightPoller === 'function') _stopLogHeightPoller();
  clearSplashLogStartTimer();
  // Stop live log tail when splash hides
  if (typeof stopSplashLog === 'function') stopSplashLog();
}

function updateSplashStatus(text) {
  const status = $('splashStatus');
  const normalized = normalizeSplashStatusText(text);
  if (status && normalized) status.textContent = normalized;
  updateSplashLongPhaseFromStatus(normalized);
  scheduleSplashStatusFit();
}

// Check if splash should show progressive loading messages
function checkSplashLongWait() {
  if (!splashState.visible) return;
  if (splashState.phase !== 'connecting') return; // Only for connecting phase
  const elapsed = Date.now() - splashState.startTime;
  if (!splashState.blockchainIndexShown && elapsed > 60000) {
    splashState.blockchainIndexShown = true;
    updateSplashStatus('Loading blockchain index\u2026');
  } else if (!splashState.longWaitShown && elapsed > 8000) {
    splashState.longWaitShown = true;
    updateSplashStatus('Loading daemon\u2026 this may take a few minutes');
  }
}

/**
 * Update splash with sync progress and ETA.
 * @param {number} blocks - current block height
 * @param {number} targetHeight - network tip height
 */
function updateSplashSyncStatus(blocks, targetHeight) {
  if (!splashState.visible || splashState.phase !== 'syncing') return;

  const blocksRemaining = Math.max(0, targetHeight - blocks);
  let statusText = `Syncing blocksâ€¦ ${blocks.toLocaleString()}`;

  // Calculate ETA if we have sync start data
  if (splashState.syncStartTime && splashState.syncStartBlocks !== null) {
    const elapsedMs = Date.now() - splashState.syncStartTime;
    const blocksSynced = blocks - splashState.syncStartBlocks;

    if (blocksSynced > 10 && elapsedMs > 5000) {
      // Calculate blocks per second and ETA
      const blocksPerSec = blocksSynced / (elapsedMs / 1000);
      if (blocksPerSec > 0) {
        const secondsRemaining = blocksRemaining / blocksPerSec;
        const etaText = formatETA(secondsRemaining);
        statusText = `Syncing blocksâ€¦ ${blocks.toLocaleString()} (~${etaText} remaining)`;
      }
    }
  }

  updateSplashStatus(statusText);
  if (targetHeight > 0) {
    setSplashMeta(
      `Current block ${blocks.toLocaleString()} / Network tip ${targetHeight.toLocaleString()} â€¢ ${blocksRemaining.toLocaleString()} remaining`
    );
  } else {
    setSplashMeta(`Current block ${blocks.toLocaleString()}`);
  }

  // Update progress bar if deterministic progress is possible
  const splashBar = document.querySelector('.splash-bar');
  if (splashBar && targetHeight > 0 && blocks > 0) {
    const pct = Math.min(100, Math.round((blocks / targetHeight) * 100));
    splashBar.style.width = pct + '%';
    splashBar.style.animation = 'none'; // Stop indeterminate animation
  }
}

// Override the initial splash sync formatter with copy and layout tuned for the
// Windows sync screen. Keeping it here avoids touching the older mojibake block.
function updateSplashSyncStatus(blocks, targetHeight) {
  if (!splashState.visible || splashState.phase !== 'syncing') return;

  const blocksRemaining = Math.max(0, targetHeight - blocks);
  let etaText = 'Calculating ETA...';

  if (splashState.syncStartTime && splashState.syncStartBlocks !== null) {
    const elapsedMs = Date.now() - splashState.syncStartTime;
    const blocksSynced = blocks - splashState.syncStartBlocks;

    if (targetHeight > 0 && blocksSynced > 10 && elapsedMs > 5000) {
      const blocksPerSec = blocksSynced / (elapsedMs / 1000);
      if (blocksPerSec > 0) {
        splashState.lastBlocksPerSec = blocksPerSec;
        const secondsRemaining = blocksRemaining / blocksPerSec;
        etaText = `${formatETA(secondsRemaining)} remaining`;
      }
    }
  }

  updateSplashStatus('Syncing with the network');
  if (targetHeight > 0) {
    setSplashMeta(`Current block: ${blocks.toLocaleString()} - Blocks left: ${blocksRemaining.toLocaleString()}`);
  } else {
    setSplashMeta(`Current block: ${blocks.toLocaleString()}`);
  }
  setSplashEta(etaText);

  const splashBar = document.querySelector('.splash-bar');
  if (splashBar && targetHeight > 0 && blocks > 0) {
    const pct = Math.min(100, Math.round((blocks / targetHeight) * 100));
    splashBar.style.width = pct + '%';
    splashBar.style.animation = 'none';
  }
}

/**
 * Format seconds into human-readable ETA.
 */
function formatETA(seconds) {
  if (seconds < 60) return 'less than a minute';
  if (seconds < 120) return '~1 minute';
  if (seconds < 3600) return `~${Math.round(seconds / 60)} minutes`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hours === 1) return mins > 0 ? `~1 hour ${mins} min` : '~1 hour';
  return mins > 0 ? `~${hours} hours ${mins} min` : `~${hours} hours`;
}

function resetRebootstrapAdvisorState(blocks) {
  rebootstrapAdvisorState = {
    enabled: true,
    startedAt: Date.now(),
    startBlock: Number.isFinite(blocks) ? blocks : 0,
    remoteCheckInFlight: false,
    remoteChecked: false,
    remoteMeta: null,
    remoteRetryAt: 0,
    remoteFailures: 0,
    applying: false,
    noticeVisible: false,
    noticeExpiresAt: 0,
    dismissedUntil: 0,
    candidate: null
  };
}

function primeRebootstrapRemoteMetadata() {
  if (!rebootstrapAdvisorState.enabled) return;
  if (rebootstrapAdvisorState.remoteChecked || rebootstrapAdvisorState.remoteCheckInFlight) return;
  if (Date.now() < (rebootstrapAdvisorState.remoteRetryAt || 0)) return;
  if (!window.ioc?.getDailyBootstrapMetadata) {
    rebootstrapAdvisorState.enabled = false;
    return;
  }

  rebootstrapAdvisorState.remoteCheckInFlight = true;
  let ok = false;
  window.ioc.getDailyBootstrapMetadata()
    .then((metadata) => {
      rebootstrapAdvisorState.remoteMeta = metadata && metadata.ok ? metadata : null;
      if (!rebootstrapAdvisorState.remoteMeta) {
        rebootstrapAdvisorState.remoteRetryAt = Date.now() + 15000;
        rebootstrapAdvisorState.remoteFailures = (rebootstrapAdvisorState.remoteFailures || 0) + 1;
        console.warn('[rebootstrap] remote metadata unavailable, will retry:', metadata?.error || 'unknown');
        return;
      }
      ok = true;
      rebootstrapAdvisorState.remoteFailures = 0;
      rebootstrapAdvisorState.remoteRetryAt = 0;
    })
    .catch((err) => {
      rebootstrapAdvisorState.remoteRetryAt = Date.now() + 15000;
      rebootstrapAdvisorState.remoteFailures = (rebootstrapAdvisorState.remoteFailures || 0) + 1;
      console.warn('[rebootstrap] metadata check failed, will retry:', err?.message || err);
    })
    .finally(() => {
      rebootstrapAdvisorState.remoteChecked = ok;
      rebootstrapAdvisorState.remoteCheckInFlight = false;
    });
}

/**
 * Start the syncing phase of splash screen.
 */
function startSplashSyncPhase(blocks) {
  setSplashPhase('syncing');
  splashState.syncStartTime = Date.now();
  splashState.syncStartBlocks = blocks;
  splashState.etaReadySince = 0;
  splashState.lastBlocksPerSec = 0;
  resetRebootstrapAdvisorState(blocks);
  primeRebootstrapRemoteMetadata();
  console.log('[splash] Started sync phase at block:', blocks);
  _startLogHeightPoller();
}

// Standalone splash poller â€” reads debug.log height on a relaxed interval,
// completely independent of refresh()/computeStatus().
let _logPollTimer = null;
function _startLogHeightPoller() {
  if (_logPollTimer) return;
  _logPollTimer = setInterval(async () => {
    if (!splashState.visible || splashState.phase !== 'syncing') {
      _stopLogHeightPoller();
      return;
    }
    try {
      const lh = await window.ioc.logHeight();
      if (typeof lh === 'number' && lh > 0) {
        const tip = last.headers || 0;
        updateSplashSyncStatus(lh, tip);
        maybeEvaluateDailyRebootstrap(lh).catch(() => {});
      }
    } catch {}
  }, SPLASH_LOG_POLL_INTERVAL_MS);
}
function _stopLogHeightPoller() {
  if (_logPollTimer) { clearInterval(_logPollTimer); _logPollTimer = null; }
}
// ===== Live Log Viewer (splash/bootstrap) =====
const MAX_LOG_LINES = 120;
let _splashLogRunning = false;
let _splashLogUnsub = null;

function appendStyledLogChunk(logEl, chunk, options = {}) {
  if (!logEl) return;
  const replace = !!options.replace;
  const stickToBottom = !!options.stickToBottom;
  const maxLines = Number.isFinite(options.maxLines) ? Math.max(1, options.maxLines) : MAX_LOG_LINES;
  const maxLineLength = Number.isFinite(options.maxLineLength) ? Math.max(20, options.maxLineLength) : 160;
  if (replace) logEl.innerHTML = '';
  const lines = String(chunk).split('\n').filter(l => l.trim().length > 0);
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    const lower = l.toLowerCase();
    if (lower.includes('error') || lower.includes('failed')) {
      div.classList.add('log-err');
    } else if (lower.includes('accepted') || lower.includes('setbestchain') || lower.includes('successfully')) {
      div.classList.add('log-ok');
    }
    div.textContent = l.length > maxLineLength ? l.substring(0, maxLineLength) + '...' : l;
    logEl.appendChild(div);
  }
  while (logEl.children.length > maxLines) {
    logEl.removeChild(logEl.firstChild);
  }
  if (stickToBottom) {
    scrollLogToBottom(logEl);
  }
}

function appendSplashLogChunk(chunk, replace = false) {
  const logEl = document.getElementById('splashLog');
  if (!logEl) return;
  appendStyledLogChunk(logEl, chunk, {
    replace,
    stickToBottom: replace || splashState.logAutoFollow,
    maxLines: MAX_LOG_LINES,
    maxLineLength: 160
  });
  updateSplashJumpLatestVisibility();
}

function loadRecentSplashLog() {
  if (!window.diag || !window.diag.recentTail) return Promise.resolve();
  return Promise.resolve(window.diag.recentTail(MAX_LOG_LINES)).then((chunk) => {
    const text = String(chunk || '');
    if (text.trim()) {
      appendSplashLogChunk(text, true);
    }
  }).catch(() => {});
}

function startSplashLog(forceRestart = false) {
  if (forceRestart && _splashLogRunning) {
    stopSplashLog();
  }
  if (_splashLogRunning) return;
  if (typeof window.diag === 'undefined') return;
  _splashLogRunning = true;
  splashState.logAutoFollow = true;
  if (_splashLogUnsub) {
    try { _splashLogUnsub(); } catch {}
    _splashLogUnsub = null;
  }
  loadRecentSplashLog();
  _splashLogUnsub = window.diag.onData((line) => {
    appendSplashLogChunk(line);
  });
  window.diag.startTail();
}

function stopSplashLog() {
  if (!_splashLogRunning) return;
  _splashLogRunning = false;
  if (_splashLogUnsub) {
    try { _splashLogUnsub(); } catch {}
    _splashLogUnsub = null;
  }
  if (typeof window.diag !== 'undefined') {
    window.diag.stopTail();
  }
}
// ===== End Live Log Viewer =====

// ===== End Splash State =====

// ===== Connection State (Step B3) =====
let connectionState = {
  connected: false,
  attempts: 0,
  maxAttempts: 30,       // ~4min total â€” daemon needs time to load block index after bootstrap
  startTime: null,
  lastError: null
};

function showConnectBanner(text, isError, errorDetail) {
  const banner = $('connectBanner');
  const textEl = $('connectText');
  const errorEl = $('connectError');
  const helpEl = $('connectHelp');
  if (!banner) return;

  banner.classList.remove('hidden');
  banner.classList.toggle('error', !!isError);
  if (textEl) textEl.textContent = text || 'Loading daemon...';

  if (isError && errorDetail) {
    if (errorEl) {
      errorEl.textContent = errorDetail;
      errorEl.classList.remove('hidden');
    }
    if (helpEl) helpEl.classList.remove('hidden');
  } else {
    if (errorEl) errorEl.classList.add('hidden');
    if (helpEl) helpEl.classList.add('hidden');
  }
}

function hideConnectBanner() {
  const banner = $('connectBanner');
  if (banner) banner.classList.add('hidden');
  connectionState.connected = true;
}

function getRetryDelay(attempt) {
  // Backoff: 1s, 2s, 4s, 8s, then cap at 8s
  const delays = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];
  return delays[Math.min(attempt, delays.length - 1)];
}
// ===== End Connection State =====

// ===== Bootstrap State (Step C5) =====
let bootstrapState = {
  checked: false,
  needed: false,
  inProgress: false,
  completed: false,
  error: null
};

function showBootstrapModal() {
  const modal = $('bootstrapModal');
  if (modal) modal.classList.remove('hidden');
}

function hideBootstrapModal() {
  const modal = $('bootstrapModal');
  if (modal) modal.classList.add('hidden');
}

function updateBootstrapUI(status, percent, error) {
  const statusEl = $('bootstrapStatus');
  const barEl = $('bootstrapBar');
  const percentEl = $('bootstrapPercent');
  const errorEl = $('bootstrapError');
  const actionsEl = $('bootstrapActions');

  if (statusEl && status) statusEl.textContent = status;
  if (barEl && typeof percent === 'number') barEl.style.width = percent + '%';
  if (percentEl && typeof percent === 'number') percentEl.textContent = percent + '%';

  if (error) {
    if (errorEl) {
      errorEl.textContent = error;
      errorEl.classList.remove('hidden');
    }
    if (actionsEl) actionsEl.classList.remove('hidden');
  } else {
    if (errorEl) errorEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.add('hidden');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function runBootstrapFlow() {
  if (bootstrapState.checked) return bootstrapState.needed;

  try {
    // Check if bootstrap is needed (no blk0001.dat in data folder)
    const needed = await window.ioc.needsBootstrap();
    bootstrapState.checked = true;
    bootstrapState.needed = needed;

    if (!needed) {
      console.log('[bootstrap] Not needed, chain data exists');
      return false;
    }

    console.log('[bootstrap] No chain data found, starting bootstrap flow');
    bootstrapState.inProgress = true;
    setSplashStepFlow('bootstrap');

    // STEP 1: Download bootstrap (daemon has NOT been started yet)
    setSplashPhase('downloading');
    updateSplashStatus('Downloading bootstrapâ€¦');
    showBootstrapModal();
    updateBootstrapUI('Downloading bootstrap...', 0, null);

    // Listen for progress events
    window.ioc.onBootstrapProgress((progress) => {
      if (progress.step && progress.message) {
        updateBootstrapUI(progress.message, 100, null);
        updateSplashStatus(progress.message);
        return;
      }
      const pct = progress.percent || 0;
      const downloaded = formatBytes(progress.downloaded || 0);
      const total = formatBytes(progress.total || 0);
      updateBootstrapUI(`Downloading bootstrap... (${downloaded} / ${total})`, pct, null);
      updateSplashStatus(`Downloading bootstrapâ€¦ ${pct}%`);
    });

    const downloadResult = await window.ioc.downloadBootstrap();
    if (!downloadResult.ok) {
      throw new Error(downloadResult.error || 'Download failed');
    }

    // STEP 2: Extract, install bootstrap files, then start daemon (with 30s timeout)
    setSplashPhase('installing');
    updateSplashStatus('Installing blockchain filesâ€¦');
    updateBootstrapUI('Installing blockchain files...', 100, null);

    const applyResult = await window.ioc.applyBootstrap();
    if (!applyResult.ok) {
      // Bootstrap now fails explicitly if the daemon never becomes RPC-ready.
      throw new Error(applyResult.error || 'Install failed');
    }

    // Done â€” daemon started and responded
    bootstrapState.inProgress = false;
    bootstrapState.completed = true;
    updateBootstrapUI('Setup complete! Starting sync...', 100, null);
    setSplashPhase('connecting');
    updateSplashStatus('Starting syncâ€¦');

    await new Promise(r => setTimeout(r, 1500));
    hideBootstrapModal();
    return true;

  } catch (err) {
    console.error('[bootstrap] Error:', err);
    bootstrapState.error = err.message || String(err);
    bootstrapState.inProgress = false;
    setSplashStepFlow('startup');
    setSplashPhase('connecting');
    updateBootstrapUI('Setup failed', 0, bootstrapState.error);
    return false;
  }
}


function setupBootstrapHandlers() {
  const skipBtn = $('bootstrapSkip');
  const retryBtn = $('bootstrapRetry');

  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      console.log('[bootstrap] User skipped bootstrap, using manual sync');
      hideBootstrapModal();
      bootstrapState.inProgress = false;
      // Continue to normal refresh loop
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      bootstrapState.checked = false;
      bootstrapState.error = null;
      updateBootstrapUI('Retrying...', 0, null);
      await runBootstrapFlow();
    });
  }
}
// ===== End Bootstrap State =====

async function runRebootstrapFlow() {
  setSplashStepFlow('bootstrap');
  setSplashPhase('downloading');
  updateSplashStatus('Downloading newer daily bootstrap...');
  setSplashMeta('Using a newer daily bootstrap checkpoint to speed up synchronization.');
  setSplashEta('Preparing download...');

  window.ioc.onBootstrapProgress((progress) => {
    if (progress.step && progress.message) {
      updateSplashStatus(progress.message);
      return;
    }
    const pct = progress.percent || 0;
    updateSplashStatus(`Downloading bootstrap... ${pct}%`);
    setSplashEta(pct > 0 ? `${pct}% downloaded` : 'Preparing download...');
  });

  const downloadResult = await window.ioc.downloadBootstrap();
  if (!downloadResult?.ok) {
    throw new Error(downloadResult?.error || 'Download failed');
  }

  setSplashPhase('installing');
  updateSplashStatus('Installing newer daily bootstrap...');
  setSplashEta('Installing blockchain data...');
  const applyResult = await window.ioc.applyBootstrap({ stopDaemonFirst: true, source: 'rebootstrap' });
  if (!applyResult?.ok) {
    throw new Error(applyResult?.error || 'Bootstrap apply failed');
  }

  setSplashPhase('connecting');
  updateSplashStatus('Restarting daemon...');
  setSplashMeta('');
  setSplashEta('');
  await new Promise(r => setTimeout(r, 1200));
}

function ensureRebootstrapNoticeUI() {
  ensureSplashDecorations();
  let panel = $('splashRebootstrapNotice');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'splashRebootstrapNotice';
    panel.className = 'splash-rebootstrap-notice hidden';
    panel.innerHTML = `
      <div class="splash-rebootstrap-title">NEW BOOTSTRAP AVAILABLE</div>
      <div id="splashRebootstrapText" class="splash-rebootstrap-text"></div>
      <div class="splash-rebootstrap-actions">
        <button id="splashRebootstrapApply" class="btn btn-ok splash-rebootstrap-btn" type="button">Yes, use latest bootstrap</button>
        <button id="splashRebootstrapLater" class="btn splash-rebootstrap-btn" type="button">No, thank you</button>
      </div>`;
    const overlay = $('splashOverlay');
    overlay?.appendChild(panel);
  }

  const laterBtn = $('splashRebootstrapLater');
  if (laterBtn && !laterBtn.dataset.bound) {
    laterBtn.dataset.bound = '1';
    laterBtn.addEventListener('click', () => {
      hideRebootstrapNotice({ disable: false, snoozeMs: REBOOTSTRAP_SNOOZE_MS });
    });
  }
  const applyBtn = $('splashRebootstrapApply');
  if (applyBtn && !applyBtn.dataset.bound) {
    applyBtn.dataset.bound = '1';
    applyBtn.addEventListener('click', () => {
      applyRebootstrapFromNotice().catch((err) => {
        console.warn('[rebootstrap] apply action failed:', err?.message || err);
      });
    });
  }
}

function setRebootstrapNoticeBusy(isBusy) {
  const applyBtn = $('splashRebootstrapApply');
  const laterBtn = $('splashRebootstrapLater');
  if (applyBtn) {
    applyBtn.disabled = !!isBusy;
    applyBtn.textContent = isBusy ? 'Downloading...' : 'Yes, use latest bootstrap';
  }
  if (laterBtn) laterBtn.disabled = !!isBusy;
}

function showRebootstrapNotice(candidate) {
  ensureRebootstrapNoticeUI();
  const panel = $('splashRebootstrapNotice');
  const text = $('splashRebootstrapText');
  if (!panel || !text) return;

  const savedText = candidate.estimatedSavedSeconds > 60
    ? formatETA(candidate.estimatedSavedSeconds).replace(/^~/, '').replace(/\s*remaining$/i, '').trim()
    : 'a short amount of time';
  text.innerHTML =
    `A more recent bootstrap is available. It is ${candidate.leadBlocks.toLocaleString()} blocks ahead ` +
    `of your current local height and could save you around <span class="splash-rebootstrap-em">${savedText}</span> of sync time.<br><br>` +
    `Would you like to switch to this newer checkpoint to speed up synchronization?`;

  panel.classList.remove('hidden');
  document.body.classList.add('splash-rebootstrap-visible');
  setRebootstrapNoticeBusy(false);
  rebootstrapAdvisorState.noticeVisible = true;
  rebootstrapAdvisorState.noticeExpiresAt = Date.now() + REBOOTSTRAP_NOTICE_TTL_MS;
  rebootstrapAdvisorState.candidate = candidate;
}

function hideRebootstrapNotice({ disable = false, snoozeMs = 0 } = {}) {
  const panel = $('splashRebootstrapNotice');
  if (panel) panel.classList.add('hidden');
  document.body.classList.remove('splash-rebootstrap-visible');
  rebootstrapAdvisorState.noticeVisible = false;
  rebootstrapAdvisorState.noticeExpiresAt = 0;
  rebootstrapAdvisorState.candidate = null;
  setRebootstrapNoticeBusy(false);
  if (disable) rebootstrapAdvisorState.enabled = false;
  if (snoozeMs > 0) rebootstrapAdvisorState.dismissedUntil = Date.now() + snoozeMs;
}

async function applyRebootstrapFromNotice() {
  if (rebootstrapAdvisorState.applying) return;
  const candidate = rebootstrapAdvisorState.candidate;
  if (!candidate) return;

  rebootstrapAdvisorState.applying = true;
  setRebootstrapNoticeBusy(true);

  try {
    const statusNow = await window.ioc.status().catch(() => null);
    const localBlocksNow = Number(statusNow?.chain?.blocks || state.blocks || 0);
    const remoteNow = await window.ioc.getDailyBootstrapMetadata();
    if (!remoteNow?.ok || !Number.isFinite(Number(remoteNow.height))) {
      throw new Error('Could not refresh daily bootstrap metadata');
    }
    const remoteHeightNow = Number(remoteNow.height);
    const leadNow = remoteHeightNow - localBlocksNow;
    if (leadNow <= REBOOTSTRAP_REMOTE_LEAD_BLOCKS) {
      hideRebootstrapNotice({ disable: true });
      updateSplashStatus('Continuing local sync...');
      setSplashMeta(`Current block: ${localBlocksNow.toLocaleString()} - Local sync is already close enough`);
      return;
    }

    const backupRes = await window.ioc.createRebootstrapBackup({
      reason: 'daily-bootstrap-refresh',
      localBlock: localBlocksNow,
      remoteBootstrapBlock: remoteHeightNow,
      remoteReleaseTitle: remoteNow.title || '',
      checkedAt: new Date().toISOString()
    });
    if (!backupRes?.ok) {
      throw new Error(backupRes?.error || 'Backup creation failed');
    }

    hideRebootstrapNotice({ disable: true });
    await runRebootstrapFlow();
  } catch (err) {
    console.error('[rebootstrap] apply failed, continuing local sync:', err);
    try {
      await window.ioc.restartDaemon();
    } catch (_) {}
    setSplashStepFlow('startup');
    // Return to the standard syncing splash immediately after failure.
    setSplashPhase('syncing');
    updateSplashStatus('Syncing with the network');
    setSplashMeta('');
    setSplashEta('Calculating ETA...');
    hideRebootstrapNotice({ disable: true, snoozeMs: REBOOTSTRAP_SNOOZE_MS });
    alert(`Could not apply the newer bootstrap.\n\n${err?.message || String(err)}\n\nContinuing with local sync.`);
  } finally {
    rebootstrapAdvisorState.applying = false;
    setRebootstrapNoticeBusy(false);
  }
}

async function maybeEvaluateDailyRebootstrap(localBlocks) {
  if (!splashState.visible || splashState.phase !== 'syncing') return;
  if (!rebootstrapAdvisorState.enabled || rebootstrapAdvisorState.applying) return;
  if (Date.now() < rebootstrapAdvisorState.dismissedUntil) return;
  if (!window.ioc?.getDailyBootstrapMetadata || !window.ioc?.createRebootstrapBackup) {
    rebootstrapAdvisorState.enabled = false;
    return;
  }

  primeRebootstrapRemoteMetadata();

  if (!rebootstrapAdvisorState.remoteChecked || !rebootstrapAdvisorState.remoteMeta) return;

  const remoteHeight = Number(rebootstrapAdvisorState.remoteMeta.height || 0);
  if (!Number.isFinite(remoteHeight) || remoteHeight <= 0) {
    rebootstrapAdvisorState.enabled = false;
    return;
  }

  const leadBlocks = remoteHeight - localBlocks;
  if (leadBlocks <= REBOOTSTRAP_REMOTE_LEAD_BLOCKS) {
    if (rebootstrapAdvisorState.noticeVisible) {
      hideRebootstrapNotice({ disable: true });
    }
    rebootstrapAdvisorState.enabled = false;
    return;
  }

  if (rebootstrapAdvisorState.noticeVisible) {
    if (Date.now() > rebootstrapAdvisorState.noticeExpiresAt) {
      hideRebootstrapNotice({ disable: false, snoozeMs: REBOOTSTRAP_SNOOZE_MS });
      return;
    }
    const currentLead = remoteHeight - localBlocks;
    if (currentLead <= REBOOTSTRAP_REMOTE_LEAD_BLOCKS) {
      hideRebootstrapNotice({ disable: true });
    }
    return;
  }

  if (!splashState.etaReadySince) return;
  if ((Date.now() - splashState.etaReadySince) < REBOOTSTRAP_NOTICE_AFTER_ETA_MS) return;

  const elapsedMs = Date.now() - (rebootstrapAdvisorState.startedAt || Date.now());
  const progressed = localBlocks - (rebootstrapAdvisorState.startBlock || localBlocks);
  const blocksPerSec = progressed / Math.max(1, elapsedMs / 1000);
  const sampleRate = blocksPerSec > 0 ? blocksPerSec : (splashState.lastBlocksPerSec || 0);
  if (!(sampleRate > 0)) return;

  const catchupSeconds = leadBlocks / sampleRate;
  const estimatedSavedSeconds = Math.max(0, catchupSeconds - REBOOTSTRAP_OVERHEAD_SECONDS);
  showRebootstrapNotice({
    remoteHeight,
    leadBlocks,
    estimatedSavedSeconds,
    sampledBlocksPerSec: sampleRate,
    observedAt: Date.now()
  });
}

/**
 * Update sync bar and text based on chain state.
 * @param {number} blocks - current local block height
 * @param {number} targetHeight - network tip height (from explorer or headers)
 * @param {number} verificationProgress - 0-1 progress value (optional)
 * @param {number} remoteTip - explicit remote tip if available (used only for progress bar math)
 */
function isChainFullySynced(blocks, targetHeight, verificationProgress, remoteTip) {
  const b = Number(blocks) || 0;
  const tip = Number(remoteTip) || 0;
  const target = Number(targetHeight) || 0;
  const vp = Number(verificationProgress);

  if (tip > 0) return b >= tip;
  if (target > 0 && target !== b) return b >= target;
  if (Number.isFinite(vp)) return vp >= 0.9999;
  return false;
}

function showSyncLockNotice(anchorEl, message = SEND_DISABLED_SYNC_MESSAGE) {
  if (!message) return;
  let notice = $('syncLockNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'syncLockNotice';
    notice.className = 'sync-lock-notice';
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  const r = anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
    ? anchorEl.getBoundingClientRect()
    : null;
  const left = r ? Math.round(r.left + (r.width / 2)) : Math.round(window.innerWidth / 2);
  const top = r ? Math.round(r.top - 8) : 120;
  notice.style.left = `${left}px`;
  notice.style.top = `${top}px`;
  notice.classList.add('show');
  if (_syncLockNoticeTimer) clearTimeout(_syncLockNoticeTimer);
  _syncLockNoticeTimer = setTimeout(() => {
    notice.classList.remove('show');
  }, 1900);
}

function wireSyncLockHoverHint(el) {
  if (!el || el.dataset.syncLockHintWired === '1') return;
  el.dataset.syncLockHintWired = '1';
  el.addEventListener('mouseenter', () => {
    if (!state.synced && !document.body.classList.contains('splash-active')) {
      showSyncLockNotice(el);
    }
  });
}

function updateSendLockState(isSynced) {
  const locked = !isSynced;
  document.body.classList.toggle('wallet-not-synced', locked);

  const targets = [$('sendBtn'), $('widget-send-btn'), $('doSend')];
  for (const btn of targets) {
    if (!btn) continue;
    wireSyncLockHoverHint(btn);
    btn.classList.toggle('send-locked', locked);
    if (locked) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('title', SEND_DISABLED_SYNC_MESSAGE);
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('title');
    }
  }
}

function updateSyncDisplay(blocks, targetHeight, verificationProgress, remoteTip) {
  const wrap = document.querySelector('#tab-overview .sync-wrap');

  // Always store blocks in state immediately (before any conditional logic)
  state.blocks = blocks;

  const isSynced = isChainFullySynced(blocks, targetHeight, verificationProgress, remoteTip);
  state.synced = isSynced;
  updateSendLockState(isSynced);

  // Overview sync line/bar are intentionally hidden; warning badge + send lock
  // communicate sync state in the active UI.
  if (wrap) wrap.style.display = 'none';

  if (wrap) wrap.classList.toggle('synced', isSynced);

  const syncChip = $('ic-sync');
  if (syncChip) syncChip.classList.toggle('ok', isSynced);
}

// Legacy wrapper for compatibility
function setSync(pct, text) {
  // Legacy wrapper kept for compatibility. We still maintain lock state.
  const wrap = document.querySelector('#tab-overview .sync-wrap');
  const isSynced = (pct || 0) >= 100;
  state.synced = isSynced;
  updateSendLockState(isSynced);

  if (wrap) {
    wrap.style.display = 'none';
    wrap.classList.toggle('synced', isSynced);
  }

  const syncChip = $('ic-sync');
  if (syncChip) syncChip.classList.toggle('ok', isSynced);
}


function setPeers(n) {
  state.peers = n || 0;
  const chip = $('ic-peers');
  const splashPeers = $('splashDebugConnections');
  if (splashPeers) splashPeers.textContent = `Connections: ${state.peers}`;
  if (chip) {
    // Tooltip shows peers + single local block height (no commas, no network tip)
    let tooltip = `Peers: ${state.peers}`;
    if (state.blocks > 0) {
      tooltip += `\nBlocks: ${state.blocks}`;
    }
    chip.title = tooltip;
    chip.classList.toggle('ok', state.peers > 0);
  }
}

function setLock(unlocked, encrypted) {
  state.unlocked = !!unlocked;
  if (typeof encrypted === 'boolean') state.encrypted = encrypted;
  const p = $('p-lock'); if (!p) return;
  const chip = $('ic-lock');

  if (state.encrypted === false) {
    // Unencrypted wallet â€” grey lock, open padlock shape
    p.setAttribute('d', 'M9 10V7a3 3 0 0 1 6 0h2a5 5 0 1 0-10 0v3H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H9zm3 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4z');
    if (chip) { chip.classList.remove('ok'); chip.title = 'Wallet is unencrypted (click to encrypt it)'; }
  } else if (state.unlocked) {
    p.setAttribute('d', 'M9 10V7a3 3 0 0 1 6 0h2a5 5 0 1 0-10 0v3H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H9zm3 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4z');
    if (chip) { chip.classList.add('ok'); chip.title = 'Wallet unlocked'; }
  } else {
    p.setAttribute('d', 'M12 2a5 5 0 00-5 5v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm3 8H9V7a3 3 0 016 0v3z');
    if (chip) { chip.classList.remove('ok'); chip.title = 'Wallet locked'; }
  }
}

function setStaking(on, amount, stakingInfo, balance) {
  const chip = $('ic-stake');
  if (chip) {
    // Staking icon is green ONLY when ALL are true:
    // 1. Wallet unlocked for staking
    // 2. Chain synced (near tip)
    // 3. Daemon reports actively staking (not just enabled)
    // 4. Balance > 0 (stakeable amount)
    const bal = typeof balance === 'number' ? balance : 0;
    const isActivelyStaking = !!on && state.unlocked && state.synced && bal > 0;
    chip.classList.toggle('ok', isActivelyStaking);

    // Build tooltip with staking info
    let tooltip = isActivelyStaking ? 'Staking on' : 'Staking off';
    if (stakingInfo && typeof stakingInfo === 'object') {
      const parts = [];
      if (typeof stakingInfo.weight === 'number' && stakingInfo.weight > 0) {
        parts.push(`Weight: ${stakingInfo.weight}`);
      }
      if (typeof stakingInfo.netstakeweight === 'number' && stakingInfo.netstakeweight > 0) {
        parts.push(`Network: ${stakingInfo.netstakeweight}`);
      }
      if (typeof stakingInfo.expectedtime === 'number' && stakingInfo.expectedtime > 0) {
        const hours = Math.round(stakingInfo.expectedtime / 3600);
        const days = Math.round(stakingInfo.expectedtime / 86400);
        if (days > 1) {
          parts.push(`Expected: ~${days} days`);
        } else if (hours > 0) {
          parts.push(`Expected: ~${hours} hours`);
        }
      }
      if (parts.length > 0) {
        tooltip += '\n' + parts.join('\n');
      }
    }
    // Show reason if daemon says staking enabled but not actively staking
    if (on && !isActivelyStaking) {
      if (!state.unlocked) tooltip += '\n(Wallet locked)';
      else if (!state.synced) tooltip += '\n(Syncing)';
      else if (bal <= 0) tooltip += '\n(No balance)';
    }
    chip.title = tooltip;
  }
  const s = $('staking'); if (s) s.textContent = on ? Number(amount || 0).toLocaleString() : '0';
}

function formatBalanceMarkup(amount) {
  const value = Number.isFinite(amount) ? amount : 0;
  const parts = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3
  }).formatToParts(value);
  const whole = [];
  const frac = [];
  let seenDecimal = false;
  for (const part of parts) {
    if (part.type === 'decimal') {
      seenDecimal = true;
      frac.push(part.value);
      continue;
    }
    if (seenDecimal || part.type === 'fraction') frac.push(part.value);
    else whole.push(part.value);
  }
  const wholeText = whole.join('') || '0';
  const fracText = frac.join('');
  return fracText
    ? `<span class="balance-whole">${wholeText}</span><span class="balance-frac">${fracText}</span>`
    : `<span class="balance-whole">${wholeText}</span>`;
}

let __resizeRAF=null;
function fitBalance() {
  const box = $('bignum'), span = $('big-balance');
  if (!box || !span) return;
  // Guard: don't run if Overview tab is hidden or not properly laid out
  const overview = $('tab-overview');
  if (!overview || overview.classList.contains('hidden')) return;
  if (span.offsetParent === null) return; // not visible
  const boxWidth = box.clientWidth;
  if (!boxWidth || boxWidth < 100) return; // layout not settled

  const ctx = document.createElement('canvas').getContext('2d');
  const font = s => `800 ${s}px -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
  const pad = parseFloat(getComputedStyle(box).paddingLeft) + parseFloat(getComputedStyle(box).paddingRight);
  let size = 84, max = boxWidth - pad - 8;
  while (size > 16) { ctx.font = font(size); if (ctx.measureText(span.textContent).width <= max) break; size -= 2; }
  span.style.setProperty('font-size', size + 'px', 'important');
}

function scheduleRefresh(ms) {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(refresh, ms);
}

async function refresh() {
  if (refreshing) {
    console.warn('[refresh] Already in progress, skipping');
    return;
  }
  refreshing = true;
  const startTime = Date.now();
  let timedOut = false;
  let connectionFailed = false;

  try {
    console.log('[refresh] Starting status fetch');
    const statusPromise = window.ioc.status();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IPC timeout after 8000ms')), 8000)
    );
    const st = await Promise.race([statusPromise, timeoutPromise]);
    const elapsed = Date.now() - startTime;
    console.log(`[refresh] Completed in ${elapsed}ms`);

    // Extract chain data
    const blocks = st?.chain?.blocks || 0;
    const headers = st?.chain?.headers || 0;
    const remoteTip = st?.remoteTip || 0;  // Network tip from explorer API
    const vp = typeof st?.chain?.verificationprogress === 'number' ? st.chain.verificationprogress : 0;

    // BALANCE MUST DISPLAY IMMEDIATELY - before any other logic
    // Render as soon as first wallet RPC responds, even while syncing
    // Do NOT gate on synced, networkTip, or verification progress
    const info = st?.info || {};
    const hasBalance = typeof info.balance === 'number' || typeof info.walletbalance === 'number';
    if (hasBalance) {
      const bal = Number(info.balance ?? info.walletbalance);
      if (last.bal === null || last.bal !== bal) {
        const balText = (Math.round(bal * 1000) / 1000).toLocaleString();
        const el = $('big-balance');
        if (el) el.innerHTML = formatBalanceMarkup(bal);
        const wBal = $('widget-balance');
        if (wBal) wBal.innerHTML = formatBalanceMarkup(bal);
        last.bal = bal;
      }
      // Always re-fit: cheap canvas op, ensures correct sizing after compactâ†’full transition
      fitBalance();
    }

    // Pending (unconfirmed) balance display â€” IOCoin daemon uses "pending" field from getinfo
    const unconf = Number(info.pending || 0);
    const pendEl = $('pending-line'), pendAmt = $('pending-amt');
    const wPendEl = $('widget-pending'), wPendAmt = $('widget-pending-amt');
    if (unconf > 0) {
      const pendText = (Math.round(unconf * 1000) / 1000).toLocaleString();
      if (pendAmt) pendAmt.textContent = pendText;
      if (wPendAmt) wPendAmt.textContent = pendText;
      if (pendEl) pendEl.classList.remove('hidden');
      if (wPendEl) wPendEl.classList.remove('hidden');
    } else {
      if (pendEl) pendEl.classList.add('hidden');
      if (wPendEl) wPendEl.classList.add('hidden');
    }

    // Check if we have valid chain data (not 0/0)
    const hasValidChainData = blocks > 0 || headers > 0;

    // Handle splash visibility - wait until within 25 blocks of network tip
    if (splashState.visible) {
      // Check if we should show "this may take a few minutes"
      checkSplashLongWait();

      if (hasValidChainData) {
        // Track initial blocks to detect movement
        if (splashState.initialBlocks === null) {
          splashState.initialBlocks = blocks;
          console.log('[splash] Initial blocks:', blocks);
        }

        // Use remoteTip (from explorer) as authoritative network height
        const networkTip = remoteTip > 0 ? remoteTip : headers;
        const blocksRemaining = networkTip > 0 ? networkTip - blocks : 0;

        // Determine if we're close enough to hide splash
        const heightSynced = networkTip > 0 && blocks >= networkTip;

        const vpSynced = vp >= 0.9999;

        const fullySynced = heightSynced || (networkTip <= 0 && vpSynced);

        if (fullySynced) {
          // Synced â€” hide splash and show wallet
          const reason = heightSynced ? `height=${blocks}` : `vp=${vp}`;
          console.log(`[splash] Sync complete (${reason}), hiding splash`);
          splashState.validStatusReceived = true;
          hideRebootstrapNotice({ disable: true });
          hideSplash();
          if (document.body.classList.contains('compact-mode') && window.ioc?.setCompactMode) {
            Promise.resolve(window.ioc.setCompactMode(true)).catch(() => {});
          }
          hideConnectBanner();
          connectionState.connected = true;
          connectionState.attempts = 0;
          connectionState.lastError = null;
        } else if (blocks > 0) {
          // Have blocks but still syncing - show sync progress in splash
          if (splashState.phase === 'connecting') {
            // Transition from connecting to syncing phase
            startSplashSyncPhase(blocks);
          }
          maybeEvaluateDailyRebootstrap(blocks).catch((err) => {
            console.warn('[rebootstrap] advisor error, continuing local sync:', err?.message || err);
          });
          // Splash text is updated by the standalone logHeight poller
          // (started in startSplashSyncPhase). No update here.
          // Mark as connected (daemon is responding)
          connectionState.connected = true;
          connectionState.attempts = 0;
        } else {
          // Have headers but no blocks yet - still warming up
          updateSplashStatus('Loading daemonâ€¦');
        }
      } else {
        // No chain data yet - still warming up
        if (!splashState.longWaitShown) {
          updateSplashStatus('Loading daemonâ€¦');
        }
      }
    } else {
      // Splash already hidden - normal connection handling
      if (!connectionState.connected) {
        hideConnectBanner();
        connectionState.connected = true;
        connectionState.attempts = 0;
        connectionState.lastError = null;
      }
    }

    // Update sync display only if we have valid data
    // Use remoteTip as target if available, otherwise fall back to headers
    const targetHeight = remoteTip > 0 ? remoteTip : (headers > 0 ? headers : blocks);
    if (hasValidChainData && (last.vp !== vp || last.blocks !== blocks || last.headers !== targetHeight)) {
      updateSyncDisplay(blocks, targetHeight, vp, remoteTip);
      last.vp = vp;
      last.blocks = blocks;
      last.headers = targetHeight;
    }

    if (typeof st?.peers === 'number' && Number.isFinite(st.peers)) {
      setPeers(st.peers);
    }

    const locked = st?.lockst?.isLocked;
    const isEncrypted = st?.lockst?.isEncrypted;
    // Skip lock state overwrite during grace period after user action
    if (typeof locked === 'boolean' && Date.now() >= lockOverrideUntil) {
      setLock(!locked, typeof isEncrypted === 'boolean' ? isEncrypted : undefined);
    }

    // staking ON flag â€” only true when daemon reports actively staking (not just enabled)
    const stakingOn = !!(st?.staking?.staking);
    // staking AMOUNT (prefer getinfo.stake, fallback to getstakinginfo fields)
    const stakingAmt = Number(
      (typeof info.stake !== 'undefined') ? info.stake :
      (st?.staking && typeof st.staking.stake !== 'undefined') ? st.staking.stake :
      (st?.staking && typeof st.staking.stakingbalance !== 'undefined') ? st.staking.stakingbalance : 0
    );

    // Always update staking display since it depends on unlocked, synced, and balance
    const stakingInfo = st?.staking || {};
    const currentBalance = last.bal != null ? last.bal : 0;
    setStaking(stakingOn, stakingAmt, stakingInfo, currentBalance);
    last.stakeOn = stakingOn; last.stakeAmt = stakingAmt;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    connectionFailed = true;
    connectionState.lastError = (err && err.message) ? err.message : String(err);

    if (err && err.message && err.message.includes('timeout')) {
      timedOut = true;
      console.error(`[refresh] Timed out after ${elapsed}ms`);
    } else {
      console.error(`[refresh] Failed after ${elapsed}ms:`, connectionState.lastError);
    }

    // Handle connection failure with retry/backoff (RC3-style)
    if (!connectionState.connected) {
      connectionState.attempts++;
      if (splashState.visible) {
        if (connectionState.attempts >= connectionState.maxAttempts) {
          hideSplash();
          showConnectBanner(
            'Daemon not responding',
            true,
            'Could not connect to iocoind. Ensure the daemon is installed and running.'
          );
        } else {
          updateSplashStatus(`Starting daemonâ€¦ (attempt ${connectionState.attempts}/${connectionState.maxAttempts})`);
        }
      } else {
        if (connectionState.attempts >= connectionState.maxAttempts) {
          showConnectBanner(
            'Daemon not responding',
            true,
            'Could not connect to iocoind. Ensure the daemon is installed and running.'
          );
        } else {
          showConnectBanner(`Loading daemonâ€¦ (attempt ${connectionState.attempts}/${connectionState.maxAttempts})`);
        }
      }
    }
  }
  finally {
    refreshing = false;
    // Adaptive polling: faster while syncing, slower when synced; extra-slow when tab/window hidden
    const isHidden = document.hidden;
    const vp = last.vp || 0;
    let delay;

    if (connectionFailed && !connectionState.connected) {
      // Use backoff delay when not connected
      delay = getRetryDelay(connectionState.attempts);
      console.log(`[refresh] Connection failed, retry in ${delay}ms (attempt ${connectionState.attempts})`);
    } else {
      // Intel Macs need slower polling to avoid daemon performance issues
      const isIntel = !navigator.userAgent.includes('ARM') && !navigator.platform?.includes('arm');
      // Faster polling during splash sync phase so block count updates in real time
      const isSplashSync = splashState.visible && splashState.phase === 'syncing';
      const base = isSplashSync
        ? SPLASH_SYNC_REFRESH_INTERVAL_MS
        : vp < 0.999
          ? (isIntel ? 3000 : 1500)    // syncing (post-splash): 3s Intel, 1.5s ARM
          : (isIntel ? 8000 : 4000);   // synced:  8s Intel, 4s ARM
      delay = isHidden ? Math.max(base, 10000) : base;
      if (timedOut) {
        delay = Math.max(delay, 6000);
      }
      console.log(`[refresh] Next refresh in ${delay}ms (vp=${vp.toFixed(3)}, hidden=${isHidden}, timedOut=${timedOut})`);
    }
    scheduleRefresh(delay);
  }
}

function enforceHistoryTableFullWidth() {
  const panelInner = document.querySelector('#tab-history .panel-inner');
  if (panelInner) {
    panelInner.style.setProperty('display', 'flex', 'important');
    panelInner.style.setProperty('align-items', 'stretch', 'important');
    panelInner.style.setProperty('width', '100%', 'important');
  }

  const table = document.querySelector('#tab-history table.tx');
  if (!table) return;

  table.style.setProperty('display', 'table', 'important');
  table.style.setProperty('width', '100%', 'important');
  table.style.setProperty('min-width', '100%', 'important');
  table.style.setProperty('max-width', '100%', 'important');
  table.style.setProperty('margin', '0', 'important');
  table.style.setProperty('table-layout', 'fixed', 'important');

  let colgroup = table.querySelector('colgroup[data-force-full-width="1"]');
  const expectedCols = 4;
  if (!colgroup || colgroup.querySelectorAll('col').length !== expectedCols) {
    table.querySelectorAll('colgroup').forEach(cg => cg.remove());
    colgroup = document.createElement('colgroup');
    colgroup.setAttribute('data-force-full-width', '1');
    colgroup.appendChild(document.createElement('col'));
    colgroup.appendChild(document.createElement('col'));
    colgroup.appendChild(document.createElement('col'));
    colgroup.appendChild(document.createElement('col'));
    table.insertBefore(colgroup, table.firstChild);
  }

  const cols = colgroup.querySelectorAll('col');
  if (cols[0]) cols[0].style.width = '25%';
  if (cols[1]) cols[1].style.width = '10%';
  if (cols[2]) cols[2].style.width = '45%';
  if (cols[3]) cols[3].style.width = '20%';

  table.querySelectorAll('thead th, tbody td').forEach(cell => {
    cell.style.textAlign = 'left';
  });
  table.querySelectorAll('thead th:nth-child(4), tbody td:nth-child(4)').forEach(cell => {
    cell.style.textAlign = 'center';
  });
}

async function loadHistory() {
  const tbody = $('txrows');
  if (!tbody) return;

  try {
    const rows = await window.ioc.listTx(50);
    tbody.innerHTML = '';

    const sorted = (rows || []).slice().sort((a, b) => ((b.timereceived ?? b.time) || 0) - ((a.timereceived ?? a.time) || 0));
    sorted.forEach(t => {
      const tr = document.createElement('tr');
      const d = new Date(((t.timereceived ?? t.time) || 0) * 1000);
      const when = d.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
      const amt = Number(t.amount || 0);
      const address = (t.address || '').toString().trim() || '-';
      const txid = (t.txid || '').toString().trim();
      const isPending = (t.confirmations === 0);

      const whenCell = document.createElement('td');
      whenCell.className = 'c-when';
      whenCell.textContent = when;
      if (isPending) {
        const pending = document.createElement('span');
        pending.className = 'tx-pending';
        pending.textContent = 'pending';
        whenCell.appendChild(document.createTextNode(' '));
        whenCell.appendChild(pending);
      }

      const amountCell = document.createElement('td');
      amountCell.className = 'c-amt';
      amountCell.textContent = String(amt);

      const addressCell = document.createElement('td');
      addressCell.className = 'c-addr';
      addressCell.textContent = address;
      addressCell.title = address;

      const txCell = document.createElement('td');
      txCell.className = 'c-tx';
      if (txid) {
        const txBtn = document.createElement('button');
        txBtn.type = 'button';
        txBtn.className = 'btn sm tx-open-btn';
        txBtn.textContent = 'Open Tx';
        txBtn.title = txid;
        txBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (window.ioc && typeof window.ioc.openExternal === 'function') {
            window.ioc.openExternal(`https://iocexplorer.online/#tx/${encodeURIComponent(txid)}`);
          }
        });
        txCell.appendChild(txBtn);
      } else {
        txCell.textContent = '-';
      }

      tr.appendChild(whenCell);
      tr.appendChild(amountCell);
      tr.appendChild(addressCell);
      tr.appendChild(txCell);
      tbody.appendChild(tr);
    });
  } catch (_) {
    // Keep UI responsive even if daemon is not ready.
  } finally {
    enforceHistoryTableFullWidth();
  }
}

const SAVED_RECIPIENTS_KEY = 'ioc-saved-recipients-v1';
let savedRecipientsEditingId = null;
let sendModalSelectedRecipientId = '';

function getSavedRecipients() {
  try {
    const raw = localStorage.getItem(SAVED_RECIPIENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setSavedRecipients(items) {
  localStorage.setItem(SAVED_RECIPIENTS_KEY, JSON.stringify(items));
}

function normalizeRecipientAlias(alias) {
  return String(alias || '').trim();
}

function findSavedRecipientByAlias(alias, excludeId = '') {
  const normalized = normalizeRecipientAlias(alias).toLowerCase();
  return getSavedRecipients().find(r => r.id !== excludeId && normalizeRecipientAlias(r.alias).toLowerCase() === normalized);
}

function populateSavedRecipientsSelect() {
  const list = $('sendRecipientMenuList');
  if (!list) return;
  const items = getSavedRecipients().slice().sort((a, b) => a.alias.localeCompare(b.alias));
  list.innerHTML = '';
  const menu = $('sendRecipientMenu');
  if (menu) menu.classList.toggle('is-empty', !items.length);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'send-recipient-item-empty';
    empty.textContent = 'No recipients yet';
    list.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'send-recipient-item';
    btn.innerHTML = `<span class="alias">${item.alias}</span><span class="address">${item.address}</span>`;
    btn.addEventListener('click', () => {
      const addrInput = $('sendAddr');
      if (addrInput) addrInput.value = item.address;
      sendModalSelectedRecipientId = item.id;
      setSendRecipientMenuOpen(false);
      const amt = $('sendAmt');
      if (amt) requestAnimationFrame(() => amt.focus());
    });
    list.appendChild(btn);
  });
}

function setSendRecipientMenuOpen(open) {
  const menu = $('sendRecipientMenu');
  const btn = $('sendRecipientPickerBtn');
  if (menu) menu.classList.toggle('hidden', !open);
  if (btn) btn.classList.toggle('active', !!open);
}

function setSavedRecipientFormOpen(open) {
  $('savedRecipientForm')?.classList.toggle('hidden', !open);
  $('savedRecipientCreateBtn')?.classList.toggle('hidden', open);
}

function resetSavedRecipientForm() {
  savedRecipientsEditingId = null;
  if ($('savedRecipientAliasInput')) $('savedRecipientAliasInput').value = '';
  if ($('savedRecipientAddressInput')) $('savedRecipientAddressInput').value = '';
  if ($('savedRecipientErr')) $('savedRecipientErr').textContent = '';
  if ($('savedRecipientSaveBtn')) $('savedRecipientSaveBtn').textContent = 'Save recipient';
  $('savedRecipientCancelBtn')?.classList.add('hidden');
  if ($('savedRecipientCancelBtn')) $('savedRecipientCancelBtn').textContent = 'Close';
  setSavedRecipientFormOpen(false);
}

function editSavedRecipient(id) {
  const item = getSavedRecipients().find(r => r.id === id);
  if (!item) return;
  savedRecipientsEditingId = id;
  setSavedRecipientFormOpen(true);
  if ($('savedRecipientAliasInput')) $('savedRecipientAliasInput').value = item.alias;
  if ($('savedRecipientAddressInput')) $('savedRecipientAddressInput').value = item.address;
  if ($('savedRecipientErr')) $('savedRecipientErr').textContent = '';
  if ($('savedRecipientSaveBtn')) $('savedRecipientSaveBtn').textContent = 'Save changes';
  $('savedRecipientCancelBtn')?.classList.remove('hidden');
  if ($('savedRecipientCancelBtn')) $('savedRecipientCancelBtn').textContent = 'Close';
  $('savedRecipientAliasInput')?.focus();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    return !!ok;
  } catch {
    return false;
  }
}

function renderSavedRecipients() {
  const grid = $('savedRecipientsGrid');
  if (!grid) return;
  const items = getSavedRecipients().slice().sort((a, b) => a.alias.localeCompare(b.alias));
  grid.innerHTML = '';
  grid.classList.toggle('saved-grid-empty', !items.length);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'addr-card saved-recipient-card saved-recipient-empty';
    empty.innerHTML = `<div class="saved-alias">No recipients yet</div>
      <div class="saved-address">Save frequently used recipient addresses here to reuse them later.</div>`;
    grid.appendChild(empty);
    populateSavedRecipientsSelect();
    return;
  }
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'addr-card saved-recipient-card';
    card.innerHTML = `<div class="saved-alias">${item.alias}</div>
      <div class="saved-address">${item.address}</div>
      <div class="saved-actions">
        <span class="saved-flash" aria-live="polite"></span>
        <button class="btn sm" type="button" data-action="copy">Copy</button>
        <button class="btn sm" type="button" data-action="edit">Edit</button>
        <button class="btn sm" type="button" data-action="delete">Delete</button>
      </div>`;
    card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
      const flash = card.querySelector('.saved-flash');
      const ok = await copyTextToClipboard(item.address);
      if (flash) {
        flash.textContent = ok ? 'Copied to clipboard' : 'Could not copy';
        flash.classList.add('visible');
        setTimeout(() => {
          flash.classList.remove('visible');
          flash.textContent = '';
        }, 1400);
      }
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', () => editSavedRecipient(item.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (!window.confirm(`Delete saved recipient "${item.alias}"?`)) return;
      const next = getSavedRecipients().filter(r => r.id !== item.id);
      setSavedRecipients(next);
      if (savedRecipientsEditingId === item.id) resetSavedRecipientForm();
      renderSavedRecipients();
    });
    grid.appendChild(card);
  });
  populateSavedRecipientsSelect();
}

function saveSavedRecipientFromForm() {
  const alias = normalizeRecipientAlias($('savedRecipientAliasInput')?.value);
  const address = ($('savedRecipientAddressInput')?.value || '').trim();
  const errEl = $('savedRecipientErr');
  if (errEl) errEl.textContent = '';
  if (!alias || !address) {
    if (errEl) errEl.textContent = 'Alias and address are required';
    return;
  }
  if (findSavedRecipientByAlias(alias, savedRecipientsEditingId || '')) {
    if (errEl) errEl.textContent = 'Alias already exists. Please choose a unique alias';
    return;
  }
  const items = getSavedRecipients();
  if (savedRecipientsEditingId) {
    const idx = items.findIndex(r => r.id === savedRecipientsEditingId);
    if (idx >= 0) {
      items[idx] = { ...items[idx], alias, address };
    }
  } else {
    items.push({ id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, alias, address });
  }
  setSavedRecipients(items);
  resetSavedRecipientForm();
  renderSavedRecipients();
}

async function loadAddrs() {
  const grid = $('addrGrid'); if (!grid) return;
  grid.innerHTML = '';
  const xs = await window.ioc.listAddrs();
  xs.forEach(x => {
    const card = document.createElement('div');
    card.className = 'addr-card' + (x.change ? ' addr-change' : '');
    const balText = typeof x.amount === 'number' ? `Balance: ${x.amount} IOC â€” Click to copy` : 'Click to copy';
    const displayLabel = x.change ? 'Change' : (x.label || 'Address');
    card.innerHTML = `<div class="label" title="Click to edit label" style="cursor:pointer">${displayLabel}</div>
      <div class="addr" title="${balText}" style="cursor:pointer;user-select:text">${x.address}</div>`;
    const labelEl = card.querySelector('.label');
    const addrEl = card.querySelector('.addr');
    // Click label to edit
    labelEl.addEventListener('click', () => {
      const originalLabel = x.label || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = originalLabel;
      input.placeholder = 'Label';
      input.style.cssText = 'width:100%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:inherit;font:inherit;padding:2px 6px;';
      labelEl.replaceWith(input);
      input.focus();
      input.select();
      const restore = () => {
        const newEl = document.createElement('div');
        newEl.className = 'label';
        newEl.title = 'Click to edit label';
        newEl.style.cursor = 'pointer';
        newEl.textContent = x.label || 'Address';
        input.replaceWith(newEl);
        loadAddrs();
      };
      const save = async () => {
        const newLabel = (input.value || '').trim();
        if (newLabel === originalLabel) {
          restore();
          return;
        }
        const res = await window.ioc.setLabel(x.address, newLabel);
        if (res?.ok) x.label = newLabel;
        restore();
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = originalLabel; input.blur(); } });
    });
    // Click address to copy
    addrEl.addEventListener('click', () => {
      navigator.clipboard.writeText(x.address).then(() => {
        addrEl.textContent = 'Copied!';
        setTimeout(() => { addrEl.textContent = x.address; }, 1200);
      });
    });
    grid.appendChild(card);
  });
}

function switchTab(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('tab-' + name).classList.remove('hidden');
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  if (name === 'history') {
    loadHistory();
    requestAnimationFrame(() => {
      enforceHistoryTableFullWidth();
      setTimeout(enforceHistoryTableFullWidth, 120);
    });
  }
  if (name === 'address') loadAddrs();
  if (name === 'recipients') {
    resetSavedRecipientForm();
    renderSavedRecipients();
  }
  // Re-fit balance after switching to Overview (double RAF ensures layout is settled)
  if (name === 'overview') {
    requestAnimationFrame(() => requestAnimationFrame(() => fitBalance()));
  }
}

async function doUnlock() {
  const pass = ($('pass').value || '').trim(); if (!pass) return;
  $('unlockErr').textContent = '';
  const btn = $('doUnlock');
  if (btn) { btn.textContent = 'Unlocking\u2026'; btn.disabled = true; }
  const r = await window.ioc.tryRpc('walletpassphrase', [pass, 9999999]);
  if (btn) { btn.textContent = 'Unlock'; btn.disabled = false; }
  if (!r || !r.ok) {
    $('unlockErr').textContent = 'Wrong passphrase';
    const sheet = $('unlockSheet');
    if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
    return;
  }
  lockOverrideUntil = Date.now() + 20000;
  setLock(true);
  $('unlockModal').classList.add('hidden');
  $('pass').value = '';
  refresh();
  window.ioc.tryRpc('reservebalance', [false]);
}

async function doEncrypt() {
  const pass = ($('encryptPass').value || '').trim();
  const confirm = ($('encryptPassConfirm').value || '').trim();
  $('encryptErr').textContent = '';
  if (!pass) { $('encryptErr').textContent = 'Passphrase is required'; return; }
  if (pass !== confirm) { $('encryptErr').textContent = 'Passphrases do not match'; return; }
  // Close modal and show splash BEFORE encrypt â€” daemon dies mid-RPC
  $('encryptModal').classList.add('hidden');
  $('encryptPass').value = '';
  $('encryptPassConfirm').value = '';
  showSplash();
  updateSplashStatus('Encrypting walletâ€¦');
  try {
    await window.ioc.rpc('encryptwallet', [pass]);
  } catch (_) {
    // encryptwallet may error because daemon shuts down mid-RPC â€” that's expected
  }
  // Daemon is now dead â€” show restart message and restart
  updateSplashStatus('Wallet encrypted. Restarting daemonâ€¦');
  try {
    const result = await window.ioc.restartDaemon();
    if (result?.ok) {
      updateSplashStatus('Daemon restarted. Loadingâ€¦');
      // Reset state so polling picks up the new encrypted status
      state.encrypted = null;
      connectionState.connected = false;
      connectionState.attempts = 0;
      // Kick refresh loop to reconnect immediately
      scheduleRefresh(2000);
    }
  } catch (e) {
    updateSplashStatus('Restart failed: ' + (e?.message || 'unknown error'));
  }
}

async function onLockClick() {
  if (state.encrypted === false) {
    // Wallet not encrypted â€” show encrypt modal
    $('encryptPass').value = '';
    $('encryptPassConfirm').value = '';
    $('encryptErr').textContent = '';
    $('encryptModal').classList.remove('hidden');
    setTimeout(() => $('encryptPass').focus(), 0);
    return;
  }
  if (state.unlocked) {
    lockOverrideUntil = Date.now() + 20000;
    setLock(false);
    setStaking(false, 0, {}, 0);
    window.ioc.tryRpc('walletlock', []);
    window.ioc.tryRpc('reservebalance', [true, 999999999]);
  } else {
    $('unlockModal').classList.remove('hidden');
    setTimeout(() => $('pass').focus(), 0);
  }
}

/** New Address flow */
function openNewAddrModal() {
  $('newLabel').value = '';
  $('newAddrErr').textContent = '';
  $('newAddrResult').classList.add('hidden');
  $('newAddrResult').textContent = '';
  $('newAddrModal').classList.remove('hidden');
  setTimeout(() => $('newLabel').focus(), 0);
}

let _creatingAddr = false;
async function createNewAddr() {
  if (_creatingAddr) return;
  _creatingAddr = true;
  try {
    const label = ($('newLabel').value || '').trim();
    $('newAddrErr').textContent = '';
    const res = await window.ioc.newAddr(label);
    if (!res?.ok) { $('newAddrErr').textContent = 'Could not create address (daemon not ready?)'; return; }
    const out = $('newAddrResult');
    out.textContent = res.address;
    out.classList.remove('hidden');
    setTimeout(loadAddrs, 300);
    setTimeout(() => { $('newAddrModal').classList.add('hidden'); }, 1200);
  } finally {
    setTimeout(() => { _creatingAddr = false; }, 1500);
  }
}

const WALLET_HELP_TOPICS = {
  'getting-started': {
    title: 'Getting Started',
    intro: 'Use this path on first launch to avoid most issues later.',
    steps: [
      { title: 'Sync first', detail: 'Sync must finish completely before using the wallet.' },
      { title: 'Verify available amount', detail: 'Open Overview and confirm your available coin amount is correct.' },
      { title: 'Create first receiving address', detail: 'Create your first receiving address in My Addresses by clicking + New Address.' }
    ]
  },
  'overview-sync': {
    title: 'Overview & Sync',
    intro: 'This section tells you whether your wallet is ready to operate safely.',
    steps: [
      { title: 'Spendable balance', detail: 'TOTAL I/O AVAILABLE is your spendable balance now.' },
      { title: 'Real staking activity', detail: 'STAKING only reflects real activity when unlocked, synced, and funded.' },
      { title: 'Partial sync warning', detail: 'If sync is still running, balances and confirmations can look incomplete.' }
    ]
  },
  sending: {
    title: 'Sending I/O',
    intro: 'Use this checklist every time you send to reduce mistakes.',
    steps: [
      { title: 'Set destination', detail: 'Open Send and paste the destination, or choose a saved Recipient.' },
      { title: 'Choose fee mode', detail: 'Enter amount and pick fee mode: Fee on top or Fee included.' },
      { title: 'Confirm before send', detail: 'You will be asked to confirm destination, amount, fee, and final debit total before sending.' },
      { title: 'Adjust when funds are short', detail: 'If funds are short, reduce amount or switch fee mode and re-check total.' }
    ]
  },
  addresses: {
    title: 'My Addresses',
    intro: 'Use this area to create and organize receiving addresses.',
    steps: [
      { title: 'Generate receiving address', detail: 'Click + New Address to generate a fresh receiving address.' },
      { title: 'Use clear naming', detail: 'Use a clear Address Name so you can identify usage later.' },
      { title: 'Share only receiver addresses', detail: 'Share only addresses from this section when receiving I/O.' },
      { title: 'Label changes are local only', detail: 'Renaming an address only affects local labels, not blockchain data.' }
    ]
  },
  recipients: {
    title: 'Recipients',
    intro: 'This is your trusted address book for outgoing transfers.',
    steps: [
      { title: 'Save frequent destinations', detail: 'Save frequent destinations with alias + full address.' },
      { title: 'Copy and verify', detail: 'Use Copy for speed, but still verify before sending.' },
      { title: 'Maintain clean entries', detail: 'Use Edit and Delete to keep entries clean and current.' },
      { title: 'Final safety check', detail: 'Always verify recipient address in the Send modal.' }
    ]
  },
  'wallet-tools': {
    title: 'Wallet Tools',
    intro: 'These actions are for maintenance and recovery workflows.',
    steps: [
      { title: 'Dump Wallet', detail: 'Dump Wallet exports keys/metadata for advanced recovery use.' },
      { title: 'Import Wallet', detail: 'Import Wallet should only be used with trusted files from your own backups.' },
      { title: 'Create Backup', detail: 'Create Backup should be done regularly and before major changes.' },
      { title: 'Show Live Debug', detail: 'Show Live Debug helps inspect daemon/network behavior in real time.' }
    ]
  },
  security: {
    title: 'Security',
    intro: 'Short rules that prevent high-impact user errors.',
    steps: [
      { title: 'Use strong credentials', detail: 'Use a strong, unique passphrase and never share it.' },
      { title: 'Keep offline backup', detail: 'Keep at least one offline backup in a separate secure location.' },
      { title: 'Verify destination every time', detail: 'Double-check destination addresses before every send.' },
      { title: 'Avoid unknown import files', detail: 'Never import unknown dump files; protect your Windows account/session.' }
    ]
  },
  'restore-wallet': {
    title: 'Restore Wallet',
    intro: 'Use this when moving to a new installation or recovering funds.',
    steps: [
      { title: 'Close app and daemon', detail: 'Fully close the wallet app and daemon.' },
      { title: 'Open wallet data folder', detail: 'Go to C:\\Users\\<USERNAME>\\AppData\\Roaming\\IOCoin.' },
      { title: 'Preserve current data', detail: '(Recommended) Rename current wallet.dat to wallet.dat.bak.' },
      { title: 'Replace with your backup file', detail: 'Copy your backup wallet.dat into that folder, replacing the active one.' },
      { title: 'Start and wait for sync', detail: 'Start the wallet normally and wait until it is fully synced.' }
    ]
  },
  'peer-connections': {
    title: 'Peer Connections',
    intro: 'If peer count is too low, verify your config file.',
    steps: [
      { title: 'Open iocoin.conf', detail: 'Open iocoin.conf in C:\\Users\\<USERNAME>\\AppData\\Roaming\\IOCoin.' },
      { title: 'Compare peer entries', detail: 'Check whether peer entries are missing or outdated (against the explorer).' },
      { title: 'Add recent peers manually', detail: 'Get recent peers from the explorer/community list and add them manually, one per line.' },
      { title: 'Use correct format', detail: 'Use this format: addnode=<IP>:<PORT>.' },
      { title: 'Restart and validate', detail: 'Save the file, restart the wallet, and re-check peers in Live Debug.' }
    ]
  },
  troubleshooting: {
    title: 'Troubleshooting',
    intro: 'Follow this order when something looks wrong.',
    steps: [
      { title: 'Confirm full sync first', detail: 'First confirm full sync; many "wrong balance" issues come from partial sync.' },
      { title: 'Inspect network stability', detail: 'If network looks unstable, inspect peers indicator and open Live Debug.' },
      { title: 'Read logs before restart', detail: 'If startup is slow, wait and read logs (Help > Live Debug) before forcing restarts.' },
      { title: 'Escalate safely', detail: 'If behavior persists, manually back up wallet first (wallet.dat file within C:\\Users\\addri\\AppData\\Roaming\\IOCoin), then proceed with maintenance or contact the community for support.' }
    ]
  }
};

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HELP_KEYWORDS = [
  'Sync',
  'Show Live Debug',
  'Create new recipient',
  '+ New Address',
  'Fee included',
  'Fee on top',
  'TOTAL I/O AVAILABLE',
  'STAKING',
  'Address Name',
  'Chain Explorer',
  'Open Explorer',
  'Dump Wallet',
  'Import Wallet',
  'Create Backup',
  'Live Debug',
  'Wallet Tools',
  'My Addresses',
  'Recipients',
  'Recipient',
  'Copy',
  'Edit',
  'Delete',
  'Restore Wallet',
  'Peer Connections',
  'wallet.dat',
  'iocoin.conf',
  'daemon',
  'Help > Live Debug',
  'Overview',
  'Settings',
  'Send'
];

const HELP_KEYWORD_REGEX = new RegExp(
  `(^|[^A-Za-z0-9])(${HELP_KEYWORDS
    .slice()
    .map((k) => escapeHtml(k))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})(?=$|[^A-Za-z0-9])`,
  'gi'
);

function highlightHelpKeywords(text) {
  return escapeHtml(text);
}

function initHelpCenter() {
  const modal = $('helpCenterModal');
  if (!modal || modal.dataset.helpCenterInit === '1') return;
  modal.dataset.helpCenterInit = '1';

  const nav = $('helpCenterNav');
  const topicTitle = $('helpTopicTitle');
  const topicIntro = $('helpTopicIntro');
  const topicList = $('helpTopicList');
  const closeButtons = [$('helpCenterClose'), $('helpCenterCloseTop')].filter(Boolean);

  let activeTopic = nav?.querySelector('.help-topic-btn.active')?.dataset.topic || 'getting-started';

  const getHelpCenterWindowContext = () => ({
    compactMode: document.body.classList.contains('compact-mode'),
    splashActive: document.body.classList.contains('splash-active'),
    splashDebugOpen: document.body.classList.contains('splash-debug-open') || !!splashState.debugExpanded
  });

  async function syncHelpCenterWindow(open) {
    if (!window.ioc?.setHelpCenterWindow) return;
    try {
      await window.ioc.setHelpCenterWindow(!!open, getHelpCenterWindowContext());
    } catch (_) {}
  }

  const renderTopic = (topicKey) => {
    const topic = WALLET_HELP_TOPICS[topicKey] || WALLET_HELP_TOPICS['getting-started'];
    activeTopic = topicKey in WALLET_HELP_TOPICS ? topicKey : 'getting-started';
    if (topicTitle) topicTitle.textContent = topic.title || '';
    if (topicIntro) topicIntro.innerHTML = highlightHelpKeywords(topic.intro);
    if (topicList) {
      topicList.innerHTML = '';
      const steps = Array.isArray(topic.steps) && topic.steps.length
        ? topic.steps
        : (Array.isArray(topic.items) ? topic.items : []);
      for (const item of steps) {
        const li = document.createElement('li');
        if (item && typeof item === 'object') {
          const title = document.createElement('span');
          title.className = 'help-step-title';
          title.textContent = item.title || '';
          const detail = document.createElement('p');
          detail.className = 'help-step-detail';
          detail.innerHTML = highlightHelpKeywords(item.detail || '');
          li.appendChild(title);
          li.appendChild(detail);
        } else {
          li.innerHTML = highlightHelpKeywords(String(item || ''));
        }
        topicList.appendChild(li);
      }
    }
    if (nav) {
      nav.querySelectorAll('.help-topic-btn').forEach((btn) => {
        const isActive = btn.dataset.topic === activeTopic;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-current', isActive ? 'true' : 'false');
      });
    }
  };

  const openHelpCenter = async (topicKey = activeTopic) => {
    renderTopic(topicKey);
    await syncHelpCenterWindow(true);
    modal.classList.remove('hidden');
  };
  const closeHelpCenter = async () => {
    modal.classList.add('hidden');
    await syncHelpCenterWindow(false);
  };

  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.help-topic-btn');
      if (!btn) return;
      renderTopic(btn.dataset.topic || 'getting-started');
    });
  }

  closeButtons.forEach((btn) => btn.addEventListener('click', closeHelpCenter));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeHelpCenter();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      openHelpCenter();
      return;
    }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeHelpCenter();
    }
  });

  if (window.ioc?.onOpenHelpCenter) {
    window.ioc.onOpenHelpCenter(() => {
      openHelpCenter();
    });
  }

  renderTopic(activeTopic);
}

function main() {
  // Mount splash extras immediately for initial connecting phase.
  ensureSplashDecorations();
  setSplashStepFlow('startup');
  setSplashPhase('connecting');
  updateSplashStatus($('splashStatus')?.textContent || 'Loading daemon...');

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  window.addEventListener('resize',()=>{if(__resizeRAF)cancelAnimationFrame(__resizeRAF);__resizeRAF=requestAnimationFrame(()=>{__resizeRAF=null;fitBalance();});});

  document.addEventListener('visibilitychange', () => {
    // When returning to the app, refresh immediately; when hiding, the next tick will stretch.
    if (!document.hidden) refresh();
  });

  if (window.ioc?.onSystemResume) {
    window.ioc.onSystemResume(() => {
      runResumeRecoveryFlow().catch(err => {
        console.warn('[resume] Recovery flow failed:', err?.message || err);
      });
    });
  }

  $('ic-lock').addEventListener('click', onLockClick);
  $('cancelUnlock').addEventListener('click', () => { $('unlockModal').classList.add('hidden'); $('pass').value=''; });
  $('doUnlock').addEventListener('click', doUnlock);
  $('pass').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); if (e.key === 'Escape') {$('unlockModal').classList.add('hidden');} });

  $('cancelEncrypt').addEventListener('click', () => { $('encryptModal').classList.add('hidden'); $('encryptPass').value=''; $('encryptPassConfirm').value=''; });
  $('doEncrypt').addEventListener('click', doEncrypt);
  $('encryptPassConfirm').addEventListener('keydown', e => { if (e.key === 'Enter') doEncrypt(); if (e.key === 'Escape') {$('encryptModal').classList.add('hidden');} });

  $('sendBtn').addEventListener('click', (e) => {
    if (!state.synced) {
      showSyncLockNotice(e.currentTarget);
      return;
    }
    if (state.encrypted === false) {
      $('encryptModal').classList.remove('hidden');
      return;
    }
    openSendModal(e.currentTarget);
  });
  // Widget send button (compact mode)
  const widgetSendBtn = $('widget-send-btn');
  if (widgetSendBtn) {
    widgetSendBtn.addEventListener('click', (e) => {
      if (!state.synced) {
        showSyncLockNotice(e.currentTarget);
        return;
      }
      if (state.encrypted === false) {
        $('encryptModal').classList.remove('hidden');
        return;
      }
      openSendModal(e.currentTarget);
    });
  }
  updateSendLockState(state.synced);
  function getSendFeeMode() {
    return document.querySelector('input[name="sendFeeMode"]:checked')?.value || 'top';
  }
  function formatSendAmount(v) {
    return Number(v || 0).toLocaleString(undefined, {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3
    }) + ' IOC';
  }
  function updateSendSummary() {
    const summary = $('sendSummary');
    const recipientEl = $('sendSummaryRecipient');
    const feeEl = $('sendSummaryFee');
    const totalEl = $('sendSummaryTotal');
    const errEl = $('sendErr');
    if (!summary || !recipientEl || !feeEl || !totalEl) return;

    const amount = parseFloat(($('sendAmt').value || '').trim());
    const mode = getSendFeeMode();
    if (!(amount > 0)) {
      summary.classList.add('hidden');
      return;
    }

    const recipientAmount = mode === 'included'
      ? Math.max(0, amount - SEND_FEE_IOC)
      : amount;
    const totalDebited = mode === 'included'
      ? amount
      : amount + SEND_FEE_IOC;

    recipientEl.textContent = formatSendAmount(recipientAmount);
    feeEl.textContent = formatSendAmount(SEND_FEE_IOC);
    totalEl.textContent = formatSendAmount(totalDebited);
    summary.classList.remove('hidden');

    if (errEl && errEl.textContent && /fee|insufficient|exceeds/i.test(errEl.textContent)) {
      errEl.textContent = '';
    }
  }
  function openSendModal(triggerEl = null) {
    const errEl = $('sendErr');
    const summary = $('sendSummary');
    if (!state.synced) {
      if (errEl) errEl.textContent = SEND_DISABLED_SYNC_MESSAGE;
      showSyncLockNotice(triggerEl || $('sendBtn') || $('widget-send-btn'));
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
      return false;
    }
    if (errEl) errEl.textContent = '';
    if (summary) summary.classList.add('hidden');
    const topMode = document.querySelector('input[name="sendFeeMode"][value="top"]');
    if (topMode) topMode.checked = true;
    sendModalSelectedRecipientId = '';
    if ($('sendAddr')) $('sendAddr').value = '';
    if ($('sendAmt')) $('sendAmt').value = '';
    const sheet = $('sendModal')?.querySelector('.sheet');
    if (sheet) sheet.classList.remove('shake');
    $('sendModal').classList.remove('hidden');
    populateSavedRecipientsSelect();
    setSendRecipientMenuOpen(false);
    updateSendSummary();
    return true;
  }
  $('sendAmt')?.addEventListener('input', updateSendSummary);
  $('sendAddr')?.addEventListener('input', () => {
    sendModalSelectedRecipientId = '';
  });
  $('sendRecipientPickerBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = $('sendRecipientMenu');
    setSendRecipientMenuOpen(!!menu?.classList.contains('hidden'));
    populateSavedRecipientsSelect();
  });
  document.addEventListener('click', (e) => {
    const modal = $('sendModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const menu = $('sendRecipientMenu');
    const pickerBtn = $('sendRecipientPickerBtn');
    if (!menu || menu.classList.contains('hidden')) return;
    const target = e.target;
    if (menu.contains(target) || pickerBtn?.contains(target)) return;
    setSendRecipientMenuOpen(false);
  });
  document.querySelectorAll('input[name="sendFeeMode"]').forEach(el => {
    el.addEventListener('change', updateSendSummary);
  });
  $('cancelSend').addEventListener('click', () => {
    setSendRecipientMenuOpen(false);
    const sheet = $('sendModal')?.querySelector('.sheet');
    if (sheet) sheet.classList.remove('shake');
    $('sendModal').classList.add('hidden');
  });
  $('doSend').addEventListener('click', async () => {
    const errEl = $('sendErr');
    if (!state.synced) {
      if (errEl) errEl.textContent = SEND_DISABLED_SYNC_MESSAGE;
      showSyncLockNotice($('doSend'));
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
      return;
    }
    const a = ($('sendAddr').value||'').trim();
    const n = parseFloat(($('sendAmt').value||'').trim());
    if (!a || !(n>0)) return;
    const available = Number(last.bal || 0);
    const feeMode = getSendFeeMode();
    const feeIncluded = feeMode === 'included';
    const recipientAmount = feeIncluded ? (n - SEND_FEE_IOC) : n;
    const totalDebited = feeIncluded ? n : (n + SEND_FEE_IOC);
    if (!state.unlocked) {
      if (errEl) errEl.textContent = 'Unlock wallet to send';
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
      return;
    }
    if (feeIncluded && recipientAmount <= 0) {
      if (errEl) errEl.textContent = `Amount must be greater than the ${SEND_FEE_IOC.toFixed(3)} IOC network fee`;
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
      return;
    }
    if (available > 0 && totalDebited > available + SEND_ALL_EPSILON) {
      if (errEl) {
        errEl.textContent = feeIncluded
          ? 'Amount exceeds available balance'
          : `Insufficient funds. Total with fee: ${formatSendAmount(totalDebited)}`;
      }
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
      return;
    }
    try {
      const val = await window.ioc.tryRpc('validateaddress', [a]);
      const isInvalid = !!(val && val.ok && val.result && typeof val.result === 'object' && val.result.isvalid === false);
      if (isInvalid) {
        if (errEl) errEl.textContent = 'Invalid recipient address';
        const sheet = $('sendModal')?.querySelector('.sheet');
        if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
        return;
      }
    } catch (_) {
      // If validation is unavailable, do not block send.
    }
    try {
      const selectedRecipient = getSavedRecipients().find(r => r.id === sendModalSelectedRecipientId);
      const confirmMsg =
        `Please confirm the address is correct before sending.\n\n` +
        `Recipient: ${selectedRecipient?.alias || 'Manual address'}\n` +
        `Address: ${a}\n` +
        `Recipient receives: ${formatSendAmount(recipientAmount)}\n` +
        `Network fee: ${formatSendAmount(SEND_FEE_IOC)}\n` +
        `Total debited: ${formatSendAmount(totalDebited)}`;
      if (!window.confirm(confirmMsg)) return;
      await window.ioc.rpc('sendtoaddress', [a, recipientAmount]);
      $('sendModal').classList.add('hidden');
      setTimeout(refresh, 400);
    } catch (e) {
      const rawMsg = extractRpcError(e) || 'Send failed';
      const msg = /insufficient funds/i.test(rawMsg) && !feeIncluded
        ? `Insufficient funds. Total with fee: ${formatSendAmount(totalDebited)}`
        : rawMsg;
      if (errEl) errEl.textContent = msg;
      const sheet = $('sendModal')?.querySelector('.sheet');
      if (sheet) { sheet.classList.remove('shake'); void sheet.offsetWidth; sheet.classList.add('shake'); }
    }
  });

  $('newAddrBtn').addEventListener('click', openNewAddrModal);
  $('savedRecipientCreateBtn')?.addEventListener('click', () => {
    setSavedRecipientFormOpen(true);
    $('savedRecipientCancelBtn')?.classList.remove('hidden');
    if ($('savedRecipientCancelBtn')) $('savedRecipientCancelBtn').textContent = 'Close';
    $('savedRecipientAliasInput')?.focus();
  });
  $('savedRecipientSaveBtn')?.addEventListener('click', saveSavedRecipientFromForm);
  $('savedRecipientCancelBtn')?.addEventListener('click', resetSavedRecipientForm);
  $('cancelNewAddr').addEventListener('click', () => $('newAddrModal').classList.add('hidden'));
  $('createNewAddr').addEventListener('click', createNewAddr);
  $('newLabel').addEventListener('keydown', e => { if (e.key === 'Enter') createNewAddr(); if (e.key === 'Escape') {$('newAddrModal').classList.add('hidden');}});

  // Setup help link to open externally via IPC
  const helpLink = $('connectHelp');
  if (helpLink) {
    helpLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.ioc && window.ioc.openExternal) {
        window.ioc.openExternal(helpLink.href);
      }
    });
  }

  initWalletToolsActions();
  initSettingsLiveDebug();
  initCompactMode();
  initHelpCenter();

  // Setup bootstrap handlers (skip/retry buttons)
  setupBootstrapHandlers();

  // Check for first-run bootstrap before starting normal refresh loop
  (async () => {
    try {
      await runBootstrapFlow();
    } catch (err) {
      console.error('[main] Bootstrap flow error:', err);
    }

    // After bootstrap (or if not needed), splash is already visible
    // Start refresh loop - splash will hide when valid status is received
    connectionState.startTime = Date.now();
    // Don't show connect banner - splash handles warmup display
    refresh();
  })();
  window.addEventListener('resize', scheduleSplashStatusFit);
}
document.addEventListener('DOMContentLoaded', () => { main(); loadVersion(); });

// Load and display wallet version
async function loadVersion() {
  try {
    const ver = await window.ioc.getVersion();
    const el = document.getElementById('walletVersion');
    if (el) el.textContent = ver ? `v${ver}` : '-';
  } catch (_) {}
}

function wireClickOnce(id, handler) {
  const element = $(id);
  if (!element || element.dataset.wiredClick === '1') return element;
  element.dataset.wiredClick = '1';
  element.addEventListener('click', handler);
  return element;
}

function isAbsoluteWalletPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return false;
  return /^[A-Za-z]:\\/.test(value) || /^\\\\/.test(value) || /^\//.test(value);
}

function formatDumpDateStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function resolveDownloadsFolderFromDataDir(dataDir) {
  const normalized = String(dataDir || '').replace(/\//g, '\\');
  const userRoot = normalized.match(/^([A-Za-z]:\\Users\\[^\\]+)/i);
  if (userRoot) return `${userRoot[1]}\\Downloads`;
  return normalized || 'C:\\';
}

async function buildDefaultDumpPath() {
  const suffix = `ioc-wallet-dump-${formatDumpDateStamp()}.txt`;
  try {
    const dataDir = await window.ioc.getDataDir();
    return `${resolveDownloadsFolderFromDataDir(dataDir)}\\${suffix}`;
  } catch {
    return `C:\\${suffix}`;
  }
}

function promptWithModal({ title, placeholder = '', type = 'text', value = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.style.width = 'min(480px, calc(100vw - 28px))';

    const heading = document.createElement('div');
    heading.className = 'title2';
    heading.style.textAlign = 'center';
    heading.textContent = title || 'Input';

    const input = document.createElement('input');
    input.type = type === 'password' ? 'password' : 'text';
    input.placeholder = placeholder;
    input.value = value;

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.style.justifyContent = 'center';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-ok';
    okBtn.type = 'button';
    okBtn.textContent = 'OK';

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', () => finish(input.value || null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        okBtn.click();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelBtn.click();
      }
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(null);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    sheet.appendChild(heading);
    sheet.appendChild(input);
    sheet.appendChild(actions);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    setTimeout(() => {
      input.focus();
      if (type !== 'password') input.select();
    }, 0);
  });
}

async function dumpWalletToFile() {
  const passphrase = await promptWithModal({
    title: 'Enter wallet passphrase',
    placeholder: 'Wallet passphrase',
    type: 'password'
  });
  if (!passphrase) return;

  const defaultPath = await buildDefaultDumpPath();
  const pathInput = await promptWithModal({
    title: 'Absolute destination path (.txt)',
    placeholder: 'C:\\Users\\<user>\\Downloads\\ioc-wallet-dump-YYYYMMDD.txt',
    value: defaultPath
  });
  if (!pathInput) return;

  const targetPath = String(pathInput).trim();
  if (!isAbsoluteWalletPath(targetPath)) {
    alert('Use an absolute path. Example: C:\\Users\\<user>\\Downloads\\ioc-wallet-dump-YYYYMMDD.txt');
    return;
  }

  try {
    try {
      await window.ioc.rpc('walletpassphrase', [passphrase, 300]);
    } catch (_) {
      // Continue: some wallets may already be unlocked.
    }

    try {
      await window.ioc.rpc('dumpwalletRT', [targetPath]);
    } catch (firstError) {
      const details = extractRpcError(firstError);
      if (/not\s*found|method\s*not\s*found/i.test(details)) {
        await window.ioc.rpc('dumpwallet', [targetPath]);
      } else {
        throw firstError;
      }
    }

    try {
      await window.ioc.rpc('walletlock', []);
    } catch (_) {}

    alert(`Dump created:\n${targetPath}`);
  } catch (error) {
    alert(`Dump failed: ${extractRpcError(error) || 'unknown error'}`);
  }
}

async function importWalletFromFile() {
  const pathInput = await promptWithModal({
    title: 'Absolute path to wallet dump (.txt)',
    placeholder: 'C:\\Users\\<user>\\Downloads\\ioc-wallet-dump-YYYYMMDD.txt'
  });
  if (!pathInput) return;

  const sourcePath = String(pathInput).trim();
  if (!isAbsoluteWalletPath(sourcePath)) {
    alert('Use an absolute path for import.');
    return;
  }

  try {
    await window.ioc.rpc('importwallet', [sourcePath]);
    alert(`Import started:\n${sourcePath}`);
  } catch (error) {
    alert(`Import failed: ${extractRpcError(error) || 'unknown error'}`);
  }
}

async function runWalletBackup() {
  const backupButton = $('backupWalletBtn');
  if (!backupButton || backupButton.disabled) return;

  backupButton.disabled = true;
  try {
    const result = await window.ioc.walletBackup();
    if (!result?.ok) {
      if (result?.canceled) return;
      alert(result?.error || 'Backup failed');
      return;
    }
    alert(`Backup saved to:\n${result.savedTo}`);
  } catch (error) {
    alert(`Backup failed: ${extractRpcError(error) || 'unknown error'}`);
  } finally {
    backupButton.disabled = false;
  }
}

function initWalletToolsActions() {
  wireClickOnce('btnDump', (event) => {
    event.preventDefault();
    dumpWalletToFile();
  });

  wireClickOnce('btnImport', (event) => {
    event.preventDefault();
    importWalletFromFile();
  });

  wireClickOnce('btnOpenPath', (event) => {
    event.preventDefault();
    if (window.sys?.openFolder) {
      window.sys.openFolder();
    }
  });

  wireClickOnce('backupWalletBtn', (event) => {
    event.preventDefault();
    runWalletBackup();
  });

  wireClickOnce('btnExplorer', (event) => {
    event.preventDefault();
    if (window.ioc?.openExternal) {
      window.ioc.openExternal('https://iocexplorer.online');
    }
  });
}

function initSettingsLiveDebug() {
  const output = $('live-tail');
  const toggle = $('start-tail');
  if (!output || !toggle || !window.diag) return;
  if (toggle.dataset.liveDebugInit === '1') return;
  toggle.dataset.liveDebugInit = '1';

  const debugPanel = output.closest('.debug-log');
  const settingsWrap = output.closest('.settings-wrap');

  let open = false;
  let unsubscribe = null;

  const stopTail = () => {
    if (unsubscribe) {
      try { unsubscribe(); } catch (_) {}
      unsubscribe = null;
    }
    try { window.diag.stopTail(); } catch (_) {}
  };

  const setOpenState = (next) => {
    open = !!next;
    output.classList.toggle('hidden', !open);
    debugPanel?.classList.toggle('live-open', open);
    settingsWrap?.classList.toggle('live-debug-open', open);
    toggle.textContent = open ? 'Close Live Debug' : 'Show Live Debug';
  };

  const appendLine = (line) => {
    if (!open) return;
    const stickToBottom = isLogNearBottom(output);
    appendStyledLogChunk(output, line, {
      stickToBottom,
      maxLines: MAX_LOG_LINES,
      maxLineLength: 160
    });
    output.classList.remove('empty');
  };

  const openPanel = async () => {
    setOpenState(true);
    appendStyledLogChunk(output, '', {
      replace: true,
      stickToBottom: true,
      maxLines: MAX_LOG_LINES,
      maxLineLength: 160
    });
    output.classList.add('empty');

    try {
      const recent = await window.diag.recentTail(MAX_LOG_LINES);
      if (recent) {
        appendStyledLogChunk(output, recent, {
          replace: true,
          stickToBottom: true,
          maxLines: MAX_LOG_LINES,
          maxLineLength: 160
        });
        if ((output.textContent || '').trim()) {
          output.classList.remove('empty');
        }
      }
    } catch (_) {}

    stopTail();
    unsubscribe = window.diag.onData(appendLine);
    try { window.diag.startTail(); } catch (_) {}
  };

  const closePanel = () => {
    setOpenState(false);
    stopTail();
  };

  toggle.addEventListener('click', () => {
    if (open) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    if (tab.dataset.liveDebugCloseWired === '1') return;
    tab.dataset.liveDebugCloseWired = '1';
    tab.addEventListener('click', () => {
      if ((tab.dataset.tab || '') !== 'settings') closePanel();
    });
  });
}

const COMPACT_ICON_EXPAND = 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z';
const COMPACT_ICON_COLLAPSE = 'M10 10H4V8h4V4h2v6zm4 0V4h2v4h4v2h-6zm-4 4v6H8v-4H4v-2h6zm10 0v2h-4v4h-2v-6h6z';

function updateCompactToggleUI(isCompact) {
  const button = $('ic-compact');
  const path = $('p-compact');
  if (!button || !path) return;

  if (isCompact) {
    path.setAttribute('d', COMPACT_ICON_EXPAND);
    button.title = 'Expand wallet';
    button.setAttribute('aria-label', 'Expand wallet');
  } else {
    path.setAttribute('d', COMPACT_ICON_COLLAPSE);
    button.title = 'Compact wallet';
    button.setAttribute('aria-label', 'Compact wallet');
  }
}

function syncCompactWidgetValues() {
  const mainBalance = $('big-balance');
  const widgetBalance = $('widget-balance');
  if (mainBalance && widgetBalance) {
    widgetBalance.innerHTML = mainBalance.innerHTML || mainBalance.textContent || '-';
  }

  const mainStaking = $('staking');
  const widgetStaking = $('widget-staking');
  if (mainStaking && widgetStaking) {
    widgetStaking.textContent = mainStaking.textContent || '0';
  }

  const pendingLine = $('pending-line');
  const widgetPending = $('widget-pending');
  const pendingAmount = $('pending-amt');
  const widgetPendingAmount = $('widget-pending-amt');
  if (widgetPending && widgetPendingAmount) {
    const pendingVisible = !!pendingLine && !pendingLine.classList.contains('hidden');
    const amountText = pendingAmount?.textContent || '0';
    widgetPending.classList.toggle('hidden', !pendingVisible);
    widgetPendingAmount.textContent = amountText;
  }
}

function setCompactModeState(isCompact, options = {}) {
  const persist = options.persist !== false;
  const refitBalance = options.refitBalance !== false;

  document.body.classList.toggle('compact-mode', !!isCompact);
  updateCompactToggleUI(!!isCompact);

  if (isCompact) {
    syncCompactWidgetValues();
  }

  if (!isCompact && refitBalance) {
    requestAnimationFrame(() => requestAnimationFrame(() => fitBalance()));
    setTimeout(() => fitBalance(), 250);
  }

  if (persist) {
    try {
      localStorage.setItem('ioc-compact-mode', isCompact ? '1' : '0');
    } catch (_) {}
  }
}

async function toggleCompactMode() {
  const wasCompact = document.body.classList.contains('compact-mode');
  const nextCompact = !wasCompact;

  setCompactModeState(nextCompact, { persist: true, refitBalance: true });

  if (!window.ioc?.setCompactMode) return;
  try {
    await window.ioc.setCompactMode(nextCompact);
  } catch (error) {
    console.warn('[compact] Failed to sync window mode with main process:', error?.message || error);
    setCompactModeState(wasCompact, { persist: true, refitBalance: true });
  }
}

function initCompactMode() {
  const button = $('ic-compact');
  if (!button || button.dataset.compactInit === '1') return;
  button.dataset.compactInit = '1';

  const initialCompact = document.body.classList.contains('compact-mode');
  setCompactModeState(initialCompact, { persist: false, refitBalance: false });

  button.addEventListener('click', () => {
    toggleCompactMode();
  });

  if (window.ioc?.onCompactModeChanged) {
    window.ioc.onCompactModeChanged((isCompact) => {
      setCompactModeState(!!isCompact, { persist: true, refitBalance: true });
    });
  }

  const watchNode = (node) => {
    if (!node) return;
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains('compact-mode')) {
        syncCompactWidgetValues();
      }
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
  };

  watchNode($('big-balance'));
  watchNode($('staking'));
  watchNode($('pending-line'));
  watchNode($('pending-amt'));
}

