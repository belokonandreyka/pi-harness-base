/**
 * Scripted model for end-to-end tests: `pi --mode rpc -e test/harness/fake-provider.ts --model fake/scripted`.
 *
 * Reports usage that grows with the number of messages in the context, so
 * pi's own threshold path (and the context-ceiling clamp) fires exactly as it
 * would with a real model, and answers deterministically from what it sees:
 *
 * - a summarisation request (no tools declared)          → "FAKE SUMMARY …"
 * - a `[context-guard] Context is at …` warning last      → calls `handoff_note`
 * - a compaction summary carrying a handoff note present  → "DONE"
 * - anything else                                          → calls `view_context`
 *
 * Env: FAKE_WINDOW (200000), FAKE_BASE (5000) and FAKE_PER_MESSAGE (4000)
 * shape the reported usage: input = BASE + PER_MESSAGE × non-system messages.
 * No network, no auth, no cost.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const WINDOW = Number(process.env.FAKE_WINDOW ?? 200000);
const BASE = Number(process.env.FAKE_BASE ?? 5000);
const PER_MESSAGE = Number(process.env.FAKE_PER_MESSAGE ?? 4000);
/** Safety stop: after this many calls the model answers DONE whatever it sees (FAKE_MAX_CALLS, default 40). */
const MAX_CALLS = Number(process.env.FAKE_MAX_CALLS ?? 40);
/**
 * Filler text in every tool-calling answer. pi decides what a compaction may cut
 * from its own character-based estimate of the entries, not from the usage we
 * report; without real bulk the whole session fits inside keepRecentTokens and
 * the threshold path silently finds "nothing to compact".
 */
const PADDING_CHARS = Number(process.env.FAKE_PADDING_CHARS ?? 4000);

function textOf(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  if (typeof message.summary === "string") return message.summary;
  return "";
}

export default function fakeProvider(pi: ExtensionAPI): void {
  let calls = 0;
  pi.registerProvider("fake", {
    // pi insists on a baseUrl for custom models; nothing is ever fetched from it.
    baseUrl: "http://127.0.0.1:9/fake",
    // pi refuses to prompt a provider with no credentials; the value is never sent anywhere.
    apiKey: "fake-key",
    api: "fake-scripted",
    models: [
      {
        id: "scripted",
        name: "Scripted test model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: WINDOW,
        maxTokens: 8192,
      },
    ],
    streamSimple(model: any, context: any, _options: any) {
      const stream = createAssistantMessageEventStream();
      calls++;
      const messages: any[] = context?.messages ?? [];
      let tools: unknown[] = [];
      try {
        tools = getCurrentTools(messages) ?? [];
      } catch {
        tools = context?.tools ?? [];
      }
      const visible = messages.filter((m) => m.role !== "system");
      const last = textOf(visible.at(-1));
      const seesNote = visible.some((m) => textOf(m).includes("Handoff note (written by the agent before compaction"));

      let content: any[];
      let stopReason: "stop" | "toolUse" = "toolUse";
      if (tools.length === 0) {
        content = [{ type: "text", text: `FAKE SUMMARY of ${visible.length} messages (call ${calls})` }];
        stopReason = "stop";
      } else if (last.includes("[context-guard] Context is at")) {
        content = [{ type: "toolCall", id: `call_${calls}`, name: "handoff_note", arguments: { note: `DONE: fake steps 1-${calls}\nNEXT ACTION: step ${calls + 1}` } }];
      } else if (seesNote) {
        content = [{ type: "text", text: "DONE" }];
        stopReason = "stop";
      } else if (MAX_CALLS > 0 && calls >= MAX_CALLS) {
        content = [{ type: "text", text: "DONE (call limit)" }];
        stopReason = "stop";
      } else {
        content = [{ type: "toolCall", id: `call_${calls}`, name: "view_context", arguments: {} }];
      }
      if (stopReason === "toolUse" && PADDING_CHARS > 0) {
        content.unshift({ type: "text", text: `step ${calls}: ${"lorem ipsum ".repeat(Math.ceil(PADDING_CHARS / 12))}`.slice(0, PADDING_CHARS) });
      }

      const input = BASE + PER_MESSAGE * visible.length;
      const output: any = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: input + 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        for (const block of content) {
          output.content.push(block);
          const contentIndex = output.content.length - 1;
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex, partial: output });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          } else {
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
          }
        }
        output.stopReason = stopReason;
        stream.push({ type: "done", reason: stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  } as any);
}
