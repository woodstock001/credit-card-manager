-- ============================================================
-- 记账功能：日常收支流水
-- 在 Supabase 后台 SQL Editor 里整段跑一次即可，不影响已有数据
-- ============================================================

create table if not exists public.ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date    date not null default current_date,      -- 发生日期
  kind          text not null default 'out',             -- out 支出 / in 收入
  amount_cents  bigint not null default 0,               -- 金额，单位「分」
  category      text not null default '其他',            -- 分类
  note          text,                                    -- 备注
  created_at    timestamptz not null default now()
);

-- 按用户 + 日期查得快
create index if not exists ledger_user_date_idx on public.ledger (user_id, entry_date desc);

-- 行级安全：只能看自己、改自己
alter table public.ledger enable row level security;

drop policy if exists p_sel on public.ledger;
drop policy if exists p_ins on public.ledger;
drop policy if exists p_upd on public.ledger;
drop policy if exists p_del on public.ledger;

create policy p_sel on public.ledger for select using (auth.uid() = user_id);
create policy p_ins on public.ledger for insert with check (auth.uid() = user_id);
create policy p_upd on public.ledger for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy p_del on public.ledger for delete using (auth.uid() = user_id);
