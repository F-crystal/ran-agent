import { canonicalDigest, deepFreezeClone } from './canonical.mjs';
import { COMPAT_UPSTREAM_VERSION } from './constants.mjs';

export const UNBOUND_REQUIRED_BEFORE_O2 = 'UNBOUND_REQUIRED_BEFORE_O2';

const GROWTH_ROWS = [
  'append_experience',
  'append_association',
  'append_low_impact_preference_observation',
  'append_i_observation_candidate',
  'append_correction_or_supersession_observation',
].map((internal_method) => ({
  internal_method,
  steward_method: internal_method,
  endpoint: 'mutate',
  disposition: 'allow',
  reconciliation_method: 'reconcile_operation',
}));

const LIFECYCLE_ROWS = [
  ['suppress_projection', 'suppress'],
  ['tombstone_projection', 'tombstone'],
  ['total_delete_projection', 'total_delete'],
].map(([internal_method, steward_method]) => ({
  internal_method,
  steward_method,
  endpoint: 'mutate',
  disposition: steward_method === 'total_delete' ? 'typed_unsupported' : 'allow',
  reconciliation_method: 'reconcile_operation',
}));

export const GROWTH_METHOD_MANIFEST = deepFreezeClone(GROWTH_ROWS);
export const LIFECYCLE_METHOD_MANIFEST = deepFreezeClone(LIFECYCLE_ROWS);

export function adapterPolicyDigest() {
  return canonicalDigest({
    upstream_version: COMPAT_UPSTREAM_VERSION,
    api_version: 'ombre.steward-api/1',
    growth_manifest: GROWTH_METHOD_MANIFEST,
    lifecycle_manifest: LIFECYCLE_METHOD_MANIFEST,
  });
}

export function resolveGrowthMethod(name) {
  return GROWTH_METHOD_MANIFEST.find((row) => row.internal_method === String(name || '')) ?? null;
}

export function resolveLifecycleMethod(name) {
  return LIFECYCLE_METHOD_MANIFEST.find((row) => row.internal_method === String(name || '')) ?? null;
}

export function isBound(method) {
  return Boolean(method) && ['allow', 'typed_unsupported'].includes(method.disposition);
}
