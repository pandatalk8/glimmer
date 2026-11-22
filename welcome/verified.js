// 邮箱验证结果页。验证邮件里的链接先打开后端的返回地址，扩展把那个标签页换成本页，
// 只带上错误类型（不带登录令牌）。云端 Supabase 不允许在 supabase.co 上托管网页，所以结果在扩展里显示。
const q = new URLSearchParams(location.search);
const error = q.get('error_code') || q.get('error');
const $ = (id) => document.getElementById(id);

if (error) {
  $('result').classList.add('err');
  $('icon').textContent = '!';
  if (error === 'otp_expired' || error === 'access_denied') {
    $('title').textContent = '验证链接已失效';
    $('text').textContent =
      '这个链接已过期或已经用过（有的邮箱会自动预先打开链接，邮箱其实可能已经验证成功）。请先在面板里直接登录；如果提示“邮箱尚未验证”，在登录页点“免费注册”用同一邮箱重新注册，会收到新的验证邮件。';
  } else {
    $('title').textContent = '邮箱验证没有完成';
    $('text').textContent = '请回到面板重新登录或重新注册；仍然不行时，把下面的错误信息发给我们。';
  }
  const desc = q.get('error_description');
  if (desc) {
    $('detail').hidden = false;
    $('detail').textContent = '错误信息：' + desc;
  }
}

$('close').onclick = async () => {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id != null) chrome.tabs.remove(tab.id);
  else window.close();
};
