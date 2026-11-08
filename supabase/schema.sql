-- ============================================================
-- 信用卡管家 · Supabase 建表脚本
-- 用法：Supabase 控制台 → SQL Editor → 粘贴全文 → Run
-- 金额单位统一为「分」(bigint)，避免浮点误差
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- 1. 信用卡 ----------
create table if not exists public.credit_cards (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bank              text not null,
  alias             text,
  last4             text,
  credit_limit_cents bigint not null default 0,
  bill_day          int  default 5,
  due_day           int  default 23,
  auto_pay          boolean not null default false,
  is_active         boolean not null default true,
  note              text,
  created_at        timestamptz not null default now()
);

-- ---------- 2. 信用卡账单 ----------
create table if not exists public.bills (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id      uuid not null references public.credit_cards(id) on delete cascade,
  period       text not null,                 -- 账期 YYYY-MM
  amount_cents bigint not null default 0,     -- 账单金额
  min_cents    bigint not null default 0,     -- 最低还款
  paid_cents   bigint not null default 0,     -- 已还金额
  due_date     date,                          -- 到期还款日
  status       text not null default 'unpaid',-- unpaid / partial / paid
  note         text,
  created_at   timestamptz not null default now(),
  unique (card_id, period)
);

-- ---------- 3. 还款记录 ----------
create table if not exists public.repayments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id      uuid not null references public.credit_cards(id) on delete cascade,
  bill_id      uuid references public.bills(id) on delete set null,
  period       text,
  amount_cents bigint not null,
  paid_at      date not null,
  method       text,
  note         text,
  created_at   timestamptz not null default now()
);

-- ---------- 4. 固定月供（房贷 / 房租 / 其他） ----------
create table if not exists public.fixed_payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null,
  type         text not null default 'mortgage', -- mortgage / rent / other
  pay_day      int  not null default 1,          -- 每月几号扣款 1-31
  amount_cents bigint not null,
  start_period text,                             -- 开始年月 YYYY-MM，可空
  end_period   text,                             -- 结束年月 YYYY-MM，可空
  auto_pay     boolean not null default true,
  remind_days  int not null default 5,
  is_active    boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

-- ---------- 5. 月供还款记录 ----------
create table if not exists public.fixed_payment_records (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fixed_payment_id uuid not null references public.fixed_payments(id) on delete cascade,
  period           text not null,
  due_date         date not null,
  due_cents        bigint not null,
  paid_cents       bigint,
  paid_at          date,
  status           text not null default 'pending', -- pending / paid
  note             text,
  created_at       timestamptz not null default now(),
  unique (fixed_payment_id, period)
);

-- ---------- 索引 ----------
create index if not exists idx_bills_card      on public.bills(card_id);
create index if not exists idx_bills_user      on public.bills(user_id);
create index if not exists idx_reps_card       on public.repayments(card_id);
create index if not exists idx_reps_user       on public.repayments(user_id);
create index if not exists idx_fixed_user      on public.fixed_payments(user_id);
create index if not exists idx_frec_fixed      on public.fixed_payment_records(fixed_payment_id);

-- ============================================================
-- 行级安全 RLS：每个账号只能看到自己的数据
-- ============================================================
alter table public.credit_cards           enable row level security;
alter table public.bills                  enable row level security;
alter table public.repayments             enable row level security;
alter table public.fixed_payments         enable row level security;
alter table public.fixed_payment_records  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['credit_cards','bills','repayments','fixed_payments','fixed_payment_records']
  loop
    execute format('drop policy if exists p_sel on public.%I', t);
    execute format('drop policy if exists p_ins on public.%I', t);
    execute format('drop policy if exists p_upd on public.%I', t);
    execute format('drop policy if exists p_del on public.%I', t);

    execute format('create policy p_sel on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy p_ins on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy p_upd on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy p_del on public.%I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;
