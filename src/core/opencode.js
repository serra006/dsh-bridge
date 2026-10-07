// OpenCode 二进制管理与 `opencode serve` 生命周期
//
// 策略（参考 ow-bridge 的做法）：
//  1. 先找系统 PATH 里有没有 opencode；
//  2. 没有就用 npm 安装官方包 opencode-ai 到应用数据目录（官方源失败则回退 npmmirror）；
//  3. 用隔离的 OPENCODE_CONFIG 目录启动 serve，互不干扰用户自己的 opencode 配置。
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const paths = require('./paths');

const SERVE_HOST = '127.0.0.1';

function dataDir() {
  const d = paths.appDataDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function pkgDir() {
  return path.join(dataDir(), 'oc-pkg');
}

// 隔离的 opencode 配置目录：通过 OPENCODE_CONFIG 环境变量指定
function ocConfigDir() {
  const d = path.join(dataDir(), 'opencode-config');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function whichOpencode() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['opencode'], (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null);
    });
  });
}

function npmInstall(target, registry) {
  return new Promise((resolve, reject) => {
    const args = ['install', '--no-audit', '--no-fund', '--prefix', target, 'opencode-ai'];
    if (registry) args.push(`--registry=${registry}`);
    const child = spawn('npm', args, { stdio: 'pipe' });
    let errOut = '';
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install 失败 (exit ${code}): ${errOut.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

// 在已安装的 npm 包里定位可执行文件
function findPkgBinary() {
  const binBase = path.join(pkgDir(), 'node_modules', '.bin', 'opencode');
  const candidates = [];
  if (process.platform === 'win32') candidates.push(binBase + '.cmd', binBase);
  else candidates.push(binBase);
  // 兜底：直接找包内 bin 声明
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir(), 'node_modules', 'opencode-ai', 'package.json'), 'utf8'));
    const binField = pkgJson.bin;
    const rel = typeof binField === 'string' ? binField : binField && (binField['opencode-ai'] || binField.opencode);
    if (rel) candidates.push(path.join(pkgDir(), 'node_modules', 'opencode-ai', rel));
  } catch { /* 忽略，走上面的候选 */ }
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function checkVersion(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { shell: process.platform === 'win32', timeout: 15000 }, (err, stdout) => {
      if (err) reject(new Error(`opencode --version 执行失败: ${err.message}`));
      else resolve(stdout.trim());
    });
  });
}

// 确保有一个可用的 opencode 可执行文件，返回 { bin, source }
async function ensureBinary(onProgress) {
  const fromPath = await whichOpencode();
  if (fromPath) return { bin: fromPath, source: 'path' };

  let bin = findPkgBinary();
  if (bin) {
    await checkVersion(bin);
    return { bin, source: 'bundled' };
  }

  const registries = [null, 'https://registry.npmmirror.com'];
  let lastErr = null;
  for (const reg of registries) {
    try {
      onProgress && onProgress(reg ? '正在从 npmmirror 镜像下载 OpenCode…' : '正在从官方 npm 下载 OpenCode…');
      await npmInstall(pkgDir(), reg);
      bin = findPkgBinary();
      if (!bin) throw new Error('安装成功但找不到可执行文件');
      const ver = await checkVersion(bin);
      onProgress && onProgress(`OpenCode 就绪 (${ver.trim()})`);
      return { bin, source: 'downloaded' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法获取 OpenCode 可执行文件');
}

function waitHealth(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: SERVE_HOST, port, path: '/global/health', timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && (j.healthy || j.version)) return resolve(j);
          } catch { /* 继续轮询 */ }
          retry();
        });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('opencode serve 启动超时'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

// 启动隔离的 opencode serve，返回 { baseUrl, stop }
async function startServe(bin, port) {
  const child = spawn(bin, ['serve', '--port', String(port), '--hostname', SERVE_HOST], {
    env: { ...process.env, OPENCODE_CONFIG: ocConfigDir() },
    shell: process.platform === 'win32' && /\.cmd$/i.test(bin),
    stdio: 'pipe',
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (process.platform === 'win32') {
        // Windows 下确保整个进程树被杀掉
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000);
      }
    } catch { /* 忽略 */ }
  };
  child.on('error', () => { /* 由 waitHealth 超时统一报错 */ });
  const health = await waitHealth(port).catch((e) => { stop(); throw e; });
  return { baseUrl: `http://${SERVE_HOST}:${port}`, stop, version: health.version };
}

module.exports = { ensureBinary, startServe, ocConfigDir, SERVE_HOST };
