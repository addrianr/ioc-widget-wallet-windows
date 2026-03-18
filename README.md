# IOC Widget Wallet

![IOC Widget Wallet](assets/IOCoin_Widget_Wallet.png)

Minimal Electron wallet for **I/O Coin (IOC)**.
Provides a lightweight GUI to interact with `iocoind`.

**Supported Platforms:**
- macOS arm64 (Apple Silicon)
- macOS x64 (Intel)
- Windows x64 (Windows 10/11)
- Linux x64 (AppImage, deb)

---

## Before You Install

**Back up your existing wallet data before installing or running this application.** If you have an existing I/O Coin wallet (legacy or otherwise), copy the entire data directory to a safe location first:

- **macOS:** `~/Library/Application Support/IOCoin/`
- **Windows:** `%APPDATA%\IOCoin\`
- **Linux:** `~/.iocoin/`

At minimum, back up `wallet.dat` — but copying the full directory ensures you can restore everything if needed. Store the backup on a separate drive or external media. This applies to fresh installs, upgrades, and switching between wallet versions.

---

## Download & Install

Download the latest release from [GitHub Releases](https://github.com/Wizrig/ioc-widget-wallet/releases/latest).

SHA256 checksums are published alongside each installer for verification.

### macOS

1. Open the downloaded `.dmg` file
2. Drag **IOC Widget Wallet** to your **Applications** folder
3. On first launch macOS may show "downloaded from the internet" prompt — click **Open** (the app is signed and notarized by Apple)
4. The wallet will auto-detect or prompt to install `iocoind`

### Windows

The IOCoin daemon requires the **Microsoft Visual C++ Redistributable (x64)**. Most Windows systems already have it, but if the wallet fails to start the daemon, install it from [Microsoft's download page](https://aka.ms/vs/17/release/vc_redist.x64.exe).

1. Run the downloaded `.exe` installer
2. Follow the setup wizard
3. Windows SmartScreen may appear on first run depending on signing — click **More info** then **Run anyway**

### Linux

AppImage requires FUSE. Most distributions include it by default, but on Fedora you may need:
```bash
sudo dnf install fuse fuse-libs
```

**AppImage:**
```bash
chmod +x IOC.Widget.Wallet-*.AppImage
./IOC.Widget.Wallet-*.AppImage
```

**Debian/Ubuntu (.deb):**
```bash
sudo dpkg -i ioc-widget-wallet_*.deb
```

---

## Installation Modes

### Easy Mode (Recommended)
On first run with no existing blockchain data, the wallet offers to download a bootstrap archive. This allows fast sync — the bootstrap is downloaded, extracted, and applied automatically. After bootstrap, the wallet syncs remaining blocks from the network.

### Expert Mode
Skip the bootstrap prompt to perform a clean sync from the network. The wallet will sync the entire blockchain from scratch (slower but fully trustless).

---

## Wallet Features

- **Automatic daemon management** — starts `iocoind` on launch or attaches to an already-running instance; prevents double-spawn via PID tracking
- **Close Wallet Completely** — stops the daemon reliably and exits
- **Close UI Only** — fully closes the Electron frontend while leaving the daemon running in the background; relaunching the wallet attaches to the running daemon
- **Runtime warmup display** — shows "Loading daemon..." on startup, then "Loading daemon... this may take a few minutes" after 8 seconds, and "Loading blockchain index..." after 1 minute if the wallet has not fully loaded
- **Bootstrap flow** — download, extract, and apply bootstrap archive with progress display, then continue syncing from the network
- **Sync progress** — displays current block height vs network tip with adaptive polling intervals
- **Balance display** — shows wallet balance immediately once daemon responds
- **Staking display** — shows staking amount (not weight) with correct rules: greyed out when no coins are available
- **Lock / Unlock**
  - Wrong password: shakes the password prompt and shows "Wrong passphrase" — does not shake the lock icon
  - Correct password: unlocks immediately with no shake and no false error
  - Locking works immediately after unlock with instant UI feedback
- **Wallet encryption** — unencrypted wallets show a grey lock icon with prompt to encrypt; encryption flow restarts the daemon automatically
- **Send IOC** — send flow prompts to unlock if wallet is locked
- **Address book** — editable labels (click to rename), click-to-copy addresses, hover to see per-address balance
- **Compact widget mode** — minimize to a small always-on-top widget showing live balance and staking
- **Backup tools** — dump, import, open default data path, backup wallet.dat
- **Debug tools** — start/stop live debug log tail
- **Reduced polling load** — RPC calls are serialized through a queue to avoid flooding the daemon; user-initiated actions (lock/unlock) bypass the queue for instant response
- **Security** — PID tracking for app-started daemon only; no unsafe process killing; safe attach logic for externally-started daemons
- **Checksums** — SHA256 checksums published for all release binaries

---

## Release Notes (v0.1.0 — RC8)

### Sync & Startup
- Real-time splash sync — block height reads directly from `debug.log`, matches live chain progress exactly
- Fast splash loading — remote tip fetch moved to background, no longer stalls the sync display
- Reliable splash dismiss — three fallback conditions prevent the splash screen from getting stuck
- Progressive warmup messages — "Loading daemon...", "this may take a few minutes", "Loading blockchain index..."

### Send & Receive
- Send errors displayed inline with shake feedback (insufficient funds, daemon errors)
- "Unlock wallet to send" prompt shown inside send modal when wallet is locked

### Lock / Unlock
- Instant lock/unlock response — UI updates immediately, not overwritten by stale polling
- Wrong password shakes the input field only — correct password never triggers a false shake

### Balance & Display
- Balance auto-scales from large to small amounts without overflow
- Balance updates every poll cycle — no stale values after send or receive
- Widget mode balance stays in sync with main wallet

### Address Book
- Near-instant loading — no longer uses slow RPC calls
- Editable labels, per-address balance on hover, click-to-copy
- Hides unused keypool addresses

### Daemon Management
- Reliable daemon restart after wallet encryption
- "Close Wallet Completely" stops daemon and exits; "Close UI Only" leaves daemon running
- Double-spawn prevention via PID tracking
- All RPC over HTTP JSON-RPC with serialized queue; user actions bypass queue for instant response

### Platform Fixes
- **macOS:** signed and notarized DMG installer
- **Windows:** bootstrap extraction via PowerShell; handles missing VC++ runtime gracefully
- **Linux:** fixed daemon install permission on AppImage (FUSE mount)

---

## Development / Build from Source

### Prerequisites

- Node.js (v16 or higher)
- npm
- Platform daemon runtime

### Clone and Install

```bash
git clone https://github.com/Wizrig/ioc-widget-wallet.git
cd ioc-widget-wallet
npm install
```

### Daemon Runtime Inputs

The Electron app bundles the IOCoin daemon from paths provided at build time.
Windows builds must package the full daemon runtime directory, not only `iocoind.exe`.

- `IOC_DAEMON_WIN_DIR`: folder containing `iocoind.exe` and every required DLL/runtime sidecar
- `IOC_DAEMON_MAC_PATH`: path to the macOS daemon payload
- `IOC_DAEMON_LINUX_PATH`: path to the Linux daemon payload

If a required variable is missing, the corresponding build now fails early instead of producing a broken installer.

### Run in Development Mode

```bash
npm run dev
```

### Build for Production

**macOS:**
```bash
export IOC_DAEMON_MAC_PATH=/path/to/iocoind
npm run build:mac
```

**Windows:**
```powershell
$env:IOC_DAEMON_WIN_DIR='C:\path\to\ioc-win64-runtime'
npm run build:win
```

The folder referenced by `IOC_DAEMON_WIN_DIR` must include `iocoind.exe` plus all DLL dependencies required by that build.

**Linux:**
```bash
export IOC_DAEMON_LINUX_PATH=/path/to/iocoind
npm run build:linux
```

---

## License

See [LICENSE](LICENSE) file for details.

---

## Contributing

This is a widget-style wallet for I/O Coin. Contributions and feedback are welcome.
