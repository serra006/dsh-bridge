// 轻量状态存储：JSON 文件，记用户偏好（如退出清理开关）
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function file() {
  return path.join(paths.appDataDir(), 'state.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function save(patch) {
  const s = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

module.exports = { load, save };
