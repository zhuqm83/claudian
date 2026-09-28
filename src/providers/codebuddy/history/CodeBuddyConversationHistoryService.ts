import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryResult,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  buildPersistedCodeBuddyProviderState,
  parseCodeBuddyProviderState,
} from '../types';

const CODEBUDDY_PROVIDER_STATE_KEYS = [
  'nativeConversationContextEstablished',
] as const;

/**
 * CodeBuddy keeps native sessions inside `~/.codebuddy`, but ACP exposes no
 * transcript reader. Claudian's own message store is authoritative here; the
 * native session id is retained so `session/load` can restore agent context.
 */
export class CodeBuddyConversationHistoryService implements ProviderConversationHistoryService {
  hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate> {
    return Promise.resolve(copyProviderHistoryState(input));
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    if (
      !conversation.sessionId
      || !missingProviderSessionId
      || conversation.sessionId !== missingProviderSessionId
    ) {
      return Promise.resolve({ outcome: 'preserve' });
    }

    const providerState = { ...conversation.providerState };
    for (const key of CODEBUDDY_PROVIDER_STATE_KEYS) delete providerState[key];
    conversation.sessionId = null;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    return Promise.resolve({ outcome: 'reset', changes: conversation });
  }

  isPendingForkConversation(_conversation: ProviderHistoryInput): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
    _vaultPath?: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Record<string, unknown> {
    return {};
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      CODEBUDDY_PROVIDER_STATE_KEYS,
      buildPersistedCodeBuddyProviderState(
        parseCodeBuddyProviderState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }
}
