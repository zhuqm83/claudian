import {
  type ACPMetadata,
  type ACPModelInfo,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  extractACPSessionModelState,
  extractACPSessionThoughtLevelState,
} from '../../acp';
import {
  type CodeBuddyDiscoveredModel,
  type CodeBuddyReasoningEffort,
  normalizeCodeBuddyDiscoveredModels,
} from '../models';

export interface NormalizedCodeBuddySessionModels {
  currentModelId: string | null;
  models: CodeBuddyDiscoveredModel[];
}

export interface CodeBuddySessionMetadataResponse {
  _meta?: ACPMetadata | null;
  configOptions?: ACPSessionConfigOption[] | null;
  models?: ACPSessionModelState | null;
}

export function normalizeCodeBuddySessionModelMetadata(
  response: CodeBuddySessionMetadataResponse,
): NormalizedCodeBuddySessionModels {
  const state = extractACPSessionModelState(response);
  const thoughtLevel = extractACPSessionThoughtLevelState(response);
  const reasoningEfforts: CodeBuddyReasoningEffort[] = thoughtLevel.availableLevels.map(level => ({
    ...(level.description ? { description: level.description } : {}),
    label: level.name,
    value: level.id,
  }));
  const rawModelsById = new Map(
    (response.models?.availableModels ?? []).flatMap(model => {
      const id = resolveACPModelId(model);
      return id ? [[id, model] as const] : [];
    }),
  );

  const models = state.availableModels.flatMap(model => {
    const rawModel = rawModelsById.get(model.id);
    const metadata: Record<string, unknown> = {
      ...(isRecord(rawModel?._meta) ? rawModel._meta : {}),
      ...(isRecord(model._meta) ? model._meta : {}),
      ...(model.id === state.currentModelId && isRecord(response._meta)
        ? response._meta
        : {}),
    };
    const supportsReasoning = metadata.supportsReasoning === true
      || metadata.supports_reasoning === true;
    return normalizeCodeBuddyDiscoveredModels([{
      ...metadata,
      description: model.description ?? rawModel?.description ?? undefined,
      displayName: model.name,
      rawId: model.id,
      reasoningEfforts: supportsReasoning ? reasoningEfforts : [],
      ...(supportsReasoning && thoughtLevel.currentLevel
        ? { defaultReasoningEffort: thoughtLevel.currentLevel }
        : {}),
      ...(thoughtLevel.availableLevels.length > 0 ? { reasoningMetadataResolved: true } : {}),
    }]);
  });

  return {
    currentModelId: state.currentModelId,
    models,
  };
}

export function normalizeCodeBuddySetModelMetadata(
  rawModelId: string,
  metadata: ACPMetadata | null | undefined,
): CodeBuddyDiscoveredModel | null {
  if (!isRecord(metadata?.model)) {
    return null;
  }
  return normalizeCodeBuddyDiscoveredModels([{
    ...metadata.model,
    rawId: resolveACPModelId(metadata.model) ?? rawModelId,
    ...(metadata.model.supportsReasoning === true ? { reasoningMetadataResolved: true } : {}),
  }])[0] ?? null;
}

export function parseCodeBuddyModelUpdateState(
  value: unknown,
): ACPSessionModelState | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.models) ? value.models : value;
  if (
    !Array.isArray(candidate.availableModels)
    || typeof candidate.currentModelId !== 'string'
    || !candidate.currentModelId.trim()
    || !candidate.availableModels.every(isACPModelInfo)
  ) {
    return null;
  }

  return candidate as unknown as ACPSessionModelState;
}

function isACPModelInfo(value: unknown): value is ACPModelInfo {
  return isRecord(value)
    && typeof value.name === 'string'
    && resolveACPModelId(value) !== null;
}

function resolveACPModelId(model: Record<string, unknown> | ACPModelInfo): string | null {
  const id = typeof model.modelId === 'string'
    ? model.modelId
    : typeof model.id === 'string'
      ? model.id
      : '';
  return id.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
