"""python3 -m unittest scripts/test_mywins_cache.py  (from the skill dir)"""
import datetime as dt
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import mywins_cache as mc


def issue(key, summary="Fix it", status="Open", description="do the thing", blockers=(), sprint="GS 378", relates=()):
    return {
        "key": key,
        "fields": {
            "summary": summary,
            "status": {"name": status},
            "priority": {"name": "Major"},
            "description": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": description}]}]},
            "customfield_10007": [{"id": 1, "name": sprint, "state": "active"}] if sprint else [],
            "issuelinks": [
                {"type": {"name": "02 Blocks"}, "inwardIssue": {"key": bk, "fields": {"status": {"name": bs}}}}
                for bk, bs in blockers
            ] + [
                {"type": {"name": "01 Relates"}, "outwardIssue": {"key": rk, "fields": {"status": {"name": rs}}}}
                for rk, rs in relates
            ],
        },
    }


def human(cid, text, who="Joe"):
    return {"id": str(cid), "created": f"2026-09-0{cid % 9 + 1}T10:00:00.000-0700",
            "author": {"displayName": who, "emailAddress": f"{who.lower()}@example.com"},
            "body": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}}


def jenkins(cid, env="test", repo="reg-service", sha="4a2fbd14be6b624d5fa03cd2046055495c097622", subject="SVC-580 add filter"):
    return {"id": str(cid), "created": "2026-09-10T05:40:08.879-0700",
            "author": {"displayName": "Jenkins", "emailAddress": "jenkins@example.com"},
            "body": {"type": "doc", "content": [
                {"type": "paragraph", "content": [
                    {"type": "emoji", "attrs": {"shortName": ":blue_square:"}},
                    {"type": "text", "text": f" java/{repo}/{env} "},
                    {"type": "text", "text": f"deployed to {env}",
                     "marks": [{"type": "link", "attrs": {"href": f"http://jenkins.example.com:8080/job/java/job/{repo}/job/{env}/{cid}/"}}]}]},
                {"type": "expand", "attrs": {"title": "Changes"}, "content": [{"type": "bulletList", "content": [
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [
                        {"type": "text", "text": subject,
                         "marks": [{"type": "link", "attrs": {"href": f"https://bitbucket.org/acme/{repo}/commits/{sha}"}}]}]}]}]}]}]}}


SCOUT = """Вступ від скаута.

### APP-1458 — Некоректне використання signals
**Складність**: small
**Шар**: UI — власник: me
**Скоуп**: `app/Reports4/edit-report/edit-report.component.ts` + ще два
**Шляхи**: web-app: site/Scripts/app/Reports4, site/Scripts/app/Shared2; pay-sdk: variants/javascript/src
**Ризики**: - none
**Готовність**: READY — обсяг видно з коду
**Quick-win**: так — 1 файл

### PAY-5747 — Google Pay button
**Complexity**: medium
**Layer**: UI — owner: me
**Scope**: not in web-app
**Paths**: pay-sdk: variants/javascript/src/PaymentOptions
**Readiness**: NEEDS CLARIFICATION — SDK version unknown
**Quick-win**: no — waiting
"""


def git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, check=True).stdout.strip()


def make_repo(root, name, files):
    p = root / name
    p.mkdir(parents=True)
    git(p, "init", "-q")
    git(p, "config", "user.email", "t@t")
    git(p, "config", "user.name", "t")
    commit(p, files, "init")
    return p


def commit(p, files, msg):
    for rel, text in files.items():
        f = p / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    git(p, "add", "-A")
    git(p, "commit", "-q", "-m", msg)
    git(p, "update-ref", "refs/remotes/origin/test", "HEAD")
    return git(p, "rev-parse", "HEAD")


class AdfAndJenkins(unittest.TestCase):
    def test_flattens_text(self):
        self.assertEqual(mc.adf_text(issue("A-1", description="a  b")["fields"]["description"]), "a b")

    def test_parses_jenkins_deploy(self):
        d = mc.parse_deploy(jenkins(7, env="stage"))
        self.assertEqual(d["env"], "stage")
        self.assertEqual(d["repo"], "reg-service")
        self.assertTrue(d["build"].endswith("/stage/7/"))
        self.assertEqual(d["commits"][0]["sha"], "4a2fbd14be6b624d5fa03cd2046055495c097622")
        self.assertEqual(d["commits"][0]["keys"], ["SVC-580"])

    def test_human_comment_is_not_a_deploy(self):
        self.assertIsNone(mc.parse_deploy(human(1, "QA: deployed to test #50 commit 4a2fbd14")))
        self.assertFalse(mc.is_service_comment(human(1, "x")))
        self.assertTrue(mc.is_service_comment(jenkins(1)))


class Fingerprint(unittest.TestCase):
    def test_service_comments_do_not_change_it(self):
        a = mc.snapshot(issue("A-1"), [human(1, "hi")])
        b = mc.snapshot(issue("A-1"), [human(1, "hi"), jenkins(2)])
        self.assertEqual(a["fp"], b["fp"])
        self.assertEqual(b["seen"]["deployBuilds"], [mc.parse_deploy(jenkins(2))["build"]])

    def test_human_comment_and_description_change_named_parts(self):
        a = mc.snapshot(issue("A-1"), [human(1, "hi")])
        b = mc.snapshot(issue("A-1"), [human(1, "hi"), human(2, "more")])
        c = mc.snapshot(issue("A-1", description="other"), [human(1, "hi")])
        self.assertNotEqual(a["fp"], b["fp"])
        self.assertNotEqual(a["fpParts"]["comments"], b["fpParts"]["comments"])
        self.assertEqual(a["fpParts"]["description"], b["fpParts"]["description"])
        self.assertNotEqual(a["fpParts"]["description"], c["fpParts"]["description"])

    def test_blockers_and_sprint(self):
        s = mc.snapshot(issue("A-1", blockers=[("B-2", "Open")], sprint="GS 379"), [])
        self.assertEqual(s["fpParts"]["blockers"], [["B-2", "Open"]])
        self.assertEqual(s["seen"]["sprint"], "GS 379")


class Handoff(unittest.TestCase):
    BLOCK = ("### {k} — needs a field\n**Complexity**: small\n**Layer**: UI — owner: me\n"
             "**Readiness**: BLOCKED — the response DTO lacks the field\n**Blocked on**: {on} — field fee in the DTO\n"
             "**Quick-win**: no — waits on the backend\n")

    def cands(self, issues, on="BACKEND"):
        cache = {"tickets": {k: {"fields": mc.parse_scout_output(self.BLOCK.format(k=k, on=on))[k]["fields"]}
                             for k in issues}}
        return mc.handoff_candidates(cache, issues)

    def test_blocked_on_backend_without_any_open_link_is_a_handoff(self):
        c = self.cands({"APP-1": issue("APP-1"), "APP-2": issue("APP-2", relates=[("APP-9", "Resolved")])})
        self.assertEqual([(x["key"], x["handoff"]) for x in c], [("APP-1", True), ("APP-2", True)])
        self.assertIn("APP-1", mc.format_handoff(c)[0])

    def test_open_links_are_listed_for_the_coordinator_to_judge(self):
        c = self.cands({"APP-1": issue("APP-1", blockers=[("SVC-1402", "Open")]),
                        "APP-3": issue("APP-3", relates=[("SVC-1600", "In Progress")])}, on="SERVICE")
        self.assertEqual([(x["key"], x["handoff"], [l["key"] for l in x["openLinks"]]) for x in c],
                         [("APP-1", False, ["SVC-1402"]), ("APP-3", False, ["SVC-1600"])])

    def test_a_redirect_ticket_is_not_proposed_twice(self):
        block = self.BLOCK.format(k="APP-1", on="BACKEND").replace("BLOCKED — the response DTO lacks the field", "REDIRECT — the whole diff is backend")
        cache = {"tickets": {"APP-1": {"fields": mc.parse_scout_output(block)["APP-1"]["fields"]}}}
        self.assertEqual(mc.handoff_candidates(cache, {"APP-1": issue("APP-1")}), [])

    def test_waiting_on_pm_or_nothing_is_not_a_handoff(self):
        self.assertEqual(self.cands({"APP-1": issue("APP-1")}, on="PM"), [])
        v = mc.parse_scout_output("### APP-1 — x\n**Complexity**: small\n**Blocked on**: —\n")
        self.assertNotIn("blockedOn", v["APP-1"]["fields"])


class ScoutParsing(unittest.TestCase):
    def test_redirect_verdict_with_a_foreign_layer(self):
        v = mc.parse_scout_output(
            "### SVC-1711 — Server error on finalize\n**Complexity**: small\n"
            "**Layer**: BACKEND — owner: backend lead (backup: second dev)\n"
            "**Paths**: web-app: api/Models/Binder\n"
            "**Readiness**: REDIRECT — the whole diff is backend\n**Quick-win**: no — not our layer\n")
        f = v["SVC-1711"]["fields"]
        self.assertEqual((f["layer"], f["readiness"], f["quickWin"]), ("BACKEND", "REDIRECT", "no"))

    def test_blocks_and_fields(self):
        v = mc.parse_scout_output(SCOUT)
        self.assertEqual(sorted(v), ["APP-1458", "PAY-5747"])
        f = v["APP-1458"]["fields"]
        self.assertEqual(f["complexity"], "small")
        self.assertEqual(f["readiness"], "READY")
        self.assertEqual(f["quickWin"], "yes")
        self.assertEqual(f["layer"], "UI")
        self.assertEqual(f["paths"], {"web-app": ["site/Scripts/app/Reports4", "site/Scripts/app/Shared2"],
                                      "pay-sdk": ["variants/javascript/src"]})
        self.assertEqual(v["PAY-5747"]["fields"]["readiness"], "NEEDS CLARIFICATION")
        self.assertTrue(v["PAY-5747"]["block"].startswith("### PAY-5747"))
        self.assertNotIn("APP-1458", v["PAY-5747"]["block"])


class ConfigAndLanguage(unittest.TestCase):
    def tearDown(self):
        mc.configure()

    def test_github_commit_links_are_parsed_too(self):
        c = jenkins(3)
        link = c["body"]["content"][1]["content"][0]["content"][0]["content"][0]["content"][0]
        link["marks"][0]["attrs"]["href"] = "https://github.com/acme/reg-service/commit/4a2fbd14be6b624d5fa03cd2046055495c097622"
        d = mc.parse_deploy(c)
        self.assertEqual(d["commits"][0]["repo"], "reg-service")
        self.assertEqual(d["repo"], "reg-service")

    def test_ukrainian_messages(self):
        mc.configure(language="uk")
        plan = {"tickets": {}, "rescout": [], "keep": [], "skipped": {}, "changes": {}, "rulesChanged": False,
                "firstRun": True, "newDeployCommits": {}}
        self.assertTrue(mc.format_plan(plan).startswith("Кеш: 0 без змін · 0 на перескаут · пропущено 0 · перший прогін"))

    def test_config_file_overrides_defaults_and_warns_on_unknown_keys(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "c.json"
            f.write_text(json.dumps({"skipPrefixes": ["OPS"], "bogus": 1}))
            cfg = mc.load_config(f)
            self.assertEqual(cfg, {"skipPrefixes": ["OPS"]})
            mc.configure(**cfg)
            self.assertEqual(mc.skip_reason("OPS-1", mc.CFG["skipPrefixes"], mc.CFG["skipKeys"]), "OPS")
            self.assertEqual(mc.load_config(Path(d) / "missing.json"), {})


class PlanAndStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "work"
        self.portal = make_repo(self.root, "web-app", {"AGENTS.md": "rules", "site/Scripts/AGENTS.md": "r",
                                                            "site/Scripts/docs/forms.md": "d",
                                                            "site/Scripts/app/Reports4/a.ts": "1",
                                                            "site/Scripts/app/Other/b.ts": "1"})
        self.issues = {k: issue(k) for k in ("APP-1458", "PAY-5747", "TIME-171", "APP-1746")}
        self.comments = {"APP-1458": [human(1, "hi")], "PAY-5747": [human(2, "yo")]}
        self.cache = mc.load_cache(Path(self.tmp.name) / "none.json")
        self.config = {"primaryRepos": ["web-app"], "rulesPaths": {"web-app": ["AGENTS.md", "site/Scripts/AGENTS.md", "site/Scripts/docs"]},
                       "skipPrefixes": ["TIME"], "skipKeys": ["APP-1746"], "serviceEmails": ["jenkins@example.com"], "language": "en"}
        mc.configure(**self.config)

    def tearDown(self):
        mc.configure()
        self.tmp.cleanup()

    def plan(self, **kw):
        kw.setdefault("max_age_days", 7)
        kw.setdefault("fresh", False)
        kw.setdefault("fetch", False)
        return mc.build_plan(self.issues, self.comments, self.cache, self.root, **kw)

    def store(self, texts=(SCOUT,), now=None):
        return mc.store(self.cache, self.issues, self.comments, list(texts), self.root, now=now)

    def test_first_run_then_all_kept(self):
        p = self.plan()
        self.assertTrue(p["firstRun"])
        self.assertEqual(sorted(p["rescout"]), ["APP-1458", "PAY-5747"])
        self.assertEqual(p["skipped"], {"TIME-171": "TIME", "APP-1746": "stale-pinned"})
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["new"])
        git(self.portal, "update-ref", "refs/remotes/origin/APP-1458", "HEAD")
        self.assertEqual(self.plan()["tickets"]["APP-1458"]["reasons"], ["new"])  # first sight: no branch noise
        res = self.store()
        self.assertEqual(res["stored"], ["APP-1458", "PAY-5747"])
        self.assertNotIn("TIME-171", self.cache["tickets"])
        p2 = self.plan()
        self.assertEqual(p2["rescout"], [])
        self.assertEqual(sorted(p2["keep"]), ["APP-1458", "PAY-5747"])
        self.assertIn("### APP-1458", p2["tickets"]["APP-1458"]["block"])
        self.assertIn("web-app", self.cache["repoHeads"])
        self.assertIn("Cache: 2 unchanged · 0 to re-scout", mc.format_plan(p2))

    def test_jira_changes_and_digest(self):
        self.store()
        self.issues["PAY-5747"] = issue("PAY-5747", status="In Progress", sprint="GS 379")
        self.comments["APP-1458"].append(human(3, "new question"))
        self.issues["NEW-1"] = issue("NEW-1")
        del self.issues["APP-1746"]
        p = self.plan()
        self.assertIn("jira:status", p["tickets"]["PAY-5747"]["reasons"])
        self.assertIn("jira:comments", p["tickets"]["APP-1458"]["reasons"])
        self.assertEqual(p["tickets"]["NEW-1"]["reasons"], ["new"])
        self.assertEqual(p["changes"]["status"], ["PAY-5747: Open → In Progress"])
        self.assertEqual(p["changes"]["sprint"], ["PAY-5747: GS 378 → GS 379"])
        self.assertEqual(p["changes"]["comments"], ["APP-1458: +1"])
        self.assertEqual(p["changes"]["new"], ["NEW-1"])
        self.assertEqual(p["changes"]["gone"], [])  # pinned tickets are never cached

    def test_blocker_closed_is_reported_and_rescouted(self):
        self.issues["PAY-5747"] = issue("PAY-5747", blockers=[("B-1", "Open")])
        p = self.plan()
        self.assertFalse(p["tickets"]["PAY-5747"]["rescout"])
        self.assertEqual(p["tickets"]["PAY-5747"]["blockedBy"], ["B-1"])
        self.assertIn("⛔ PAY-5747 — BLOCKED by B-1", mc.format_plan(p))
        self.store()
        self.issues["PAY-5747"] = issue("PAY-5747", blockers=[("B-1", "Resolved")])
        p = self.plan()
        self.assertTrue(p["tickets"]["PAY-5747"]["rescout"])
        self.assertIn("jira:blockers", p["tickets"]["PAY-5747"]["reasons"])
        self.assertEqual(p["changes"]["blockersClosed"], ["PAY-5747: B-1 → Resolved"])

    def test_related_task_resolved_or_committed_rescouts(self):
        # the UI ticket itself never changes; the backend task it merely "relates"
        # to gets Resolved and its commit carries the other key
        self.issues["PAY-5747"] = issue("PAY-5747", relates=[("SVC-1600", "Open")])
        self.store()
        self.assertEqual(self.plan()["rescout"], [])
        self.issues["PAY-5747"] = issue("PAY-5747", relates=[("SVC-1600", "Resolved")])
        p = self.plan()
        self.assertIn("jira:links", p["tickets"]["PAY-5747"]["reasons"])
        self.assertEqual(p["changes"]["linksResolved"], ["PAY-5747: SVC-1600 → Resolved"])
        self.assertIn("linked tickets resolved: PAY-5747: SVC-1600 → Resolved", mc.format_plan(p))
        self.store()  # a fresh verdict records the new link state; store(texts=[]) would keep it flagged
        commit(self.portal, {"site/Controllers/Fl.cs": "void"}, "SVC-1600 Support Void - Portal/Retail")
        p = self.plan()
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["git:1 commit(s) mention linked SVC-1600 in web-app"])
        self.assertEqual(p["tickets"]["APP-1458"]["reasons"], [])

    def test_verdict_without_a_layer_rescouts_once(self):
        self.store()
        key = next(k for k, e in self.cache["tickets"].items() if (e.get("fields") or {}).get("layer"))
        del self.cache["tickets"][key]["fields"]["layer"]
        self.assertEqual(self.plan()["tickets"][key]["reasons"], ["cache-upgrade:layer"])

    def test_cache_written_before_a_part_existed_rescouts_once(self):
        self.store()
        del self.cache["tickets"]["PAY-5747"]["fpParts"]["links"]
        p = self.plan()
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["cache-upgrade:links"])
        self.assertEqual(p["tickets"]["APP-1458"]["reasons"], [])

    def test_stale_and_fresh(self):
        self.store(now="2026-09-01T06:00:00Z")
        p = self.plan(now=dt.datetime(2026, 9, 10, tzinfo=dt.timezone.utc))
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["stale:8d"])
        p = self.plan(now=dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc))
        self.assertEqual(p["rescout"], [])
        p = self.plan(fresh=True, now=dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc))
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["fresh"])

    def test_deploy_comment_invalidates_only_affected_tickets(self):
        self.store()
        # a Jenkins build on APP-1458 ships commits for pay-sdk; PAY-5747's scope lives there too
        self.comments["APP-1458"].append(jenkins(9, repo="pay-sdk", subject="APP-1458 sdk bump"))
        p = self.plan()
        self.assertIn("deploy:pay-sdk/test", p["tickets"]["APP-1458"]["reasons"])
        self.assertIn("service-deploy:pay-sdk", p["tickets"]["PAY-5747"]["reasons"])
        self.assertEqual(p["changes"]["deploys"], ["APP-1458: pay-sdk → test"])
        self.assertIn("service pay-sdk: 1 new commit(s)", mc.format_plan(p))
        self.store(texts=[])  # no new scout, but the deploy is now seen
        p2 = self.plan()
        self.assertNotIn("deploy:pay-sdk/test", p2["tickets"]["APP-1458"]["reasons"])
        self.assertEqual(p2["tickets"]["PAY-5747"]["reasons"], [])

    def test_git_signals(self):
        self.store()
        # 1) a commit mentioning the key on origin/test
        commit(self.portal, {"site/Scripts/app/Other/b.ts": "2"}, "APP-1458 partial fix")
        p = self.plan()
        self.assertEqual(p["tickets"]["APP-1458"]["reasons"], ["git:1 commit(s) mention APP-1458 in web-app"])
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], [])
        self.store(texts=[])
        # 2) a commit touching a scout path (folder granularity), unrelated message
        commit(self.portal, {"site/Scripts/app/Reports4/new.ts": "x"}, "OTHER-1 refactor")
        p = self.plan()
        self.assertEqual(p["tickets"]["APP-1458"]["reasons"], ["git:1 commit(s) touch scout paths in web-app"])
        self.store(texts=[])
        # 3) a branch named after the ticket appears, then moves
        git(self.portal, "update-ref", "refs/remotes/origin/PAY-5747", "HEAD")
        p = self.plan()
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["git:branch origin/PAY-5747 new in web-app"])
        self.assertEqual(p["changes"]["branches"], ["PAY-5747: origin/PAY-5747 appeared in web-app"])
        self.store(texts=[])
        self.assertEqual(self.plan()["rescout"], [])
        commit(self.portal, {"x.txt": "1"}, "noise")
        git(self.portal, "update-ref", "refs/remotes/origin/PAY-5747", "HEAD")
        p = self.plan()
        self.assertEqual(p["tickets"]["PAY-5747"]["reasons"], ["git:branch origin/PAY-5747 moved in web-app"])
        self.store(texts=[])
        # 4) rules change invalidates everything
        commit(self.portal, {"site/Scripts/docs/forms.md": "new rules"}, "docs")
        p = self.plan()
        self.assertTrue(p["rulesChanged"])
        self.assertIn("rules-changed", p["tickets"]["PAY-5747"]["reasons"])
        self.assertIn("rules-changed", p["tickets"]["APP-1458"]["reasons"])

    def test_cli_roundtrip(self):
        d = Path(self.tmp.name) / "run"
        d.mkdir()
        (d / "issues.json").write_text(json.dumps({"issues": list(self.issues.values())}))
        for k, cs in self.comments.items():
            (d / f"{k}.comments.json").write_text(json.dumps({"comments": cs}))
        (d / "scout-1.md").write_text(SCOUT)
        cache = d / "cache.json"
        (d / "config.json").write_text(json.dumps({**self.config, "reposRoot": str(self.root), "cache": str(cache)}))
        base = ["--issues", str(d / "issues.json"), "--comments-dir", str(d), "--config", str(d / "config.json")]
        self.assertEqual(mc.main(["plan", *base, "--json", str(d / "plan.json")]), 0)
        plan = json.loads((d / "plan.json").read_text())
        self.assertEqual(sorted(plan["rescout"]), ["APP-1458", "PAY-5747"])
        self.assertEqual(mc.main(["store", *base, "--scout", str(d / "scout-1.md")]), 0)
        self.assertTrue(cache.exists())
        self.assertEqual(mc.main(["plan", *base, "--json", str(d / "plan.json")]), 0)
        self.assertEqual(json.loads((d / "plan.json").read_text())["rescout"], [])


if __name__ == "__main__":
    unittest.main()
