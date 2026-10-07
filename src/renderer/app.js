// 控制面板逻辑：拉取主进程状态并渲染
const $ = (id) => document.getElementById(id);

let proxyUse = true;

function render(s) {
  const dot = $('status-dot');
  dot.className = 'dot ' + (s.stage === 'ready' ? 'ready' : s.stage === 'error' ? 'error' : s.stage === 'starting' ? 'starting' : 'idle');
  $('status-text').textContent = s.message || '';
  // 代理卡片
  proxyUse = !!s.useSystemProxy;
  const pdot = $('proxy-dot');
  if (s.useSystemProxy && s.sysProxy) {
    pdot.className = 'dot ready';
    $('proxy-text').textContent = '正在使用系统代理';
  } else if (s.useSystemProxy) {
    pdot.className = 'dot starting';
    $('proxy-text').textContent = '已开启，但未检测到系统代理（将直连）';
  } else {
    pdot.className = 'dot idle';
    $('proxy-text').textContent = '已关闭，直连';
  }
  $('sys-proxy').textContent = s.sysProxy || '未检测到';
  $('btn-proxy-toggle').textContent = proxyUse ? '关闭系统代理' : '开启系统代理';
  $('proxy-url').textContent = s.proxyUrl || '-';
  $('settings-path').textContent = s.settingsPath || '-';
  $('import-state').textContent = s.imported ? '已导入' : '未导入';
  $('btn-rescan').disabled = s.stage !== 'ready';
  $('btn-import').disabled = s.stage !== 'ready' || !s.models.length;
  $('btn-import').textContent = s.imported ? '重新导入到 DeepSeek Harness' : '一键导入到 DeepSeek Harness';

  $('model-count').textContent = s.models.length ? `（${s.models.length} 个可用）` : '';
  const tbody = $('model-table').querySelector('tbody');
  if (!s.models.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无可用模型，可点击「重新扫描」</td></tr>';
  } else {
    tbody.innerHTML = s.models.map((m) =>
      `<tr><td>${escapeHtml(m.name)}</td><td><code>${escapeHtml(m.modelID)}</code></td><td>${m.latencyMs != null ? m.latencyMs + ' ms' : '-'}</td></tr>`
    ).join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  try { render(await window.bridge.getState()); } catch (e) { /* 主进程忙时忽略 */ }
}

$('btn-rescan').addEventListener('click', async () => {
  $('btn-rescan').disabled = true;
  try { render(await window.bridge.rescan()); } catch (e) { await refresh(); }
});

$('btn-proxy-toggle').addEventListener('click', async () => {
  $('btn-proxy-toggle').disabled = true;
  try {
    render(await window.bridge.setProxyUse(!proxyUse));
  } catch (e) { await refresh(); }
  $('btn-proxy-toggle').disabled = false;
});

$('btn-import').addEventListener('click', async () => {
  $('btn-import').disabled = true;
  try {
    const s = await window.bridge.doImport();
    render(s);
  } catch (e) {
    await refresh();
  }
});

window.bridge.onState(render);
refresh();
