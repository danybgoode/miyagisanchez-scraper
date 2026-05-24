create extension if not exists pgcrypto;

create table if not exists public.marketplace_scrape_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'running',
  count_inserted integer not null default 0,
  count_skipped integer not null default 0,
  count_errors integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.marketplace_scrape_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.marketplace_scrape_runs(id) on delete cascade,
  source_platform text not null,
  source_url text,
  source_id text,
  shop_name text,
  shop_source_url text,
  listing_title text,
  listing_description text,
  price_cents integer,
  currency text default 'MXN',
  condition text,
  listing_type text not null default 'product',
  category text,
  state text,
  municipio text,
  location text,
  image_url text,
  raw_data jsonb not null default '{}'::jsonb,
  status text not null default 'collected',
  created_at timestamptz not null default now()
);

create index if not exists marketplace_scrape_run_items_run_id_idx
  on public.marketplace_scrape_run_items(run_id, created_at);

create index if not exists marketplace_scrape_run_items_source_url_idx
  on public.marketplace_scrape_run_items(source_url);

create table if not exists public.marketplace_shops (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  location text,
  logo_url text,
  clerk_user_id text,
  source text not null default 'scraped',
  source_url text,
  verified boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketplace_shops_source_url_unique
  on public.marketplace_shops(source_url)
  where source_url is not null;

create table if not exists public.marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.marketplace_shops(id) on delete set null,
  title text not null,
  description text,
  price_cents integer,
  currency text default 'MXN',
  condition text,
  listing_type text not null default 'product',
  category text,
  state text,
  municipio text,
  location text,
  images jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}'::text[],
  status text not null default 'active',
  source text not null default 'scraped',
  source_platform text,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketplace_listings_source_url_unique
  on public.marketplace_listings(source_url)
  where source_url is not null;

create table if not exists public.supply_batches (
  id uuid primary key default gen_random_uuid(),
  name text,
  source text not null default 'csv',
  params jsonb not null default '{}'::jsonb,
  status text not null default 'staged',
  total_count integer not null default 0,
  approved_count integer not null default 0,
  imported_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supply_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.supply_batches(id) on delete cascade,
  source_url text,
  title text,
  description text,
  price text,
  shop_name text,
  location text,
  state text,
  municipio text,
  image_url text,
  category text,
  listing_type text,
  condition text,
  quality_score integer not null default 0,
  status text not null default 'staged',
  import_error text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists supply_items_batch_id_idx
  on public.supply_items(batch_id, created_at);

create index if not exists supply_items_source_url_idx
  on public.supply_items(source_url);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supply-images',
  'supply-images',
  true,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.marketplace_scrape_runs enable row level security;
alter table public.marketplace_scrape_run_items enable row level security;
alter table public.marketplace_shops enable row level security;
alter table public.marketplace_listings enable row level security;
alter table public.supply_batches enable row level security;
alter table public.supply_items enable row level security;
