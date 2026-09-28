import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_KILL_SHELL,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_LS,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_READ_MCP_RESOURCE,
  TOOL_SKILL,
  TOOL_SUBAGENT,
  TOOL_TODO_WRITE,
  TOOL_TOOL_SEARCH,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { AskUserAnswers } from '../../../core/types';
import type { SDKToolUseResult } from '../../../core/types/diff';
import type { ACPToolRawNameProvenance } from '../../acp/ACPToolStreamAdapter';

/**
 * CodeBuddy advertises Claude Code style tool titles (`Read`, `Glob`, ...).
 * snake_case aliases are kept for runtimes that report native tool ids.
 */
const CODEBUDDY_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  agent: TOOL_SUBAGENT,
  askuserquestion: TOOL_ASK_USER_QUESTION,
  bash: TOOL_BASH,
  bashoutput: TOOL_BASH_OUTPUT,
  edit: TOOL_EDIT,
  edit_file: TOOL_EDIT,
  enterplanmode: TOOL_ENTER_PLAN_MODE,
  exitplanmode: TOOL_EXIT_PLAN_MODE,
  find: TOOL_GLOB,
  glob: TOOL_GLOB,
  grep: TOOL_GREP,
  kill_shell: TOOL_KILL_SHELL,
  killshell: TOOL_KILL_SHELL,
  list_dir: TOOL_LS,
  listmcpresources: TOOL_LIST_MCP_RESOURCES,
  ls: TOOL_LS,
  multiedit: TOOL_EDIT,
  notebookedit: TOOL_NOTEBOOK_EDIT,
  read: TOOL_READ,
  read_file: TOOL_READ,
  readmcpresource: TOOL_READ_MCP_RESOURCE,
  run_terminal_command: TOOL_BASH,
  search_replace: TOOL_EDIT,
  skill: TOOL_SKILL,
  slashcommand: 'SlashCommand',
  task: TOOL_SUBAGENT,
  taskoutput: TOOL_ASK_USER_QUESTION,
  todo_write: TOOL_TODO_WRITE,
  todowrite: TOOL_TODO_WRITE,
  toolsearch: TOOL_TOOL_SEARCH,
  webfetch: TOOL_WEB_FETCH,
  web_fetch: TOOL_WEB_FETCH,
  websearch: TOOL_WEB_SEARCH,
  web_search: TOOL_WEB_SEARCH,
  write: TOOL_WRITE,
  write_file: TOOL_WRITE,
};

export interface CodeBuddyNormalizedToolCall {
  input: Record<string, unknown>;
  name: string;
  output: string;
  rawInput: unknown;
  rawName: string;
  rawOutput: unknown;
}

export interface CodeBuddyToolProviderPayload {
  rawInput?: unknown;
  rawName: string;
  rawOutput?: unknown;
}

export interface CodeBuddyNormalizedToolUseResult extends SDKToolUseResult {
  answers?: AskUserAnswers;
  providerPayload: CodeBuddyToolProviderPayload;
}

export interface CodeBuddyRawToolNameResolution {
  provenance: ACPToolRawNameProvenance;
  rawName: string;
}

export function normalizeCodeBuddyToolName(rawName: string): string {
  const normalized = rawName.trim();
  if (!normalized) {
    return 'tool';
  }
  return CODEBUDDY_TOOL_NAME_MAP[normalized.toLowerCase()] ?? normalized;
}

export function resolveCodeBuddyRawToolName(
  currentRawName: CodeBuddyRawToolNameResolution | undefined,
  update: { kind?: string | null; title?: string | null },
): CodeBuddyRawToolNameResolution {
  const title = update.title?.trim();
  const normalizedTitle = title?.toLowerCase();
  if (currentRawName?.provenance === 'title') {
    return currentRawName;
  }
  if (normalizedTitle && normalizedTitle in CODEBUDDY_TOOL_NAME_MAP) {
    return { provenance: 'title', rawName: normalizedTitle };
  }
  if (title) {
    return { provenance: 'title', rawName: title };
  }
  if (currentRawName) {
    return currentRawName;
  }
  const kind = update.kind?.trim();
  if (kind) {
    return { provenance: 'kind', rawName: kind };
  }
  return { provenance: 'fallback', rawName: 'tool' };
}

export function normalizeCodeBuddyToolCall(
  value: {
    kind?: string | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    title?: string | null;
  },
  currentRawName?: CodeBuddyRawToolNameResolution,
): CodeBuddyNormalizedToolCall {
  const rawName = resolveCodeBuddyRawToolName(currentRawName, value).rawName;
  return {
    input: normalizeToolInput(rawName, value.rawInput),
    name: normalizeCodeBuddyToolName(rawName),
    output: formatToolOutput(value.rawOutput),
    rawInput: value.rawInput,
    rawName,
    rawOutput: value.rawOutput,
  };
}

export function buildCodeBuddyToolProviderPayload(value: {
  rawInput?: unknown;
  rawName: string;
  rawOutput?: unknown;
}): CodeBuddyToolProviderPayload {
  return {
    ...(value.rawInput !== undefined ? { rawInput: value.rawInput } : {}),
    rawName: value.rawName,
    ...(value.rawOutput !== undefined ? { rawOutput: value.rawOutput } : {}),
  };
}

export function normalizeCodeBuddyToolUseResult(
  rawName: string,
  input: Record<string, unknown>,
  rawOutput: unknown,
  rawInput?: unknown,
): CodeBuddyNormalizedToolUseResult {
  const providerPayload = buildCodeBuddyToolProviderPayload({
    rawInput,
    rawName,
    rawOutput,
  });
  const answers = normalizeCodeBuddyQuestionAnswers(rawName, input, rawOutput);
  return {
    ...(answers ? { answers } : {}),
    providerPayload,
  };
}

function normalizeCodeBuddyQuestionAnswers(
  rawName: string,
  input: Record<string, unknown>,
  rawOutput: unknown,
): AskUserAnswers | undefined {
  if (normalizeCodeBuddyToolName(rawName) !== TOOL_ASK_USER_QUESTION || !isRecord(rawOutput)) {
    return undefined;
  }
  const userAnswered = isRecord(rawOutput.UserAnswered)
    ? rawOutput.UserAnswered
    : isRecord(rawOutput.userAnswered)
      ? rawOutput.userAnswered
      : null;
  const message = userAnswered && typeof userAnswered.message === 'string'
    ? userAnswered.message.trim()
    : '';
  if (!message) return undefined;

  const parsed = extractResolvedAnswersFromResultText(message);
  if (parsed) return parsed;

  const questions = Array.isArray(input.questions)
    ? input.questions.filter(isRecord)
    : [];
  if (questions.length !== 1) {
    return undefined;
  }
  const questionText = typeof questions[0].question === 'string' ? questions[0].question : '';
  if (!questionText) return undefined;
  const questionId = typeof questions[0].id === 'string' ? questions[0].id : '';
  const answers: AskUserAnswers = { [questionText]: message };
  if (questionId) {
    answers[questionId] = message;
  }
  return answers;
}

function normalizeToolInput(rawName: string, value: unknown): Record<string, unknown> {
  const input = isRecord(value)
    ? value
    : value === undefined ? {} : { value };

  switch (rawName.trim().toLowerCase()) {
    case 'read':
    case 'read_file':
      return addInputAlias(input, 'file_path', ['path', 'target_file']);
    case 'list_dir':
    case 'ls':
      return addInputAlias(input, 'path', ['target_directory']);
    case 'glob':
    case 'find':
      return addInputAlias(input, 'path', ['directory', 'cwd']);
    case 'skill':
      return addInputAlias(input, 'skill', ['name']);
    case 'task':
    case 'agent':
      return addInputAlias(input, 'run_in_background', ['background']);
    case 'todo_write':
    case 'todowrite':
      return normalizeTodoInput(input);
    default:
      return input;
  }
}

function addInputAlias(
  input: Record<string, unknown>,
  targetKey: string,
  sourceKeys: readonly string[],
): Record<string, unknown> {
  if (input[targetKey] !== undefined) return input;
  for (const sourceKey of sourceKeys) {
    if (input[sourceKey] !== undefined) {
      return { ...input, [targetKey]: input[sourceKey] };
    }
  }
  return input;
}

function normalizeTodoInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.todos)) return input;

  let changed = false;
  const rawTodos: unknown[] = input.todos;
  const todos = rawTodos.map((todo) => {
    if (!isRecord(todo) || typeof todo.content !== 'string' || todo.activeForm !== undefined) {
      return todo;
    }
    changed = true;
    return { ...todo, activeForm: todo.content };
  });
  return changed ? { ...input, todos } : input;
}

function formatToolOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
