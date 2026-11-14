import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/build-desktop.cjs"


class DesktopBuildTest(unittest.TestCase):
    def node(self, code, *, data=None):
        env = os.environ.copy()
        env.pop("APP_VERSION", None)
        program = "const api=require(" + json.dumps(str(SCRIPT)) + ");\n" + code
        result = subprocess.run(["node", "-e", program], input=json.dumps(data) if data is not None else "",
                                text=True, capture_output=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def fixture(self, directory):
        root = Path(directory)
        frontend, desktop = root / "frontend", root / "frontend/desktop"
        (frontend / "scripts").mkdir(parents=True)
        desktop.mkdir()
        (frontend / "package.json").write_text(json.dumps({"version": "2.3.4"}))
        for name in ("app-version.cjs", "verify-renderer.cjs"):
            shutil.copy2(ROOT / "frontend/scripts" / name, frontend / "scripts" / name)
        for name in ("verify-web.cjs", "verify-storage.cjs"):
            shutil.copy2(ROOT / "frontend/desktop" / name, desktop / name)
        payload = self.node("console.log(JSON.stringify(require(" + json.dumps(str(ROOT / "frontend/desktop/verify-storage.cjs")) + ").payload))")
        for name in payload:
            (desktop / name).write_text("fixture:" + name)
        (desktop / "package.json").write_text(json.dumps({"build": {"productName": "MVS ERP", "directories": {"output": "release"}, "extraResources": [{"from": "../dist", "to": "web", "filter": ["**/*"]}], "win": {}, "linux": {}, "mac": {}}}))
        return root

    def run_fake(self, root, *, selected=None, host="darwin", dry=False, failure="", tamper=""):
        return self.node(r'''
const fs=require('node:fs'),path=require('node:path');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
 const plan=api.createPlan({root:input.root,selected:input.selected,host:input.host,hostArch:'arm64'}),calls=[],messages=[];
 let error=null,result;
 try{result=await api.runBuild(plan,{dryRun:input.dry,write:s=>messages.push(s),run:async step=>{
  calls.push({label:step.label,command:step.command,args:step.args,cwd:step.cwd,env:{APP_VERSION:step.env.APP_VERSION,ERP_BUILD_TARGET:step.env.ERP_BUILD_TARGET,ERP_DESKTOP_RENDERER_DIR:step.env.ERP_DESKTOP_RENDERER_DIR}});
  if(step.label===input.failure)throw new Error('fake executor failed');
  if(step.label==='Fresh desktop renderer'){
   fs.mkdirSync(path.join(step.renderer,'assets'),{recursive:true});fs.writeFileSync(path.join(step.renderer,'assets/entry.js'),'fixture');fs.writeFileSync(path.join(step.renderer,'index.html'),'fixture HTML');
   fs.writeFileSync(path.join(step.renderer,'build-target.json'),JSON.stringify({protocol:1,target:'desktop',version:plan.version,entry:'assets/entry.js',modules:['src/main.ts','src/platform/desktop.ts']}));
   fs.writeFileSync(path.join(step.renderer,'precache-manifest.json'),JSON.stringify({version:plan.version,assets:['/assets/entry.js']}));
  }
  if(step.target){
   const resources=path.join(step.target.directory,'fixture-unpacked','resources');fs.mkdirSync(resources,{recursive:true});fs.writeFileSync(path.join(resources,'app.asar'),'fake ASAR');
   fs.cpSync(step.renderer,path.join(resources,'web'),{recursive:true});
   fs.mkdirSync(path.join(resources,'app.asar.unpacked'));
   for(const name of require(path.join(plan.desktop,'verify-storage.cjs')).payload)fs.copyFileSync(path.join(plan.desktop,name),path.join(resources,'app.asar.unpacked',name));
   fs.writeFileSync(path.join(step.target.directory,step.target.filename),'fake binary archive');
   if(input.tamper==='renderer')fs.writeFileSync(path.join(resources,'web','assets/entry.js'),'wrong bytes');
   if(input.tamper==='storage')fs.writeFileSync(path.join(resources,'app.asar.unpacked','storage.cjs'),'wrong bytes');
  }
 }});}catch(e){error=e.message}
 console.log(JSON.stringify({error,result,calls,messages,targets:plan.targets,limits:plan.limitations}));
})().catch(e=>{console.error(e);process.exitCode=1});
''', data={"root": str(root), "selected": selected if selected is not None else ["windows", "linux", "macos"], "host": host, "dry": dry, "failure": failure, "tamper": tamper})

    def test_only_trimmed_case_insensitive_n_means_no(self):
        result = self.node(r'''
(async()=>{const answers=['',' N ','no'],prompts=[];const result=await api.askTargets(async()=>answers.shift(),s=>prompts.push(s));console.log(JSON.stringify({result,prompts}))})()
''')
        self.assertEqual(result["result"], ["windows", "macos"])
        self.assertEqual(len(result["prompts"]), 3)
        for answer in ["y", "Y", "yes", "нет", "0", "maybe", "   "]:
            result = self.node("(async()=>{console.log(JSON.stringify(await api.askTargets(async()=>" + json.dumps(answer) + ",()=>{})))})()")
            self.assertEqual(result, ["windows", "linux", "macos"])

    def test_eof_before_all_answers_aborts(self):
        for count in [0, 1, 2]:
            result = self.node("(async()=>{let left=" + str(count) + ";try{await api.askTargets(async()=>left-->0?'':null,()=>{});throw Error('unexpected')}catch(e){console.log(JSON.stringify(e.message))}})()")
            self.assertIn("Input ended", result)

    def test_cli_dry_run_and_incomplete_stdin_have_no_build_side_effects(self):
        before = (ROOT / "bin").exists()
        env = os.environ.copy()
        env.pop("APP_VERSION", None)
        for answers, expected in [("n\nn\nn\n", 0), ("n\nn\n", 1)]:
            result = subprocess.run(["node", str(SCRIPT), "--dry-run"], input=answers, text=True, capture_output=True, env=env, check=False)
            self.assertEqual(result.returncode, expected, result.stderr)
        self.assertEqual((ROOT / "bin").exists(), before)

    def test_arch_options_and_unknown_options(self):
        self.assertEqual(self.node("console.log(JSON.stringify(api.parseArguments(['--dry-run','--arch','arm64'])))")["arch"], "arm64")
        for args in [["--arch"], ["--arch=all"], ["--arch", "../outside"], ["--publish"], ["--version", "9.0.0"]]:
            result = self.node("try{api.parseArguments(" + json.dumps(args) + ");console.log('false')}catch{console.log('true')}")
            self.assertTrue(result)

    def test_plan_versions_names_and_default_architectures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            result = self.node("console.log(JSON.stringify(api.createPlan({root:" + json.dumps(str(root)) + ",selected:['windows','linux','macos'],host:'darwin',hostArch:'arm64'})))")
            self.assertEqual(result["version"], "2.3.4")
            self.assertEqual([t["arch"] for t in result["targets"]], ["x64", "x64", "arm64"])
            for target in result["targets"]:
                self.assertIn("mvs-erp-v2.3.4-" + target["key"] + "-" + target["arch"], target["filename"])
                self.assertTrue(Path(target["directory"]).is_relative_to(root / "bin/v2.3.4"))

    def test_dry_run_and_no_targets_create_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            for options in [{"dry": True}, {"selected": []}]:
                result = self.run_fake(root, **options)
                self.assertIsNone(result["error"])
                self.assertEqual(result["calls"], [])
                self.assertFalse((root / "bin").exists())

    def test_unsupported_selected_hosts_fail_without_installing_or_creating_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            for host, selected in [("linux", ["macos"]), ("win32", ["linux"]), ("freebsd", ["windows"])]:
                result = self.run_fake(root, selected=selected, host=host, dry=True)
                self.assertIn("cannot be built", result["error"])
                self.assertTrue(result["limits"])
                self.assertEqual(result["calls"], [])
                self.assertFalse((root / "bin").exists())

    def test_existing_target_and_symlink_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            target = root / "bin/v2.3.4/windows-x64"
            target.mkdir(parents=True)
            marker = target / "old.zip"
            marker.write_bytes(b"keep")
            result = self.run_fake(root)
            self.assertIn("Target already exists", result["error"])
            self.assertEqual(result["calls"], [])
            self.assertEqual(marker.read_bytes(), b"keep")
        if os.name != "nt":
            with tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                outside = root / "outside"
                outside.mkdir()
                (root / "bin").symlink_to(outside, target_is_directory=True)
                result = self.run_fake(root)
                self.assertIn("symlink", result["error"])
                self.assertEqual(result["calls"], [])
                self.assertEqual(list(outside.iterdir()), [])

    def test_existing_checkout_lock_prevents_concurrent_builds_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            lock = root / "bin/.desktop-build.lock"
            lock.parent.mkdir()
            lock.write_text("existing build owns this file")
            result = self.run_fake(root, selected=["windows"])
            self.assertIn("Another build owns", result["error"])
            self.assertEqual(result["calls"], [])
            self.assertEqual(lock.read_text(), "existing build owns this file")
            self.assertFalse((root / "bin/v2.3.4").exists())

    def test_fake_full_build_is_fresh_verified_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            stale = root / "frontend/dist"
            stale.mkdir()
            (stale / "old.txt").write_text("preserve existing dist")
            result = self.run_fake(root)
            self.assertIsNone(result["error"], result["error"])
            self.assertEqual(len(result["result"]), 3)
            self.assertFalse((root / "bin/.desktop-build.lock").exists())
            self.assertEqual((stale / "old.txt").read_text(), "preserve existing dist")
            builds = [call for call in result["calls"] if call["label"].startswith("Package ")]
            self.assertEqual(len(builds), 3)
            for call in builds:
                self.assertEqual(call["args"][-2:], ["--publish", "never"])
                self.assertEqual(call["env"]["ERP_BUILD_TARGET"], "desktop")
                self.assertEqual(call["env"]["APP_VERSION"], "2.3.4")
                self.assertNotEqual(call["env"]["ERP_DESKTOP_RENDERER_DIR"], str(stale))
            for artifact in result["result"]:
                self.assertEqual(len(artifact["sha256"]), 64)
                self.assertTrue(Path(artifact["artifact"]).is_file())
            for target in result["targets"]:
                self.assertTrue((Path(target["directory"]) / target["filename"]).is_file())

    def test_selected_failure_stops_and_keeps_previous_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            result = self.run_fake(root, failure="Package linux")
            self.assertIn("Build stopped", result["error"])
            self.assertFalse((root / "bin/.desktop-build.lock").exists())
            self.assertTrue(list((root / "bin/v2.3.4/windows-x64").glob("*.zip")))
            self.assertFalse((root / "bin/v2.3.4/macos-arm64").exists())
            manifests = list((root / "bin/v2.3.4").glob(".build-*/result.json"))
            self.assertEqual(len(manifests), 1)
            self.assertIn("fake executor failed", json.loads(manifests[0].read_text())["error"])

    def test_embedded_renderer_and_storage_tampering_fail_verification(self):
        for tamper in ["renderer", "storage"]:
            with tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                result = self.run_fake(root, selected=["windows"], tamper=tamper)
                self.assertIsNotNone(result["error"])
                self.assertFalse(any(message.startswith("Verified:") for message in result["messages"]))

    def test_windows_npm_runs_through_cmd_without_shell_interpolation_of_paths(self):
        with tempfile.TemporaryDirectory(prefix="desktop space ") as directory:
            root = self.fixture(directory)
            result = self.run_fake(root, selected=["windows"], host="win32")
            self.assertIsNone(result["error"], result["error"])
            installs = result["calls"][:2]
            for call in installs:
                self.assertTrue(call["command"].lower().endswith("cmd.exe"))
                self.assertEqual(call["args"], ["/d", "/s", "/c", "npm ci"])
                self.assertTrue(Path(call["cwd"]).is_relative_to(root))


if __name__ == "__main__":
    unittest.main()
