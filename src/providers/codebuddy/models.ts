import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';

export interface CodeBuddyReasoningEffort {
  description?: string;
  label: string;
  value: string;
}

export interface CodeBuddyDiscoveredModel {
  contextWindow?: number;
  defaultReasoningEffort?: string;
  description?: string;
  displayName: string;
  rawId: string;
  reasoningMetadataResolved?: boolean;
  reasoningEfforts: CodeBuddyReasoningEffort[];
  supportsImages?: boolean;
  supportsReasoning: boolean;
}

export const CODEBUDDY_MODEL_PREFIX = 'codebuddy/';

/** CodeBuddy advertises `enabled` as "use the model default", so it is not an explicit effort. */
const CODEBUDDY_REASONING_EFFORT_ORDER = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function isCodeBuddyModelSelectionId(model: string): boolean {
  return decodeCodeBuddyModelId(model.trim()) !== null;
}

export function encodeCodeBuddyModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === CODEBUDDY_MODEL_PREFIX) {
    return '';
  }
  return normalized.startsWith(CODEBUDDY_MODEL_PREFIX)
    ? normalized
    : `${CODEBUDDY_MODEL_PREFIX}${normalized}`;
}

export function decodeCodeBuddyModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(CODEBUDDY_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(CODEBUDDY_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeCodeBuddyDiscoveredModels(value: unknown): CodeBuddyDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedById = new Map<string, CodeBuddyDiscoveredModel>();
  for (const entry of value) {
    const model = normalizeCodeBuddyDiscoveredModel(entry);
    if (!model) {
      continue;
    }

    const current = normalizedById.get(model.rawId);
    normalizedById.set(
      model.rawId,
      current ? mergeCodeBuddyModelMetadata(current, model) : model,
    );
  }
  return Array.from(normalizedById.values());
}

export function mergeCodeBuddyDiscoveredModels(
  catalogModels: CodeBuddyDiscoveredModel[],
  liveModels: CodeBuddyDiscoveredModel[],
): CodeBuddyDiscoveredModel[] {
  const merged = normalizeCodeBuddyDiscoveredModels(catalogModels);
  const indexes = new Map(merged.map((model, index) => [model.rawId, index] as const));

  for (const incoming of normalizeCodeBuddyDiscoveredModels(liveModels)) {
    const index = indexes.get(incoming.rawId);
    if (index === undefined) {
      indexes.set(incoming.rawId, merged.length);
      merged.push(incoming);
      continue;
    }
    merged[index] = mergeCodeBuddyModelMetadata(merged[index], incoming);
  }

  return merged;
}

export function findCodeBuddyModel(
  models: CodeBuddyDiscoveredModel[],
  modelId: string,
): CodeBuddyDiscoveredModel | null {
  const rawModelId = decodeCodeBuddyModelId(modelId) ?? modelId.trim();
  if (!rawModelId) {
    return null;
  }
  return models.find(model => model.rawId === rawModelId) ?? null;
}

export function getCodeBuddyAvailableReasoningEfforts(
  model: CodeBuddyDiscoveredModel | null | undefined,
): readonly CodeBuddyReasoningEffort[] {
  if (!model || !model.supportsReasoning) {
    return [];
  }
  return model.reasoningEfforts;
}

export function resolveCodeBuddyDefaultReasoningEffort(
  model: CodeBuddyDiscoveredModel | null | undefined,
  preferredEffort?: string,
): string {
  const availableValues = model?.reasoningEfforts.map(effort => effort.value) ?? [];
  const normalizedPreferred = preferredEffort?.trim();
  if (normalizedPreferred && availableValues.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }
  if (model?.defaultReasoningEffort && availableValues.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }

  return availableValues.includes(DEFAULT_REASONING_VALUE)
    ? DEFAULT_REASONING_VALUE
    : availableValues[0] ?? '';
}

export function normalizeCodeBuddyReasoningEfforts(value: unknown): CodeBuddyReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts: CodeBuddyReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const effortValue = readTrimmedString(record?.value ?? record?.id ?? entry);
    if (!effortValue || seen.has(effortValue)) {
      continue;
    }
    seen.add(effortValue);
    const label = readTrimmedString(record?.label ?? record?.name)
      || formatReasoningValueLabel(effortValue);
    const description = readTrimmedString(record?.description);
    efforts.push({
      ...(description ? { description } : {}),
      label,
      value: effortValue,
    });
  }
  return efforts.sort((left, right) => {
    const leftIndex = CODEBUDDY_REASONING_EFFORT_ORDER.indexOf(
      left.value as (typeof CODEBUDDY_REASONING_EFFORT_ORDER)[number],
    );
    const rightIndex = CODEBUDDY_REASONING_EFFORT_ORDER.indexOf(
      right.value as (typeof CODEBUDDY_REASONING_EFFORT_ORDER)[number],
    );
    if (leftIndex === -1) return rightIndex === -1 ? 0 : 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function normalizeCodeBuddyDiscoveredModel(value: unknown): CodeBuddyDiscoveredModel | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawId = readTrimmedString(value.rawId ?? value.modelId ?? value.id);
  if (!rawId) {
    return null;
  }

  const contextWindow = readPositiveFiniteNumber(
    value.contextWindow ?? value.context_window ?? value.maxInputTokens,
  );
  const description = readTrimmedString(value.description);
  const displayName = readTrimmedString(
    value.displayName ?? value.display_name ?? value.name ?? value.label,
  ) || rawId;
  const reasoningEfforts = normalizeCodeBuddyReasoningEfforts(
    value.reasoningEfforts ?? value.reasoning_efforts,
  );
  const supportsReasoning = value.supportsReasoning === true
    || value.supports_reasoning === true
    || reasoningEfforts.length > 0;
  const defaultReasoningEffort = readTrimmedString(
    value.defaultReasoningEffort ?? value.reasoningEffort,
  );
  const supportsImages = value.supportsImages === true || value.supports_images === true;

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(description ? { description } : {}),
    displayName,
    rawId,
    ...(value.reasoningMetadataResolved === true
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts,
    supportsReasoning,
    ...(value.supportsImages === undefined && value.supports_images === undefined
      ? {}
      : { supportsImages }),
  };
}

function mergeCodeBuddyModelMetadata(
  current: CodeBuddyDiscoveredModel,
  incoming: CodeBuddyDiscoveredModel,
): CodeBuddyDiscoveredModel {
  const incomingReasoningIsAuthoritative = incoming.reasoningMetadataResolved === true;
  const reasoningEfforts = incoming.reasoningEfforts.length > 0
    ? incoming.reasoningEfforts
    : current.reasoningEfforts;
  const defaultReasoningEffort = incomingReasoningIsAuthoritative
    ? incoming.defaultReasoningEffort
    : incoming.defaultReasoningEffort ?? current.defaultReasoningEffort;
  const incomingDisplayNameIsRich = incoming.displayName !== incoming.rawId;
  const contextWindow = incoming.contextWindow ?? current.contextWindow;
  const description = incoming.description ?? current.description;
  const supportsImages = incoming.supportsImages ?? current.supportsImages;

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(description ? { description } : {}),
    displayName: incomingDisplayNameIsRich ? incoming.displayName : current.displayName,
    rawId: current.rawId,
    ...(incoming.reasoningMetadataResolved || current.reasoningMetadataResolved
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts,
    supportsReasoning: incoming.supportsReasoning
      || current.supportsReasoning
      || reasoningEfforts.length > 0,
    ...(supportsImages !== undefined ? { supportsImages } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
