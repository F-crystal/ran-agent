#!/usr/bin/env node

// This is intentionally a no-egress acceptance journey.  It opens the actual
// staged broker against the deployed registry, reads resumable activity state,
// then closes it without selecting or calling any MCP provider.
import { createHash } from 'node:crypto';

import { protectedCapabilityCollision } from '../node_bridge/src/externalMcp/protectedCapabilities.mjs';
import { listEnabledExternalMcpManifests } from '../node_bridge/src/externalMcp/registry.mjs';
import { createExternalMcpAutonomyRuntime } from '../node_bridge/src/externalMcp/runtime.mjs';

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

const manifests = listEnabledExternalMcpManifests();
if (manifests.some((manifest) => protectedCapabilityCollision(manifest?.id))) {
  process.stderr.write('hermes-release-runtime-journey: failed:protected_capability_collision\n');
  process.exitCode = 1;
} else {
  const runtime = createExternalMcpAutonomyRuntime();
  try {
    const activities = runtime.store.list();
    const active = activities.filter((activity) => activity.status === 'active');
    // Starting an idle broker proves the staged start/stop path without
    // waking a real provider or mutating an in-progress owner activity.
    if (active.length === 0) await runtime.start();
    const resumable = activities.filter((activity) => activity.status === 'active'
      && activity?.coreJobReceipt?.jobId && activity?.checkpoint?.phase);
    const fingerprint = digest(JSON.stringify({
      manifests: manifests.map((manifest) => manifest.id).sort(),
      resumable: resumable.map((activity) => activity.activityId).sort(),
    }));
    process.stdout.write(`hermes-release-runtime-journey: ok configured=${manifests.length} resumable=${resumable.length} redacted=${fingerprint}\n`);
  } finally {
    runtime.stop();
  }
}
