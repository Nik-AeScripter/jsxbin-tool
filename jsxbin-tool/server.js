const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');

const app = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ─── jsxer binary setup ────────────────────────────────────────────────────

const JSXER_VERSION = 'v1.7.4';
const JSXER_BASE_URL = `https://github.com/AngeloD2022/jsxer/releases/download/${JSXER_VERSION}`;

const JSXER_ASSETS = {
  'darwin-arm64': 'jsxer-macos-arm64',
  'darwin-x64':  'jsxer-macos-x64',
  'win32-x64':   'jsxer-windows-x64.exe',
  'win32-ia32':  'jsxer-windows-x86.exe',
  'linux-x64':   'jsxer-linux-x64',
};

function getBinaryName() {
  const key = `${process.platform}-${process.arch}`;
  return JSXER_ASSETS[key] || null;
}

function getBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(__dirname, 'bin', `jsxer${ext}`);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      https.get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    request(url);
  });
}

async function ensureBinary() {
  const binPath = getBinaryPath();
  if (fs.existsSync(binPath)) return binPath;

  const assetName = getBinaryName();
  if (!assetName) {
    throw new Error(`No prebuilt jsxer binary for ${process.platform}-${process.arch}. Build from source: https://github.com/AngeloD2022/jsxer`);
  }

  console.log(`📦 Downloading jsxer ${JSXER_VERSION} (${assetName})...`);
  fs.mkdirSync(path.join(__dirname, 'bin'), { recursive: true });

  const url = `${JSXER_BASE_URL}/${assetName}`;
  await downloadFile(url, binPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  console.log(`✅ jsxer downloaded to ${binPath}`);
  return binPath;
}

// ─── Routes ────────────────────────────────────────────────────────────────

// Status endpoint — reports binary availability
app.get('/status', async (req, res) => {
  const binPath = getBinaryPath();
  const exists = fs.existsSync(binPath);
  const platform = `${process.platform}-${process.arch}`;
  const supported = !!getBinaryName();
  res.json({ ready: exists, platform, supported, version: JSXER_VERSION });
});

// Download binary on demand
app.post('/setup', async (req, res) => {
  try {
    await ensureBinary();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Decode: JSXBin → JSX
app.post('/decode', upload.single('file'), async (req, res) => {
  try {
    const binPath = getBinaryPath();
    if (!fs.existsSync(binPath)) {
      return res.status(400).json({ error: 'jsxer binary not set up. Click "Setup" first.' });
    }

    let inputContent = req.file
      ? fs.readFileSync(req.file.path, 'utf8')
      : req.body.content;

    if (!inputContent) return res.status(400).json({ error: 'No input provided.' });

    const tmpInput = path.join(os.tmpdir(), `jsxer_in_${Date.now()}.jsxbin`);
    fs.writeFileSync(tmpInput, inputContent.trim());

    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }

    // jsxer outputs to a .jsx file next to the input file
    const tmpOutput = tmpInput.replace('.jsxbin', '.jsx');

    execFile(binPath, [tmpInput], { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpInput); } catch (e) {}

      // Check if jsxer wrote an output file (its default behaviour)
      let result = null;
      if (fs.existsSync(tmpOutput)) {
        result = fs.readFileSync(tmpOutput, 'utf8');
        try { fs.unlinkSync(tmpOutput); } catch (e) {}
      }

      // Fall back to stdout if no file produced
      if (!result && stdout) {
        // Strip jsxer's [i] log lines, keep actual code
        const lines = stdout.split('\n').filter(l => !l.startsWith('[i]') && !l.startsWith('[!]') && !l.startsWith('[E]'));
        result = lines.join('\n').trim();
      }

      if (result && result.length > 0) {
        res.json({ success: true, result });
      } else {
        const errMsg = stderr || (err && err.message) || 'Unknown error';
        res.json({ success: false, error: errMsg });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  JSXBin Tool running → http://localhost:${PORT}\n`);
  console.log('   Open this URL in your browser. Press Ctrl+C to stop.\n');
  // Auto-download binary on startup if not present
  if (!fs.existsSync(getBinaryPath())) {
    ensureBinary().catch(e => console.warn('⚠️  Auto-download failed:', e.message));
  }
});