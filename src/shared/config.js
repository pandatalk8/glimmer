// 后端配置：Supabase 项目地址与 anon key
// 在 Supabase 后台 Project Settings → API 中复制。anon key 本身就是公开的（数据安全靠 RLS），可以随扩展发布。
// 不要在这里填写 service_role key 或 Stripe 密钥。
export const BACKEND = {
  supabaseUrl: '', // 例：https://abcdefghijklm.supabase.co
  supabaseAnonKey: '',
};
