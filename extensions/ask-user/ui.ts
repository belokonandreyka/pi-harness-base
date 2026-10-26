/**
 * The question dialog. Adapted from pi's MIT-licensed example
 * `examples/extensions/questionnaire.ts` (pi-coding-agent 1.4.0): one question
 * shows an option list, several questions get a tab bar and a Submit tab, and
 * every question also takes a typed answer.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Answer, Question, QuestionnaireResult } from "./questions.ts";

type RenderOption = { label: string; description?: string; isOther?: boolean };

export function showQuestionnaire(
  ctx: ExtensionContext,
  questions: Question[],
  signal?: AbortSignal,
): Promise<QuestionnaireResult> {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1;

  return ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let finished = false;
    let cachedLines: string[] | undefined;
    const answers = new Map<number, Answer>();

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      const ordered = [...answers.entries()].sort(([a], [b]) => a - b).map(([, answer]) => answer);
      done({ answers: ordered, cancelled });
    }

    function onAbort() {
      submit(true);
    }
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener("abort", onAbort, { once: true });

    function options(): RenderOption[] {
      const q = questions[currentTab];
      if (!q) return [];
      return [...q.options, { label: "Type something.", isOther: true }];
    }

    function allAnswered() {
      return questions.every((_, i) => answers.has(i));
    }

    function advance() {
      if (!isMulti) return submit(false);
      currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
      optionIndex = 0;
      refresh();
    }

    editor.onSubmit = (value) => {
      const text = value.trim() || "(no response)";
      answers.set(currentTab, { header: questions[currentTab].header, answer: text, typed: true });
      inputMode = false;
      editor.setText("");
      advance();
    };

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + totalTabs) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
      }

      if (currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
        else if (matchesKey(data, Key.escape)) submit(true);
        return;
      }

      const opts = options();
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }
      const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
      if (digit >= 0 && digit < opts.length) optionIndex = digit;
      if (matchesKey(data, Key.enter) || (digit >= 0 && digit < opts.length)) {
        const opt = opts[optionIndex];
        if (opt.isOther) {
          inputMode = true;
          editor.setText("");
          refresh();
          return;
        }
        answers.set(currentTab, { header: questions[currentTab].header, answer: opt.label, typed: false });
        advance();
        return;
      }
      if (matchesKey(data, Key.escape)) submit(true);
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const w = Math.max(1, width);
      const q = questions[currentTab];
      const opts = options();

      const add = (prefix: string, text: string) => {
        const pw = visibleWidth(prefix);
        if (pw >= w) {
          lines.push(...wrapTextWithAnsi(prefix + text, w));
          return;
        }
        const wrapped = wrapTextWithAnsi(text, w - pw);
        wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${line}`));
      };

      const renderOptions = () => {
        opts.forEach((opt, i) => {
          const selected = i === optionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const label = `${i + 1}. ${opt.label}${opt.isOther && inputMode ? " ✎" : ""}`;
          add(prefix, theme.fg(selected || (opt.isOther && inputMode) ? "accent" : "text", label));
          if (opt.description) add("     ", theme.fg("muted", opt.description));
        });
      };

      lines.push(theme.fg("accent", "─".repeat(w)));
      if (isMulti) {
        const tabs = ["← "];
        questions.forEach((question, i) => {
          const text = ` ${answers.has(i) ? "■" : "□"} ${question.header} `;
          tabs.push(`${i === currentTab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answers.has(i) ? "success" : "muted", text)} `);
        });
        const submitText = " ✓ Submit ";
        tabs.push(`${currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText)} →`);
        add(" ", tabs.join(""));
        lines.push("");
      }

      if (inputMode && q) {
        add(" ", theme.fg("text", q.question));
        lines.push("");
        renderOptions();
        lines.push("");
        add(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
        lines.push("");
        add(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
      } else if (currentTab === questions.length) {
        add(" ", theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        questions.forEach((question, i) => {
          const a = answers.get(i);
          if (a) add(" ", `${theme.fg("muted", `${question.header}: `)}${theme.fg("text", a.answer)}`);
        });
        lines.push("");
        if (allAnswered()) add(" ", theme.fg("success", "Press Enter to submit"));
        else add(" ", theme.fg("warning", `Unanswered: ${questions.filter((_, i) => !answers.has(i)).map((x) => x.header).join(", ")}`));
      } else if (q) {
        if (!isMulti) add(" ", theme.fg("accent", theme.bold(q.header)));
        add(" ", theme.fg("text", q.question));
        lines.push("");
        renderOptions();
      }

      lines.push("");
      if (!inputMode) {
        add(" ", theme.fg("dim", isMulti
          ? "Tab/←→ navigate • ↑↓ or 1-9 select • Enter confirm • Esc dismiss"
          : "↑↓ or 1-9 select • Enter confirm • Esc dismiss"));
      }
      lines.push(theme.fg("accent", "─".repeat(w)));
      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}
