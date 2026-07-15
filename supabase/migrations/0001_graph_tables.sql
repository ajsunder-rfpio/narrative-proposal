-- Proposal graph persistence.
--
-- Each entity is stored as JSONB (`data`) with a few extracted key columns for
-- foreign keys and indexing. The GraphStore export/import seam owns
-- (de)serialization fidelity (covered in the graph test suite); this schema is
-- the durable mirror. Fully column-normalized tables are a follow-up.
--
-- Edge functions connect with the service role and bypass RLS. RLS is enabled
-- with no policies so nothing is reachable with the anon key by default.

create table if not exists pursuits (
  id          text primary key,
  org_id      text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
create index if not exists pursuits_org_id_idx on pursuits (org_id);

create table if not exists intake_sources (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists intake_sources_pursuit_idx on intake_sources (pursuit_id);

create table if not exists requirements (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists requirements_pursuit_idx on requirements (pursuit_id);

create table if not exists requirement_mappings (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists requirement_mappings_pursuit_idx on requirement_mappings (pursuit_id);

-- OutlineNode ids are permanent and never reused; provenance rides alongside.
create table if not exists outline_nodes (
  id            text primary key,
  pursuit_id    text not null references pursuits (id) on delete cascade,
  origin        text check (origin in ('agent', 'human')),
  template_key  text,
  data          jsonb not null
);
create index if not exists outline_nodes_pursuit_idx on outline_nodes (pursuit_id);

create table if not exists sections (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  node_id     text not null,
  data        jsonb not null
);
create index if not exists sections_pursuit_idx on sections (pursuit_id);

create table if not exists section_revisions (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  section_id  text not null,
  data        jsonb not null
);
create index if not exists section_revisions_section_idx on section_revisions (section_id);

create table if not exists win_themes (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists win_themes_pursuit_idx on win_themes (pursuit_id);

create table if not exists claims (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  section_id  text not null,
  data        jsonb not null
);
create index if not exists claims_section_idx on claims (section_id);

create table if not exists citations (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  claim_id    text not null,
  data        jsonb not null
);
create index if not exists citations_claim_idx on citations (claim_id);

-- Library assets/passages are org-scoped, not pursuit-scoped.
create table if not exists assets (
  id      text primary key,
  org_id  text not null,
  data    jsonb not null
);
create index if not exists assets_org_idx on assets (org_id);

create table if not exists passages (
  id        text primary key,
  asset_id  text not null references assets (id) on delete cascade,
  data      jsonb not null
);
create index if not exists passages_asset_idx on passages (asset_id);

create table if not exists generation_records (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists generation_records_pursuit_idx on generation_records (pursuit_id);

create table if not exists pursuit_snapshots (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists pursuit_snapshots_pursuit_idx on pursuit_snapshots (pursuit_id);

create table if not exists evaluator_reports (
  id          text primary key,
  pursuit_id  text not null references pursuits (id) on delete cascade,
  data        jsonb not null
);
create index if not exists evaluator_reports_pursuit_idx on evaluator_reports (pursuit_id);

create table if not exists pursuit_contexts (
  pursuit_id  text primary key references pursuits (id) on delete cascade,
  data        jsonb not null
);

-- Id-factory high-water mark + retired set, so "ids never reused" survives.
create table if not exists id_state (
  pursuit_id  text primary key references pursuits (id) on delete cascade,
  counter     bigint not null,
  retired     jsonb not null default '[]'::jsonb
);

-- Deny-by-default: only the service role (used by the edge functions) reaches
-- these tables. Add per-role policies when a client path needs direct reads.
alter table pursuits              enable row level security;
alter table intake_sources        enable row level security;
alter table requirements          enable row level security;
alter table requirement_mappings  enable row level security;
alter table outline_nodes         enable row level security;
alter table sections              enable row level security;
alter table section_revisions     enable row level security;
alter table win_themes            enable row level security;
alter table claims                enable row level security;
alter table citations             enable row level security;
alter table assets                enable row level security;
alter table passages              enable row level security;
alter table generation_records    enable row level security;
alter table pursuit_snapshots     enable row level security;
alter table evaluator_reports     enable row level security;
alter table pursuit_contexts      enable row level security;
alter table id_state              enable row level security;
