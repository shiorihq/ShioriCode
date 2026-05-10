/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { ProviderUserInputAnswers, UserInputQuestion } from "contracts";
import { Schema } from "effect";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

export interface CursorAskQuestionResponse {
  readonly outcome:
    | {
        readonly outcome: "answered";
        readonly answers: ReadonlyArray<{
          readonly questionId: string;
          readonly selectedOptionIds: ReadonlyArray<string>;
        }>;
      }
    | { readonly outcome: "cancelled" };
}

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export interface CursorCreatePlanResponse {
  readonly outcome: { readonly outcome: "accepted" };
}

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

function normalizeAnswerValues(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function resolveSelectedOptionIds(
  question: typeof CursorAskQuestion.Type,
  rawAnswer: unknown,
): ReadonlyArray<string> {
  const selectedOptionIds: Array<string> = [];
  for (const value of normalizeAnswerValues(rawAnswer)) {
    const option =
      question.options.find((candidate) => candidate.id === value) ??
      question.options.find((candidate) => candidate.label === value);
    selectedOptionIds.push(option?.id ?? value);
  }

  const deduped = Array.from(new Set(selectedOptionIds));
  return question.allowMultiple === true ? deduped : deduped.slice(0, 1);
}

export function buildCursorAskQuestionResponse(
  params: typeof CursorAskQuestionRequest.Type,
  answers: ProviderUserInputAnswers,
): CursorAskQuestionResponse {
  const hasSelectableQuestion = params.questions.some((question) => question.options.length > 0);
  if (Object.keys(answers).length === 0 && hasSelectableQuestion) {
    return { outcome: { outcome: "cancelled" } };
  }

  return {
    outcome: {
      outcome: "answered",
      answers: params.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: resolveSelectedOptionIds(question, answers[question.id]),
      })),
    },
  };
}

export function buildCursorCreatePlanResponse(): CursorCreatePlanResponse {
  return { outcome: { outcome: "accepted" } };
}

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() ?? todo.title?.trim() ?? "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}

type CursorTodoInput = typeof CursorTodo.Type;

interface CursorTodoStateEntry {
  readonly id: string;
  readonly content?: string;
  readonly title?: string;
  readonly status?: string;
}

export interface CursorTodoPlanState {
  readonly todosById: Map<string, CursorTodoStateEntry>;
  readonly order: Array<string>;
  lastPlan:
    | {
        readonly explanation?: string;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      }
    | undefined;
}

export function makeCursorTodoPlanState(): CursorTodoPlanState {
  return {
    todosById: new Map(),
    order: [],
    lastPlan: undefined,
  };
}

function normalizeTodoId(todo: CursorTodoInput, index: number): string {
  const explicitId = todo.id?.trim();
  if (explicitId) {
    return explicitId;
  }
  const contentKey = todo.content?.trim() || todo.title?.trim();
  return contentKey ? `content:${contentKey}` : `index:${index}`;
}

function mergeTodoEntry(
  previous: CursorTodoStateEntry | undefined,
  id: string,
  todo: CursorTodoInput,
): CursorTodoStateEntry {
  return {
    id,
    ...(previous?.content !== undefined ? { content: previous.content } : {}),
    ...(previous?.title !== undefined ? { title: previous.title } : {}),
    ...(previous?.status !== undefined ? { status: previous.status } : {}),
    ...(todo.content !== undefined ? { content: todo.content } : {}),
    ...(todo.title !== undefined ? { title: todo.title } : {}),
    ...(todo.status !== undefined ? { status: todo.status } : {}),
  };
}

function todoEntryToInput(entry: CursorTodoStateEntry): CursorTodoInput {
  return {
    id: entry.id,
    ...(entry.content !== undefined ? { content: entry.content } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
  };
}

export function applyCursorTodosUpdate(
  state: CursorTodoPlanState,
  params: typeof CursorUpdateTodosRequest.Type,
): CursorTodoPlanState["lastPlan"] {
  if (!params.merge) {
    state.todosById.clear();
    state.order.splice(0);
  }

  params.todos.forEach((todo, index) => {
    const id = normalizeTodoId(todo, index);
    if (!state.todosById.has(id)) {
      state.order.push(id);
    }
    state.todosById.set(id, mergeTodoEntry(state.todosById.get(id), id, todo));
  });

  const mergedTodos = state.order
    .map((id) => state.todosById.get(id))
    .filter((entry): entry is CursorTodoStateEntry => entry !== undefined)
    .map(todoEntryToInput);
  state.lastPlan = extractTodosAsPlan({
    toolCallId: params.toolCallId,
    merge: false,
    todos: mergedTodos,
  });
  return state.lastPlan;
}
