import type {
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPNewSessionResponse,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPSessionNotification,
  ACPSetSessionConfigOptionRequest,
  ACPSetSessionConfigOptionResponse,
  ACPSetSessionModelRequest,
  ACPSetSessionModelResponse,
  ACPSetSessionModeRequest,
} from '../../acp';
import { ACPClientConnection, ACPJSONRPCTransport, ACPSubprocess } from '../../acp';
import type {
  CodeBuddyExecutionNativeConnection,
  CodeBuddyExecutionNativeCreateOptions,
} from './CodeBuddyExecutionBackend';

/** CodeBuddy exposes ACP over stdio via its `--acp` flag. */
const CODEBUDDY_ACP_ARGS = ['--acp'] as const;

export class CodeBuddyExecutionNativeConnectionImpl
implements CodeBuddyExecutionNativeConnection {
  private readonly connection: ACPClientConnection;
  private readonly listeners = new Set<
    Parameters<CodeBuddyExecutionNativeConnection['onNotification']>[0]
  >();
  private readonly process: ACPSubprocess;
  private readonly transport: ACPJSONRPCTransport;

  constructor(options: CodeBuddyExecutionNativeCreateOptions) {
    this.process = new ACPSubprocess({
      args: [...CODEBUDDY_ACP_ARGS, ...options.systemPromptArgs],
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    });
    this.process.start();
    this.transport = new ACPJSONRPCTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.connection = new ACPClientConnection({
      clientInfo: { name: 'claudian', version: options.version },
      delegate: {
        onSessionNotification: notification => this.notify(notification),
        requestPermission: request => options.requestPermission(request),
      },
      transport: this.transport,
    });
  }

  cancel(sessionId: string): void {
    this.connection.cancel({ sessionId });
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  async initialize(): Promise<void> {
    await this.connection.initialize();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse> {
    return this.connection.loadSession(request);
  }

  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.connection.newSession(request);
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.process.onClose(listener);
  }

  onNotification(
    listener: Parameters<CodeBuddyExecutionNativeConnection['onNotification']>[0],
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse> {
    return this.connection.prompt(request);
  }

  setConfigOption(
    request: ACPSetSessionConfigOptionRequest,
  ): Promise<ACPSetSessionConfigOptionResponse> {
    return this.connection.setConfigOption(request);
  }

  setMode(request: ACPSetSessionModeRequest): Promise<unknown> {
    return this.connection.setMode(request);
  }

  setModel(request: ACPSetSessionModelRequest): Promise<ACPSetSessionModelResponse> {
    return this.connection.setModel(request);
  }

  async shutdown(): Promise<void> {
    this.listeners.clear();
    this.connection.dispose();
    this.transport.dispose();
    await this.process.shutdown();
  }

  private notify(notification: ACPSessionNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}
