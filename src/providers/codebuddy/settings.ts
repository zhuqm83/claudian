import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCLIPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  type CodeBuddyDiscoveredModel,
  decodeCodeBuddyModelId,
  normalizeCodeBuddyDiscoveredModels,
} from './models';

export interface CodeBuddyCatalogSnapshot {
  models: CodeBuddyDiscoveredModel[];
  defaultModelId: string | null;
  fingerprint: string;
  refreshedAt: number;
}

export interface PersistedCodeBuddyProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  catalogsByHost: Record<string, CodeBuddyCatalogSnapshot>;
  environmentVariables: string;
  environmentHash: string;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export interface CodeBuddyProviderSettings extends PersistedCodeBuddyProviderSettings {
  currentCatalog: CodeBuddyCatalogSnapshot | null;
}

export const DEFAULT_CODEBUDDY_PROVIDER_SETTINGS: Readonly<PersistedCodeBuddyProviderSettings> = Object.freeze({
  catalogsByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredReasoningByModel: {},
  visibleModels: [],
});

export function getOrderedCodeBuddyVisibleModelIds(
  settings: CodeBuddyProviderSettings,
): string[] {
  if (settings.visibleModels !== null) {
    return [...settings.visibleModels];
  }

  const models = settings.currentCatalog?.models ?? [];
  const defaultModelId = settings.currentCatalog?.defaultModelId;
  if (!defaultModelId || !models.some(model => model.rawId === defaultModelId)) {
    return models.map(model => model.rawId);
  }

  return [
    defaultModelId,
    ...models.filter(model => model.rawId !== defaultModelId).map(model => model.rawId),
  ];
}

export function normalizeCodeBuddyCatalogSnapshot(value: unknown): CodeBuddyCatalogSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const defaultModelId = normalizeRawModelId(value.defaultModelId);
  const fingerprint = readTrimmedString(value.fingerprint);
  const refreshedAt = typeof value.refreshedAt === 'number'
    && Number.isFinite(value.refreshedAt)
    && value.refreshedAt >= 0
    ? Math.floor(value.refreshedAt)
    : 0;

  return {
    defaultModelId,
    fingerprint,
    models: normalizeCodeBuddyDiscoveredModels(value.models),
    refreshedAt,
  };
}

export function getCodeBuddyProviderSettings(
  settings: Record<string, unknown>,
): CodeBuddyProviderSettings {
  const config = getProviderConfig(settings, 'codebuddy');
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const catalogsByHost = normalizeCodeBuddyCatalogsByHost(config.catalogsByHost ?? config.selectedModelsByHost);
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const id of normalizeCodeBuddyVisibleModels(config.visibleModels) ?? []) allowedModelIds.add(id);
  for (const modelId of collectSelectedCodeBuddyRawModelIds(settings)) {
    allowedModelIds.add(modelId);
  }

  const visibleModels = normalizeCodeBuddyVisibleModels(config.visibleModels);
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  return {
    catalogsByHost,
    cliPath: readTrimmedString(config.cliPath)
      || DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    currentCatalog,
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'codebuddy')
        ?? DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeCodeBuddyModelAliases(
      config.modelAliases,
      allowedModelIds,
    ),
    preferredReasoningByModel: normalizeCodeBuddyPreferredReasoningByModel(
      config.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
    ),
    visibleModels,
  };
}

export function updateCodeBuddyProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PersistedCodeBuddyProviderSettings>,
): CodeBuddyProviderSettings {
  const current = getCodeBuddyProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;

  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[currentHostKey] = hostCliPath;
    } else {
      delete cliPathsByHost[currentHostKey];
    }
    cliPath = DEFAULT_CODEBUDDY_PROVIDER_SETTINGS.cliPath;
  }

  const catalogsByHost = updates.catalogsByHost !== undefined
    ? normalizeCodeBuddyCatalogsByHost(updates.catalogsByHost)
    : { ...current.catalogsByHost };
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const id of normalizeCodeBuddyVisibleModels(updates.visibleModels ?? current.visibleModels) ?? []) {
    allowedModelIds.add(id);
  }
  for (const modelId of collectSelectedCodeBuddyRawModelIds(settings)) {
    allowedModelIds.add(modelId);
  }
  const visibleModels = normalizeCodeBuddyVisibleModels(
    updates.visibleModels === undefined ? current.visibleModels : updates.visibleModels,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  const next: PersistedCodeBuddyProviderSettings = {
    catalogsByHost,
    cliPath,
    cliPathsByHost,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeCodeBuddyModelAliases(
      updates.modelAliases ?? current.modelAliases,
      allowedModelIds,
    ),
    preferredReasoningByModel: normalizeCodeBuddyPreferredReasoningByModel(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
    ),
    visibleModels,
  };

  setProviderConfig(settings, 'codebuddy', next as unknown as Record<string, unknown>);
  return { ...next, currentCatalog };
}

export function getCurrentCodeBuddyCatalog(
  settings: Record<string, unknown>,
): CodeBuddyCatalogSnapshot | null {
  return getCodeBuddyProviderSettings(settings).currentCatalog;
}

export function updateCurrentCodeBuddyCatalog(
  settings: Record<string, unknown>,
  snapshot: CodeBuddyCatalogSnapshot,
): CodeBuddyCatalogSnapshot | null {
  const normalized = normalizeCodeBuddyCatalogSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const current = getCodeBuddyProviderSettings(settings);
  updateCodeBuddyProviderSettings(settings, {
    catalogsByHost: {
      ...current.catalogsByHost,
      [getHostnameKey()]: normalized,
    },
  });
  return normalized;
}

export function normalizeCodeBuddyVisibleModels(
  value: unknown,
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const rawModelId = normalizeRawModelId(entry);
    if (!rawModelId || seen.has(rawModelId)) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

export function normalizeCodeBuddyModelAliases(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const restrictToAllowed = allowedModelIds.size > 0;
  const normalized: Record<string, string> = {};
  for (const [modelId, aliasValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const alias = readTrimmedString(aliasValue);
    if (
      !rawModelId
      || !alias
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }
    normalized[rawModelId] = alias;
  }
  return normalized;
}

export function normalizeCodeBuddyPreferredReasoningByModel(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  catalogModels: CodeBuddyDiscoveredModel[] = [],
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const restrictToAllowed = catalogModels.length > 0;
  const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
  const normalized: Record<string, string> = {};
  for (const [modelId, effortValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const effort = readTrimmedString(effortValue);
    if (
      !rawModelId
      || !effort
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }

    const catalogModel = catalogById.get(rawModelId);
    if (
      catalogModel?.reasoningMetadataResolved === true
      && !catalogModel.reasoningEfforts.some(option => option.value === effort)
    ) {
      continue;
    }
    normalized[rawModelId] = effort;
  }
  return normalized;
}

function normalizeCodeBuddyCatalogsByHost(
  value: unknown,
): Record<string, CodeBuddyCatalogSnapshot> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, CodeBuddyCatalogSnapshot> = {};
  for (const [hostKey, snapshot] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedSnapshot = normalizeCodeBuddyCatalogSnapshot(snapshot);
    if (normalizedHostKey && normalizedSnapshot) {
      normalized[normalizedHostKey] = normalizedSnapshot;
    }
  }
  return normalized;
}

function collectSelectedCodeBuddyRawModelIds(settings: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  addSelectedCodeBuddyRawModelId(selected, settings.model);
  addSelectedCodeBuddyRawModelId(selected, settings.titleGenerationModel);

  if (isRecord(settings.savedProviderModel)) {
    addSelectedCodeBuddyRawModelId(selected, settings.savedProviderModel.codebuddy);
  }
  return selected;
}

function addSelectedCodeBuddyRawModelId(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const rawModelId = decodeCodeBuddyModelId(value.trim());
  if (rawModelId) {
    target.add(rawModelId);
  }
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return decodeCodeBuddyModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function projectCodeBuddyModelSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const current = getCodeBuddyProviderSettings(settings);
  const visibleModels = getCodeBuddyMigratedVisibleModelIds(current);
  const selected = new Set(visibleModels);
  const selectedModelsByHost = Object.fromEntries(
    Object.entries(current.catalogsByHost).map(([host, catalog]) => [host, {
      ...catalog,
      defaultModelId: catalog.defaultModelId && selected.has(catalog.defaultModelId)
        ? catalog.defaultModelId
        : null,
      models: catalog.models.filter(model => selected.has(model.rawId)),
    }]),
  );
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, 'codebuddy'),
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
    selectedModelsByHost,
    visibleModels,
  };
  delete config.catalogsByHost;
  delete config.currentCatalog;
  return config;
}

export function getCodeBuddyMigratedVisibleModelIds(
  current: CodeBuddyProviderSettings,
): string[] {
  return current.visibleModels ?? [...new Set([
    ...getOrderedCodeBuddyVisibleModelIds(current),
    ...Object.values(current.catalogsByHost).flatMap(catalog => catalog.models.map(model => model.rawId)),
  ])];
}
