import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
} from '../../../core/providers/types';
import { computeCodeBuddyEnvironmentHash } from '../env/CodeBuddySettingsReconciler';
import {
  type CodeBuddyDiscoveredModel,
  mergeCodeBuddyDiscoveredModels,
  normalizeCodeBuddyDiscoveredModels,
} from '../models';
import {
  type CodeBuddyCatalogSnapshot,
  getCodeBuddyProviderSettings,
  getCurrentCodeBuddyCatalog,
  updateCurrentCodeBuddyCatalog,
} from '../settings';
import type {
  CodeBuddyModelCatalogDiscoveryResult,
  CodeBuddyModelCatalogServiceLike,
} from './CodeBuddyModelCatalogService';

export interface CodeBuddyCatalogResult {
  catalog: CodeBuddyCatalogSnapshot | null;
  changed: boolean;
  diagnostics?: string;
  kind: 'completed' | 'skipped';
  persistedSettingsChanged: boolean;
}

export class CodeBuddyModelCatalogCoordinator {
  private readonly activeOperations = new Set<Promise<unknown>>();
  private abortController: AbortController | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private inFlightRefresh: {
    contextKey: string;
    generation: number;
    promise: Promise<CodeBuddyCatalogResult>;
  } | null = null;
  private liveContextKey: string | null = null;
  private readonly liveModelsById = new Map<string, CodeBuddyDiscoveredModel>();
  private liveDefaultModelId: string | null = null;
  private refreshGeneration = 0;
  private transitionActive = false;
  private readonly transitionWaiters = new Set<() => void>();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly service: CodeBuddyModelCatalogServiceLike,
  ) {}

  getCachedCatalog(): CodeBuddyCatalogSnapshot | null {
    return getCurrentCodeBuddyCatalog(this.plugin.settings);
  }

  refresh(context?: ProviderTransitionOwnerContext, signal?: AbortSignal): Promise<CodeBuddyCatalogResult> {
    if (this.disposed || signal?.aborted || !getCodeBuddyProviderSettings(this.plugin.settings).enabled) {
      return Promise.resolve(this.#skippedResult());
    }
    return this.#runOperation(
      () => this.#refreshUnfenced(context, signal),
      context?.providerTransitionOwner === true,
      () => this.#skippedResult(),
    );
  }

  mergeLiveModels(
    liveModels: CodeBuddyDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed) {
      return Promise.resolve({ changed: false });
    }
    return this.#runOperation(
      () => this.#mergeLiveModelsUnfenced(liveModels, defaultModelId, sourceContextKey),
      false,
      () => ({ changed: false }),
    );
  }

  cancel(): void {
    this.refreshGeneration += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.inFlightRefresh = null;
  }

  beginEnvironmentTransition(): void {
    if (!this.disposed) this.transitionActive = true;
  }

  endEnvironmentTransition(): void {
    if (this.disposed) return;
    this.transitionActive = false;
    this.#releaseTransitionWaiters();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.cancel();
    await Promise.allSettled(this.activeOperations);
    this.liveContextKey = null;
    this.liveDefaultModelId = null;
    this.liveModelsById.clear();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.transitionActive = false;
    this.#releaseTransitionWaiters();
    this.cancel();
    this.disposePromise = Promise.allSettled(this.activeOperations).then(() => undefined);
    return this.disposePromise;
  }

  async #refreshUnfenced(
    context?: ProviderTransitionOwnerContext,
    signal?: AbortSignal,
  ): Promise<CodeBuddyCatalogResult> {
    if (signal?.aborted) return this.#skippedResult();
    if (this.transitionActive && context?.providerTransitionOwner !== true) {
      return this.#skippedResult();
    }
    const contextKey = this.#getContextKey();
    this.#prepareLiveContext(contextKey);
    if (this.inFlightRefresh?.contextKey === contextKey) {
      return this.inFlightRefresh.promise;
    }
    if (this.inFlightRefresh) this.abortController?.abort();

    const generation = ++this.refreshGeneration;
    const promise = this.#runRefresh(generation, contextKey, context);
    this.inFlightRefresh = { contextKey, generation, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlightRefresh?.generation === generation) {
        this.inFlightRefresh = null;
      }
    }
  }

  async #runRefresh(
    generation: number,
    contextKey: string,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodeBuddyCatalogResult> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const discovery = await this.service.discoverCatalog(abortController.signal, context);
      if (!this.#isCurrentRefresh(generation) || contextKey !== this.#getContextKey()) {
        return this.#skippedResult();
      }
      if (discovery.kind === 'skipped') {
        return this.#skippedResult();
      }
      if (discovery.diagnostics) {
        return {
          ...this.#completedResult(),
          diagnostics: discovery.diagnostics,
        };
      }

      const persisted = await this.#persistCatalog(
        contextKey,
        current => snapshotFromDiscovery(discovery, current, this.#liveModels(contextKey)),
        generation,
      );
      if (!this.#isCurrentRefresh(generation)) {
        return this.#skippedResult();
      }
      if (persisted.changed) {
        this.plugin.notifyProviderChatOptionsChanged('codebuddy');
      }
      return {
        catalog: this.getCachedCatalog(),
        kind: 'completed',
        ...persisted,
      };
    } catch {
      if (!this.#isCurrentRefresh(generation)) {
        return this.#skippedResult();
      }
      return {
        ...this.#completedResult(),
        diagnostics: 'CodeBuddy model catalog refresh failed',
      };
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  async #mergeLiveModelsUnfenced(
    liveModels: CodeBuddyDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const contextKey = this.#getContextKey();
    if (sourceContextKey && sourceContextKey !== contextKey) {
      return { changed: false };
    }
    this.#prepareLiveContext(contextKey);
    const normalizedLiveModels = normalizeCodeBuddyDiscoveredModels(liveModels);
    if (normalizedLiveModels.length === 0) {
      return { changed: false };
    }
    for (const model of normalizedLiveModels) {
      const currentLive = this.liveModelsById.get(model.rawId);
      this.liveModelsById.set(
        model.rawId,
        currentLive
          ? mergeCodeBuddyDiscoveredModels([currentLive], [model])[0]
          : model,
      );
    }
    const normalizedDefaultModelId = defaultModelId?.trim() || null;
    if (normalizedDefaultModelId) {
      this.liveDefaultModelId = normalizedDefaultModelId;
    }

    const persisted = await this.#persistCatalog(
      contextKey,
      current => ({
        defaultModelId: this.liveDefaultModelId ?? current?.defaultModelId ?? null,
        fingerprint: current?.fingerprint ?? '',
        models: mergeCodeBuddyDiscoveredModels(current?.models ?? [], normalizedLiveModels),
        refreshedAt: current?.refreshedAt ?? 0,
      }),
    );
    if (persisted.changed) {
      this.plugin.notifyProviderChatOptionsChanged('codebuddy');
    }
    return persisted;
  }

  #liveModels(contextKey: string): CodeBuddyDiscoveredModel[] {
    return this.liveContextKey === contextKey
      ? Array.from(this.liveModelsById.values())
      : [];
  }

  async #persistCatalog(
    expectedContextKey: string,
    buildSnapshot: (current: CodeBuddyCatalogSnapshot | null) => CodeBuddyCatalogSnapshot,
    expectedGeneration?: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    let result = { changed: false, persistedSettingsChanged: false };
    await this.plugin.mutateSettingsConditionally((settings) => {
      if (
        this.disposed
        || (expectedGeneration !== undefined && !this.#isCurrentRefresh(expectedGeneration))
        || computeCodeBuddyEnvironmentHash(settings) !== expectedContextKey
      ) {
        return false;
      }
      const current = getCurrentCodeBuddyCatalog(settings);
      const snapshot = buildSnapshot(current);
      const changed = !sameCatalogContent(current, snapshot);
      const persistedSettingsChanged = !sameValue(current, snapshot);
      if (persistedSettingsChanged) {
        updateCurrentCodeBuddyCatalog(settings, snapshot);
      }
      result = { changed, persistedSettingsChanged };
      return persistedSettingsChanged;
    });
    return result;
  }

  #runOperation<T>(
    operation: () => Promise<T>,
    transitionOwner: boolean,
    disposedResult: () => T,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(disposedResult());
    if (this.transitionActive && !transitionOwner) {
      return this.#waitForTransition().then(() =>
        this.#runOperation(operation, transitionOwner, disposedResult));
    }

    const promise = operation();
    this.activeOperations.add(promise);
    void promise.then(
      () => this.activeOperations.delete(promise),
      () => this.activeOperations.delete(promise),
    );
    return promise;
  }

  #waitForTransition(): Promise<void> {
    if (this.disposed || !this.transitionActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.transitionWaiters.add(resolve);
    });
  }

  #releaseTransitionWaiters(): void {
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #getContextKey(): string {
    return computeCodeBuddyEnvironmentHash(this.plugin.settings);
  }

  #isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  #prepareLiveContext(contextKey: string): void {
    if (this.liveContextKey === contextKey) return;
    this.liveContextKey = contextKey;
    this.liveDefaultModelId = null;
    this.liveModelsById.clear();
  }

  #completedResult(): CodeBuddyCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'completed',
      persistedSettingsChanged: false,
    };
  }

  #skippedResult(): CodeBuddyCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'skipped',
      persistedSettingsChanged: false,
    };
  }
}

function snapshotFromDiscovery(
  discovery: Extract<CodeBuddyModelCatalogDiscoveryResult, { kind: 'completed' }>,
  current: CodeBuddyCatalogSnapshot | null,
  liveModels: CodeBuddyDiscoveredModel[],
): CodeBuddyCatalogSnapshot {
  const currentModelsById = new Map(
    (current?.models ?? []).map(model => [model.rawId, model] as const),
  );
  return {
    defaultModelId: discovery.defaultModelId,
    fingerprint: discovery.fingerprint,
    models: mergeCodeBuddyDiscoveredModels(
      discovery.models.map((discoveredModel) => {
        const currentModel = currentModelsById.get(discoveredModel.rawId);
        return currentModel
          ? mergeCodeBuddyDiscoveredModels([currentModel], [discoveredModel])[0]
          : discoveredModel;
      }),
      liveModels,
    ),
    refreshedAt: Date.now(),
  };
}

function sameCatalogContent(
  current: CodeBuddyCatalogSnapshot | null,
  next: CodeBuddyCatalogSnapshot,
): boolean {
  return current !== null && sameValue(
    { defaultModelId: current.defaultModelId, models: current.models },
    { defaultModelId: next.defaultModelId, models: next.models },
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
