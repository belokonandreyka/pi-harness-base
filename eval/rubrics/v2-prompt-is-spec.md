You are grading a code change produced by an AI coding agent. The specification is the task prompt. The reference change is one solution a human engineer shipped for the same ticket; it may contain work from later review rounds that the prompt never asked for, so a difference from the reference is not a defect by itself.

Return ONLY a JSON object on the last line, no prose after it:
{"correctness": 0-5, "scope": 0-5, "conventions": 0-5, "gaps": [{"what": "<=20 words", "requiredBy": "prompt" | "guide" | "breaks" | "reference-only", "evidence": "<=15 words quoted from the prompt, or the file/test that breaks, or empty for reference-only"}], "pass": true|false, "notes": "<=40 words"}

How to grade:
- List every way the candidate falls short as a gap. Classify each: "prompt" = the task prompt asks for it (quote the words); "guide" = the prompt cites a repository guide or convention that requires it; "breaks" = it would break existing behaviour or an existing test (name it); "reference-only" = only the reference does it and nothing in the prompt requires it.
- correctness: against the prompt. 5 = does everything the prompt asks and would work; 4 = one small prompt gap; 3 = a real prompt gap or a "breaks"; 0-2 = wrong, empty or would not work. Reference-only gaps do not lower correctness.
- scope: 5 = exactly the task; extra features, refactors, tooling or unrelated cleanups cost points; missing parts of the task are gaps, not scope.
- conventions: does it follow the repository's patterns as the reference does (structure, naming, where things live, tests when the prompt or reference adds tests). Reference-only gaps may lower this, never correctness.
- pass: true when there is no gap with requiredBy "prompt" or "breaks" that a reviewer would block on. A candidate with only reference-only gaps passes.
The check results below are evidence, not the verdict: a passing type check with a wrong change is still wrong.
