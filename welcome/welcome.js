// 首次安装的欢迎页：当场试译一段文字，三步上手，一句话说明免费与会员
import { getSettings } from '../src/shared/settings.js';
import { TARGET_LANGUAGES } from '../src/shared/languages.js';

const $ = (s) => document.querySelector(s);
const S = await getSettings();

$('#demoLang').innerHTML = TARGET_LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === S.targetLang ? 'selected' : ''}>翻译成 ${l.name}</option>`).join('');

async function demo() {
  const btn = $('#demoBtn');
  btn.disabled = true;
  btn.textContent = '翻译中…';
  const r = await chrome.runtime
    .sendMessage({ type: 'translate', engine: 'google', texts: [$('#demoSrc').textContent], to: $('#demoLang').value })
    .catch((e) => ({ ok: false, error: e.message }));
  $('#demoOut').hidden = false;
  $('#demoOut').classList.toggle('err', !r?.ok);
  $('#demoOut').textContent = r?.ok ? r.data[0] : `翻译失败：${r?.error || '请检查网络'}`;
  btn.disabled = false;
  btn.textContent = '再试一次';
}
$('#demoBtn').onclick = demo;
$('#demoLang').onchange = () => !$('#demoOut').hidden && demo();
$('#tryPage').onclick = () => chrome.tabs.create({ url: 'https://en.wikipedia.org/wiki/Reading' });
$('#openPlans').onclick = () => chrome.runtime.sendMessage({ type: 'openPremium' });
$('#openOptions').onclick = () => chrome.runtime.openOptionsPage();
