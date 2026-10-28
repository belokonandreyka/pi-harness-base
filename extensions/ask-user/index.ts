/**
 * ask-user: an `ask_user` tool that asks the user one to four multiple-choice
 * questions in a dialog, the way Claude Code's AskUserQuestion and Codex's
 * request_user_input do, instead of ending the turn with a question in text.
 *
 * While the dialog is open the extension emits `herdr:blocked` on pi's event
 * bus. herdr's pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`)
 * turns that into the `blocked` agent state, so herdr plays its needs-input
 * sound (`ui.sound.request_path`) and paints the pane red. A question in plain
 * text only ever ends in `done`, which sounds like a finished task.
 *
 * Only an interactive (TUI) session can answer. In print, JSON and RPC runs the
 * tool returns an error that tells the model to state its assumption instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Ask, createExecute, DESCRIPTION, type QuestionnaireResult } from "./questions.ts";
import { showQuestionnaire } from "./ui.ts";

const Params = Type.Object({
  questions: Type.Array(
    Type.Object({
      header: Type.String({ description: "Very short label for the question (≤16 chars), e.g. 'Branch', 'Scope'. Shown in herdr's sidebar while waiting." }),
      question: Type.String({ description: "The full question, ending with a question mark." }),
      context: Type.Optional(Type.String({ description: "The text the decision is about, shown above the question: the full draft of a comment, message, commit or PR text the user is approving. Required for any approval of text you will send or publish." })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 words. Put the recommended option first and end its label with ' (Recommended)'." }),
          description: Type.Optional(Type.String({ description: "What choosing this option means or what will happen." })),
        }),
        { description: "2-4 mutually exclusive choices. A typed free-text answer is always offered; do not add an 'Other' option." },
      ),
    }),
    { description: "1-4 questions asked in one dialog." },
  ),
  defaultAfterMinutes: Type.Optional(Type.Number({ description: "Apply the first (Recommended) option of every unanswered question after this many minutes (at most 240). Only when every recommended option is safe and easy to undo; never for deleting or repairing data, pushing, deploying or spending." })),
});

export default function askUserExtension(pi: ExtensionAPI, ask: Ask = showQuestionnaire) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: DESCRIPTION,
    parameters: Params,

    execute: createExecute(pi, ask) as any,

    renderCall(args, theme) {
      const qs = Array.isArray((args as any)?.questions) ? (args as any).questions : [];
      const headers = qs.map((q: any, i: number) => q?.header || `Q${i + 1}`).join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", headers)}`, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details || (details.cancelled && !details.answers.length)) {
        const first = result.content[0];
        return new Text(theme.fg("warning", first?.type === "text" ? first.text.split("\n")[0] : "Dismissed"), 0, 0);
      }
      return new Text(details.answers.map((a) => `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${a.typed ? theme.fg("muted", "(typed) ") : ""}${a.answer}`).join("\n"), 0, 0);
    },
  });
}
