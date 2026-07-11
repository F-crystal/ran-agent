import { createHash } from 'node:crypto';


const ADAPTER_ID = 'generic-mcp-adapter';
const ADAPTER_VERSION = '1';
const MAX_TEXT_CHARS = 16_384;
const MAX_ARGUMENT_BYTES = 32_768;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const READ_NAME = /^(?:list|get|read|search|find|fetch|inspect|observe|status|state|guide|describe|resolve)(?:_|$)/i;
const OBSERVE_NAME = /(?:^|_)(?:observe|status|state|inspect|snapshot|current)(?:_|$)/i;
const WRITE_NAME = /^(?:play|move|act|advance|save|create|update|set|write|submit|start|resume|pause|stop)(?:_|$)/i;
const BOUNDARY_NAME = /(?:^|_)(?:account|login|logout|auth|credential|payment|purchase|trade|delete|remove|terminal|shell|command|file|upload|send|message|post|comment|follow|react|physical|device|robot)(?:_|$)/i;
const OPERATION_ID_FIELDS = ['operationId', 'operation_id', 'idempotencyKey', 'idempotency_key', 'requestId', 'request_id'];
const BRIDGE_RESULTS = new WeakMap();


export function createGenericMcpAdapter(discovery = {}, options = {}) {
  return new GenericMcpAdapter(discovery, options);
}


// The runtime binds bridge results by object identity. A remote MCP may return
// arbitrary JSON, so a public marker field would be forgeable evidence.
export function bindGenericMcpBrokerResult(value, broker) {
  if (!value || typeof value !== 'object' || !broker || typeof broker !== 'object') {
    throw new TypeError('bridge result and broker response must be objects');
  }
  BRIDGE_RESULTS.set(value, broker);
  return value;
}


export class GenericMcpAdapter {
  constructor(discovery = {}, options = {}) {
    this.options = options;
    this.initializeResult = {};
    this.tools = [];
    this.actions = new Map();
    this.operations = new Map();
    this.scope = emptyScope();
    this._descriptor = {};
    this.refreshDiscovery(discovery);
  }

  get descriptor() {
    return this._descriptor;
  }

  refreshDiscovery(discovery = {}) {
    if (discovery.initializeResult && typeof discovery.initializeResult === 'object') {
      this.initializeResult = discovery.initializeResult;
    }
    if (Object.hasOwn(discovery, 'toolsResult')) {
      this.tools = normalizeTools(discovery.toolsResult);
    }
    this.actions.clear();
    this._descriptor = buildDescriptor(this.initializeResult, this.tools);
    return this._descriptor;
  }

  resolveScope(goal = {}, manifest = {}, trustedContext = {}) {
    const requestedResourceId = cleanText(goal.resourceId || goal.resource_id || goal.resourceScope || '', 240);
    const allowedResourceIds = Array.isArray(trustedContext.allowedResourceIds)
      ? trustedContext.allowedResourceIds.map((item) => cleanText(item, 240)).filter(Boolean)
      : [];
    const resourceTrusted = !requestedResourceId
      || allowedResourceIds.length === 0
      || allowedResourceIds.includes(requestedResourceId);
    const parameters = boundedObject(goal.parameters || {});
    this.scope = {
      serverId: cleanText(manifest.id || manifest.serverId || this._descriptor.serverInfo.name || '', 120),
      resourceId: resourceTrusted ? requestedResourceId : '',
      parameters,
      mode: resourceTrusted ? this._descriptor.mode : 'constrained',
      constraints: resourceTrusted ? [...this._descriptor.constraints] : [...this._descriptor.constraints, 'scope_not_trusted'],
    };
    return { ...this.scope, parameters: { ...parameters }, constraints: [...this.scope.constraints] };
  }

  async observe(resourceScope = {}, session = {}, transport) {
    const scope = {
      ...this.scope,
      ...(resourceScope && typeof resourceScope === 'object' ? resourceScope : {}),
      parameters: boundedObject(resourceScope?.parameters || this.scope.parameters || {}),
    };
    const explicitName = cleanText(session.observeToolName || session.observe_tool_name || '', 160);
    const observationTool = this.tools.find((tool) => (
      tool.effect === 'read'
      && (explicitName ? tool.name === explicitName : OBSERVE_NAME.test(tool.name))
    ));
    const caller = transportCall(transport);

    if (observationTool && caller) {
      const compiled = compileArguments(observationTool.inputSchema, {}, scope.parameters);
      if (compiled.ok) {
        try {
          const raw = await caller({ toolName: observationTool.name, arguments: compiled.arguments });
          return buildObservation(normalizeEvidence(raw), observationTool);
        } catch {
          // A failed optional observation degrades to the last bounded result.
        }
      }
    }

    return {
      ...buildObservation(normalizeEvidence(session.lastResult), null),
      quality: 'opaque',
      source: session.lastResult === undefined ? 'no_observe_capability' : 'last_result',
      constrained: true,
    };
  }

  legalActions(goal = {}, observation = {}, riskEnvelope = {}) {
    this.actions.clear();
    const allowedEffects = new Set(
      Array.isArray(riskEnvelope.allowedEffects) ? riskEnvelope.allowedEffects.map(String) : ['read'],
    );
    const boundaryGrants = new Set(
      Array.isArray(riskEnvelope.boundaryGrants) ? riskEnvelope.boundaryGrants.map(String) : [],
    );
    const sharedParameters = {
      ...(this.scope.parameters && typeof this.scope.parameters === 'object' ? this.scope.parameters : {}),
      ...(goal.parameters && typeof goal.parameters === 'object' ? goal.parameters : {}),
    };
    const perTool = goal.toolArguments && typeof goal.toolArguments === 'object'
      ? goal.toolArguments
      : {};
    const suggested = observation.suggestedArguments && typeof observation.suggestedArguments === 'object'
      ? observation.suggestedArguments
      : {};
    const publicActions = [];

    for (const tool of this.tools) {
      const explicit = {
        ...(suggested[tool.name] && typeof suggested[tool.name] === 'object' ? suggested[tool.name] : {}),
        ...(perTool[tool.name] && typeof perTool[tool.name] === 'object' ? perTool[tool.name] : {}),
      };
      const compiled = compileArguments(tool.inputSchema, explicit, sharedParameters);
      if (!compiled.ok) continue;

      const needsBoundary = tool.effect === 'unknown' || tool.effect === 'boundary' || tool.effect === 'destructive';
      const boundaryGranted = boundaryGrants.has(tool.name) || boundaryGrants.has(tool.effect);
      let availability = 'available';
      if (needsBoundary && !boundaryGranted) availability = 'needs_boundary';
      else if (!allowedEffects.has(tool.effect) && !(tool.effect === 'boundary' && allowedEffects.has('write'))) {
        if (needsBoundary) availability = 'needs_boundary';
        else continue;
      }

      const actionId = `action_${digest({
        manifestHash: this._descriptor.manifestHash,
        toolName: tool.name,
        arguments: compiled.arguments,
      }).slice(0, 24)}`;
      const action = {
        actionId,
        toolName: tool.name,
        label: tool.title || tool.name,
        effect: tool.effect,
        availability,
        requiresBoundary: needsBoundary,
        idempotent: tool.idempotent,
      };
      this.actions.set(actionId, { ...action, nativeArguments: compiled.arguments, tool });
      publicActions.push(action);
    }
    return publicActions;
  }

  // Bridge-only preparation: normalized actions remain the only model-facing
  // handle, while the supervisor can durably bind the discovered native call.
  operationContext(actionId) {
    const action = this.actions.get(String(actionId || ''));
    if (!action) return null;
    return {
      toolName: action.toolName,
      arguments: structuredClone(action.nativeArguments),
    };
  }

  async execute(actionId, operationId, transport) {
    if (typeof actionId !== 'string' || !actionId.startsWith('action_')) {
      throw new TypeError('execute accepts one normalized actionId string');
    }
    const normalizedOperationId = cleanText(operationId, 240);
    if (!normalizedOperationId) throw new TypeError('operationId is required');
    const existing = this.operations.get(normalizedOperationId);
    if (existing) {
      if (existing.actionId !== actionId) throw new Error('operationId is already bound to another action');
      return { ...existing, duplicate: true };
    }
    const action = this.actions.get(actionId);
    if (!action) throw new Error('normalized actionId is unknown or stale');

    if (action.availability === 'needs_boundary') {
      const receipt = {
        actionId,
        operationId: normalizedOperationId,
        toolName: action.toolName,
        effect: action.effect,
        outcome: 'needs_boundary',
        retry: 'forbidden',
      };
      this.operations.set(normalizedOperationId, receipt);
      return receipt;
    }

    const caller = transportCall(transport);
    if (!caller) throw new TypeError('transport.call is required');
    const nativeArguments = withOperationId(action.tool, action.nativeArguments, normalizedOperationId);
    if (!validateArguments(action.tool.inputSchema, nativeArguments)) {
      throw new Error('compiled native arguments no longer match the discovered schema');
    }

    let receipt;
    try {
      const raw = await caller({
        toolName: action.toolName,
        arguments: nativeArguments,
        operationId: normalizedOperationId,
      });
      const broker = brokerResult(raw);
      const evidence = normalizeEvidence(broker?.result ?? raw);
      const observation = buildObservation(evidence, action.tool);
      const outcome = broker
        ? brokerOutcome(broker, action.effect)
        : evidence.error
        ? (action.effect === 'read' ? 'failed' : 'unknown')
        : evidence.format === 'malformed'
          ? (action.effect === 'read' ? 'failed' : 'unknown')
          : action.effect === 'unknown'
            ? 'unknown'
            : 'applied';
      receipt = {
        actionId,
        operationId: normalizedOperationId,
        toolName: action.toolName,
        effect: action.effect,
        outcome,
        retry: retryDisposition(action, outcome),
        evidence,
        observation,
        ...(broker?.receipt ? {
          brokerReceipt: broker.receipt,
          evidenceRef: cleanText(broker.receipt.evidenceRef || broker.receipt.evidence_ref, 240),
        } : {}),
      };
    } catch {
      const outcome = action.effect === 'read' ? 'failed' : 'unknown';
      receipt = {
        actionId,
        operationId: normalizedOperationId,
        toolName: action.toolName,
        effect: action.effect,
        outcome,
        retry: retryDisposition(action, outcome),
        evidence: {
          format: 'transport_error',
          text: '',
          data: null,
          untrusted: true,
          error: true,
        },
        observation: {
          quality: 'opaque',
          source: 'transport_error',
          constrained: true,
          evidence: null,
          terminal: null,
        },
      };
    }
    this.operations.set(normalizedOperationId, receipt);
    return receipt;
  }

  reconcile(operationId, observation = {}) {
    const normalizedOperationId = cleanText(operationId, 240);
    if (!normalizedOperationId || !this.operations.has(normalizedOperationId)) return 'unknown';
    const data = observation?.evidence?.data || observation?.data || observation?.structuredContent || {};
    const applied = operationIds(data, ['appliedOperationIds', 'applied_operation_ids']);
    if (applied.includes(normalizedOperationId)) return 'applied';
    const notApplied = operationIds(data, ['notAppliedOperationIds', 'not_applied_operation_ids']);
    if (notApplied.includes(normalizedOperationId)) return 'not_applied';
    if (cleanText(data.operationId || data.operation_id, 240) === normalizedOperationId) {
      const state = cleanText(data.outcome || data.status, 80).toLowerCase();
      if (['applied', 'succeeded', 'success'].includes(state)) return 'applied';
      if (['not_applied', 'rejected', 'cancelled', 'canceled'].includes(state)) return 'not_applied';
    }
    return 'unknown';
  }

  classify(goal = {}, observation = {}, operationResult = {}) {
    const goalState = cleanText(goal.status || goal.state, 80).toLowerCase();
    if (goalState === 'stopped' || goalState === 'expired') return { status: goalState };
    if (operationResult.outcome === 'needs_boundary') return { status: 'blocked', reason: 'needs_boundary' };
    if (operationResult.outcome === 'unknown') return { status: 'blocked', reason: 'ambiguous_operation' };
    if (operationResult.outcome === 'failed') return { status: 'blocked', reason: 'operation_failed' };
    if (this._descriptor.capabilities.typedTerminal && observation.terminal === true) {
      return { status: 'completed', reason: 'typed_terminal' };
    }
    return {
      status: 'ongoing',
      progress: operationResult.outcome === 'applied' ? 'progress' : 'unknown',
      reason: this._descriptor.capabilities.typedTerminal ? 'terminal_not_reached' : 'no_typed_terminal',
    };
  }
}


function buildDescriptor(initializeResult, tools) {
  const serverInfo = {
    name: cleanText(initializeResult?.serverInfo?.name, 160),
    version: cleanText(initializeResult?.serverInfo?.version, 80),
  };
  const capabilities = {
    observe: tools.some((tool) => tool.effect === 'read' && OBSERVE_NAME.test(tool.name)),
    typedTerminal: tools.some((tool) => schemaHasTerminal(tool.outputSchema)),
    idempotency: tools.some((tool) => tool.idempotent),
    reconcile: tools.some((tool) => /(?:^|_)(?:reconcile|operation_status|check_operation|get_operation)(?:_|$)/i.test(tool.name)),
    dynamicTools: Boolean(initializeResult?.capabilities?.tools?.listChanged),
  };
  const constraints = [];
  if (tools.length === 0) constraints.push('no_tools');
  if (tools.some((tool) => !tool.hasAnnotations)) constraints.push('missing_annotations');
  if (!capabilities.observe) constraints.push('no_observe');
  if (!capabilities.typedTerminal) constraints.push('no_typed_terminal');
  if (!capabilities.idempotency) constraints.push('no_idempotency');
  if (!capabilities.reconcile) constraints.push('no_reconcile');
  if (tools.some((tool) => tool.effect === 'unknown')) constraints.push('unknown_effect');
  const sanitizedTools = tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: stableValue(tool.inputSchema),
    outputSchema: stableValue(tool.outputSchema),
    annotations: stableValue(tool.annotations),
    effect: tool.effect,
    idempotent: tool.idempotent,
  }));
  return {
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    connected: true,
    mode: constraints.length ? 'constrained' : 'active',
    serverInfo,
    toolCount: tools.length,
    capabilities,
    constraints,
    manifestHash: digest({ serverInfo, tools: sanitizedTools }),
  };
}


function normalizeTools(toolsResult) {
  const rawTools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
  return rawTools
    .filter((tool) => tool && typeof tool === 'object' && cleanText(tool.name, 160))
    .slice(0, 500)
    .map((tool) => {
      const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', additionalProperties: true };
      const outputSchema = tool.outputSchema && typeof tool.outputSchema === 'object'
        ? tool.outputSchema
        : null;
      const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
      const name = cleanText(tool.name, 160);
      return {
        name,
        title: cleanText(tool.title, 200),
        description: cleanText(tool.description, 2_000),
        inputSchema,
        outputSchema,
        annotations,
        hasAnnotations: Boolean(tool.annotations && typeof tool.annotations === 'object'),
        effect: classifyEffect(name, annotations),
        // MCP annotations are server-provided metadata. They can make a tool
        // more conservative, but never establish idempotency for retries.
        idempotent: schemaHasOperationId(inputSchema),
      };
    });
}


function classifyEffect(name, annotations) {
  // An untrusted annotation may tighten classification, never lower it.
  if (annotations.destructiveHint === true) return 'destructive';
  if (BOUNDARY_NAME.test(name)) return 'boundary';
  if (READ_NAME.test(name)) return 'read';
  if (WRITE_NAME.test(name)) return 'write';
  return 'unknown';
}


function brokerResult(value) {
  return BRIDGE_RESULTS.get(value) || null;
}


function brokerOutcome(broker, effect) {
  if (broker.ok === true) return 'applied';
  const outcome = cleanText(broker.outcome, 80).toLowerCase();
  if (['needs_boundary', 'unknown', 'not_applied'].includes(outcome)) return outcome;
  return effect === 'read' ? 'failed' : 'unknown';
}


function compileArguments(schema, explicit, shared) {
  const safeExplicit = strictArgumentObject(explicit);
  const safeShared = strictArgumentObject(shared);
  if (!safeExplicit || !safeShared) return { ok: false };
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const args = {};
  for (const [name, propertySchema] of Object.entries(properties).slice(0, MAX_OBJECT_KEYS)) {
    if (Object.hasOwn(safeExplicit, name)) args[name] = safeExplicit[name];
    else if (Object.hasOwn(safeShared, name)) args[name] = safeShared[name];
    else if (propertySchema && typeof propertySchema === 'object' && Object.hasOwn(propertySchema, 'const')) args[name] = propertySchema.const;
    else if (propertySchema && typeof propertySchema === 'object' && Object.hasOwn(propertySchema, 'default')) args[name] = propertySchema.default;
  }
  if (schema?.additionalProperties !== false) {
    for (const [name, value] of Object.entries(safeExplicit)) {
      if (!Object.hasOwn(args, name)) args[name] = value;
    }
  }
  const nativeArguments = strictArgumentObject(args);
  if (!nativeArguments || Buffer.byteLength(JSON.stringify(nativeArguments), 'utf8') > MAX_ARGUMENT_BYTES) return { ok: false };
  return validateArguments(schema, nativeArguments) ? { ok: true, arguments: nativeArguments } : { ok: false };
}


function validateArguments(schema, value, depth = 0, seen = new WeakMap()) {
  if (!schema || typeof schema !== 'object') return isBoundedValue(value);
  if (depth > MAX_DEPTH) return isBoundedValue(value);
  if (schema.const !== undefined && !Object.is(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((item) => validateArguments(item, value, depth + 1, seen));
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter((item) => validateArguments(item, value, depth + 1, seen)).length === 1;
  const type = Array.isArray(schema.type) ? schema.type : [schema.type || inferredType(value)];
  if (!type.some((item) => valueMatchesType(value, item))) return false;
  if (value === null || typeof value !== 'object') return validateScalar(schema, value);
  if (seen.get(schema) === value) return true;
  seen.set(schema, value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return false;
    if (schema.items) return value.every((item) => validateArguments(schema.items, item, depth + 1, seen));
    return true;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) return false;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((name) => !Object.hasOwn(value, name))) return false;
  if (schema.additionalProperties === false && keys.some((name) => !Object.hasOwn(properties, name))) return false;
  for (const key of keys) {
    const propertySchema = properties[key];
    if (propertySchema && !validateArguments(propertySchema, value[key], depth + 1, seen)) return false;
    if (!propertySchema && schema.additionalProperties && typeof schema.additionalProperties === 'object'
      && !validateArguments(schema.additionalProperties, value[key], depth + 1, seen)) return false;
  }
  return true;
}


function validateScalar(schema, value) {
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT_CHARS) return false;
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) return false;
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return false;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return false;
  }
  return true;
}


function withOperationId(tool, args, operationId) {
  const properties = tool.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
  const field = OPERATION_ID_FIELDS.find((name) => Object.hasOwn(properties, name));
  return field && !Object.hasOwn(args, field) ? { ...args, [field]: operationId } : { ...args };
}


function normalizeEvidence(raw) {
  if (typeof raw === 'string') return textEvidence(raw);
  if (!raw || typeof raw !== 'object') return malformedEvidence(raw);
  const error = raw.isError === true || Boolean(raw.error);
  const structured = raw.structuredContent && typeof raw.structuredContent === 'object'
    ? boundedClone(raw.structuredContent)
    : null;
  const content = Array.isArray(raw.content) ? raw.content : [];
  const textParts = content
    .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  if (structured) {
    return {
      format: 'structured',
      text: cleanText(textParts.join('\n'), MAX_TEXT_CHARS),
      data: structured,
      untrusted: true,
      error,
    };
  }
  if (textParts.length) return { ...textEvidence(textParts.join('\n')), error };
  return malformedEvidence(raw, error);
}


function textEvidence(text) {
  return {
    format: 'text',
    text: cleanText(text, MAX_TEXT_CHARS),
    data: null,
    untrusted: true,
    error: false,
  };
}


function malformedEvidence(raw, error = false) {
  return {
    format: 'malformed',
    text: '',
    data: raw && typeof raw === 'object' ? boundedClone(raw) : null,
    untrusted: true,
    error,
  };
}


function buildObservation(evidence, tool) {
  const terminal = tool && schemaHasTerminal(tool.outputSchema)
    ? extractTerminal(evidence.data)
    : null;
  return {
    quality: evidence.format === 'structured' ? 'structured' : evidence.format === 'text' ? 'text' : 'opaque',
    source: tool?.name || 'bounded_result',
    constrained: evidence.format !== 'structured',
    evidence,
    terminal,
  };
}


function extractTerminal(data) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['terminal', 'done', 'completed', 'is_over']) {
    if (typeof data[key] === 'boolean') return data[key];
  }
  const status = cleanText(data.status, 80).toLowerCase();
  if (['completed', 'complete', 'won', 'lost', 'terminal'].includes(status)) return true;
  return null;
}


function schemaHasTerminal(schema, depth = 0, seen = new WeakSet()) {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH || seen.has(schema)) return false;
  seen.add(schema);
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  if (['terminal', 'done', 'completed', 'is_over'].some((name) => Object.hasOwn(properties, name))) return true;
  const statusEnum = properties.status?.enum;
  if (Array.isArray(statusEnum) && statusEnum.some((item) => ['completed', 'complete', 'won', 'lost', 'terminal'].includes(String(item).toLowerCase()))) return true;
  return Object.values(properties).some((item) => schemaHasTerminal(item, depth + 1, seen));
}


function schemaHasOperationId(schema) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  return OPERATION_ID_FIELDS.some((name) => Object.hasOwn(properties, name));
}


function retryDisposition(action, outcome) {
  if (outcome === 'applied') return 'not_needed';
  if (action.effect === 'read') return 'allowed';
  if (outcome === 'unknown' && !action.idempotent) return 'forbidden';
  return action.idempotent ? 'same_operation_id_only' : 'forbidden';
}


function operationIds(data, names) {
  if (!data || typeof data !== 'object') return [];
  for (const name of names) {
    if (Array.isArray(data[name])) return data[name].map((item) => cleanText(item, 240));
  }
  return [];
}


function transportCall(transport) {
  if (typeof transport === 'function') return transport;
  if (transport && typeof transport.call === 'function') return transport.call.bind(transport);
  return null;
}


function boundedObject(value) {
  const bounded = boundedClone(value);
  return bounded && typeof bounded === 'object' && !Array.isArray(bounded) ? bounded : {};
}


function strictArgumentObject(value) {
  try {
    const cloned = strictArgumentClone(value);
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : null;
  } catch {
    return null;
  }
}


function strictArgumentClone(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT_CHARS) throw new RangeError('argument string is too long');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('argument number must be finite');
    return value;
  }
  if (typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) {
    throw new TypeError('argument value is unsupported, too deep, or recursive');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new RangeError('argument array is too long');
    return value.map((item) => strictArgumentClone(item, depth + 1, seen));
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new RangeError('argument object has too many keys');
  const output = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 160) throw new RangeError('argument key is invalid');
    output[key] = strictArgumentClone(item, depth + 1, seen);
  }
  return output;
}


function boundedClone(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanText(value, MAX_TEXT_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundedClone(item, depth + 1, seen));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[cleanText(key, 160)] = boundedClone(item, depth + 1, seen);
  }
  return output;
}


function isBoundedValue(value) {
  try {
    return Buffer.byteLength(JSON.stringify(boundedClone(value)), 'utf8') <= MAX_ARGUMENT_BYTES;
  } catch {
    return false;
  }
}


function stableValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return cleanText(value, MAX_TEXT_CHARS);
  if (typeof value !== 'object' || depth > MAX_DEPTH) return null;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => stableValue(item, depth + 1, seen));
  return Object.fromEntries(
    Object.keys(value).sort().slice(0, MAX_OBJECT_KEYS).map((key) => [key, stableValue(value[key], depth + 1, seen)]),
  );
}


function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}


function cleanText(value, maxChars) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxChars);
}


function inferredType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}


function valueMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string' || type === 'boolean') return typeof value === type;
  return true;
}


function emptyScope() {
  return { serverId: '', resourceId: '', parameters: {}, mode: 'constrained', constraints: [] };
}
