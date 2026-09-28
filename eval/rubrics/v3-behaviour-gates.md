You are grading a code change produced by an AI coding agent. The specification is the task prompt. The reference change is one solution a human engineer shipped for the same ticket; it may contain work from later review rounds that the prompt never asked for, so a difference from the reference is not a defect by itself.

Return ONLY a JSON object on the last line, no prose after it:
{"correctness": 0-5, "scope": 0-5, "conventions": 0-5, "gaps": [{"what": "<=20 words", "kind": "behaviour" | "style", "requiredBy": "prompt" | "guide" | "breaks" | "reference-only", "evidence": "<=15 words quoted from the prompt, or the file/test that breaks, or empty for reference-only", "where": "<=12 words: the candidate file and what is there or missing"}], "pass": true|false, "notes": "<=40 words"}

How to grade:
- List every way the candidate falls short as a gap, and only gaps you can point at in the candidate diff ("where"). Classify the source: "prompt" = the task prompt asks for it (quote the words); "guide" = the prompt cites a repository guide or convention; "breaks" = it would break existing behaviour or an existing test (name it); "reference-only" = only the reference does it. Classify the kind: "behaviour" = a user or caller would see a different result (wrong data, missing branch, crash, broken test); "style" = naming, imports, aliases, line length, helper choice, formatting, comments.
- correctness: against the prompt, behaviour gaps only. 5 = does everything the prompt asks and would work; 4 = one small behaviour gap; 3 = a real behaviour gap or a "breaks"; 0-2 = wrong, empty or would not work. Style and reference-only gaps never lower correctness.
- scope: 5 = exactly the task; extra features, refactors, tooling or unrelated cleanups cost points; missing parts of the task are gaps, not scope.
- conventions: where style gaps go. 5 = follows the repository's patterns as the reference does; each style gap required by the prompt or a guide costs a point.
- pass: false only when there is a behaviour gap with requiredBy "prompt" or "breaks". Style gaps and reference-only gaps never fail a candidate; they show in conventions.
The check results below are evidence, not the verdict: a passing type check with a wrong change is still wrong.
