import { randomUUID } from 'node:crypto';

import {
  ExecutionEventQueue,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
} from '../../../core/execution';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ChatMessage } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendLinkedContent } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../../utils/session';
import {
  type ACPContentBlock,
  ACPExecutionEventNormalizer,
  ACPInteractionController,
  type ACPMetadata,
  type ACPPromptResponse,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  type ACPSessionNotification,
  ACPToolStreamAdapter,
  type ACPUsage,
  type ACPUsageUpdate,
  buildACPUsageInfo,
} from '../../acp';
import type { CodeBuddyCommandCatalog } from '../commands/CodeBuddyCommandCatalog';
import { computeCodeBuddyEnvironmentHash } from '../env/CodeBuddySettingsReconciler';
import {
  type CodeBuddyDiscoveredModel,
  decodeCodeBuddyModelId,
  findCodeBuddyModel,
  getCodeBuddyAvailableReasoningEfforts,
  normalizeCodeBuddyDiscoveredModels,
} from '../models';
import {
  normalizeCodeBuddyToolCall,
  normalizeCodeBuddyToolName,
  normalizeCodeBuddyToolUseResult,
  resolveCodeBuddyRawToolName,
} from '../normalization/codebuddyToolNormalization';
import {
  buildCodeBuddySystemPrompt,
  type CodeBuddySystemPromptSettings,
} from '../prompt/CodeBuddySystemPrompt';
import { assertCodeBuddyModelAvailable } from '../runtime/CodeBuddyModelAvailability';
import type { CodeBuddyModelCatalogCoordinator } from '../runtime/CodeBuddyModelCatalogCoordinator';
import { buildCodeBuddyRuntimeEnv } from '../runtime/CodeBuddyRuntimeEnvironment';
import { getCodeBuddyProviderSettings } from '../settings';
import { parseCodeBuddyProviderState } from '../types';
import type {
  CodeBuddyExecutionNativeConnection,
  CodeBuddyExecutionNativeFactory,
} from './CodeBuddyExecutionBackend';
import {
  normalizeCodeBuddySessionModelMetadata,
  normalizeCodeBuddySetModelMetadata,
} from './CodeBuddySessionModelMetadata';

const CODEBUDDY_MODEL_CONFIG_ID = 'model';
const CODEBUDDY_THOUGHT_LEVEL_CONFIG_ID = 'thought_level';
const CODEBUDDY_PASSIVE_TOOL_INSTRUCTION = [
  'Do not use any tools for this request.',
  'Answer only from information supplied directly in the prompt.',
].join(' ');

interface CodeBuddyExecutionSessionOptions {
  readonly commandCatalog?: Pick<CodeBuddyCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<CodeBuddyModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory: CodeBuddyExecutionNativeFactory;
}

class CodeBuddyExecutionRunState implements ProviderExecutionRun {
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  private readonly queue: ExecutionEventQueue<ProviderExecutionEvent>;
  private terminal = false;
  private settle!: () => void;
  readonly settled = new Promise<void>(resolve => { this.settle = resolve; });

  constructor(
    readonly executionId: string,
    readonly turnId: string,
    private readonly cancelCallback: () => void,
  ) {
    this.queue = new ExecutionEventQueue<ProviderExecutionEvent>(cancelCallback);
    this.events = this.queue;
  }

  cancel(): void {
    this.cancelCallback();
  }

  emit(event: ProviderExecutionEvent): void {
    if (!this.terminal) this.queue.push(event);
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.queue.push(event);
    this.queue.close();
    this.settle();
  }

  get isTerminal(): boolean {
    return this.terminal;
  }
}

interface ActiveExecution {
  acceptingLiveOutput: boolean;
  readonly abortController: AbortController;
  accepted: boolean;
  readonly cancellationGeneration: number;
  contextUsage: ACPUsageUpdate | null;
  readonly normalizer: ACPExecutionEventNormalizer;
  promptUsage: ACPUsage | null;
  readonly request: ProviderExecutionRequest;
  readonly run: CodeBuddyExecutionRunState;
  sequence: number;
  promptResponse?: ACPPromptResponse;
}

interface CodeBuddyNativeOwner {
  readonly generation: number;
  initialized: boolean;
  loadedSessionConfigurationKey: string | null;
  loadedSessionId: string | null;
  readonly modelContextKey: string;
  readonly native: CodeBuddyExecutionNativeConnection;
  notificationUnsubscribe: () => void;
  shutdownFlight: Promise<void> | null;
}

export class CodeBuddyExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'codebuddy' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private cancellationGeneration = 0;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private nativeGeneration = 0;
  private nativeOwner: CodeBuddyNativeOwner | null = null;
  private nativeStartupFlight: Promise<CodeBuddyExecutionNativeConnection> | null = null;
  private quarantineGeneration = 0;
  private readonly interactionController: ACPInteractionController;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private nativeConversationContextEstablished: boolean;
  private providerSessionId: string | undefined;
  private providerState: Readonly<Record<string, unknown>>;
  private revision = 0;
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: CodeBuddyExecutionSessionOptions,
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    const providerState = parseCodeBuddyProviderState(config.resumeSeed?.providerState);
    this.providerState = { ...providerState };
    this.nativeConversationContextEstablished = Boolean(
      this.providerSessionId
      && providerState.nativeConversationContextEstablished !== false,
    );
    this.snapshot = this.#createSnapshot('idle');
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('CodeBuddy execution session is disposed.');
    if (this.active) throw new Error('CodeBuddy execution session is already executing.');
    const run = new CodeBuddyExecutionRunState(
      randomUUID(),
      randomUUID(),
      () => { void this.#cancelRun(run, 'cancelled'); },
    );
    const active: ActiveExecution = {
      acceptingLiveOutput: false,
      abortController: new AbortController(),
      accepted: false,
      cancellationGeneration: this.cancellationGeneration,
      contextUsage: null,
      normalizer: new ACPExecutionEventNormalizer({
        mapUsage: usage => {
          if (active.acceptingLiveOutput) active.contextUsage = usage;
          return buildACPUsageInfo({ contextWindow: usage });
        },
        scope: {
          executionId: run.executionId,
          kind: 'requested',
          sessionInstanceId: this.sessionInstanceId,
          turnId: run.turnId,
        },
        toolStreamAdapter: createCodeBuddyToolStreamAdapter(),
      }),
      promptUsage: null,
      request,
      run,
      sequence: 0,
    };
    this.active = active;
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    const onAbort = (): void => { void this.#cancelRun(run, 'aborted'); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) {
      request.signal.removeEventListener('abort', onAbort);
      onAbort();
    } else {
      void this.#performExecution(active).finally(() => {
        request.signal.removeEventListener('abort', onAbort);
      });
    }
    return run;
  }

  cancel(): void {
    const run = this.active?.run;
    if (run) void this.#cancelRun(run, 'cancelled');
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.snapshot.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.quarantineGeneration += 1;
    this.disposalFlight = (async () => {
      const active = this.active;
      if (active) await this.#cancelRun(active.run, 'session-disposed');
      if (this.cancellationFlight) await this.cancellationFlight;
      await this.#shutdownNative();
      this.interactionController.dispose();
      this.listeners.clear();
      this.#updateSnapshot('disposed');
    })();
    return this.disposalFlight;
  }

  async #performExecution(active: ActiveExecution): Promise<void> {
    if (active.request.toolPolicy.kind === 'allow-list') {
      this.#failConfiguration(
        active,
        'CodeBuddy does not support reliable exact allow-list enforcement.',
      );
      return;
    }
    let unsubscribeClose: (() => void) | undefined;
    try {
      assertCodeBuddyModelAvailable(this.plugin.settings, active.request.configuration.model);
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      const native = await this.#ensureNative(active);
      if (this.#isCancellationRequested(active)) return;
      const sessionId = await this.#ensureSession(native, active.request, active);
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(native, sessionId, active.request, active);
      if (this.#isCancellationRequested(active)) return;
      assertCodeBuddyModelAvailable(this.plugin.settings, active.request.configuration.model);
      active.normalizer.reset();
      active.acceptingLiveOutput = true;
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = native.onClose?.(error => {
          reject(new Error('CodeBuddy transport closed', { cause: error }));
        });
      });
      const response = await Promise.race([closed, native.prompt({
        prompt: buildPromptBlocks(active.request, !this.nativeConversationContextEstablished),
        sessionId,
      })]);
      if (this.#isCancellationRequested(active)) return;
      this.accept(active, response);
      active.promptResponse = response;
      active.promptUsage = parseCodeBuddyPromptUsage(response) ?? active.promptUsage;
      this.#finishCompletedIfReady(active);
      await Promise.race([closed, active.run.settled]);
    } catch (error) {
      if (this.#isCancellationRequested(active)) return;
      const category = classifyError(error);
      this.#updateSnapshot('invalidated', {
        message: error instanceof Error ? error.message : String(error),
        reason: category === 'provider-session-missing'
          ? 'provider-session-missing'
          : category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: true,
      });
      this.#emitCurrentSnapshot();
      active.run.finish({
        category,
        message: error instanceof Error ? error.message : String(error),
        ...(category === 'provider-session-missing' && this.providerSessionId
          ? { missingProviderSessionId: this.providerSessionId }
          : {}),
        recoverable: true,
        scope: this.#nextScope(active),
        type: 'execution_error',
      });
      active.normalizer.dispose();
      this.active = null;
    } finally {
      unsubscribeClose?.();
    }
  }

  #failConfiguration(active: ActiveExecution, message: string): void {
    this.#updateSnapshot('invalidated', {
      message,
      reason: 'configuration-changed',
      recoverable: false,
    });
    this.#emitCurrentSnapshot();
    active.run.finish({
      category: 'configuration',
      message,
      recoverable: false,
      scope: this.#nextScope(active),
      type: 'execution_error',
    });
    active.normalizer.dispose();
    if (this.active === active) this.active = null;
  }

  async #ensureNative(active?: ActiveExecution): Promise<CodeBuddyExecutionNativeConnection> {
    const currentOwner = this.nativeOwner;
    if (
      !this.nativeStartupFlight
      && currentOwner?.initialized
      && currentOwner.native.isAlive?.() !== false
    ) return currentOwner.native;
    let startupFlight = this.nativeStartupFlight;
    if (!startupFlight) {
      startupFlight = this.#startNative(
        this.quarantineGeneration,
        this.#buildSystemPromptArgs(active?.request),
      );
      this.nativeStartupFlight = startupFlight;
      startupFlight.then(
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
      );
    }
    const native = await startupFlight;
    this.#throwIfCancellationRequested(active);
    return native;
  }

  async #startNative(
    quarantineGeneration: number,
    systemPromptArgs: readonly string[],
  ): Promise<CodeBuddyExecutionNativeConnection> {
    const previousOwner = this.nativeOwner;
    if (previousOwner) await this.#shutdownNativeOwner(previousOwner);
    const command = await this.plugin.getResolvedProviderCliPath('codebuddy') ?? 'codebuddy';
    if (quarantineGeneration !== this.quarantineGeneration || this.disposed) {
      throw new Error('CodeBuddy native startup was cancelled.');
    }
    const generation = ++this.nativeGeneration;
    const native = this.options.nativeFactory.create({
      command,
      cwd: this.config.vaultWorkingDirectory,
      env: buildCodeBuddyRuntimeEnv(this.plugin.settings, command),
      requestPermission: (request, signal) => {
        const policy = this.active?.request.toolPolicy.kind;
        if (policy === 'passive' || policy === 'read-only') {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.interactionController.requestPermission(
          request,
          signal ?? this.active?.abortController.signal,
        );
      },
      systemPromptArgs,
      version: this.plugin.manifest?.version ?? '0.0.0',
    });
    const owner: CodeBuddyNativeOwner = {
      generation,
      initialized: false,
      loadedSessionConfigurationKey: null,
      loadedSessionId: null,
      modelContextKey: computeCodeBuddyEnvironmentHash(this.plugin.settings),
      native,
      notificationUnsubscribe: () => {},
      shutdownFlight: null,
    };
    this.nativeOwner = owner;
    try {
      owner.notificationUnsubscribe = native.onNotification(notification => {
        if (this.#isCurrentNativeOwner(owner)) this.handleNotification(notification);
      });
      await native.initialize();
      if (
        quarantineGeneration !== this.quarantineGeneration
        || this.disposed
        || !this.#isCurrentNativeOwner(owner)
      ) {
        throw new Error('CodeBuddy native startup was cancelled.');
      }
      owner.initialized = true;
      return native;
    } catch (error) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch {
        // Startup cleanup cannot replace the error that initiated quarantine.
      }
      throw error;
    }
  }

  async #ensureSession(
    native: CodeBuddyExecutionNativeConnection,
    request: ProviderExecutionRequest | undefined,
    active?: ActiveExecution,
  ): Promise<string> {
    const owner = this.#getNativeOwner(native);
    const sessionConfigurationKey = request
      ? this.#buildSessionConfigurationKey(request)
      : null;
    if (this.providerSessionId) {
      if (owner.loadedSessionId === this.providerSessionId) {
        if (request && owner.loadedSessionConfigurationKey !== sessionConfigurationKey) {
          await this.#shutdownNative();
          this.#throwIfCancellationRequested(active);
          const replacement = await this.#ensureNative(active);
          return this.#ensureSession(replacement, request, active);
        }
        return this.providerSessionId;
      }
      return this.#loadProviderSession(
        native,
        this.providerSessionId,
        request,
        active,
        sessionConfigurationKey,
      );
    }

    const response = await native.newSession({
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
    });
    this.#throwIfCancellationRequested(active);
    this.#captureProviderSession(response.sessionId);
    this.#setNativeConversationContextEstablished(false);
    owner.loadedSessionId = response.sessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return response.sessionId;
  }

  async #loadProviderSession(
    native: CodeBuddyExecutionNativeConnection,
    targetSessionId: string,
    request: ProviderExecutionRequest | undefined,
    active: ActiveExecution | undefined,
    sessionConfigurationKey: string | null,
  ): Promise<string> {
    const owner = this.#getNativeOwner(native);
    const response = await native.loadSession({
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
      sessionId: targetSessionId,
    });
    this.#throwIfCancellationRequested(active);
    const loadedSessionId = response.sessionId ?? targetSessionId;
    this.#captureProviderSession(loadedSessionId);
    owner.loadedSessionId = loadedSessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return loadedSessionId;
  }

  /**
   * CodeBuddy ignores `_meta.systemPromptOverride`, so the prompt travels
   * through the native CLI flags instead. `--append-system-prompt` keeps the
   * native agent prompt, while an explicit override replaces it.
   */
  #buildSystemPromptArgs(request: ProviderExecutionRequest | undefined): string[] {
    if (!request) return [];
    const instructions = request.configuration.systemInstructions;
    const explicit = instructions.kind === 'explicit';
    const base = explicit
      ? instructions.instructions.trim()
      : buildCodeBuddySystemPrompt(this.#getSystemPromptSettings(), {
          dynamicSections: instructions.dynamicSections,
        }).trim();
    const prompt = request.toolPolicy.kind === 'passive'
      ? [base, CODEBUDDY_PASSIVE_TOOL_INSTRUCTION].filter(Boolean).join('\n\n')
      : base;
    if (!prompt) return [];
    return [explicit ? '--system-prompt' : '--append-system-prompt', prompt];
  }

  #buildSessionConfigurationKey(request: ProviderExecutionRequest): string {
    return JSON.stringify(this.#buildSystemPromptArgs(request));
  }

  #getSystemPromptSettings(): CodeBuddySystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath: this.config.vaultWorkingDirectory,
    };
  }

  async #applyConfiguration(
    native: CodeBuddyExecutionNativeConnection,
    sessionId: string,
    request: ProviderExecutionRequest,
    active: ActiveExecution,
  ): Promise<void> {
    const owner = this.#getNativeOwner(native);
    const rawModel = request.configuration.model
      ? decodeCodeBuddyModelId(request.configuration.model)
      : null;

    if (rawModel) {
      const response = await native.setModel({ modelId: rawModel, sessionId });
      this.#throwIfCancellationRequested(active);
      const model = normalizeCodeBuddySetModelMetadata(rawModel, response._meta);
      if (model) {
        await this.#mergeModelMetadataBestEffort([model], undefined, owner.modelContextKey);
        this.#throwIfCancellationRequested(active);
      }
      const reasoningEffort = this.#resolveReasoningEffort(
        rawModel,
        request.configuration.reasoning ?? undefined,
      );
      if (reasoningEffort) {
        await native.setConfigOption({
          configId: CODEBUDDY_THOUGHT_LEVEL_CONFIG_ID,
          sessionId,
          type: 'select',
          value: reasoningEffort,
        });
        this.#throwIfCancellationRequested(active);
      }
    }

    await native.setMode({ modeId: resolveCodeBuddyModeId(request), sessionId });
    this.#throwIfCancellationRequested(active);
  }

  #resolveReasoningEffort(
    rawModelId: string,
    requestedReasoning: string | undefined,
  ): string | null {
    const requested = requestedReasoning?.trim() ?? '';
    if (!requested) return null;
    const settings = getCodeBuddyProviderSettings(this.plugin.settings);
    const model = findCodeBuddyModel(settings.currentCatalog?.models ?? [], rawModelId);
    const advertisedValues = getCodeBuddyAvailableReasoningEfforts(model)
      .map(effort => effort.value);
    if (advertisedValues.includes(requested)) return requested;
    throw new Error(
      `CodeBuddy model "${rawModelId}" does not support reasoning effort "${requested}".`,
    );
  }

  private handleNotification(notification: ACPSessionNotification): void {
    const active = this.active;
    if (
      this.disposed
      || !active
      || this.#isCancellationRequested(active)
      || notification.sessionId !== this.providerSessionId
    ) return;

    const result = active.normalizer.normalize(notification.update);
    if (result.metadata?.type === 'commands') {
      this.options.commandCatalog?.setCommandSnapshot([...result.metadata.commands]);
      return;
    }
    if (result.metadata?.type === 'config_options') {
      const owner = this.nativeOwner;
      if (owner) void this.#publishModelsFromConfig(result.metadata.configOptions, owner);
      return;
    }
    if (!active.acceptingLiveOutput) return;
    this.accept(active);
    for (const event of result.events) {
      active.run.emit({
        ...event,
        scope: this.#nextScope(active),
      });
    }
  }

  private accept(active: ActiveExecution, response?: ACPPromptResponse): void {
    if (active.accepted) return;
    active.accepted = true;
    if (!this.nativeConversationContextEstablished) {
      this.#setNativeConversationContextEstablished(true);
      this.#updateSnapshot('executing');
      this.#emitCurrentSnapshot();
    }
    active.run.emit({
      accepted: true,
      ...(response?.userMessageId ? { nativeUserMessageId: response.userMessageId } : {}),
      scope: this.#nextScope(active),
      type: 'turn_started',
    });
  }

  #finishCompletedIfReady(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active) || !active.promptResponse) return;
    const response = active.promptResponse;
    if (active.promptUsage) {
      const model = active.request.configuration.model ?? '';
      const advertisedWindow = findCodeBuddyModel(
        getCodeBuddyProviderSettings(this.plugin.settings).currentCatalog?.models ?? [],
        model,
      )?.contextWindow;
      const size = active.contextUsage?.size || advertisedWindow;
      const usage = buildACPUsageInfo({
        model: decodeCodeBuddyModelId(model) ?? undefined,
        contextWindow: size ? { size, used: active.promptUsage.totalTokens } : null,
        promptUsage: active.promptUsage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', scope: this.#nextScope(active), usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.run.finish({
      providerPayload: response,
      reason: mapStopReason(response.stopReason),
      scope: this.#nextScope(active),
      type: 'turn_completed',
    });
    active.normalizer.dispose();
    this.active = null;
  }

  async #cancelRun(run: CodeBuddyExecutionRunState, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.cancellationGeneration += 1;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    this.quarantineGeneration += 1;
    active.abortController.abort();
    this.interactionController.dismissAll('cancelled');
    const native = this.nativeOwner?.native ?? null;
    this.cancellationFlight = (async () => {
      const sessionId = this.providerSessionId;
      if (native && sessionId) native.cancel(sessionId);
      try {
        if (native?.flush) await native.flush();
        await this.#shutdownNative();
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('invalidated', {
            message: 'The cancelled CodeBuddy process was quarantined and will be replaced.',
            reason: 'cancelled',
            recoverable: true,
          });
          this.#emitCurrentSnapshot();
        }
        if (!run.isTerminal) {
          run.finish({ reason, scope: this.#nextScope(active), type: 'cancelled' });
        }
        active.normalizer.dispose();
        if (this.active === active) this.active = null;
      }
    })().finally(() => {
      this.cancellationFlight = null;
    });
    return this.cancellationFlight;
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed
      || active.cancellationGeneration !== this.cancellationGeneration
      || this.active !== active
      || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution | undefined): void {
    if (active && this.#isCancellationRequested(active)) {
      throw new CodeBuddyExecutionCancellationError();
    }
  }

  async #shutdownNative(): Promise<void> {
    const startupFlight = this.nativeStartupFlight;
    const owner = this.nativeOwner;
    let shutdownError: Error | null = null;
    if (owner) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch (error) {
        shutdownError = toError(error);
      }
    }
    if (startupFlight) {
      try {
        await startupFlight;
      } catch {
        // The startup caller receives the initiating startup failure.
      }
    }
    const remainingOwner = this.nativeOwner;
    if (remainingOwner) {
      try {
        await this.#shutdownNativeOwner(remainingOwner);
      } catch (error) {
        shutdownError ??= toError(error);
      }
    }
    if (shutdownError) throw shutdownError;
  }

  #shutdownNativeOwner(owner: CodeBuddyNativeOwner): Promise<void> {
    if (this.nativeOwner === owner) {
      this.nativeOwner = null;
      try {
        owner.notificationUnsubscribe();
      } catch {
        // Listener cleanup cannot prevent process shutdown.
      }
    }
    if (!owner.shutdownFlight) {
      owner.shutdownFlight = Promise.resolve().then(() => owner.native.shutdown());
    }
    return owner.shutdownFlight;
  }

  #isCurrentNativeOwner(owner: CodeBuddyNativeOwner): boolean {
    return !this.disposed
      && owner.generation === this.nativeGeneration
      && this.nativeOwner === owner;
  }

  #getNativeOwner(native: CodeBuddyExecutionNativeConnection): CodeBuddyNativeOwner {
    const owner = this.nativeOwner;
    if (!owner || owner.native !== native) {
      throw new Error('CodeBuddy native connection ownership changed.');
    }
    return owner;
  }

  #captureProviderSession(providerSessionId: string): void {
    this.providerSessionId = providerSessionId;
  }

  #setNativeConversationContextEstablished(established: boolean): void {
    this.nativeConversationContextEstablished = established;
    this.providerState = {
      ...this.providerState,
      nativeConversationContextEstablished: established,
    };
  }

  async #publishSessionModels(
    response: {
      _meta?: ACPMetadata | null;
      configOptions?: ACPSessionConfigOption[] | null;
      models?: ACPSessionModelState | null;
    },
    sourceContextKey: string,
  ): Promise<void> {
    const { currentModelId, models } = normalizeCodeBuddySessionModelMetadata(response);
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(models, currentModelId ?? undefined, sourceContextKey);
    }
  }

  async #publishModelsFromConfig(
    options: readonly ACPSessionConfigOption[],
    owner: CodeBuddyNativeOwner,
  ): Promise<void> {
    if (!this.#isCurrentNativeOwner(owner)) return;
    const modelOption = options.find(
      option => option.id === CODEBUDDY_MODEL_CONFIG_ID && option.type === 'select',
    );
    if (!modelOption || modelOption.type !== 'select') return;
    const flat = modelOption.options.flatMap(option => (
      'options' in option ? option.options : [option]
    ));
    const models = normalizeCodeBuddyDiscoveredModels(flat.map(option => ({
      displayName: option.name,
      rawId: option.value,
      reasoningEfforts: [],
      supportsReasoning: false,
    })));
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(
        models,
        modelOption.currentValue,
        owner.modelContextKey,
      );
    }
  }

  async #mergeModelMetadataBestEffort(
    models: CodeBuddyDiscoveredModel[],
    defaultModelId: string | undefined,
    sourceContextKey: string,
  ): Promise<void> {
    try {
      await this.options.modelCatalogCoordinator?.mergeLiveModels(
        models,
        defaultModelId,
        sourceContextKey,
      );
    } catch {
      // Catalog synchronization is best-effort and cannot disrupt execution.
    }
  }

  #nextScope(active: ActiveExecution): ProviderRequestedEventScope {
    return {
      executionId: active.run.executionId,
      kind: 'requested',
      sequence: ++active.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: active.run.turnId,
    };
  }

  #updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: Extract<ProviderSessionSnapshot, { status: 'invalidated' }>['invalidation'],
  ): void {
    this.snapshot = this.#createSnapshot(status, invalidation);
  }

  #createSnapshot(
    status: ProviderSessionStatus,
    invalidation?: Extract<ProviderSessionSnapshot, { status: 'invalidated' }>['invalidation'],
  ): ProviderSessionSnapshot {
    const providerState = this.providerState;
    const base = {
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      providerId: this.providerId,
      revision: this.revision++,
    };
    return status === 'invalidated'
      ? { ...base, invalidation: invalidation!, status }
      : { ...base, status };
  }

  #emitCurrentSnapshot(): void {
    const active = this.active;
    if (active && !active.run.isTerminal) {
      active.run.emit({
        scope: this.#nextScope(active),
        snapshot: this.snapshot,
        type: 'session_state_changed',
      });
      return;
    }
    const event: ProviderSessionEvent = {
      scope: {
        kind: 'session',
        sequence: this.snapshot.revision,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'session_state_changed',
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with native CodeBuddy lifecycle.
      }
    }
  }
}

class CodeBuddyExecutionCancellationError extends Error {
  constructor() {
    super('CodeBuddy execution was cancelled.');
    this.name = 'CodeBuddyExecutionCancellationError';
  }
}

function createCodeBuddyToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    normalizeToolInput(rawName, input) {
      return normalizeCodeBuddyToolCall({ rawInput: input, title: rawName }).input;
    },
    normalizeToolName(rawName) {
      return normalizeCodeBuddyToolName(rawName ?? 'tool');
    },
    normalizeToolUseResult(rawName, input, rawOutput, rawInput) {
      return normalizeCodeBuddyToolUseResult(rawName ?? 'tool', input, rawOutput, rawInput);
    },
    resolveRawToolName(currentRawName, update) {
      return resolveCodeBuddyRawToolName(currentRawName, update);
    },
  });
}

function buildPromptBlocks(
  request: ProviderExecutionRequest,
  replayConversationHistory = false,
): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [];
  let text = request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const context = request.context;
  if (context?.linkedContent) {
    text = appendLinkedContent(text, context.linkedContent.path);
  }
  if (context?.editorSelection && context.editorSelection.mode !== 'none') {
    text = appendEditorContext(text, context.editorSelection);
  }
  if (context?.browserSelection) text = appendBrowserContext(text, context.browserSelection);
  if (context?.canvasSelection) text = appendCanvasContext(text, context.canvasSelection);
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    text = buildPromptWithHistoryContext(
      buildContextFromHistory(history),
      text,
      text,
      history,
    );
  }
  if (text) blocks.push({ text, type: 'text' });
  for (const block of request.input) {
    if (block.type === 'image' && block.image.data) {
      blocks.push({
        data: block.image.data,
        mimeType: block.image.mediaType,
        type: 'image',
      });
    }
  }
  return blocks;
}

export function resolveCodeBuddyModeId(request: ProviderExecutionRequest): string {
  if (request.configuration.permissionMode === 'plan') return 'plan';
  if (
    request.configuration.permissionMode === 'yolo'
    || request.toolPolicy.kind === 'unrestricted'
  ) {
    return 'bypassPermissions';
  }
  return 'default';
}

function parseCodeBuddyPromptUsage(response: ACPPromptResponse): ACPUsage | null {
  const usage = (response as { usage?: unknown }).usage;
  if (!isRecord(usage)) return null;
  const inputTokens = readFiniteNumber(usage.inputTokens);
  const outputTokens = readFiniteNumber(usage.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cachedReadTokens = readFiniteNumber(usage.cachedReadTokens);
  const cachedWriteTokens = readFiniteNumber(usage.cachedWriteTokens);
  const thoughtTokens = readFiniteNumber(usage.thoughtTokens);
  return {
    ...(cachedReadTokens !== null ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== null ? { cachedWriteTokens } : {}),
    inputTokens,
    outputTokens,
    ...(thoughtTokens !== null ? { thoughtTokens } : {}),
    totalTokens: readFiniteNumber(usage.totalTokens) ?? inputTokens + outputTokens,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapStopReason(reason: string): 'completed' | 'max-tokens' | 'provider-ended' {
  if (reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens';
  return reason === 'end_turn' || reason === 'completed' ? 'completed' : 'provider-ended';
}

function classifyError(
  error: unknown,
): 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'unknown' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (error instanceof ProviderModelUnavailableError) return 'configuration';
  if (message.includes('auth')) return 'authentication';
  if (message.includes('session') && (message.includes('missing') || message.includes('not found'))) {
    return 'provider-session-missing';
  }
  if (message.includes('config') || message.includes('model')) return 'configuration';
  if (message.includes('transport') || message.includes('closed')) return 'transport';
  return 'unknown';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
