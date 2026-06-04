import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  AskQuestionInteractionSpec,
  HookResult,
  QuestionHookResult,
  QuestionResponse,
  StepSource,
  StepType,
  ToolCall,
} from "../types.js";
import { HookContext, OnInteractionHook, PreToolCallDecideHook } from "../hooks/hooks.js";
import type { Agent } from "../agent.js";

export type InteractiveIO = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  read?: (prompt: string) => Promise<string>;
};

export async function asyncInput(prompt = "", io: InteractiveIO = {}): Promise<string> {
  if (io.read) {
    return await io.read(prompt);
  }
  const output = io.output ?? stdout;
  const rl = createInterface({
    input: io.input ?? stdin,
    output,
    terminal: Boolean((output as NodeJS.WriteStream).isTTY),
  });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export const async_input: typeof asyncInput = asyncInput;

export class Spinner implements AsyncDisposable {
  #message: string;
  #enabled: boolean;
  #timer?: ReturnType<typeof setInterval>;
  #frame = 0;
  #frames = ["-", "\\", "|", "/"];

  constructor(message = "Thinking...", enabled = Boolean(stdout.isTTY)) {
    this.#message = message;
    this.#enabled = enabled;
  }

  update(message: string): void {
    this.#message = message;
  }

  start(): this {
    if (!this.#enabled || this.#timer) {
      return this;
    }
    this.#timer = setInterval(() => {
      stdout.write(`\r\x1b[K${this.#frames[this.#frame]} ${this.#message}`);
      this.#frame = (this.#frame + 1) % this.#frames.length;
    }, 80);
    return this;
  }

  stop(): void {
    if (!this.#timer) {
      return;
    }
    clearInterval(this.#timer);
    this.#timer = undefined;
    stdout.write("\r\x1b[K");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
  }
}

export class ToolConfirmationHook extends PreToolCallDecideHook {
  #io: InteractiveIO;

  constructor(io: InteractiveIO = {}) {
    super();
    this.#io = io;
  }

  override async run(_context: HookContext, data: ToolCall): Promise<HookResult> {
    console.log(`\nTool execution requested: ${data.name}`);
    if (Object.keys(data.args).length) {
      console.log(`Arguments: ${JSON.stringify(data.args)}`);
    }

    let answer = "n";
    try {
      answer = await asyncInput("Allow execution? (y/n) [n]: ", this.#io);
    } catch {
      answer = "n";
    }

    return isYes(answer)
      ? new HookResult({ allow: true })
      : new HookResult({ allow: false, message: "User denied tool call." });
  }
}

export async function askUserHandler(toolCall: ToolCall, io: InteractiveIO = {}): Promise<boolean> {
  console.log(`\nPolicy check: Tool execution requested: ${toolCall.name}`);
  if (Object.keys(toolCall.args).length) {
    console.log(`Arguments: ${JSON.stringify(toolCall.args)}`);
  }

  try {
    return isYes(await asyncInput("Allow execution? (y/n) [n]: ", io));
  } catch {
    return false;
  }
}

export const ask_user_handler: typeof askUserHandler = askUserHandler;

export function _upgrade_to_interactive_confirmation(agent: Agent, io: InteractiveIO = {}): void {
  agent.upgradeRunCommandConfirmation((toolCall) => askUserHandler(toolCall, io));
}

export class AskQuestionHook extends OnInteractionHook {
  #io: InteractiveIO;

  constructor(io: InteractiveIO = {}) {
    super();
    this.#io = io;
  }

  override async run(
    _context: HookContext,
    data: AskQuestionInteractionSpec,
  ): Promise<QuestionHookResult> {
    const responses: QuestionResponse[] = [];
    try {
      for (const question of data.questions) {
        console.log(`\nQuestion: ${question.question}`);
        question.options.forEach((option, index) => {
          console.log(`  ${index + 1}. ${option.text}`);
        });

        const answer = (await asyncInput("Response: ", this.#io)).trim();
        if (!answer) {
          responses.push(new QuestionResponse({ skipped: true }));
          continue;
        }

        const optionId = matchOption(answer, question.options);
        responses.push(
          optionId
            ? new QuestionResponse({ selectedOptionIds: [optionId] })
            : new QuestionResponse({ freeformResponse: answer }),
        );
      }
    } catch {
      return new QuestionHookResult({ responses, cancelled: true });
    }

    return new QuestionHookResult({ responses });
  }
}

export async function runInteractiveLoop(agent: Agent, io: InteractiveIO = {}): Promise<void> {
  if (!agent.isStarted) {
    throw new Error("Agent session not started. Use 'await Agent.start(...)'.");
  }

  agent.registerHook(new AskQuestionHook(io));
  _upgrade_to_interactive_confirmation(agent, io);
  console.log("Starting interactive loop. Type 'exit' or 'quit' to end.");

  while (true) {
    let userInput: string;
    try {
      userInput = (await asyncInput("User: ", io)).trim();
    } catch {
      console.log("\nGoodbye!");
      return;
    }

    if (!userInput) {
      continue;
    }
    if (["exit", "quit"].includes(userInput.toLowerCase())) {
      console.log("Goodbye!");
      return;
    }

    await agent.conversation.send(userInput);
    const spinner = new Spinner().start();
    let finalText = "";
    let receivedCompleteResponse = false;
    try {
      for await (const step of agent.conversation.receiveSteps()) {
        if (step.type === StepType.TOOL_CALL) {
          const toolName = step.toolCalls[0]?.name ?? "tool";
          spinner.update(`Running tool '${toolName}'...`);
        } else if (step.type === StepType.COMPACTION) {
          spinner.update("Compacting context...");
        } else if (step.source === StepSource.MODEL && step.thinkingDelta) {
          spinner.update("Reasoning...");
        }
        if (step.isCompleteResponse) {
          finalText = step.content;
          receivedCompleteResponse = true;
          break;
        }
      }
    } finally {
      spinner.stop();
    }

    if (receivedCompleteResponse) {
      console.log(`Agent: ${finalText}`);
    }
  }
}

export const run_interactive_loop: typeof runInteractiveLoop = runInteractiveLoop;

function isYes(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function matchOption(
  answer: string,
  options: readonly { id: string; text: string }[],
): string | undefined {
  const index = Number.parseInt(answer, 10);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.id;
  }

  return options.find(
    (option) =>
      answer.toLowerCase() === option.text.toLowerCase() ||
      answer.toLowerCase() === option.id.toLowerCase(),
  )?.id;
}
