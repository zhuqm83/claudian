import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { getVaultPath } from '../../../utils/path';
import type { CodeBuddyDiscoveredModel } from '../models';
import { getCodeBuddyProviderSettings } from '../settings';
import {
  CodeBuddyModelCatalogProbe,
  type CodeBuddyModelCatalogProbeLike,
} from './CodeBuddyModelCatalogProbe';
import { buildCodeBuddyRuntimeEnv } from './CodeBuddyRuntimeEnvironment';

const FINGERPRINT_VERSION = '1';
const MODEL_COMMAND_TIMEOUT_MS = 30_000;

export type CodeBuddyModelCatalogDiscoveryResult =
  | {
    defaultModelId: string | null;
    diagnostics?: string;
    fingerprint: string;
    kind: 'completed';
    models: CodeBuddyDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface CodeBuddyModelCatalogServiceLike {
  discoverCatalog(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CodeBuddyModelCatalogDiscoveryResult>;
}

export interface CodeBuddyModelCatalogServiceOptions {
  modelCommandTimeoutMs?: number;
  probe?: CodeBuddyModelCatalogProbeLike;
}

export interface CodeBuddyCatalogFingerprintInputs {
  command: string;
  environmentKeys: string[];
  version: string;
}

export function buildCodeBuddyCatalogFingerprint(
  inputs: CodeBuddyCatalogFingerprintInputs,
): string {
  const payload = [
    FINGERPRINT_VERSION,
    inputs.command.trim(),
    inputs.version.trim(),
    Array.from(new Set(inputs.environmentKeys.map(key => key.trim()).filter(Boolean))).sort(),
  ];
  return `${FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}

export class CodeBuddyModelCatalogService implements CodeBuddyModelCatalogServiceLike {
  private readonly probe: CodeBuddyModelCatalogProbeLike;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CodeBuddyModelCatalogServiceOptions = {},
  ) {
    this.probe = options.probe ?? new CodeBuddyModelCatalogProbe();
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<CodeBuddyModelCatalogDiscoveryResult> {
    if (!getCodeBuddyProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    const command = await this.plugin.getResolvedProviderCliPath('codebuddy', ownerContext)
      ?? 'codebuddy';
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const configuredEnvironment = getRuntimeEnvironmentVariables(this.plugin.settings, 'codebuddy');
    const fingerprint = buildCodeBuddyCatalogFingerprint({
      command,
      environmentKeys: Object.keys(configuredEnvironment),
      version: this.plugin.manifest?.version ?? 'unavailable',
    });

    try {
      const catalog = await this.probe.discover({
        command,
        cwd,
        env: buildCodeBuddyRuntimeEnv(this.plugin.settings, command),
        signal,
        timeoutMs: this.options.modelCommandTimeoutMs ?? MODEL_COMMAND_TIMEOUT_MS,
        version: this.plugin.manifest?.version ?? '0.0.0',
      });
      if (catalog.models.length === 0) {
        return {
          defaultModelId: null,
          diagnostics: 'CodeBuddy returned no available models',
          fingerprint,
          kind: 'completed',
          models: [],
        };
      }
      return {
        defaultModelId: catalog.currentModelId,
        fingerprint,
        kind: 'completed',
        models: catalog.models,
      };
    } catch {
      return {
        defaultModelId: null,
        diagnostics: signal?.aborted
          ? 'CodeBuddy model discovery was cancelled'
          : 'CodeBuddy model discovery failed',
        fingerprint,
        kind: 'completed',
        models: [],
      };
    }
  }
}
