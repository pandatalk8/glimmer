// 当前可用的付费翻译引擎（公开、无需登录）：服务器配置了对应 API Key、且未被 DISABLED_ENGINES 暂停。
// 插件只展示这里返回的付费引擎；Google 翻译由浏览器直连，始终可用，不在此列。
// GET → { engines: ['deepl', 'deepseek', …] }
import { corsHeaders, json } from '../_shared/http.ts';
import { availableEngines, disabledEngines } from '../_shared/translate.ts';

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') return json({ error: '仅支持 GET' }, 405);
  const engines = availableEngines((n) => Deno.env.get(n), disabledEngines(Deno.env.get('DISABLED_ENGINES')));
  return new Response(JSON.stringify({ engines }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
});
