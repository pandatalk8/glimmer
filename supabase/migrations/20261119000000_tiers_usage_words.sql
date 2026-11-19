-- 微光翻译：三档会员、AI 用量、生词本云同步
-- 会员等级：free（免费）/ premium（无限生词本、云同步、DeepL / Microsoft）/ premium_plus（再加全部大模型）

-- ---------- 会员等级 ----------
-- 旧版只有 free / pro；pro 原本包含全部功能，迁移为 premium_plus
alter table public.profiles drop constraint if exists profiles_plan_check;
update public.profiles set plan = 'premium_plus' where plan = 'pro';
alter table public.profiles
  add constraint profiles_plan_check check (plan in ('free', 'premium', 'premium_plus'));

-- 当前用户是否为会员（供 RLS 使用）；security definer：读取 profiles 不受调用者 RLS 限制
create or replace function public.is_member(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = uid and plan in ('premium', 'premium_plus')
  );
$$;

-- ---------- 用量：按自然月统计 ----------
create table if not exists public.usage_monthly (
  user_id uuid not null references auth.users (id) on delete cascade,
  month text not null, -- 'YYYY-MM'（UTC）
  tokens bigint not null default 0, -- 大模型 Token
  chars bigint not null default 0, -- 机器翻译（DeepL / Microsoft）字符数
  requests integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.usage_monthly enable row level security;

drop policy if exists "usage_select_own" on public.usage_monthly;
create policy "usage_select_own" on public.usage_monthly
  for select to authenticated
  using ((select auth.uid()) = user_id);
-- 不开放写入：只有翻译函数（service role）通过 add_usage 累加

-- 原子累加用量，返回累加后的本月 Token 数
create or replace function public.add_usage(p_user uuid, p_month text, p_tokens bigint, p_chars bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  total bigint;
begin
  insert into public.usage_monthly as u (user_id, month, tokens, chars, requests)
  values (p_user, p_month, p_tokens, p_chars, 1)
  on conflict (user_id, month) do update
    set tokens = u.tokens + excluded.tokens,
        chars = u.chars + excluded.chars,
        requests = u.requests + 1,
        updated_at = now()
  returning tokens into total;
  return total;
end;
$$;

revoke all on function public.add_usage(uuid, text, bigint, bigint) from public, anon, authenticated;

-- ---------- 生词本云同步（会员功能） ----------
create table if not exists public.words (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null, -- 小写去空格后的单词，用于去重
  w text not null,
  t text not null default '',
  url text not null default '',
  ts bigint not null default 0, -- 收藏时间（毫秒）
  m boolean not null default false, -- 是否已掌握
  deleted boolean not null default false, -- 墓碑：删除也要同步到其他设备
  updated_at bigint not null default 0, -- 最后修改时间（毫秒，客户端时钟），合并时较新的为准
  primary key (user_id, key)
);

alter table public.words enable row level security;

-- 只有会员能读写自己的云端生词本；会员到期后云端数据保留，但无法读取，续费后恢复
drop policy if exists "words_select_member" on public.words;
create policy "words_select_member" on public.words
  for select to authenticated
  using ((select auth.uid()) = user_id and public.is_member((select auth.uid())));

drop policy if exists "words_insert_member" on public.words;
create policy "words_insert_member" on public.words
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.is_member((select auth.uid())));

drop policy if exists "words_update_member" on public.words;
create policy "words_update_member" on public.words
  for update to authenticated
  using ((select auth.uid()) = user_id and public.is_member((select auth.uid())))
  with check ((select auth.uid()) = user_id and public.is_member((select auth.uid())));
