// 后端配置：Supabase 项目地址与 anon key
// 在 Supabase 后台 Project Settings → API 中复制。anon key 本身就是公开的（数据安全靠 RLS），可以随扩展发布。
// 不要在这里填写 service_role key 或 Stripe 密钥。
export const BACKEND = {
  supabaseUrl: '', // 例：https://abcdefghijklm.supabase.co
  supabaseAnonKey: '',
};

// 注册页底部“服务条款”“隐私政策”的链接；留空时只显示文字，不可点击
export const TERMS = {
  terms: '',
  privacy: '',
};

// 本地开发后端：`npx supabase start` 启动的本机 Supabase。
// 公开密钥是 Supabase CLI 的固定默认值，每台开发机都一样，只能访问本机，不是机密。
// 仅当插件以“加载已解压的扩展程序”方式加载（开发版）、且上面的 BACKEND 未填写时自动使用。
export const LOCAL_DEV_BACKEND = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
};
