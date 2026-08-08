import { keyedContentHashSqlCheck } from './coreHashToken.mjs';

export const CORE_SCHEMA_VERSION = 2;

const strictNonNegativeIntegerCheck = (column) => `typeof(${column}) = 'integer' AND ${column} >= 0`;
const fenceOperationKeyCheck = (column) => `length(${column}) BETWEEN 1 AND 200
  AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const operationSemanticDigestCheck = (column) => `length(${column}) = 74
  AND ${column} GLOB 'sha256:v1:[0-9a-f]*'
  AND ${column} NOT GLOB 'sha256:v1:*[^0-9a-f]*'`;

const fenceReasonCheck = (column) => `${column} IN (
  'lease_acquired','lease_rotated','stop','cancel','restart',
  'writer_handoff','reconciliation','maintenance_claim',
  'presentation_claim','projection_claim'
)`;

export const CORE_TABLES = Object.freeze([
  'schema_migration', 'journal_event', 'journal_payload', 'payload_tombstone',
  'publication_ledger', 'maintenance_outbox', 'ingress_event', 'conversation',
  'exchange', 'exchange_instruction', 'semantic_turn', 'turn_revision',
  'turn_assembly', 'turn_assembly_part', 'provider_epoch', 'provider_epoch_binding',
  'presentation_binding', 'presentation_outbox', 'projection_outbox',
  'projector_cursor', 'activity', 'work_run', 'lease', 'fence', 'work_checkpoint',
  'steer_instruction', 'capability_profile', 'connector_handle', 'grant',
  'confirmation_request', 'action_intent', 'effect_attempt',
  'effect_observation', 'effect_receipt', 'living_identity', 'facet_revision',
  'facet_evidence_link', 'soul_revision', 'soul_revision_facet',
  'soul_change_receipt', 'runtime_interaction_override',
  'schedule_spec', 'schedule_spec_revision', 'wake_occurrence',
]);

export const CORE_SCHEMA_V1 = Object.freeze([
  `CREATE TABLE schema_migration (
    migration_id TEXT PRIMARY KEY,
    from_version INTEGER NOT NULL UNIQUE CHECK(from_version >= 0),
    to_version INTEGER NOT NULL UNIQUE CHECK(to_version = from_version + 1),
    checksum TEXT NOT NULL CHECK(length(trim(checksum)) > 0),
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE journal_event (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence_no >= 1),
    journal_event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    owner_id TEXT,
    conversation_id TEXT,
    exchange_id TEXT,
    activity_id TEXT,
    actor_ref TEXT,
    origin_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    causation_id TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    FOREIGN KEY (exchange_id, conversation_id) REFERENCES exchange(exchange_id, conversation_id),
    FOREIGN KEY (activity_id, conversation_id) REFERENCES activity(activity_id, conversation_id),
    CHECK(exchange_id IS NULL OR conversation_id IS NOT NULL)
  )`,
  `CREATE TABLE journal_payload (
    journal_payload_id TEXT PRIMARY KEY,
    journal_event_id TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('encrypted_blob','external_ref','redacted')),
    payload_ref TEXT NOT NULL,
    content_hash_token TEXT NOT NULL CHECK(${keyedContentHashSqlCheck('content_hash_token')}),
    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','sensitive','high')),
    retention_class TEXT NOT NULL CHECK(retention_class IN ('canonical','diagnostic','ephemeral','owner_directed')),
    expires_at TEXT,
    erased_at TEXT,
    created_at TEXT NOT NULL,
    CHECK(erased_at IS NULL OR storage_kind = 'redacted'),
    FOREIGN KEY (journal_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE payload_tombstone (
    tombstone_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_revision INTEGER NOT NULL CHECK(subject_revision >= 0),
    supersedes_tombstone_id TEXT,
    reason_code TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
    causation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(subject_type, subject_id, subject_revision, source_event_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (supersedes_tombstone_id) REFERENCES payload_tombstone(tombstone_id)
  )`,
  `CREATE TABLE publication_ledger (
    publication_id TEXT PRIMARY KEY,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_revision INTEGER NOT NULL CHECK(subject_revision >= 0),
    target TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('requested','published','superseded','withdrawn','failed')),
    source_event_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
    causation_id TEXT NOT NULL,
    receipt_ref TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(operation_scope, operation_key),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE maintenance_outbox (
    maintenance_outbox_id TEXT PRIMARY KEY,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    task_type TEXT NOT NULL,
    source_event_id TEXT,
    source_revision INTEGER CHECK(source_revision IS NULL OR source_revision >= 0),
    target TEXT NOT NULL,
    payload_ref TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','reserved','completed','failed','cancelled')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    fence_token INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    fence_reason_code TEXT CHECK(fence_reason_code IS NULL OR ${fenceReasonCheck('fence_reason_code')}),
    fence_causation_id TEXT,
    fence_operation_key TEXT CHECK(fence_operation_key IS NULL OR ${fenceOperationKeyCheck('fence_operation_key')}),
    fence_operation_digest TEXT CHECK(fence_operation_digest IS NULL OR ${operationSemanticDigestCheck('fence_operation_digest')}),
    fence_committed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(operation_scope, operation_key),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (fence_causation_id) REFERENCES journal_event(journal_event_id),
    CHECK(fence_token = 0 OR (
      fence_reason_code = 'maintenance_claim' AND
      fence_causation_id IS NOT NULL AND fence_operation_key IS NOT NULL
      AND fence_operation_digest IS NOT NULL
      AND fence_committed_at IS NOT NULL
    )),
    CHECK((state = 'reserved') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE ingress_event (
    ingress_event_id TEXT PRIMARY KEY,
    source_instance_id TEXT NOT NULL CHECK(length(trim(source_instance_id)) > 0),
    platform TEXT NOT NULL CHECK(length(trim(platform)) > 0),
    native_event_id TEXT,
    native_event_id_trust TEXT NOT NULL CHECK(native_event_id_trust IN ('trusted','untrusted','absent')),
    idempotency_disposition TEXT NOT NULL CHECK(idempotency_disposition IN ('native_exact','internal_only')),
    conversation_hint TEXT,
    payload_ref TEXT,
    payload_hash_token TEXT CHECK(${keyedContentHashSqlCheck('payload_hash_token', { nullable: true })}),
    state TEXT NOT NULL CHECK(state IN ('received','assembling','sealed','rejected','superseded')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(
      (native_event_id_trust = 'trusted' AND native_event_id IS NOT NULL AND length(trim(native_event_id)) > 0 AND idempotency_disposition = 'native_exact') OR
      (native_event_id_trust = 'untrusted' AND native_event_id IS NOT NULL AND length(trim(native_event_id)) > 0 AND idempotency_disposition = 'internal_only') OR
      (native_event_id_trust = 'absent' AND native_event_id IS NULL AND idempotency_disposition = 'internal_only')
    )
  )`,
  `CREATE TABLE conversation (
    conversation_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused','closed','revoked')),
    foreground_exchange_id TEXT,
    primary_frontend TEXT,
    visibility_scope TEXT NOT NULL DEFAULT 'owner' CHECK(visibility_scope IN ('owner','shared','restricted')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (foreground_exchange_id, conversation_id) REFERENCES exchange(exchange_id, conversation_id)
  )`,
  `CREATE TABLE exchange (
    exchange_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    ingress_event_id TEXT,
    root_instruction_turn_id TEXT,
    activity_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','running','waiting','completed','cancelled','failed','superseded')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),
    continued_from_exchange_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(exchange_id, conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    FOREIGN KEY (ingress_event_id) REFERENCES ingress_event(ingress_event_id),
    FOREIGN KEY (root_instruction_turn_id, conversation_id) REFERENCES semantic_turn(semantic_turn_id, conversation_id),
    FOREIGN KEY (activity_id, conversation_id) REFERENCES activity(activity_id, conversation_id),
    FOREIGN KEY (continued_from_exchange_id, conversation_id) REFERENCES exchange(exchange_id, conversation_id),
    CHECK((state IN ('completed','cancelled','failed','superseded')) = (completed_at IS NOT NULL))
  )`,
  `CREATE TABLE exchange_instruction (
    exchange_instruction_id TEXT PRIMARY KEY,
    exchange_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    semantic_turn_id TEXT NOT NULL,
    instruction_kind TEXT NOT NULL CHECK(instruction_kind IN ('root','continuation','constraint','steer')),
    sequence_no INTEGER NOT NULL CHECK(sequence_no >= 1),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(exchange_id, sequence_no),
    FOREIGN KEY (exchange_id, conversation_id) REFERENCES exchange(exchange_id, conversation_id),
    FOREIGN KEY (semantic_turn_id, conversation_id) REFERENCES semantic_turn(semantic_turn_id, conversation_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE semantic_turn (
    semantic_turn_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    exchange_id TEXT,
    actor_ref TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    active_revision_id TEXT,
    commit_state TEXT NOT NULL CHECK(commit_state IN ('committed','withdrawn','superseded')),
    visibility TEXT NOT NULL CHECK(visibility IN ('visible','internal','suppressed')),
    created_at TEXT NOT NULL,
    UNIQUE(semantic_turn_id, conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    FOREIGN KEY (exchange_id, conversation_id) REFERENCES exchange(exchange_id, conversation_id),
    FOREIGN KEY (active_revision_id, semantic_turn_id) REFERENCES turn_revision(turn_revision_id, semantic_turn_id)
  )`,
  `CREATE TABLE turn_revision (
    turn_revision_id TEXT PRIMARY KEY,
    semantic_turn_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    change_kind TEXT NOT NULL CHECK(change_kind IN ('initial','corrected','withdrawn','superseded')),
    payload_ref TEXT NOT NULL,
    content_hash_token TEXT NOT NULL CHECK(${keyedContentHashSqlCheck('content_hash_token')}),
    source_event_id TEXT NOT NULL,
    supersedes_revision_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(semantic_turn_id, revision),
    UNIQUE(turn_revision_id, semantic_turn_id),
    FOREIGN KEY (semantic_turn_id) REFERENCES semantic_turn(semantic_turn_id),
    FOREIGN KEY (supersedes_revision_id, semantic_turn_id) REFERENCES turn_revision(turn_revision_id, semantic_turn_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK((revision = 1 AND supersedes_revision_id IS NULL) OR (revision > 1 AND supersedes_revision_id IS NOT NULL))
  )`,
  `CREATE TABLE turn_assembly (
    turn_assembly_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','sealing','sealed','superseded','rejected')),
    quiet_deadline TEXT NOT NULL,
    hard_deadline TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sealed_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    CHECK((state = 'sealed') = (sealed_at IS NOT NULL))
  )`,
  `CREATE TABLE turn_assembly_part (
    turn_assembly_part_id TEXT PRIMARY KEY,
    turn_assembly_id TEXT NOT NULL,
    ingress_event_id TEXT NOT NULL,
    part_kind TEXT NOT NULL CHECK(part_kind IN ('text','image','audio','quote','edit','withdrawal','other')),
    sequence_no INTEGER NOT NULL CHECK(sequence_no >= 1),
    payload_ref TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
    state TEXT NOT NULL CHECK(state IN ('active','superseded','withdrawn')),
    created_at TEXT NOT NULL,
    UNIQUE(turn_assembly_id, sequence_no),
    UNIQUE(turn_assembly_id, ingress_event_id, source_revision),
    FOREIGN KEY (turn_assembly_id) REFERENCES turn_assembly(turn_assembly_id),
    FOREIGN KEY (ingress_event_id) REFERENCES ingress_event(ingress_event_id)
  )`,
  `CREATE TABLE provider_epoch (
    provider_epoch_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','tainted','rotating','closed')),
    taint_state TEXT NOT NULL DEFAULT 'clean' CHECK(taint_state IN ('clean','suspect','tainted')),
    committed_event_cursor INTEGER CHECK(committed_event_cursor IS NULL OR committed_event_cursor >= 1),
    active_speculative_work_run_id TEXT,
    soul_revision_id TEXT,
    capability_snapshot_ref TEXT NOT NULL,
    canonical_snapshot_ref TEXT NOT NULL,
    snapshot_hash_token TEXT NOT NULL CHECK(${keyedContentHashSqlCheck('snapshot_hash_token')}),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    closed_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    FOREIGN KEY (committed_event_cursor) REFERENCES journal_event(sequence_no),
    FOREIGN KEY (active_speculative_work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (soul_revision_id) REFERENCES soul_revision(soul_revision_id),
    CHECK((state = 'closed') = (closed_at IS NOT NULL))
  )`,
  `CREATE TABLE provider_epoch_binding (
    provider_epoch_binding_id TEXT PRIMARY KEY,
    provider_epoch_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    upstream_handle TEXT NOT NULL,
    handle_hash_token TEXT NOT NULL CHECK(${keyedContentHashSqlCheck('handle_hash_token')}),
    state TEXT NOT NULL CHECK(state IN ('active','rotating','closed')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    closed_at TEXT,
    FOREIGN KEY (provider_epoch_id) REFERENCES provider_epoch(provider_epoch_id),
    CHECK((state = 'closed') = (closed_at IS NOT NULL))
  )`,
  `CREATE TABLE presentation_binding (
    presentation_binding_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    source_instance_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    destination_ref TEXT NOT NULL,
    adapter_metadata_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL CHECK(state IN ('active','paused','revoked')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(presentation_binding_id, conversation_id),
    UNIQUE(source_instance_id, platform, destination_ref),
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id)
  )`,
  `CREATE TABLE presentation_outbox (
    presentation_outbox_id TEXT PRIMARY KEY,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    semantic_turn_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
    presentation_binding_id TEXT NOT NULL,
    target TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','reserved','sent','ambiguous','failed','cancelled')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    fence_token INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    fence_reason_code TEXT CHECK(fence_reason_code IS NULL OR ${fenceReasonCheck('fence_reason_code')}),
    fence_causation_id TEXT,
    fence_operation_key TEXT CHECK(fence_operation_key IS NULL OR ${fenceOperationKeyCheck('fence_operation_key')}),
    fence_operation_digest TEXT CHECK(fence_operation_digest IS NULL OR ${operationSemanticDigestCheck('fence_operation_digest')}),
    fence_committed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(operation_scope, operation_key),
    FOREIGN KEY (semantic_turn_id, conversation_id) REFERENCES semantic_turn(semantic_turn_id, conversation_id),
    FOREIGN KEY (presentation_binding_id, conversation_id) REFERENCES presentation_binding(presentation_binding_id, conversation_id),
    FOREIGN KEY (semantic_turn_id, source_revision) REFERENCES turn_revision(semantic_turn_id, revision),
    FOREIGN KEY (fence_causation_id) REFERENCES journal_event(journal_event_id),
    CHECK(fence_token = 0 OR (
      fence_reason_code = 'presentation_claim' AND
      fence_causation_id IS NOT NULL AND fence_operation_key IS NOT NULL
      AND fence_operation_digest IS NOT NULL
      AND fence_committed_at IS NOT NULL
    )),
    CHECK((state = 'reserved') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE projection_outbox (
    projection_outbox_id TEXT PRIMARY KEY,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    projector_id TEXT NOT NULL,
    target_scope TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK(source_sequence >= 1),
    source_event_id TEXT NOT NULL,
    source_entity_type TEXT NOT NULL CHECK(source_entity_type = 'journal_event'),
    source_entity_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
    payload_ref TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','reserved','completed','failed','stale','cancelled')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    fence_token INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(operation_scope, operation_key),
    UNIQUE(projection_outbox_id, projector_id, target_scope),
    FOREIGN KEY (source_sequence) REFERENCES journal_event(sequence_no),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK(source_entity_id = source_event_id),
    CHECK((state = 'reserved') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE projector_cursor (
    projector_cursor_id TEXT PRIMARY KEY,
    projector_id TEXT NOT NULL,
    target_scope TEXT NOT NULL,
    committed_source_sequence INTEGER,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    lease_owner TEXT,
    lease_until TEXT,
    fence_token INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    fence_reason_code TEXT CHECK(fence_reason_code IS NULL OR ${fenceReasonCheck('fence_reason_code')}),
    fence_causation_id TEXT,
    fence_operation_key TEXT CHECK(fence_operation_key IS NULL OR ${fenceOperationKeyCheck('fence_operation_key')}),
    fence_operation_digest TEXT CHECK(fence_operation_digest IS NULL OR ${operationSemanticDigestCheck('fence_operation_digest')}),
    fence_result_outbox_id TEXT,
    fence_committed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(projector_id, target_scope),
    FOREIGN KEY (committed_source_sequence) REFERENCES journal_event(sequence_no),
    FOREIGN KEY (fence_causation_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (fence_result_outbox_id) REFERENCES projection_outbox(projection_outbox_id),
    CHECK(fence_token = 0 OR (
      fence_reason_code = 'projection_claim' AND
      fence_causation_id IS NOT NULL AND fence_operation_key IS NOT NULL
      AND fence_operation_digest IS NOT NULL AND fence_result_outbox_id IS NOT NULL
      AND fence_committed_at IS NOT NULL
    )),
    CHECK((lease_owner IS NULL) = (lease_until IS NULL))
  ) STRICT`,
  `CREATE TABLE activity (
    activity_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    conversation_id TEXT,
    title TEXT NOT NULL,
    goal_ref TEXT NOT NULL,
    domain TEXT NOT NULL,
    risk_class TEXT NOT NULL CHECK(risk_class IN ('closed_game','read_only','reversible','external_effect','high_impact')),
    autonomy_level INTEGER NOT NULL DEFAULT 0 CHECK(autonomy_level BETWEEN 0 AND 3),
    state TEXT NOT NULL CHECK(state IN ('draft','active','paused','completed','cancelled','failed','archived')),
    contract_revision INTEGER NOT NULL DEFAULT 0 CHECK(contract_revision >= 0),
    budget_json TEXT NOT NULL DEFAULT '{}',
    grant_scope_ref TEXT,
    resume_policy TEXT NOT NULL CHECK(resume_policy IN ('manual','bounded_auto','never')),
    report_policy TEXT NOT NULL CHECK(report_policy IN ('silent','milestone','always')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    archived_at TEXT,
    UNIQUE(activity_id, conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    CHECK((state = 'archived') = (archived_at IS NOT NULL))
  )`,
  `CREATE TABLE work_run (
    work_run_id TEXT PRIMARY KEY,
    activity_id TEXT,
    exchange_id TEXT,
    attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
    provider_epoch_id TEXT,
    execution_epoch_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','cancel_requested','completed','cancelled','failed','interrupted')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    lease_id TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    fence_token INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    fence_reason_code TEXT CHECK(fence_reason_code IS NULL OR ${fenceReasonCheck('fence_reason_code')}),
    fence_causation_id TEXT,
    fence_operation_key TEXT CHECK(fence_operation_key IS NULL OR ${fenceOperationKeyCheck('fence_operation_key')}),
    fence_operation_digest TEXT CHECK(fence_operation_digest IS NULL OR ${operationSemanticDigestCheck('fence_operation_digest')}),
    fence_committed_at TEXT,
    contract_revision INTEGER NOT NULL DEFAULT 0 CHECK(contract_revision >= 0),
    budget_json TEXT NOT NULL DEFAULT '{}',
    cancel_requested_at TEXT,
    started_at TEXT,
    heartbeat_at TEXT,
    ended_at TEXT,
    failure_class TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(activity_id, attempt_no),
    FOREIGN KEY (activity_id) REFERENCES activity(activity_id),
    FOREIGN KEY (exchange_id) REFERENCES exchange(exchange_id),
    FOREIGN KEY (provider_epoch_id) REFERENCES provider_epoch(provider_epoch_id),
    FOREIGN KEY (lease_id) REFERENCES lease(lease_id),
    FOREIGN KEY (fence_causation_id) REFERENCES journal_event(journal_event_id),
    CHECK(fence_token = 0 OR (
      fence_reason_code IN (
        'lease_acquired','lease_rotated','stop','cancel','restart',
        'writer_handoff','reconciliation'
      ) AND fence_causation_id IS NOT NULL AND fence_operation_key IS NOT NULL
      AND fence_operation_digest IS NOT NULL
      AND fence_committed_at IS NOT NULL
    )),
    CHECK((lease_owner IS NULL) = (lease_until IS NULL)),
    CHECK((state IN ('completed','cancelled','failed','interrupted')) = (ended_at IS NOT NULL)),
    CHECK(cancel_requested_at IS NULL OR state IN ('cancel_requested','cancelled','failed','interrupted'))
  ) STRICT`,
  `CREATE TABLE lease (
    lease_id TEXT PRIMARY KEY,
    work_run_id TEXT NOT NULL,
    lease_owner TEXT NOT NULL,
    lease_until TEXT NOT NULL,
    fence_token INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    state TEXT NOT NULL CHECK(state IN ('active','expired','revoked')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(${strictNonNegativeIntegerCheck('revision')}),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(lease_id, work_run_id),
    FOREIGN KEY (work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK((state = 'revoked') = (revoked_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE fence (
    fence_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK(domain IN (
      'maintenance_outbox','presentation_outbox','projector_cursor','work_run'
    )),
    maintenance_outbox_id TEXT,
    presentation_outbox_id TEXT,
    projector_cursor_id TEXT,
    work_run_id TEXT,
    old_fence INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('old_fence')}),
    new_fence INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('new_fence')} AND new_fence = old_fence + 1),
    old_revision INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('old_revision')}),
    new_revision INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('new_revision')} AND new_revision = old_revision + 1),
    reason_code TEXT NOT NULL CHECK(${fenceReasonCheck('reason_code')}),
    causation_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK(${fenceOperationKeyCheck('operation_key')}),
    operation_semantic_digest TEXT NOT NULL CHECK(${operationSemanticDigestCheck('operation_semantic_digest')}),
    resulting_state TEXT,
    claimed_projection_outbox_id TEXT,
    resulting_outbox_revision INTEGER CHECK(resulting_outbox_revision IS NULL OR ${strictNonNegativeIntegerCheck('resulting_outbox_revision')}),
    resulting_outbox_fence INTEGER CHECK(resulting_outbox_fence IS NULL OR ${strictNonNegativeIntegerCheck('resulting_outbox_fence')}),
    resulting_lease_owner TEXT,
    resulting_lease_until TEXT,
    result_source_sequence INTEGER CHECK(result_source_sequence IS NULL OR result_source_sequence >= 1),
    result_source_event_id TEXT,
    result_source_entity_type TEXT,
    result_source_entity_id TEXT,
    result_source_revision INTEGER CHECK(result_source_revision IS NULL OR result_source_revision >= 0),
    committed_at TEXT NOT NULL,
    UNIQUE(maintenance_outbox_id, new_fence),
    UNIQUE(presentation_outbox_id, new_fence),
    UNIQUE(projector_cursor_id, new_fence),
    UNIQUE(work_run_id, new_fence),
    UNIQUE(maintenance_outbox_id, operation_key),
    UNIQUE(presentation_outbox_id, operation_key),
    UNIQUE(projector_cursor_id, operation_key),
    UNIQUE(work_run_id, operation_key),
    FOREIGN KEY (maintenance_outbox_id) REFERENCES maintenance_outbox(maintenance_outbox_id),
    FOREIGN KEY (presentation_outbox_id) REFERENCES presentation_outbox(presentation_outbox_id),
    FOREIGN KEY (projector_cursor_id) REFERENCES projector_cursor(projector_cursor_id),
    FOREIGN KEY (work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (causation_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (claimed_projection_outbox_id) REFERENCES projection_outbox(projection_outbox_id),
    FOREIGN KEY (result_source_sequence) REFERENCES journal_event(sequence_no),
    FOREIGN KEY (result_source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK(
      (domain = 'maintenance_outbox' AND maintenance_outbox_id IS NOT NULL
        AND presentation_outbox_id IS NULL AND projector_cursor_id IS NULL AND work_run_id IS NULL
        AND reason_code = 'maintenance_claim') OR
      (domain = 'presentation_outbox' AND maintenance_outbox_id IS NULL
        AND presentation_outbox_id IS NOT NULL AND projector_cursor_id IS NULL AND work_run_id IS NULL
        AND reason_code = 'presentation_claim') OR
      (domain = 'projector_cursor' AND maintenance_outbox_id IS NULL
        AND presentation_outbox_id IS NULL AND projector_cursor_id IS NOT NULL AND work_run_id IS NULL
        AND reason_code = 'projection_claim'
        AND claimed_projection_outbox_id IS NOT NULL
        AND resulting_state = 'reserved'
        AND resulting_outbox_revision IS NOT NULL AND resulting_outbox_fence IS NOT NULL
        AND resulting_lease_owner IS NOT NULL AND resulting_lease_until IS NOT NULL
        AND result_source_sequence IS NOT NULL AND result_source_event_id IS NOT NULL
        AND result_source_entity_type IS NOT NULL AND result_source_entity_id IS NOT NULL
        AND result_source_revision IS NOT NULL) OR
      (domain = 'work_run' AND maintenance_outbox_id IS NULL
        AND presentation_outbox_id IS NULL AND projector_cursor_id IS NULL AND work_run_id IS NOT NULL
        AND reason_code IN (
          'lease_acquired','lease_rotated','stop','cancel','restart',
          'writer_handoff','reconciliation'
        ) AND resulting_state IS NOT NULL
        AND claimed_projection_outbox_id IS NULL
        AND resulting_outbox_revision IS NULL AND resulting_outbox_fence IS NULL
        AND resulting_lease_owner IS NULL AND resulting_lease_until IS NULL
        AND result_source_sequence IS NULL AND result_source_event_id IS NULL
        AND result_source_entity_type IS NULL AND result_source_entity_id IS NULL
        AND result_source_revision IS NULL)
    )
  ) STRICT`,
  `CREATE TABLE work_checkpoint (
    work_checkpoint_id TEXT PRIMARY KEY,
    work_run_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK(sequence_no >= 1),
    run_revision INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('run_revision')}),
    fence_token INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    goal_snapshot_ref TEXT NOT NULL,
    verified_evidence_refs TEXT NOT NULL,
    artifact_refs TEXT NOT NULL,
    effect_receipt_refs TEXT NOT NULL,
    ambiguous_effect_refs TEXT NOT NULL,
    remaining_work_ref TEXT NOT NULL,
    next_legal_actions_ref TEXT NOT NULL,
    budget_remaining_ref TEXT NOT NULL,
    resume_preconditions_ref TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(work_run_id, sequence_no),
    FOREIGN KEY (work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  ) STRICT`,
  `CREATE TABLE steer_instruction (
    steer_instruction_id TEXT PRIMARY KEY,
    work_run_id TEXT,
    exchange_id TEXT,
    activity_id TEXT,
    instruction_type TEXT NOT NULL CHECK(instruction_type IN ('steer','stop','cancel','queue')),
    disposition TEXT NOT NULL CHECK(disposition IN ('received','accepted','applied','rejected')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    payload_ref TEXT,
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    applied_at TEXT,
    CHECK((work_run_id IS NOT NULL) + (exchange_id IS NOT NULL) + (activity_id IS NOT NULL) = 1),
    CHECK(disposition <> 'accepted' OR accepted_at IS NOT NULL),
    CHECK(disposition <> 'applied' OR (accepted_at IS NOT NULL AND applied_at IS NOT NULL)),
    FOREIGN KEY (work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (exchange_id) REFERENCES exchange(exchange_id),
    FOREIGN KEY (activity_id) REFERENCES activity(activity_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE capability_profile (
    capability_profile_id TEXT PRIMARY KEY,
    profile_kind TEXT NOT NULL CHECK(profile_kind IN ('runtime','connector','activity')),
    subject_ref TEXT NOT NULL,
    capability_snapshot_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','active','superseded','revoked')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(profile_kind, subject_ref, revision),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE connector_handle (
    connector_handle_id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL,
    instance_scope TEXT NOT NULL,
    capability_profile_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('probation','active','degraded','revoked')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(connector_id, instance_scope),
    FOREIGN KEY (capability_profile_id) REFERENCES capability_profile(capability_profile_id)
  )`,
  `CREATE TABLE grant (
    grant_id TEXT PRIMARY KEY,
    grant_type TEXT NOT NULL CHECK(grant_type IN ('explicit','standing','activity','system')),
    principal_id TEXT NOT NULL,
    activity_id TEXT,
    project_id TEXT,
    action_family TEXT NOT NULL,
    resource_selector TEXT NOT NULL,
    effect_ceiling TEXT NOT NULL CHECK(effect_ceiling IN ('none','closed_game','read_only','reversible','external_send','irreversible')),
    autonomy_ceiling INTEGER NOT NULL CHECK(autonomy_ceiling BETWEEN 0 AND 3),
    constraints_ref TEXT NOT NULL,
    budget_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','expired','revoked','consumed')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    source_event_id TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (activity_id) REFERENCES activity(activity_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK((state = 'revoked') = (revoked_at IS NOT NULL))
  )`,
  `CREATE TABLE confirmation_request (
    confirmation_request_id TEXT PRIMARY KEY,
    action_intent_id TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    preview_ref TEXT NOT NULL,
    effect_class TEXT NOT NULL CHECK(effect_class IN ('closed_game','read_only','reversible','external_effect','irreversible')),
    state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired','consumed')),
    expected_action_revision INTEGER NOT NULL CHECK(expected_action_revision >= 0),
    expected_activity_revision INTEGER CHECK(expected_activity_revision IS NULL OR expected_activity_revision >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE(action_intent_id, action_digest, expected_action_revision),
    FOREIGN KEY (action_intent_id) REFERENCES action_intent(action_intent_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK((state = 'consumed') = (consumed_at IS NOT NULL))
  )`,
  `CREATE TABLE action_intent (
    action_intent_id TEXT PRIMARY KEY,
    exchange_id TEXT,
    activity_id TEXT,
    work_run_id TEXT,
    action_family TEXT NOT NULL,
    connector_handle_id TEXT,
    normalized_parameters_ref TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    effect_class TEXT NOT NULL CHECK(effect_class IN ('closed_game','read_only','reversible','external_effect','irreversible')),
    state TEXT NOT NULL CHECK(state IN ('proposed','authorized','dispatching','completed','ambiguous','failed','cancelled')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    grant_id TEXT,
    confirmation_request_id TEXT,
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(operation_scope, operation_key),
    FOREIGN KEY (exchange_id) REFERENCES exchange(exchange_id),
    FOREIGN KEY (activity_id) REFERENCES activity(activity_id),
    FOREIGN KEY (work_run_id) REFERENCES work_run(work_run_id),
    FOREIGN KEY (connector_handle_id) REFERENCES connector_handle(connector_handle_id),
    FOREIGN KEY (grant_id) REFERENCES grant(grant_id),
    FOREIGN KEY (confirmation_request_id) REFERENCES confirmation_request(confirmation_request_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE effect_attempt (
    effect_attempt_id TEXT PRIMARY KEY,
    action_intent_id TEXT NOT NULL,
    operation_scope TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
    state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','provisional_applied','observed_applied','observed_not_applied','ambiguous','failed','cancel_requested','cancelled')),
    fence_token INTEGER NOT NULL CHECK(${strictNonNegativeIntegerCheck('fence_token')}),
    dispatch_ref TEXT,
    adapter_receipt_ref TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(action_intent_id, attempt_no),
    UNIQUE(operation_scope, operation_key),
    FOREIGN KEY (action_intent_id) REFERENCES action_intent(action_intent_id),
    CHECK((state IN ('observed_applied','observed_not_applied','ambiguous','failed','cancelled')) = (ended_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE effect_observation (
    effect_observation_id TEXT PRIMARY KEY,
    effect_attempt_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('state_seen','applied','not_applied','contradictory','unknown')),
    evidence_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('adapter','gateway','host','user','reconciliation')),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (effect_attempt_id) REFERENCES effect_attempt(effect_attempt_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE effect_receipt (
    effect_receipt_id TEXT PRIMARY KEY,
    effect_attempt_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('observed_applied','observed_not_applied','ambiguous','rejected')),
    evidence_type TEXT NOT NULL CHECK(evidence_type IN ('adapter_receipt','gateway_observation','host_observation','manual_reconciliation')),
    issuer_ref TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    receipt_ref TEXT NOT NULL,
    content_hash_token TEXT NOT NULL CHECK(${keyedContentHashSqlCheck('content_hash_token')}),
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (effect_attempt_id) REFERENCES effect_attempt(effect_attempt_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id)
  )`,
  `CREATE TABLE living_identity (
    identity_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    seed_revision_id TEXT,
    active_soul_revision_id TEXT,
    active_soul_state TEXT GENERATED ALWAYS AS (
      CASE WHEN active_soul_revision_id IS NULL THEN NULL ELSE 'active' END
    ) STORED,
    constitution_revision_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','paused','revoked')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(identity_id, active_soul_revision_id),
    FOREIGN KEY (active_soul_revision_id, identity_id) REFERENCES soul_revision(soul_revision_id, identity_id),
    FOREIGN KEY (active_soul_revision_id, identity_id, active_soul_state)
      REFERENCES soul_revision(soul_revision_id, identity_id, state)
      DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE TABLE facet_revision (
    facet_revision_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    facet_group TEXT NOT NULL,
    facet_key TEXT NOT NULL,
    value_ref TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT,
    impact_class TEXT NOT NULL CHECK(impact_class IN ('interaction','relationship','identity','soul')),
    state TEXT NOT NULL CHECK(state IN ('candidate','provisional','active','superseded','withdrawn','rejected')),
    source_kind TEXT NOT NULL,
    supersedes_id TEXT,
    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','sensitive','high')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    activated_at TEXT,
    invalidated_at TEXT,
    UNIQUE(identity_id, facet_key, scope_type, scope_id, revision),
    UNIQUE(facet_revision_id, identity_id),
    FOREIGN KEY (identity_id) REFERENCES living_identity(identity_id),
    FOREIGN KEY (supersedes_id, identity_id) REFERENCES facet_revision(facet_revision_id, identity_id),
    CHECK((state = 'active') = (activated_at IS NOT NULL)),
    CHECK((state IN ('superseded','withdrawn','rejected')) = (invalidated_at IS NOT NULL))
  )`,
  `CREATE TABLE facet_evidence_link (
    facet_evidence_link_id TEXT PRIMARY KEY,
    facet_revision_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL CHECK(evidence_type IN ('user_statement','source_event','artifact','observation','owner_decision')),
    evidence_ref TEXT NOT NULL,
    relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','supersedes','withdraws')),
    independence_group TEXT NOT NULL,
    verification_state TEXT NOT NULL CHECK(verification_state IN ('unverified','verified','rejected','withdrawn')),
    weight_class TEXT NOT NULL CHECK(weight_class IN ('weak','normal','strong','owner')),
    created_at TEXT NOT NULL,
    UNIQUE(facet_revision_id, evidence_type, evidence_ref, relation),
    FOREIGN KEY (facet_revision_id) REFERENCES facet_revision(facet_revision_id)
  )`,
  `CREATE TABLE soul_revision (
    soul_revision_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    parent_revision_id TEXT,
    constitution_revision_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('draft','validated','activating','active','rejected','superseded','revoked')),
    content_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(trim(content_hash)) > 0),
    compiler_version TEXT,
    activation_receipt_id TEXT,
    active_pointer_identity_id TEXT,
    active_pointer_soul_revision_id TEXT,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision >= 0),
    state_causation_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    validated_at TEXT,
    activated_at TEXT,
    superseded_at TEXT,
    revoked_at TEXT,
    UNIQUE(identity_id, revision),
    UNIQUE(soul_revision_id, identity_id),
    UNIQUE(soul_revision_id, identity_id, state),
    FOREIGN KEY (identity_id) REFERENCES living_identity(identity_id),
    FOREIGN KEY (parent_revision_id, identity_id) REFERENCES soul_revision(soul_revision_id, identity_id),
    FOREIGN KEY (state_causation_event_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (activation_receipt_id) REFERENCES soul_change_receipt(soul_change_receipt_id),
    FOREIGN KEY (active_pointer_identity_id, active_pointer_soul_revision_id)
      REFERENCES living_identity(identity_id, active_soul_revision_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK(
      (state = 'active'
        AND active_pointer_identity_id = identity_id
        AND active_pointer_soul_revision_id = soul_revision_id)
      OR
      (state <> 'active'
        AND active_pointer_identity_id IS NULL
        AND active_pointer_soul_revision_id IS NULL)
    ),
    CHECK((state = 'revoked') = (revoked_at IS NOT NULL))
  )`,
  `CREATE TABLE soul_revision_facet (
    soul_revision_id TEXT NOT NULL,
    facet_revision_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    render_role TEXT NOT NULL,
    included INTEGER NOT NULL CHECK(included IN (0,1)),
    omission_reason TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(soul_revision_id, facet_revision_id),
    FOREIGN KEY (soul_revision_id, identity_id) REFERENCES soul_revision(soul_revision_id, identity_id),
    FOREIGN KEY (facet_revision_id, identity_id) REFERENCES facet_revision(facet_revision_id, identity_id),
    CHECK((included = 1 AND omission_reason IS NULL) OR (included = 0 AND omission_reason IS NOT NULL))
  )`,
  `CREATE TABLE soul_change_receipt (
    soul_change_receipt_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    trigger_event_id TEXT NOT NULL,
    old_soul_revision_id TEXT,
    new_soul_revision_id TEXT NOT NULL,
    expected_hash TEXT NOT NULL CHECK(length(trim(expected_hash)) > 0),
    actual_hash TEXT NOT NULL CHECK(length(trim(actual_hash)) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('success','failed','invalidated')),
    invalidates_receipt_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (identity_id) REFERENCES living_identity(identity_id),
    FOREIGN KEY (trigger_event_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (old_soul_revision_id, identity_id) REFERENCES soul_revision(soul_revision_id, identity_id),
    FOREIGN KEY (new_soul_revision_id, identity_id) REFERENCES soul_revision(soul_revision_id, identity_id),
    FOREIGN KEY (invalidates_receipt_id) REFERENCES soul_change_receipt(soul_change_receipt_id),
    CHECK(outcome <> 'success' OR expected_hash = actual_hash),
    CHECK((outcome = 'invalidated') = (invalidates_receipt_id IS NOT NULL))
  )`,
  `CREATE TABLE runtime_interaction_override (
    runtime_interaction_override_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('global','conversation','activity')),
    scope_id TEXT,
    payload_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','expired','revoked','superseded')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    expires_at TEXT,
    source_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (identity_id) REFERENCES living_identity(identity_id),
    FOREIGN KEY (source_event_id) REFERENCES journal_event(journal_event_id),
    CHECK((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global' AND scope_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX ingress_trusted_native_event
    ON ingress_event(source_instance_id, platform, native_event_id)
    WHERE native_event_id_trust = 'trusted'`,
  `CREATE UNIQUE INDEX facet_active_scope
    ON facet_revision(identity_id, facet_key, scope_type, COALESCE(scope_id, ''))
    WHERE state = 'active'`,
  `CREATE UNIQUE INDEX soul_one_active_per_identity
    ON soul_revision(identity_id) WHERE state = 'active'`,
  `CREATE INDEX journal_event_traversal ON journal_event(sequence_no, event_type)`,
  `CREATE INDEX exchange_conversation ON exchange(conversation_id, created_at)`,
  `CREATE INDEX work_run_activity_state ON work_run(activity_id, state)`,
  `CREATE INDEX projection_ready ON projection_outbox(projector_id, target_scope, state, next_attempt_at, source_sequence)`,
  `CREATE TRIGGER schema_migration_no_update BEFORE UPDATE ON schema_migration
    BEGIN SELECT RAISE(ABORT, 'schema migration ledger is append-only'); END`,
  `CREATE TRIGGER schema_migration_no_delete BEFORE DELETE ON schema_migration
    BEGIN SELECT RAISE(ABORT, 'schema migration ledger is append-only'); END`,
  `CREATE TRIGGER payload_tombstone_no_update BEFORE UPDATE ON payload_tombstone
    BEGIN SELECT RAISE(ABORT, 'payload tombstone is append-only'); END`,
  `CREATE TRIGGER payload_tombstone_no_delete BEFORE DELETE ON payload_tombstone
    BEGIN SELECT RAISE(ABORT, 'payload tombstone is append-only'); END`,
  `CREATE TRIGGER publication_ledger_no_update BEFORE UPDATE ON publication_ledger
    BEGIN SELECT RAISE(ABORT, 'publication ledger is append-only'); END`,
  `CREATE TRIGGER publication_ledger_no_delete BEFORE DELETE ON publication_ledger
    BEGIN SELECT RAISE(ABORT, 'publication ledger is append-only'); END`,
  `CREATE TRIGGER effect_observation_no_update BEFORE UPDATE ON effect_observation
    BEGIN SELECT RAISE(ABORT, 'effect observation is append-only'); END`,
  `CREATE TRIGGER effect_observation_no_delete BEFORE DELETE ON effect_observation
    BEGIN SELECT RAISE(ABORT, 'effect observation is append-only'); END`,
  `CREATE TRIGGER effect_receipt_no_update BEFORE UPDATE ON effect_receipt
    BEGIN SELECT RAISE(ABORT, 'effect receipt is append-only'); END`,
  `CREATE TRIGGER effect_receipt_no_delete BEFORE DELETE ON effect_receipt
    BEGIN SELECT RAISE(ABORT, 'effect receipt is append-only'); END`,
  `CREATE TRIGGER turn_revision_no_update BEFORE UPDATE ON turn_revision
    BEGIN SELECT RAISE(ABORT, 'turn revision is append-only'); END`,
  `CREATE TRIGGER turn_revision_no_delete BEFORE DELETE ON turn_revision
    BEGIN SELECT RAISE(ABORT, 'turn revision is append-only'); END`,
  `CREATE TRIGGER facet_evidence_no_update BEFORE UPDATE ON facet_evidence_link
    BEGIN SELECT RAISE(ABORT, 'facet evidence is append-only'); END`,
  `CREATE TRIGGER facet_evidence_no_delete BEFORE DELETE ON facet_evidence_link
    BEGIN SELECT RAISE(ABORT, 'facet evidence is append-only'); END`,
  `CREATE TRIGGER soul_revision_facet_no_update BEFORE UPDATE ON soul_revision_facet
    BEGIN SELECT RAISE(ABORT, 'Soul facet composition is append-only'); END`,
  `CREATE TRIGGER soul_revision_facet_no_delete BEFORE DELETE ON soul_revision_facet
    BEGIN SELECT RAISE(ABORT, 'Soul facet composition is append-only'); END`,
  `CREATE TRIGGER fence_no_update BEFORE UPDATE ON fence
    BEGIN SELECT RAISE(ABORT, 'fence is append-only'); END`,
  `CREATE TRIGGER fence_no_delete BEFORE DELETE ON fence
    BEGIN SELECT RAISE(ABORT, 'fence is append-only'); END`,
  `CREATE TRIGGER fence_parent_state_match
    BEFORE INSERT ON fence
    WHEN NOT (
      (NEW.domain = 'maintenance_outbox' AND EXISTS (
        SELECT 1 FROM maintenance_outbox item
        WHERE item.maintenance_outbox_id = NEW.maintenance_outbox_id
          AND item.fence_token = NEW.new_fence AND item.revision = NEW.new_revision
          AND item.fence_reason_code = NEW.reason_code
          AND item.fence_causation_id = NEW.causation_id
          AND item.fence_operation_key = NEW.operation_key
          AND item.fence_operation_digest = NEW.operation_semantic_digest
          AND item.fence_committed_at = NEW.committed_at
      )) OR
      (NEW.domain = 'presentation_outbox' AND EXISTS (
        SELECT 1 FROM presentation_outbox item
        WHERE item.presentation_outbox_id = NEW.presentation_outbox_id
          AND item.fence_token = NEW.new_fence AND item.revision = NEW.new_revision
          AND item.fence_reason_code = NEW.reason_code
          AND item.fence_causation_id = NEW.causation_id
          AND item.fence_operation_key = NEW.operation_key
          AND item.fence_operation_digest = NEW.operation_semantic_digest
          AND item.fence_committed_at = NEW.committed_at
      )) OR
      (NEW.domain = 'projector_cursor' AND EXISTS (
        SELECT 1 FROM projector_cursor cursor
        WHERE cursor.projector_cursor_id = NEW.projector_cursor_id
          AND cursor.fence_token = NEW.new_fence AND cursor.revision = NEW.new_revision
          AND cursor.fence_reason_code = NEW.reason_code
          AND cursor.fence_causation_id = NEW.causation_id
          AND cursor.fence_operation_key = NEW.operation_key
          AND cursor.fence_operation_digest = NEW.operation_semantic_digest
          AND cursor.fence_result_outbox_id = NEW.claimed_projection_outbox_id
          AND cursor.fence_committed_at = NEW.committed_at
      )) OR
      (NEW.domain = 'work_run' AND EXISTS (
        SELECT 1 FROM work_run run
        WHERE run.work_run_id = NEW.work_run_id
          AND run.fence_token = NEW.new_fence AND run.revision = NEW.new_revision
          AND run.fence_reason_code = NEW.reason_code
          AND run.fence_causation_id = NEW.causation_id
          AND run.fence_operation_key = NEW.operation_key
          AND run.fence_operation_digest = NEW.operation_semantic_digest
          AND run.fence_committed_at = NEW.committed_at
      ))
    )
    BEGIN SELECT RAISE(ABORT, 'fence audit must match committed authority state'); END`,
  `CREATE TRIGGER maintenance_outbox_initial_fence
    BEFORE INSERT ON maintenance_outbox
    WHEN NEW.fence_token <> 0 OR NEW.revision <> 0
      OR NEW.fence_reason_code IS NOT NULL
      OR NEW.fence_causation_id IS NOT NULL OR NEW.fence_operation_key IS NOT NULL
      OR NEW.fence_operation_digest IS NOT NULL
      OR NEW.fence_committed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'maintenance outbox authority must start at revision and fence zero'); END`,
  `CREATE TRIGGER maintenance_outbox_fence_transition
    BEFORE UPDATE OF revision, fence_token, fence_reason_code, fence_causation_id, fence_operation_key, fence_operation_digest, fence_committed_at
    ON maintenance_outbox
    WHEN NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
      OR (NEW.fence_token = OLD.fence_token AND (
        NEW.fence_reason_code IS NOT OLD.fence_reason_code
        OR NEW.fence_causation_id IS NOT OLD.fence_causation_id
        OR NEW.fence_operation_key IS NOT OLD.fence_operation_key
        OR NEW.fence_operation_digest IS NOT OLD.fence_operation_digest
        OR NEW.fence_committed_at IS NOT OLD.fence_committed_at
      ))
      OR (NEW.fence_token <> OLD.fence_token AND (
        NEW.fence_token <> OLD.fence_token + 1
        OR NEW.revision <> OLD.revision + 1
        OR NEW.fence_reason_code <> 'maintenance_claim'
        OR NEW.fence_causation_id IS NULL OR NEW.fence_operation_key IS NULL
        OR NEW.fence_operation_digest IS NULL
        OR NEW.fence_committed_at IS NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid maintenance outbox fence transition'); END`,
  `CREATE TRIGGER maintenance_outbox_fence_audit
    AFTER UPDATE OF fence_token ON maintenance_outbox
    WHEN NEW.fence_token <> OLD.fence_token
    BEGIN
      INSERT INTO fence(
        fence_id, domain, maintenance_outbox_id,
        old_fence, new_fence, old_revision, new_revision,
        reason_code, causation_id, operation_key, operation_semantic_digest,
        resulting_state, committed_at
      ) VALUES (
        'maintenance_outbox:' || NEW.maintenance_outbox_id || ':' || NEW.fence_token,
        'maintenance_outbox', NEW.maintenance_outbox_id,
        OLD.fence_token, NEW.fence_token, OLD.revision, NEW.revision,
        NEW.fence_reason_code, NEW.fence_causation_id, NEW.fence_operation_key,
        NEW.fence_operation_digest, NEW.state, NEW.fence_committed_at
      );
    END`,
  `CREATE TRIGGER maintenance_outbox_identity_immutable
    BEFORE UPDATE OF maintenance_outbox_id, operation_scope, operation_key ON maintenance_outbox
    WHEN NEW.maintenance_outbox_id IS NOT OLD.maintenance_outbox_id
      OR NEW.operation_scope IS NOT OLD.operation_scope OR NEW.operation_key IS NOT OLD.operation_key
    BEGIN SELECT RAISE(ABORT, 'maintenance outbox identity is immutable'); END`,
  `CREATE TRIGGER maintenance_outbox_no_delete BEFORE DELETE ON maintenance_outbox
    BEGIN SELECT RAISE(ABORT, 'maintenance outbox authority cannot be deleted'); END`,
  `CREATE TRIGGER presentation_outbox_initial_fence
    BEFORE INSERT ON presentation_outbox
    WHEN NEW.fence_token <> 0 OR NEW.revision <> 0
      OR NEW.fence_reason_code IS NOT NULL
      OR NEW.fence_causation_id IS NOT NULL OR NEW.fence_operation_key IS NOT NULL
      OR NEW.fence_operation_digest IS NOT NULL
      OR NEW.fence_committed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'presentation outbox authority must start at revision and fence zero'); END`,
  `CREATE TRIGGER presentation_outbox_fence_transition
    BEFORE UPDATE OF revision, fence_token, fence_reason_code, fence_causation_id, fence_operation_key, fence_operation_digest, fence_committed_at
    ON presentation_outbox
    WHEN NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
      OR (NEW.fence_token = OLD.fence_token AND (
        NEW.fence_reason_code IS NOT OLD.fence_reason_code
        OR NEW.fence_causation_id IS NOT OLD.fence_causation_id
        OR NEW.fence_operation_key IS NOT OLD.fence_operation_key
        OR NEW.fence_operation_digest IS NOT OLD.fence_operation_digest
        OR NEW.fence_committed_at IS NOT OLD.fence_committed_at
      ))
      OR (NEW.fence_token <> OLD.fence_token AND (
        NEW.fence_token <> OLD.fence_token + 1
        OR NEW.revision <> OLD.revision + 1
        OR NEW.fence_reason_code <> 'presentation_claim'
        OR NEW.fence_causation_id IS NULL OR NEW.fence_operation_key IS NULL
        OR NEW.fence_operation_digest IS NULL
        OR NEW.fence_committed_at IS NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid presentation outbox fence transition'); END`,
  `CREATE TRIGGER presentation_outbox_fence_audit
    AFTER UPDATE OF fence_token ON presentation_outbox
    WHEN NEW.fence_token <> OLD.fence_token
    BEGIN
      INSERT INTO fence(
        fence_id, domain, presentation_outbox_id,
        old_fence, new_fence, old_revision, new_revision,
        reason_code, causation_id, operation_key, operation_semantic_digest,
        resulting_state, committed_at
      ) VALUES (
        'presentation_outbox:' || NEW.presentation_outbox_id || ':' || NEW.fence_token,
        'presentation_outbox', NEW.presentation_outbox_id,
        OLD.fence_token, NEW.fence_token, OLD.revision, NEW.revision,
        NEW.fence_reason_code, NEW.fence_causation_id, NEW.fence_operation_key,
        NEW.fence_operation_digest, NEW.state, NEW.fence_committed_at
      );
    END`,
  `CREATE TRIGGER presentation_outbox_identity_immutable
    BEFORE UPDATE OF presentation_outbox_id, operation_scope, operation_key ON presentation_outbox
    WHEN NEW.presentation_outbox_id IS NOT OLD.presentation_outbox_id
      OR NEW.operation_scope IS NOT OLD.operation_scope OR NEW.operation_key IS NOT OLD.operation_key
    BEGIN SELECT RAISE(ABORT, 'presentation outbox identity is immutable'); END`,
  `CREATE TRIGGER presentation_outbox_no_delete BEFORE DELETE ON presentation_outbox
    BEGIN SELECT RAISE(ABORT, 'presentation outbox authority cannot be deleted'); END`,
  `CREATE TRIGGER projection_outbox_initial_fence
    BEFORE INSERT ON projection_outbox
    WHEN NEW.fence_token <> 0 OR NEW.revision <> 0
    BEGIN SELECT RAISE(ABORT, 'projection outbox snapshot must start at revision and fence zero'); END`,
  `CREATE TRIGGER projection_outbox_fence_binding
    BEFORE UPDATE OF fence_token, revision ON projection_outbox
    WHEN NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
      OR (NEW.fence_token <> OLD.fence_token AND (
        NEW.revision <> OLD.revision + 1 OR NEW.state <> 'reserved'
        OR NOT EXISTS (
          SELECT 1 FROM projector_cursor cursor
          JOIN fence audit ON audit.domain = 'projector_cursor'
            AND audit.projector_cursor_id = cursor.projector_cursor_id
            AND audit.new_fence = NEW.fence_token
            AND audit.causation_id = NEW.source_event_id
            AND audit.claimed_projection_outbox_id = NEW.projection_outbox_id
            AND audit.resulting_outbox_revision = NEW.revision
            AND audit.resulting_outbox_fence = NEW.fence_token
            AND audit.resulting_lease_owner = NEW.lease_owner
            AND audit.resulting_lease_until = NEW.lease_until
          WHERE cursor.projector_id = NEW.projector_id
            AND cursor.target_scope = NEW.target_scope
            AND cursor.fence_token = NEW.fence_token
        )
      ))
    BEGIN SELECT RAISE(ABORT, 'projection outbox fence must bind an audited projector claim'); END`,
  `CREATE TRIGGER projection_outbox_identity_immutable
    BEFORE UPDATE OF projection_outbox_id, operation_scope, operation_key, projector_id,
      target_scope, source_sequence, source_event_id, source_entity_type,
      source_entity_id, source_revision ON projection_outbox
    WHEN NEW.projection_outbox_id IS NOT OLD.projection_outbox_id
      OR NEW.operation_scope IS NOT OLD.operation_scope OR NEW.operation_key IS NOT OLD.operation_key
      OR NEW.projector_id IS NOT OLD.projector_id OR NEW.target_scope IS NOT OLD.target_scope
      OR NEW.source_sequence IS NOT OLD.source_sequence OR NEW.source_event_id IS NOT OLD.source_event_id
      OR NEW.source_entity_type IS NOT OLD.source_entity_type OR NEW.source_entity_id IS NOT OLD.source_entity_id
      OR NEW.source_revision IS NOT OLD.source_revision
    BEGIN SELECT RAISE(ABORT, 'projection outbox source identity is immutable'); END`,
  `CREATE TRIGGER projection_outbox_no_delete BEFORE DELETE ON projection_outbox
    BEGIN SELECT RAISE(ABORT, 'projection outbox fence snapshot cannot be deleted'); END`,
  `CREATE TRIGGER projector_cursor_initial_fence
    BEFORE INSERT ON projector_cursor
    WHEN NEW.fence_token <> 0 OR NEW.revision <> 0
      OR NEW.fence_reason_code IS NOT NULL
      OR NEW.fence_causation_id IS NOT NULL OR NEW.fence_operation_key IS NOT NULL
      OR NEW.fence_operation_digest IS NOT NULL OR NEW.fence_result_outbox_id IS NOT NULL
      OR NEW.fence_committed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'projector cursor authority must start at revision and fence zero'); END`,
  `CREATE TRIGGER projector_cursor_fence_transition
    BEFORE UPDATE OF revision, fence_token, fence_reason_code, fence_causation_id, fence_operation_key, fence_operation_digest, fence_result_outbox_id, fence_committed_at
    ON projector_cursor
    WHEN NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
      OR (NEW.fence_token = OLD.fence_token AND (
        NEW.fence_reason_code IS NOT OLD.fence_reason_code
        OR NEW.fence_causation_id IS NOT OLD.fence_causation_id
        OR NEW.fence_operation_key IS NOT OLD.fence_operation_key
        OR NEW.fence_operation_digest IS NOT OLD.fence_operation_digest
        OR NEW.fence_result_outbox_id IS NOT OLD.fence_result_outbox_id
        OR NEW.fence_committed_at IS NOT OLD.fence_committed_at
      ))
      OR (NEW.fence_token <> OLD.fence_token AND (
        NEW.fence_token <> OLD.fence_token + 1
        OR NEW.revision <> OLD.revision + 1
        OR NEW.fence_reason_code <> 'projection_claim'
        OR NEW.fence_causation_id IS NULL OR NEW.fence_operation_key IS NULL
        OR NEW.fence_operation_digest IS NULL OR NEW.fence_result_outbox_id IS NULL
        OR NEW.fence_committed_at IS NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid projector cursor fence transition'); END`,
  `CREATE TRIGGER projector_cursor_fence_audit
    AFTER UPDATE OF fence_token ON projector_cursor
    WHEN NEW.fence_token <> OLD.fence_token
    BEGIN
      INSERT INTO fence(
        fence_id, domain, projector_cursor_id,
        old_fence, new_fence, old_revision, new_revision,
        reason_code, causation_id, operation_key, operation_semantic_digest,
        resulting_state, claimed_projection_outbox_id,
        resulting_outbox_revision, resulting_outbox_fence,
        resulting_lease_owner, resulting_lease_until,
        result_source_sequence, result_source_event_id, result_source_entity_type,
        result_source_entity_id, result_source_revision, committed_at
      ) VALUES (
        'projector_cursor:' || NEW.projector_cursor_id || ':' || NEW.fence_token,
        'projector_cursor', NEW.projector_cursor_id,
        OLD.fence_token, NEW.fence_token, OLD.revision, NEW.revision,
        NEW.fence_reason_code, NEW.fence_causation_id, NEW.fence_operation_key,
        NEW.fence_operation_digest, 'reserved', NEW.fence_result_outbox_id,
        (SELECT revision + 1 FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        NEW.fence_token, NEW.lease_owner, NEW.lease_until,
        (SELECT source_sequence FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        (SELECT source_event_id FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        (SELECT source_entity_type FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        (SELECT source_entity_id FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        (SELECT source_revision FROM projection_outbox WHERE projection_outbox_id = NEW.fence_result_outbox_id),
        NEW.fence_committed_at
      );
    END`,
  `CREATE TRIGGER projector_cursor_identity_immutable
    BEFORE UPDATE OF projector_cursor_id, projector_id, target_scope ON projector_cursor
    WHEN NEW.projector_cursor_id IS NOT OLD.projector_cursor_id
      OR NEW.projector_id IS NOT OLD.projector_id OR NEW.target_scope IS NOT OLD.target_scope
    BEGIN SELECT RAISE(ABORT, 'projector cursor identity is immutable'); END`,
  `CREATE TRIGGER projector_cursor_no_delete BEFORE DELETE ON projector_cursor
    BEGIN SELECT RAISE(ABORT, 'projector cursor authority cannot be deleted'); END`,
  `CREATE TRIGGER work_run_parent_consistency_insert
    BEFORE INSERT ON work_run
    WHEN NEW.activity_id IS NOT NULL AND NEW.exchange_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM activity a JOIN exchange e ON e.exchange_id = NEW.exchange_id
      WHERE a.activity_id = NEW.activity_id AND a.conversation_id IS NOT NULL
        AND a.conversation_id <> e.conversation_id
    )
    BEGIN SELECT RAISE(ABORT, 'Work Run parents belong to different conversations'); END`,
  `CREATE TRIGGER work_run_initial_fence
    BEFORE INSERT ON work_run
    WHEN NEW.fence_token <> 0 OR NEW.revision <> 0
      OR NEW.fence_reason_code IS NOT NULL
      OR NEW.fence_causation_id IS NOT NULL OR NEW.fence_operation_key IS NOT NULL
      OR NEW.fence_operation_digest IS NOT NULL
      OR NEW.fence_committed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Work Run authority must start at revision and fence zero'); END`,
  `CREATE TRIGGER work_run_fence_transition
    BEFORE UPDATE OF revision, fence_token, fence_reason_code, fence_causation_id, fence_operation_key, fence_operation_digest, fence_committed_at
    ON work_run
    WHEN NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
      OR (NEW.fence_token = OLD.fence_token AND (
        NEW.fence_reason_code IS NOT OLD.fence_reason_code
        OR NEW.fence_causation_id IS NOT OLD.fence_causation_id
        OR NEW.fence_operation_key IS NOT OLD.fence_operation_key
        OR NEW.fence_operation_digest IS NOT OLD.fence_operation_digest
        OR NEW.fence_committed_at IS NOT OLD.fence_committed_at
      ))
      OR (NEW.fence_token <> OLD.fence_token AND (
        NEW.fence_token <> OLD.fence_token + 1
        OR NEW.revision <> OLD.revision + 1
        OR NEW.fence_reason_code NOT IN (
          'lease_acquired','lease_rotated','stop','cancel','restart',
          'writer_handoff','reconciliation'
        )
        OR NEW.fence_causation_id IS NULL OR NEW.fence_operation_key IS NULL
        OR NEW.fence_operation_digest IS NULL
        OR NEW.fence_committed_at IS NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid Work Run fence transition'); END`,
  `CREATE TRIGGER work_run_fence_audit
    AFTER UPDATE OF fence_token ON work_run
    WHEN NEW.fence_token <> OLD.fence_token
    BEGIN
      INSERT INTO fence(
        fence_id, domain, work_run_id,
        old_fence, new_fence, old_revision, new_revision,
        reason_code, causation_id, operation_key, operation_semantic_digest,
        resulting_state, committed_at
      ) VALUES (
        'work_run:' || NEW.work_run_id || ':' || NEW.fence_token,
        'work_run', NEW.work_run_id,
        OLD.fence_token, NEW.fence_token, OLD.revision, NEW.revision,
        NEW.fence_reason_code, NEW.fence_causation_id, NEW.fence_operation_key,
        NEW.fence_operation_digest, NEW.state, NEW.fence_committed_at
      );
    END`,
  `CREATE TRIGGER work_run_identity_immutable
    BEFORE UPDATE OF work_run_id, activity_id, exchange_id, attempt_no,
      provider_epoch_id, execution_epoch_id ON work_run
    WHEN NEW.work_run_id IS NOT OLD.work_run_id OR NEW.activity_id IS NOT OLD.activity_id
      OR NEW.exchange_id IS NOT OLD.exchange_id OR NEW.attempt_no IS NOT OLD.attempt_no
      OR NEW.provider_epoch_id IS NOT OLD.provider_epoch_id
      OR NEW.execution_epoch_id IS NOT OLD.execution_epoch_id
    BEGIN SELECT RAISE(ABORT, 'Work Run generation identity is immutable'); END`,
  `CREATE TRIGGER work_run_no_delete BEFORE DELETE ON work_run
    BEGIN SELECT RAISE(ABORT, 'Work Run authority cannot be deleted'); END`,
  `CREATE TRIGGER work_run_parent_consistency_update
    BEFORE UPDATE OF activity_id, exchange_id ON work_run
    WHEN NEW.activity_id IS NOT NULL AND NEW.exchange_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM activity a JOIN exchange e ON e.exchange_id = NEW.exchange_id
      WHERE a.activity_id = NEW.activity_id AND a.conversation_id IS NOT NULL
        AND a.conversation_id <> e.conversation_id
    )
    BEGIN SELECT RAISE(ABORT, 'Work Run parents belong to different conversations'); END`,
  `CREATE TRIGGER work_checkpoint_current_run
    BEFORE INSERT ON work_checkpoint WHEN NOT EXISTS (
      SELECT 1 FROM work_run run WHERE run.work_run_id = NEW.work_run_id
        AND run.revision = NEW.run_revision AND run.fence_token = NEW.fence_token
    )
    BEGIN SELECT RAISE(ABORT, 'checkpoint requires current Work Run revision and fence'); END`,
  `CREATE TRIGGER lease_fence_immutable
    BEFORE UPDATE OF fence_token ON lease WHEN NEW.fence_token IS NOT OLD.fence_token
    BEGIN SELECT RAISE(ABORT, 'lease captures an immutable Work Run fence'); END`,
  `CREATE TRIGGER work_checkpoint_fence_immutable
    BEFORE UPDATE OF fence_token, run_revision ON work_checkpoint
    WHEN NEW.fence_token IS NOT OLD.fence_token OR NEW.run_revision IS NOT OLD.run_revision
    BEGIN SELECT RAISE(ABORT, 'checkpoint authority snapshot is immutable'); END`,
  `CREATE TRIGGER action_intent_parent_consistency
    BEFORE INSERT ON action_intent WHEN NEW.work_run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM work_run run WHERE run.work_run_id = NEW.work_run_id AND (
        (NEW.activity_id IS NOT NULL AND run.activity_id IS NOT NEW.activity_id) OR
        (NEW.exchange_id IS NOT NULL AND run.exchange_id IS NOT NEW.exchange_id)
      )
    )
    BEGIN SELECT RAISE(ABORT, 'action intent parents do not match Work Run'); END`,
  `CREATE TRIGGER effect_attempt_current_fence
    BEFORE INSERT ON effect_attempt WHEN EXISTS (
      SELECT 1 FROM action_intent intent JOIN work_run run ON run.work_run_id = intent.work_run_id
      WHERE intent.action_intent_id = NEW.action_intent_id
        AND run.fence_token <> NEW.fence_token
    )
    BEGIN SELECT RAISE(ABORT, 'effect attempt uses stale Work Run fence'); END`,
  `CREATE TRIGGER effect_attempt_fence_immutable
    BEFORE UPDATE OF fence_token ON effect_attempt WHEN NEW.fence_token IS NOT OLD.fence_token
    BEGIN SELECT RAISE(ABORT, 'effect attempt captures an immutable Work Run fence'); END`,
  `CREATE TRIGGER soul_change_receipt_no_update BEFORE UPDATE ON soul_change_receipt
    BEGIN SELECT RAISE(ABORT, 'soul receipt is append-only'); END`,
  `CREATE TRIGGER soul_change_receipt_no_delete BEFORE DELETE ON soul_change_receipt
    BEGIN SELECT RAISE(ABORT, 'soul receipt is append-only'); END`,
  `CREATE TRIGGER soul_change_receipt_invalidation_active_guard
    BEFORE INSERT ON soul_change_receipt
    WHEN NEW.outcome = 'invalidated' AND EXISTS (
      SELECT 1 FROM soul_revision revision
      JOIN living_identity identity ON identity.active_soul_revision_id = revision.soul_revision_id
      WHERE revision.activation_receipt_id = NEW.invalidates_receipt_id
        AND revision.state = 'active'
    )
    BEGIN SELECT RAISE(ABORT, 'active Soul receipt cannot be invalidated before revocation'); END`,
  `CREATE TRIGGER soul_revision_no_direct_active
    BEFORE INSERT ON soul_revision WHEN NEW.state = 'active'
    BEGIN SELECT RAISE(ABORT, 'Soul revision cannot be inserted active'); END`,
  `CREATE TRIGGER soul_revision_state_transition
    BEFORE UPDATE OF state ON soul_revision
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state = 'draft' AND NEW.state IN ('validated','rejected','revoked')) OR
      (OLD.state = 'validated' AND NEW.state IN ('activating','revoked')) OR
      (OLD.state = 'activating' AND NEW.state IN ('active','validated','revoked')) OR
      (OLD.state = 'active' AND NEW.state IN ('superseded','revoked'))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid Soul revision state transition'); END`,
  `CREATE TRIGGER soul_revision_state_audit
    BEFORE UPDATE OF state ON soul_revision
    WHEN NEW.state <> OLD.state AND (
      NEW.state_revision <> OLD.state_revision + 1 OR
      NEW.state_causation_event_id IS NULL OR length(trim(NEW.state_causation_event_id)) = 0
    )
    BEGIN SELECT RAISE(ABORT, 'Soul state transition requires revision and causation'); END`,
  `CREATE TRIGGER soul_revision_content_immutable
    BEFORE UPDATE OF identity_id, parent_revision_id, content_ref, content_hash, revision, created_at ON soul_revision
    BEGIN SELECT RAISE(ABORT, 'Soul revision content and lineage are immutable'); END`,
  `CREATE TRIGGER soul_revision_activation_receipt_immutable
    BEFORE UPDATE OF activation_receipt_id ON soul_revision
    WHEN OLD.state = 'active' AND NEW.activation_receipt_id IS NOT OLD.activation_receipt_id
    BEGIN SELECT RAISE(ABORT, 'active Soul activation receipt is immutable'); END`,
  `CREATE TRIGGER soul_revision_active_receipt
    BEFORE UPDATE OF state, activation_receipt_id ON soul_revision
    WHEN NEW.state = 'active' AND NOT EXISTS (
      SELECT 1 FROM soul_change_receipt receipt
      WHERE receipt.soul_change_receipt_id = NEW.activation_receipt_id
        AND receipt.identity_id = NEW.identity_id
        AND receipt.new_soul_revision_id = NEW.soul_revision_id
        AND receipt.outcome = 'success'
        AND length(trim(receipt.expected_hash)) > 0
        AND length(trim(receipt.actual_hash)) > 0
        AND receipt.expected_hash = receipt.actual_hash
        AND receipt.expected_hash = NEW.content_hash
        AND NOT EXISTS (
          SELECT 1 FROM soul_change_receipt invalidation
          WHERE invalidation.invalidates_receipt_id = receipt.soul_change_receipt_id
            AND invalidation.outcome = 'invalidated'
        )
    )
    BEGIN SELECT RAISE(ABORT, 'successful Soul activation receipt required'); END`,
  `CREATE TRIGGER living_identity_active_soul_pointer_insert
    BEFORE INSERT ON living_identity WHEN NEW.active_soul_revision_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'active Soul pointer cannot be set during identity insert'); END`,
  `CREATE TRIGGER living_identity_active_soul_pointer_update
    BEFORE UPDATE OF active_soul_revision_id ON living_identity
    WHEN NEW.active_soul_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM soul_revision revision
      JOIN soul_change_receipt receipt ON receipt.soul_change_receipt_id = revision.activation_receipt_id
      WHERE revision.soul_revision_id = NEW.active_soul_revision_id
        AND revision.identity_id = NEW.identity_id
        AND revision.state = 'active'
        AND receipt.identity_id = NEW.identity_id
        AND receipt.new_soul_revision_id = revision.soul_revision_id
        AND receipt.outcome = 'success'
        AND receipt.expected_hash = receipt.actual_hash
        AND receipt.expected_hash = revision.content_hash
        AND NOT EXISTS (
          SELECT 1 FROM soul_change_receipt invalidation
          WHERE invalidation.invalidates_receipt_id = receipt.soul_change_receipt_id
            AND invalidation.outcome = 'invalidated'
        )
    )
    BEGIN SELECT RAISE(ABORT, 'active Soul pointer requires matching successful receipt'); END`,
]);

export const CORE_SCHEMA_V2 = Object.freeze([
  `CREATE TABLE schedule_spec_revision (
    schedule_spec_revision_id TEXT PRIMARY KEY,
    schedule_spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    recurrence_kind TEXT NOT NULL CHECK(recurrence_kind IN ('one_shot','interval','daily')),
    recurrence_json TEXT NOT NULL CHECK(length(trim(recurrence_json)) > 0),
    task_kind TEXT NOT NULL CHECK(task_kind IN ('scheduled_instruction','system_maintenance','external_poll')),
    payload_ref TEXT NOT NULL CHECK(length(trim(payload_ref)) > 0),
    catch_up_policy TEXT NOT NULL CHECK(catch_up_policy IN ('skip','latest','bounded')),
    catch_up_limit INTEGER NOT NULL CHECK(typeof(catch_up_limit) = 'integer' AND catch_up_limit BETWEEN 1 AND 8),
    activity_contract_revision INTEGER NOT NULL CHECK(activity_contract_revision >= 0),
    operation_key TEXT NOT NULL CHECK(${fenceOperationKeyCheck('operation_key')}),
    semantic_digest TEXT NOT NULL CHECK(${operationSemanticDigestCheck('semantic_digest')}),
    causation_id TEXT NOT NULL,
    conversation_id TEXT,
    presentation_binding_id TEXT,
    expected_binding_revision INTEGER CHECK(expected_binding_revision IS NULL OR expected_binding_revision >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(schedule_spec_id, revision),
    UNIQUE(schedule_spec_id, operation_key),
    UNIQUE(schedule_spec_revision_id, schedule_spec_id),
    FOREIGN KEY (schedule_spec_id) REFERENCES schedule_spec(schedule_spec_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (causation_id) REFERENCES journal_event(journal_event_id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id),
    FOREIGN KEY (presentation_binding_id, conversation_id)
      REFERENCES presentation_binding(presentation_binding_id, conversation_id),
    CHECK(
      (conversation_id IS NULL AND presentation_binding_id IS NULL AND expected_binding_revision IS NULL) OR
      (conversation_id IS NOT NULL AND presentation_binding_id IS NOT NULL
        AND expected_binding_revision IS NOT NULL AND task_kind = 'scheduled_instruction')
    )
  ) STRICT`,
  `CREATE TABLE schedule_spec (
    schedule_spec_id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    current_revision_id TEXT NOT NULL,
    next_due_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('enabled','exhausted','retired')),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (activity_id) REFERENCES activity(activity_id),
    FOREIGN KEY (current_revision_id, schedule_spec_id)
      REFERENCES schedule_spec_revision(schedule_spec_revision_id, schedule_spec_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK((state = 'enabled') = (next_due_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE wake_occurrence (
    wake_occurrence_id TEXT PRIMARY KEY,
    schedule_spec_id TEXT NOT NULL,
    schedule_spec_revision_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(schedule_spec_id, scheduled_for),
    FOREIGN KEY (schedule_spec_id) REFERENCES schedule_spec(schedule_spec_id),
    FOREIGN KEY (schedule_spec_revision_id, schedule_spec_id)
      REFERENCES schedule_spec_revision(schedule_spec_revision_id, schedule_spec_id)
  ) STRICT`,
  `ALTER TABLE work_run ADD COLUMN wake_occurrence_id TEXT REFERENCES wake_occurrence(wake_occurrence_id)`,
  `CREATE INDEX schedule_due ON schedule_spec(state, next_due_at, schedule_spec_id)`,
  `CREATE INDEX wake_occurrence_schedule ON wake_occurrence(schedule_spec_id, scheduled_for)`,
  `CREATE TRIGGER schedule_spec_revision_no_update BEFORE UPDATE ON schedule_spec_revision
    BEGIN SELECT RAISE(ABORT, 'schedule spec revision is append-only'); END`,
  `CREATE TRIGGER schedule_spec_revision_no_delete BEFORE DELETE ON schedule_spec_revision
    BEGIN SELECT RAISE(ABORT, 'schedule spec revision is append-only'); END`,
  `CREATE TRIGGER wake_occurrence_no_update BEFORE UPDATE ON wake_occurrence
    BEGIN SELECT RAISE(ABORT, 'wake occurrence is append-only'); END`,
  `CREATE TRIGGER wake_occurrence_no_delete BEFORE DELETE ON wake_occurrence
    BEGIN SELECT RAISE(ABORT, 'wake occurrence is append-only'); END`,
  `CREATE TRIGGER work_run_occurrence_immutable
    BEFORE UPDATE OF wake_occurrence_id ON work_run
    WHEN NEW.wake_occurrence_id IS NOT OLD.wake_occurrence_id
    BEGIN SELECT RAISE(ABORT, 'Work Run occurrence binding is immutable'); END`,
]);
