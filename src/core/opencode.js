// OpenCode 二进制管理与 `opencode serve` 生命周期
//
// 背景（重要）：OpenCode 的免费模型只能通过 opencode 客户端访问 Zen 网关，
// 直接调网关会被拒绝（实测返回 Internal server error）。所以本应用必须在
// 本地跑一个隔离的 opencode serve，再把它转成 OpenAI 兼容接口。
// 这与 ow-bridge 的架构一致（"通过隔离的 OpenCode"）。
//
// 二进制获取顺序：
//  1. 系统 PATH 里的 opencode；
//  2. 本应用数据目录已缓存的；
//  3. 从 npm registry 直接下载对应平台的二进制包（不需要本机装 Node/npm）；
//  4. 兜底：npm install opencode-ai（需要本机有 npm）。
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net'); // isPortFree 用
const path = require('path');
const http = require('http');
const https = require('https');
const tar = require('tar');
const paths = require('./paths');

const SERVE_HOST = '127.0.0.1';
const SERVE_TIMEOUT_MS = 120000; // Windows 首次启动可能被安全软件扫描拖慢
const SERVE_PORTS = [4188, 4189, 4190, 4191, 4192];
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

function dataDir() {
  const d = paths.appDataDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function binDir() {
  const d = path.join(dataDir(), 'bin');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function binName() {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function cachedBin() {
  const p = path.join(binDir(), binName());
  return fs.existsSync(p) ? p : null;
}

function logDir() {
  const d = path.join(dataDir(), 'logs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function pkgDir() {
  return path.join(dataDir(), 'oc-pkg');
}

// 隔离的 opencode 配置文件：通过 OPENCODE_CONFIG 环境变量指定。
// 注意：OPENCODE_CONFIG 必须是文件路径（或不存在），指向目录会导致
// serve 的 /config/providers 等接口 500（EISDIR）。文件本身不需要存在。
function ocConfigDir() {
  const d = path.join(dataDir(), 'opencode-config');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'opencode.json');
}

// 平台 → npm 上的二进制包名
function platformPkg() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'opencode-windows-x64';
  if (p === 'win32' && a === 'arm64') return 'opencode-windows-arm64';
  if (p === 'darwin' && a === 'arm64') return 'opencode-darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'opencode-darwin-x64';
  if (p === 'linux' && a === 'x64') return 'opencode-linux-x64';
  if (p === 'linux' && a === 'arm64') return 'opencode-linux-arm64';
  return null;
}

// ---- 下载：优先 curl（自带代理/重定向/重试，最稳），兜底 Node https ----

function hasCurl() {
  return new Promise((resolve) => {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFile(curl, ['--version'], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

function curlFetch(url, { dest, onProgress, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const args = ['-fSL', '--retry', '2', '--connect-timeout', '20',
      '--max-time', String(Math.ceil(timeoutMs / 1000))];
    if (dest) args.push('--progress-bar', '-o', dest);
    else args.push('-sS');
    args.push(url);
    const child = spawn(curl, args, {
      stdio: dest ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let errOut = '';
    let lastPct = -1;
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => {
      errOut += d;
      if (onProgress) {
        const m = errOut.match(/(\d{1,3}(?:\.\d+)?)%/g);
        if (m) {
          const pct = Math.floor(parseFloat(m[m.length - 1]));
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
      }
    });
    child.on('error', (e) => reject(new Error(`无法执行 curl：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(dest ? undefined : out);
      else reject(new Error(`curl 下载失败 (exit ${code}): ${(errOut || out).slice(-300).trim()}`));
    });
  });
}

// Node 原生 https（无 curl 时的兜底；直连）
function httpsGetRaw(url, timeoutMs = 30000, _depth = 0) {
  return new Promise((resolve, reject) => {
    if (_depth > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetRaw(new URL(res.headers.location, url).toString(), timeoutMs, _depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
  });
}

function nodeDownload(url, dest, onProgress) {
  return httpsGetRaw(url, 120000).then((res) => new Promise((resolve, reject) => {
    const total = Number(res.headers['content-length']) || 0;
    let done = 0;
    let lastPct = -1;
    const file = fs.createWriteStream(dest);
    res.on('data', (c) => {
      done += c.length;
      if (total && onProgress) {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    });
    res.on('error', (e) => { file.destroy(); reject(e); });
    file.on('error', reject);
    file.on('finish', () => file.close(resolve));
    res.pipe(file);
  }));
}

async function fetchJson(url, timeoutMs = 30000) {
  if (await hasCurl()) {
    const text = await curlFetch(url, { timeoutMs });
    return JSON.parse(text);
  }
  const res = await httpsGetRaw(url, timeoutMs);
  const body = await new Promise((resolve, reject) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve(b));
    res.on('error', reject);
  });
  return JSON.parse(body);
}

async function downloadFile(url, dest, onProgress) {
  if (await hasCurl()) {
    return curlFetch(url, { dest, onProgress });
  }
  return nodeDownload(url, dest, onProgress);
}

// ---- 二进制获取 ----

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
    const child = spawn('npm', args, { stdio: 'pipe', windowsHide: true });
    let errOut = '';
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install 失败 (exit ${code}): ${errOut.slice(-500)}`));
    });
    child.on('error', (e) => reject(new Error(`无法执行 npm（本机可能没装 Node.js）：${e.message}`)));
  });
}

function findPkgBinary() {
  const binBase = path.join(pkgDir(), 'node_modules', '.bin', 'opencode');
  const candidates = [];
  if (process.platform === 'win32') candidates.push(binBase + '.cmd', binBase);
  else candidates.push(binBase);
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
    execFile(bin, ['--version'], {
      shell: process.platform === 'win32' && /\.cmd$/i.test(bin),
      windowsHide: true,
      timeout: 30000,
    }, (err, stdout) => {
      if (err) reject(new Error(`opencode --version 执行失败: ${err.message}`));
      else resolve(stdout.trim());
    });
  });
}

// 直连下载：从 registry 取版本 → 平台二进制包 tarball → 解压出可执行文件
async function ensureBinaryDirect(registry, onProgress) {
  const pkg = platformPkg();
  if (!pkg) throw new Error(`暂不支持的平台: ${process.platform}/${process.arch}`);
  const reg = registry.replace(/\/+$/, '');
  onProgress && onProgress('正在查询 OpenCode 最新版本…');
  const meta = await fetchJson(`${reg}/opencode-ai/latest`);
  const version = meta.version;
  if (!version) throw new Error('查询版本失败');
  onProgress && onProgress(`正在下载 OpenCode ${version}…`);
  const pkgMeta = await fetchJson(`${reg}/${pkg}/latest`);
  const tarball = pkgMeta.dist && pkgMeta.dist.tarball;
  if (!tarball) throw new Error('找不到二进制包下载地址');

  const tmpTgz = path.join(dataDir(), `${pkg}-${version}.tgz`);
  await downloadFile(tarball, tmpTgz, (pct) => {
    onProgress && onProgress(`正在下载 OpenCode ${version}… ${pct}%`);
  });

  onProgress && onProgress('正在解压…');
  const tmpDir = path.join(dataDir(), `${pkg}-${version}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await tar.x({ file: tmpTgz, cwd: tmpDir });
  } catch (e) {
    throw new Error(`解压失败: ${e.message}`);
  }
  // tarball 内结构：package/bin/opencode(.exe)
  const srcBin = path.join(tmpDir, 'package', 'bin', binName());
  if (!fs.existsSync(srcBin)) throw new Error('解压后找不到可执行文件');
  const dest = path.join(binDir(), binName());
  fs.copyFileSync(srcBin, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  fs.rmSync(tmpTgz, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const ver = await checkVersion(dest);
  onProgress && onProgress(`OpenCode 就绪 (${ver})`);
  return dest;
}

// 确保有一个可用的 opencode 可执行文件，返回 { bin, source }
async function ensureBinary(onProgress) {
  const fromPath = await whichOpencode();
  if (fromPath) return { bin: fromPath, source: 'path' };

  const cached = cachedBin();
  if (cached) {
    try {
      await checkVersion(cached);
      return { bin: cached, source: 'cached' };
    } catch {
      try { fs.rmSync(cached, { force: true }); } catch { /* 忽略 */ }
    }
  }

  let lastErr = null;
  for (const reg of REGISTRIES) {
    try {
      const dest = await ensureBinaryDirect(reg, onProgress);
      return { bin: dest, source: 'downloaded' };
    } catch (e) {
      lastErr = e;
    }
  }

  // 兜底：npm 安装（需要本机有 npm）
  for (const reg of [null, 'https://registry.npmmirror.com']) {
    try {
      onProgress && onProgress(reg ? '尝试用 npm 从镜像安装 OpenCode…' : '尝试用 npm 安装 OpenCode…');
      await npmInstall(pkgDir(), reg);
      const bin = findPkgBinary();
      if (!bin) throw new Error('安装成功但找不到可执行文件');
      const ver = await checkVersion(bin);
      onProgress && onProgress(`OpenCode 就绪 (${ver})`);
      return { bin, source: 'npm' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法获取 OpenCode 可执行文件');
}

// ---- serve 生命周期 ----

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, SERVE_HOST);
  });
}

function tryStart(bin, port, onProgress) {
  return new Promise((resolve, reject) => {
    const lf = path.join(logDir(), 'opencode-serve.log');
    const log = fs.createWriteStream(lf, { flags: 'a' });
    log.write(`\n===== ${new Date().toISOString()} | ${bin} serve --port ${port} --hostname ${SERVE_HOST}\n`);

    const child = spawn(bin, ['serve', '--port', String(port), '--hostname', SERVE_HOST], {
      env: { ...process.env, OPENCODE_CONFIG: ocConfigDir() },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.cmd$/i.test(bin),
      windowsHide: true,
    });
    child.stdout.on('data', (d) => log.write(d));
    child.stderr.on('data', (d) => log.write(d));

    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { log.end(); } catch { /* 忽略 */ }
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000);
        }
      } catch { /* 忽略 */ }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stop();
      reject(err);
    };

    // 关键修复：进程崩溃/启动失败时立刻报真实错误，不再等到超时
    child.on('error', (e) => fail(new Error(`无法启动 opencode：${e.message}\n日志：${lf}`)));
    child.on('exit', (code, signal) => fail(new Error(
      `opencode serve 异常退出（code ${code}${signal ? `, ${signal}` : ''}）。\n` +
      `可能原因：被杀毒软件拦截/隔离，或缺少运行库。\n日志：${lf}`
    )));

    const start = Date.now();
    let lastNote = 0;
    const tick = () => {
      if (settled) return;
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed >= 10 && elapsed - lastNote >= 15) {
        lastNote = elapsed;
        onProgress && onProgress(`仍在等待 opencode serve 启动…（${elapsed}s，首次启动可能被安全软件扫描拖慢）`);
      }
      const req = http.get({ host: SERVE_HOST, port, path: '/global/health', timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (settled) return;
          try {
            const j = JSON.parse(body);
            if (j && (j.healthy || j.version)) {
              settled = true;
              return resolve({ baseUrl: `http://${SERVE_HOST}:${port}`, port, stop, version: j.version, logFile: lf });
            }
          } catch { /* 继续轮询 */ }
          retry();
        });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() - start > SERVE_TIMEOUT_MS) {
        return fail(new Error(
          `opencode serve 启动超时（${SERVE_TIMEOUT_MS / 1000}s）。\n` +
          `进程没有崩溃，可能是首次启动被安全软件扫描拖慢，可稍后重试；\n` +
          `也可能是网络问题导致它卡住。日志：${lf}`
        ));
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

// 启动隔离的 opencode serve，返回 { baseUrl, port, stop, version, logFile }
async function startServe(bin, preferredPort, onProgress) {
  const ports = [preferredPort, ...SERVE_PORTS.filter((p) => p !== preferredPort)];
  for (const p of ports) {
    if (await isPortFree(p)) {
      return tryStart(bin, p, onProgress);
    }
  }
  throw new Error(`端口 ${ports.join('/')} 都被占用，无法启动本地服务`);
}

module.exports = { ensureBinary, startServe, ocConfigDir, logDir, SERVE_HOST };
