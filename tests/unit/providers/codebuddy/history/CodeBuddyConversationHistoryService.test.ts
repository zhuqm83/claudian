import type { Conversation } from '@/core/types';
import { CodeBuddyConversationHistoryService } from '@/providers/codebuddy/history/CodeBuddyConversationHistoryService';

function createConversation(): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    lastActivityAt: 1,
    messages: [{ content: 'Hello', id: 'm1', role: 'user', timestamp: 1 }],
    providerId: 'codebuddy',
    providerState: {
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: true,
    },
    sessionId: 'session-1',
    title: 'CodeBuddy',
  };
}

describe('CodeBuddyConversationHistoryService', () => {
  it('leaves Claudian-owned messages untouched during hydration', async () => {
    const service = new CodeBuddyConversationHistoryService();
    const conversation = createConversation();

    const update = await service.hydrateConversationHistory(conversation, '/vault');

    expect(update.messages).toEqual(conversation.messages);
    expect(update.providerState).toEqual(conversation.providerState);
  });

  it('resolves the persisted native session id', () => {
    const service = new CodeBuddyConversationHistoryService();

    expect(service.resolveSessionIdForConversation(createConversation())).toBe('session-1');
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
  });

  it('never reports a pending fork because CodeBuddy cannot fork', () => {
    const service = new CodeBuddyConversationHistoryService();

    expect(service.isPendingForkConversation(createConversation())).toBe(false);
    expect(service.buildForkProviderState('session-1', 'assistant-1')).toEqual({});
  });

  it('preserves unknown provider state when persisting', () => {
    const service = new CodeBuddyConversationHistoryService();

    expect(service.buildPersistedProviderState(createConversation())).toEqual({
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: true,
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('resets a confirmed stale binding while preserving unknown state', async () => {
      const service = new CodeBuddyConversationHistoryService();
      const conversation = createConversation();

      const result = await service.resolveMissingConversationSession(
        conversation,
        '/vault',
        'session-1',
      );

      expect(result.outcome).toBe('reset');
      expect(result.changes?.sessionId).toBeNull();
      expect(result.changes?.providerState).toEqual({
        futureResumeCursor: { token: 'cursor-1' },
      });
    });

    it('preserves a newer binding when the failure identifies another session', async () => {
      const service = new CodeBuddyConversationHistoryService();

      const result = await service.resolveMissingConversationSession(
        createConversation(),
        '/vault',
        'stale-session',
      );

      expect(result.outcome).toBe('preserve');
      expect(result.changes).toBeUndefined();
    });
  });
});
