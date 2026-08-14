-- CUE Foundation Schema v1.0
-- PostgreSQL 15+ / Supabase-compatible baseline
-- Governing architecture: CUE Operational Data Architecture v1

create extension if not exists pgcrypto;

create type cue_source_type as enum ('flex','slack','email','drive','motive','cue_staffing','cue_trucking','cue_warehouse','manual','system');
create type cue_intake_status as enum ('received','normalized','needs_match','matched','needs_review','snoozed','decided','applied','verified','closed','duplicate','superseded','ignored','rejected','failed','dead_letter');
create type cue_decision_status as enum ('open','assigned','waiting','escalated','decided','executing','verified','closed');
create type cue_proposal_status as enum ('draft','proposed','approved','rejected','applied','failed','reversed');
create type cue_work_status as enum ('open','in_progress','waiting','blocked','resolved','canceled');
create type cue_work_type as enum ('task','issue','risk','missing_information','decision_required');
create type cue_readiness_status as enum ('not_started','in_progress','ready','at_risk','blocked','not_applicable','overridden');
create type cue_command_status as enum ('requested','validated','approval_required','approved','rejected','executing','succeeded','failed','compensated');
create type cue_actor_type as enum ('user','connector','rule','ai','system');
create type cue_authority_level as enum ('supporting','candidate','operational','authoritative');
create type cue_decision_action as enum ('accept_update','accept_as_truth','supporting_evidence','create_task','create_issue','create_risk','link_show','choose_another_show','merge','request_confirmation','snooze','ignore_once','ignore_similar','reject_incorrect','not_relevant');

create table cue_people (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  primary_email citext,
  active boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cue_organizations (
  id uuid primary key default gen_random_uuid(),
  organization_type text not null check (organization_type in ('client','vendor','partner','internal','other')),
  name text not null,
  aliases text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cue_venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  address jsonb not null default '{}',
  timezone text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cue_shows (
  id uuid primary key default gen_random_uuid(),
  parent_show_id uuid references cue_shows(id),
  name text not null,
  aliases text[] not null default '{}',
  client_id uuid references cue_organizations(id),
  venue_id uuid references cue_venues(id),
  project_manager_id uuid references cue_people(id),
  coordinator_id uuid references cue_people(id),
  show_status text not null default 'draft',
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  load_in_at timestamptz,
  show_start_at timestamptz,
  load_out_at timestamptz,
  timezone text not null default 'America/New_York',
  active_show_sheet_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (planned_end_at is null or planned_start_at is null or planned_end_at >= planned_start_at)
);
create index cue_shows_dates_idx on cue_shows(planned_start_at, planned_end_at) where archived_at is null;
create index cue_shows_aliases_gin on cue_shows using gin(aliases);

create table cue_source_identities (
  id uuid primary key default gen_random_uuid(),
  source_type cue_source_type not null,
  external_type text not null,
  external_id text not null,
  entity_type text not null,
  entity_id uuid not null,
  external_label text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, external_type, external_id)
);
create index cue_source_identities_entity_idx on cue_source_identities(entity_type, entity_id);

create table cue_show_source_links (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references cue_shows(id) on delete cascade,
  source_type cue_source_type not null,
  external_type text not null,
  external_id text not null,
  label text,
  is_primary boolean not null default false,
  match_method text,
  match_confidence numeric(5,4) check (match_confidence between 0 and 1),
  confirmed_by uuid references cue_people(id),
  confirmed_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, external_type, external_id)
);
create index cue_show_source_links_show_idx on cue_show_source_links(show_id, source_type);

create table cue_connector_runs (
  id uuid primary key default gen_random_uuid(),
  source_type cue_source_type not null,
  connector_name text not null,
  connector_version text not null,
  status text not null check (status in ('running','succeeded','partial','rate_limited','failed')),
  cursor_before jsonb,
  cursor_after jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  duplicate_count integer not null default 0,
  retry_count integer not null default 0,
  rate_limit_count integer not null default 0,
  error_summary jsonb not null default '{}',
  metadata jsonb not null default '{}'
);
create index cue_connector_runs_health_idx on cue_connector_runs(source_type, started_at desc);

create table cue_source_records (
  id uuid primary key default gen_random_uuid(),
  source_type cue_source_type not null,
  connector_run_id uuid references cue_connector_runs(id),
  external_id text not null,
  external_parent_id text,
  external_revision_id text,
  source_url text,
  author_external_id text,
  author_person_id uuid references cue_people(id),
  observed_at timestamptz,
  effective_at timestamptz,
  ingested_at timestamptz not null default now(),
  content_hash text not null,
  normalized_text text,
  payload jsonb not null,
  permissions_metadata jsonb not null default '{}',
  connector_version text not null,
  schema_version integer not null default 1,
  supersedes_source_record_id uuid references cue_source_records(id),
  created_at timestamptz not null default now(),
  unique(source_type, external_id, content_hash)
);
create index cue_source_records_parent_idx on cue_source_records(source_type, external_parent_id);
create index cue_source_records_time_idx on cue_source_records(source_type, observed_at desc);
create index cue_source_records_payload_gin on cue_source_records using gin(payload);

create table cue_intake_items (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references cue_source_records(id),
  status cue_intake_status not null default 'received',
  category text,
  urgency text check (urgency is null or urgency in ('low','normal','high','urgent')),
  impact text check (impact is null or impact in ('informational','minor','material','critical')),
  summary text,
  recommended_owner_person_id uuid references cue_people(id),
  matched_show_id uuid references cue_shows(id),
  match_confidence numeric(5,4) check (match_confidence between 0 and 1),
  match_reasons jsonb not null default '[]',
  interpretation_version text,
  model_metadata jsonb not null default '{}',
  snoozed_until timestamptz,
  duplicate_of_intake_id uuid references cue_intake_items(id),
  superseded_by_intake_id uuid references cue_intake_items(id),
  assigned_to uuid references cue_people(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);
create index cue_intake_queue_idx on cue_intake_items(status, urgency, created_at);
create index cue_intake_show_idx on cue_intake_items(matched_show_id, status);

create table cue_match_candidates (
  id uuid primary key default gen_random_uuid(),
  intake_item_id uuid not null references cue_intake_items(id) on delete cascade,
  candidate_entity_type text not null,
  candidate_entity_id uuid not null,
  score numeric(5,4) not null check (score between 0 and 1),
  reasons jsonb not null default '[]',
  matcher_version text not null,
  rank integer not null,
  selected boolean not null default false,
  selected_by uuid references cue_people(id),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  unique(intake_item_id, candidate_entity_type, candidate_entity_id, matcher_version)
);
create index cue_match_candidates_rank_idx on cue_match_candidates(intake_item_id, rank);

create table cue_candidate_facts (
  id uuid primary key default gen_random_uuid(),
  intake_item_id uuid not null references cue_intake_items(id) on delete cascade,
  fact_type text not null,
  subject_entity_type text,
  subject_entity_id uuid,
  value jsonb not null,
  units text,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  evidence_span jsonb not null,
  extraction_method text not null,
  extraction_version text not null,
  created_at timestamptz not null default now()
);
create index cue_candidate_facts_intake_idx on cue_candidate_facts(intake_item_id, fact_type);

create table cue_proposed_updates (
  id uuid primary key default gen_random_uuid(),
  intake_item_id uuid not null references cue_intake_items(id),
  candidate_fact_id uuid references cue_candidate_facts(id),
  status cue_proposal_status not null default 'draft',
  target_show_id uuid references cue_shows(id),
  target_domain text not null,
  target_entity_type text not null,
  target_entity_id uuid,
  target_field text not null,
  current_value jsonb,
  proposed_value jsonb not null,
  owning_system cue_source_type not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  readiness_impact jsonb not null default '{}',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cue_proposals_show_idx on cue_proposed_updates(target_show_id, status);

create table cue_decision_cards (
  id uuid primary key default gen_random_uuid(),
  show_id uuid references cue_shows(id),
  intake_item_id uuid references cue_intake_items(id),
  status cue_decision_status not null default 'open',
  card_type text not null,
  domain text not null,
  headline text not null,
  explanation text not null,
  recommendation text,
  urgency text not null default 'normal',
  impact text not null default 'minor',
  confidence numeric(5,4) check (confidence between 0 and 1),
  assigned_to uuid references cue_people(id),
  required_authority jsonb not null default '{}',
  due_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index cue_decision_cards_my_queue_idx on cue_decision_cards(assigned_to, status, due_at);
create index cue_decision_cards_show_idx on cue_decision_cards(show_id, status);

create table cue_decision_card_proposals (
  decision_card_id uuid not null references cue_decision_cards(id) on delete cascade,
  proposed_update_id uuid not null references cue_proposed_updates(id) on delete cascade,
  primary key(decision_card_id, proposed_update_id)
);

create table cue_decisions (
  id uuid primary key default gen_random_uuid(),
  decision_card_id uuid not null references cue_decision_cards(id),
  action cue_decision_action not null,
  actor_person_id uuid not null references cue_people(id),
  rationale text,
  authority_scope jsonb not null default '{}',
  parameters jsonb not null default '{}',
  decided_at timestamptz not null default now(),
  supersedes_decision_id uuid references cue_decisions(id)
);
create index cue_decisions_card_idx on cue_decisions(decision_card_id, decided_at desc);

create table cue_operational_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  event_version integer not null default 1,
  show_id uuid references cue_shows(id),
  domain text not null,
  entity_type text not null,
  entity_id uuid,
  occurred_at timestamptz not null,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_type cue_actor_type not null,
  actor_id text,
  source_type cue_source_type not null,
  source_record_id uuid references cue_source_records(id),
  intake_item_id uuid references cue_intake_items(id),
  decision_id uuid references cue_decisions(id),
  previous_value jsonb,
  new_value jsonb,
  evidence jsonb not null default '[]',
  confidence numeric(5,4) check (confidence between 0 and 1),
  correlation_id uuid not null default gen_random_uuid(),
  causation_event_id uuid references cue_operational_events(id),
  idempotency_key text not null unique,
  supersedes_event_id uuid references cue_operational_events(id),
  visibility text not null default 'internal',
  metadata jsonb not null default '{}'
);
create index cue_events_show_time_idx on cue_operational_events(show_id, effective_at desc);
create index cue_events_entity_idx on cue_operational_events(entity_type, entity_id, effective_at desc);
create index cue_events_type_idx on cue_operational_events(event_type, recorded_at desc);

create table cue_current_show_state (
  show_id uuid not null references cue_shows(id) on delete cascade,
  projection_name text not null,
  projection_version integer not null,
  state jsonb not null,
  last_event_id uuid references cue_operational_events(id),
  source_freshness jsonb not null default '{}',
  projected_at timestamptz not null default now(),
  primary key(show_id, projection_name)
);
create index cue_current_show_state_gin on cue_current_show_state using gin(state);

create table cue_readiness_requirements (
  id uuid primary key default gen_random_uuid(),
  requirement_key text not null,
  version integer not null default 1,
  domain text not null,
  milestone_gate text not null,
  title text not null,
  description text not null,
  criticality text not null check (criticality in ('informational','warning','blocking')),
  applicability_rule jsonb not null,
  evaluation_rule jsonb not null,
  default_owner_role text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(requirement_key, version)
);

create table cue_readiness_evaluations (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references cue_shows(id) on delete cascade,
  requirement_id uuid not null references cue_readiness_requirements(id),
  status cue_readiness_status not null,
  score numeric(5,2) check (score between 0 and 100),
  explanation text not null,
  evidence jsonb not null default '[]',
  missing_items jsonb not null default '[]',
  confidence numeric(5,4) check (confidence between 0 and 1),
  rule_version text not null,
  evaluated_at timestamptz not null default now(),
  triggered_by_event_id uuid references cue_operational_events(id),
  valid_until timestamptz
);
create index cue_readiness_eval_latest_idx on cue_readiness_evaluations(show_id, requirement_id, evaluated_at desc);

create table cue_readiness_overrides (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references cue_shows(id),
  requirement_id uuid references cue_readiness_requirements(id),
  milestone_gate text,
  override_status cue_readiness_status not null,
  reason text not null,
  actor_person_id uuid not null references cue_people(id),
  authority_scope jsonb not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (requirement_id is not null or milestone_gate is not null)
);

create table cue_show_readiness (
  show_id uuid primary key references cue_shows(id) on delete cascade,
  overall_status cue_readiness_status not null,
  overall_score numeric(5,2) check (overall_score between 0 and 100),
  domain_rollup jsonb not null,
  milestone_rollup jsonb not null,
  blockers jsonb not null default '[]',
  warnings jsonb not null default '[]',
  missing_requirements jsonb not null default '[]',
  next_actions jsonb not null default '[]',
  source_freshness jsonb not null default '{}',
  ruleset_version text not null,
  last_event_id uuid references cue_operational_events(id),
  evaluated_at timestamptz not null default now()
);
create index cue_show_readiness_status_idx on cue_show_readiness(overall_status, evaluated_at);

create table cue_work_items (
  id uuid primary key default gen_random_uuid(),
  show_id uuid references cue_shows(id),
  work_type cue_work_type not null,
  status cue_work_status not null default 'open',
  domain text not null,
  title text not null,
  description text,
  owner_person_id uuid references cue_people(id),
  owner_role text,
  due_at timestamptz,
  readiness_impact jsonb not null default '{}',
  source_record_id uuid references cue_source_records(id),
  intake_item_id uuid references cue_intake_items(id),
  decision_id uuid references cue_decisions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index cue_work_items_owner_idx on cue_work_items(owner_person_id, status, due_at);
create index cue_work_items_show_idx on cue_work_items(show_id, status);

create table cue_commands (
  id uuid primary key default gen_random_uuid(),
  show_id uuid references cue_shows(id),
  command_type text not null,
  target_system cue_source_type not null,
  target_entity_type text not null,
  target_entity_id text,
  payload jsonb not null,
  status cue_command_status not null default 'requested',
  requested_by uuid not null references cue_people(id),
  required_authority jsonb not null default '{}',
  approved_by uuid references cue_people(id),
  decision_id uuid references cue_decisions(id),
  idempotency_key text not null unique,
  execution_result jsonb,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  executed_at timestamptz,
  failed_at timestamptz
);

create table cue_field_authority_rules (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  entity_type text not null,
  field_pattern text not null,
  source_type cue_source_type not null,
  authority_level cue_authority_level not null,
  precedence integer not null,
  approval_policy jsonb not null default '{}',
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  created_by uuid references cue_people(id),
  created_at timestamptz not null default now(),
  unique(domain, entity_type, field_pattern, source_type, effective_from)
);

create table cue_outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index cue_outbox_pending_idx on cue_outbox(available_at) where published_at is null;

-- Updated-at trigger.
create or replace function cue_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['cue_people','cue_organizations','cue_venues','cue_shows','cue_source_identities','cue_show_source_links','cue_intake_items','cue_proposed_updates','cue_decision_cards','cue_work_items']
  loop
    execute format('create trigger %I_set_updated_at before update on %I for each row execute function cue_set_updated_at()', t, t);
  end loop;
end $$;

-- Append-only ledger protection; service/migration role may be exempted through RLS or role policy.
create or replace function cue_prevent_event_mutation() returns trigger language plpgsql as $$
begin raise exception 'cue_operational_events is append-only'; end $$;
create trigger cue_operational_events_no_update before update or delete on cue_operational_events
for each row execute function cue_prevent_event_mutation();

-- First-slice event types (convention: domain.entity.action, past tense semantics).
comment on table cue_operational_events is
'Initial event examples: intake.signal.accepted, show.field.changed, staffing.requirement.changed, trucking.requirement.changed, trucking.run.assigned, warehouse.shortage.detected, communication.brief.acknowledged, readiness.status.changed.';

-- RLS policies are intentionally deployment-specific. Enable only with a complete user-role/show-scope mapping.
-- Required policy principle: CEO/GM cross-show; PM assigned shows; domain operators relevant domains;
-- crew/driver limited assigned records; pricing, compensation, contact and location scopes restricted.


