import {
  normalizeCodeBuddyToolCall,
  normalizeCodeBuddyToolName,
  normalizeCodeBuddyToolUseResult,
  resolveCodeBuddyRawToolName,
} from '@/providers/codebuddy/normalization/codebuddyToolNormalization';

describe('codebuddy tool normalization', () => {
  it('maps CodeBuddy tool titles onto shared tool names', () => {
    expect(normalizeCodeBuddyToolName('Read')).toBe('Read');
    expect(normalizeCodeBuddyToolName('Glob')).toBe('Glob');
    expect(normalizeCodeBuddyToolName('TodoWrite')).toBe('TodoWrite');
    expect(normalizeCodeBuddyToolName('read_file')).toBe('Read');
    expect(normalizeCodeBuddyToolName('run_terminal_command')).toBe('Bash');
    expect(normalizeCodeBuddyToolName('UnmappedTool')).toBe('UnmappedTool');
    expect(normalizeCodeBuddyToolName('   ')).toBe('tool');
  });

  it('keeps the first resolved tool name when later updates carry descriptive titles', () => {
    const first = resolveCodeBuddyRawToolName(undefined, { kind: 'other', title: 'Read' });
    expect(first).toEqual({ provenance: 'title', rawName: 'read' });

    const later = resolveCodeBuddyRawToolName(first, {
      kind: 'read',
      title: 'Read d:\\vault\\note.md',
    });
    expect(later).toBe(first);
  });

  it('falls back through title, kind, and finally a placeholder', () => {
    expect(resolveCodeBuddyRawToolName(undefined, { title: 'Custom action' }))
      .toEqual({ provenance: 'title', rawName: 'Custom action' });
    expect(resolveCodeBuddyRawToolName(undefined, { kind: 'search' }))
      .toEqual({ provenance: 'kind', rawName: 'search' });
    expect(resolveCodeBuddyRawToolName(undefined, {}))
      .toEqual({ provenance: 'fallback', rawName: 'tool' });
  });

  it('normalizes incremental rawInput into the shared input shape', () => {
    const call = normalizeCodeBuddyToolCall({
      rawInput: { path: 'note.md' },
      title: 'Read',
    });

    expect(call.name).toBe('Read');
    expect(call.input).toEqual({ file_path: 'note.md', path: 'note.md' });
  });

  it('keeps raw payloads available to the renderer', () => {
    const result = normalizeCodeBuddyToolUseResult(
      'Read',
      { file_path: 'note.md' },
      'contents',
      { file_path: 'note.md' },
    );

    expect(result.providerPayload).toEqual({
      rawInput: { file_path: 'note.md' },
      rawName: 'Read',
      rawOutput: 'contents',
    });
  });
});
