-- AI 点数与 DeepL / Microsoft 字符额度（决策 D1、发布计划 2.3；成本测算见 docs/backend.md 第十节）
-- tokens：大模型原始 Token（用于成本核算）；points：按引擎加权后的 AI 点数（用于 Premium+ 额度）；chars：机器翻译字符（用于字符额度）

alter table public.usage_monthly add column if not exists points bigint not null default 0;

-- 旧数据按 1 倍折算为点数
update public.usage_monthly set points = tokens where points = 0 and tokens > 0;

-- 原子累加用量，返回累加后的本月点数与字符数
create or replace function public.add_usage_points(p_user uuid, p_month text, p_tokens bigint, p_chars bigint, p_points bigint)
returns table (total_points bigint, total_chars bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  insert into public.usage_monthly as u (user_id, month, tokens, chars, points, requests)
  values (p_user, p_month, p_tokens, p_chars, p_points, 1)
  on conflict (user_id, month) do update
    set tokens = u.tokens + excluded.tokens,
        chars = u.chars + excluded.chars,
        points = u.points + excluded.points,
        requests = u.requests + 1,
        updated_at = now()
  returning u.points, u.chars;
end;
$$;

revoke all on function public.add_usage_points(uuid, text, bigint, bigint, bigint) from public, anon, authenticated;
