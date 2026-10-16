const strip = document.getElementById('company-network-strip');
const text = document.getElementById('company-network-text');
const button = document.getElementById('company-network-check');
let token = '';
let busy = false;
function render(network) {
  const company = network.mode === 'company_direct';
  strip.dataset.state = network.state;
  button.hidden = !company;
  button.disabled = busy;
  button.textContent = busy ? '检查中…' : '检查出口';
  if (!company) {
    text.textContent = '公众号网络：系统模式';
    text.title = '使用系统代理设置；未启用公司固定出口保护';
    return;
  }
  const label = {verified: '出口预检通过', blocked: '已阻止同步', unchecked: '尚未检查', checking: '检查中'}[network.state] || '待检查';
  text.textContent = `公司直连 · ${label} · 要求 ${network.expected_public_ip || '配置无效'}`
    + (network.observed_public_ip ? ` · 实测 ${network.observed_public_ip}` : '');
  text.title = network.last_error || '实测为公网探测服务所见出口；每次微信请求重新检查，不自动切换代理。';
}
async function check() {
  if (busy) return;
  busy = true;
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const response = await fetch('/api/wechat/network/check', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Editor-Token': token}, body: '{}'
    });
    const network = await response.json();
    if (!network.mode) throw new Error(network.error || '检查失败，请刷新页面');
    busy = false;
    render(network);
  } catch (error) {
    text.textContent = `公众号网络检查失败：${error.message}`;
    strip.dataset.state = 'blocked';
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = '检查出口';
  }
}
button.addEventListener('click', check);
try {
  const response = await fetch('/api/editor/config');
  if (!response.ok) throw new Error('读取配置失败');
  const config = await response.json();
  token = config.csrf_token;
  render(config.network || {mode: 'system', state: 'system'});
  if (config.network?.state === 'unchecked') await check();
  setInterval(async () => {
    if (busy) return;
    try {
      const response = await fetch('/api/wechat/network', {headers: {'X-Editor-Token': token}});
      if (!response.ok) throw new Error('读取失败');
      if (!busy) render(await response.json());
    } catch {
      if (!busy) {
        text.textContent = '公众号网络状态不可用，请刷新页面';
        strip.dataset.state = 'blocked';
      }
    }
  }, 15000);
} catch (error) {
  text.textContent = `公众号网络状态不可用：${error.message}`;
  strip.dataset.state = 'blocked';
}
