import {
  ACP_METHOD_NAMES,
  ACPJSONRPCTransport,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  ACPSubprocess,
} from '../../acp';
import {
  normalizeCodeBuddySessionModelMetadata,
  type NormalizedCodeBuddySessionModels,
} from '../execution/CodeBuddySessionModelMetadata';

export interface CodeBuddyModelCatalogProbeRequest {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  version: string;
}

export interface CodeBuddyModelCatalogProbeLike {
  discover(request: CodeBuddyModelCatalogProbeRequest): Promise<NormalizedCodeBuddySessionModels>;
}

/**
 * Owns a short-lived ACP process. CodeBuddy exposes its model catalog on
 * `session/new`, so discovery opens an ephemeral session with persistence
 * disabled and never prompts it.
 */
export class CodeBuddyModelCatalogProbe implements CodeBuddyModelCatalogProbeLike {
  async discover(request: CodeBuddyModelCatalogProbeRequest): Promise<NormalizedCodeBuddySessionModels> {
    request.signal?.throwIfAborted();
    const process = new ACPSubprocess({
      args: ['--acp', '--no-session-persistence'],
      command: request.command,
      cwd: request.cwd,
      env: request.env,
    });
    let transport: ACPJSONRPCTransport | undefined;
    try {
      process.start();
      transport = new ACPJSONRPCTransport({
        input: process.stdout,
        onClose: listener => process.onClose(listener),
        output: process.stdin,
      });
      const options = { signal: request.signal, timeoutMs: request.timeoutMs };
      await transport.request(ACP_METHOD_NAMES.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'claudian', version: request.version },
      }, options);
      const response = await transport.request<{
        configOptions?: ACPSessionConfigOption[] | null;
        models?: ACPSessionModelState | null;
      }>(ACP_METHOD_NAMES.newSession, {
        cwd: request.cwd,
        mcpServers: [],
      }, options);

      const catalog = normalizeCodeBuddySessionModelMetadata({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      });
      // The catalog is a complete capability snapshot; live updates may be partial.
      return {
        ...catalog,
        models: catalog.models.map(model => ({ ...model, reasoningMetadataResolved: true })),
      };
    } finally {
      transport?.dispose();
      await process.shutdown();
    }
  }
}
