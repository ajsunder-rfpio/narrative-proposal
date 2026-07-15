-- Grant the graph tables to service_role only.
--
-- The edge functions reach the graph via the trusted service_role client (only
-- after the handler has authenticated the caller). service_role BYPASSes RLS,
-- but PostgREST still enforces table-level privileges — and the graph tables
-- were created RLS-deny-by-default with no grants, so service_role hit
-- "permission denied for table pursuits".
--
-- This grants the required privileges to service_role ONLY. anon and
-- authenticated get nothing; RLS stays deny-by-default (no policies added), so
-- the tables remain unreachable with the publishable/anon or a user token.

grant usage on schema public to service_role;

-- The public schema holds exactly the graph tables (see 0001), so this covers
-- them: pursuits, intake_sources, requirements, requirement_mappings,
-- outline_nodes, sections, section_revisions, win_themes, claims, citations,
-- assets, passages, generation_records, pursuit_snapshots, evaluator_reports,
-- pursuit_contexts, id_state.
grant select, insert, update, delete
  on all tables in schema public
  to service_role;

-- Keep the pattern working for graph tables added by future migrations without
-- re-granting each time. Still service_role only.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
