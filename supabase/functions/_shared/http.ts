// HTTP 工具：CORS、JSON 响应、环境变量
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 浏览器可访问的 Supabase 地址，用于拼接支付返回页。
 * 云端与 SUPABASE_URL 相同；本地运行时 SUPABASE_URL 是容器内地址（http://kong:8000），
 * 需设置 PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 */
export function publicUrl(): string {
  return (Deno.env.get('PUBLIC_SUPABASE_URL') || env('SUPABASE_URL')).replace(/\/$/, '');
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}
