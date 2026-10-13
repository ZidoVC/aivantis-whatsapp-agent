-- ============================================================================
-- Aivantis platform schema (base) — as created in Supabase.
-- Multi-tenant: every domain table carries business_id (FK → business).
-- Kept here for version control. This is the schema the app currently runs against.
-- Hardening / improvements live in 002_schema_hardening.sql.
-- ============================================================================

-- Business: כל עסק שמשתמש במערכת
create table business (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text default 'Asia/Jerusalem',
  whatsapp_number text unique,
  plan text default 'starter',
  created_at timestamptz default now()
);

-- Service: שירות שהעסק מציע
create table service (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  name text not null,
  duration_min int not null,
  price numeric,
  active boolean default true,
  created_at timestamptz default now()
);

-- Staff: איש צוות בעסק
create table staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  name text not null,
  working_hours jsonb,
  created_at timestamptz default now()
);

-- Booking: תור שנקבע
create table booking (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  service_id uuid references service(id),
  staff_id uuid references staff(id),
  customer_name text,
  customer_phone text,
  start_time timestamptz not null,
  status text default 'confirmed',
  created_at timestamptz default now()
);

-- Lead: פנייה שלא הבשילה לתור
create table lead (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  customer_phone text,
  note text,
  status text default 'open',
  created_at timestamptz default now()
);

-- Conversation: שיחת וואטסאפ עם לקוח
create table conversation (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  customer_phone text,
  last_active timestamptz default now()
);

-- Message: הודעה בודדת בתוך שיחה
create table message (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversation(id) on delete cascade,
  direction text not null,
  body text,
  created_at timestamptz default now()
);

-- אינדקסים לביצועים מהירים לפי עסק
create index idx_service_business on service(business_id);
create index idx_staff_business on staff(business_id);
create index idx_booking_business on booking(business_id);
create index idx_lead_business on lead(business_id);
create index idx_conversation_business on conversation(business_id);
