import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPNewSessionResponse,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionNotification,
  ACPSetSessionConfigOptionRequest,
  ACPSetSessionConfigOptionResponse,
  ACPSetSessionModelRequest,
  ACPSetSessionModelResponse,
  ACPSetSessionModeRequest,
} from '../../acp';
import type { CodeBuddyCommandCatalog } from '../commands/CodeBuddyCommandCatalog';
import type { CodeBuddyModelCatalogCoordinator } from '../runtime/CodeBuddyModelCatalogCoordinator';
import { CodeBuddyExecutionNativeConnectionImpl } from './CodeBuddyExecutionNativeConnection';
import { CodeBuddyExecutionSession } from './CodeBuddyExecutionSession';

export interface CodeBuddyExecutionNativeConnection {
  cancel(sessionId: string): void;
  flush?(): Promise<void>;
  initialize(): Promise<void>;
  isAlive?(): boolean;
  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse>;
  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse>;
  onClose?(listener: (error?: Error) => void): () => void;
  onNotification(
    listener: (notification: ACPSessionNotification) => void,
  ): () => void;
  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse>;
  setConfigOption(
    request: ACPSetSessionConfigOptionRequest,
  ): Promise<ACPSetSessionConfigOptionResponse>;
  setMode(request: ACPSetSessionModeRequest): Promise<unknown>;
  setModel(request: ACPSetSessionModelRequest): Promise<ACPSetSessionModelResponse>;
  shutdown(): Promise<void>;
}

export interface CodeBuddyExecutionNativeCreateOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestPermission: (
    request: ACPRequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<ACPRequestPermissionResponse>;
  /**
   * CodeBuddy ignores `_meta.systemPromptOverride` over ACP, so the prompt is
   * passed through its native CLI flags at process launch.
   */
  readonly systemPromptArgs: readonly string[];
  readonly version: string;
}

export interface CodeBuddyExecutionNativeFactory {
  create(options: CodeBuddyExecutionNativeCreateOptions): CodeBuddyExecutionNativeConnection;
}

export interface CodeBuddyExecutionBackendOptions {
  readonly commandCatalog?: Pick<CodeBuddyCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<CodeBuddyModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory?: CodeBuddyExecutionNativeFactory;
}

export class CodeBuddyExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'codebuddy' as const;
  private readonly nativeFactory: CodeBuddyExecutionNativeFactory;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CodeBuddyExecutionBackendOptions = {},
  ) {
    this.nativeFactory = options.nativeFactory ?? {
      create: nativeOptions => new CodeBuddyExecutionNativeConnectionImpl(nativeOptions),
    };
  }

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CodeBuddyExecutionSession(this.plugin, config, {
      commandCatalog: this.options.commandCatalog,
      modelCatalogCoordinator: this.options.modelCatalogCoordinator,
      nativeFactory: this.nativeFactory,
    });
  }
}
