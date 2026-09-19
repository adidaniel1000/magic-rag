"""Exercise installers in temporary checkouts without downloads or a live index."""

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None
# Windows' system bash may be a WSL shim even when no working distro is installed.
GIT_BASH = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
BASH = str(GIT_BASH) if os.name == "nt" and GIT_BASH.is_file() else shutil.which("bash")

DRIVER = r'''
import json
import os
from pathlib import Path
import shlex
import sys
import venv

def record(stage, args=()):
    with open(os.environ["INSTALL_TEST_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"stage": stage, "args": list(args), "cwd": os.getcwd()}) + "\n")
    if os.environ.get("INSTALL_TEST_FAIL") == stage:
        sys.exit(17)

if __name__ == "__main__":
    name, *args = sys.argv[1:]
    if name in ("py", "python3", "python"):
        record("venv", args)
        target = Path(args[-1])
        if os.environ["INSTALL_TEST_SHELL"] == "powershell":
            venv.EnvBuilder(with_pip=False).create(target)
        else:
            executable = target / "bin/python"
            executable.parent.mkdir(parents=True)
            executable.write_text(
                "#!/usr/bin/env bash\nexec " + shlex.quote(sys.executable.replace("\\", "/"))
                + " " + shlex.quote(__file__.replace("\\", "/")) + ' venv-python "$@"\n',
                encoding="utf-8",
            )
            executable.chmod(0o755)
    elif name == "venv-python":
        record("pip" if args[:2] == ["-m", "pip"] else "sqlite" if args[0].endswith("verify_sqlite.py") else "ui", args)
    elif name == "npm":
        record("ci" if args == ["ci"] else "build", args)
    else:
        record(name, args)
'''


class InstallerFixture:
    shell = ""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="magic rag installers ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "checkout with spaces"
        self.checkout.mkdir()
        self.log = self.root / "commands.jsonl"
        self.env = os.environ.copy()
        self.env.pop("MAGIC_RAG_INSTALL_DIR", None)
        self.env.pop("INSTALL_TEST_FAIL", None)
        self.env.update({
            "INSTALL_TEST_LOG": str(self.log),
            "INSTALL_TEST_SHELL": self.shell,
            "PYTHONPATH": str(self.root),
            "PYTHONUTF8": "1",
            "GIT_CONFIG_GLOBAL": str(self.root / "gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
        })

    def run_command(self, command, **kwargs):
        return subprocess.run(command, cwd=self.root, env=self.env, text=True,
                              capture_output=True, timeout=45, **kwargs)

    def stages(self):
        if not self.log.exists():
            return []
        return [json.loads(line)["stage"] for line in self.log.read_text(encoding="utf-8-sig").splitlines()]

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def prepare_setup(self):
        (self.checkout / "setup").mkdir()
        (self.checkout / "web").mkdir()
        (self.checkout / "scripts").mkdir()
        for name in ("setup.ps1", "setup.bat", "setup.sh"):
            shutil.copyfile(PROJECT_ROOT / "setup" / name, self.checkout / "setup" / name)
        for name in ("startMagicRagUI.sh", "startMagicRagUI.bat"):
            shutil.copyfile(PROJECT_ROOT / name, self.checkout / name)
        (self.root / "installer_driver.py").write_text(DRIVER, encoding="utf-8")
        (self.root / "pip.py").write_text("from installer_driver import record\nrecord('pip')\n", encoding="utf-8")
        (self.checkout / "setup/verify_sqlite.py").write_text(
            "from installer_driver import record\nrecord('sqlite')\n", encoding="utf-8",
        )
        (self.checkout / "scripts/rag_ui.py").write_text(
            "import sys\nfrom installer_driver import record\nrecord('ui', sys.argv[1:])\n", encoding="utf-8",
        )
        fake_bin = self.root / "fake bin"
        fake_bin.mkdir()
        for name in ("node", "npm", "py", "python3", "python"):
            if self.shell == "powershell":
                script = fake_bin / (name + ".cmd")
                script.write_text(
                    f'@echo off\n"{sys.executable}" "{self.root / "installer_driver.py"}" {name} %*\nexit /b %errorlevel%\n',
                    encoding="utf-8",
                )
            else:
                script = fake_bin / name
                script.write_text(
                    "#!/usr/bin/env bash\nexec " + shlex.quote(sys.executable.replace("\\", "/"))
                    + " " + shlex.quote((self.root / "installer_driver.py").as_posix())
                    + f' {name} "$@"\n', encoding="utf-8",
                )
                script.chmod(0o755)
        self.env["PATH"] = str(fake_bin) + os.pathsep + self.env["PATH"]

    def run_setup(self):
        if self.shell == "powershell":
            # Also exercise the legacy CMD entry point.
            return self.run_command([os.environ["COMSPEC"], "/d", "/c", str(self.checkout / "setup/setup.bat")])
        return self.run_command([BASH, str(self.checkout / "setup/setup.sh")])

    def prepare_remote(self):
        """Redirect the production clone URL to a small, isolated local repository."""
        remote = self.root / "fixture remote"
        (remote / "setup").mkdir(parents=True)
        (remote / "setup/setup.sh").write_text(
            '#!/usr/bin/env bash\nprintf \'{"stage":"setup"}\\n\' >> "$INSTALL_TEST_LOG"\n'
            '[[ "${INSTALL_TEST_FAIL:-}" != setup ]]\n', encoding="utf-8",
        )
        (remote / "startMagicRagUI.sh").write_text(
            '#!/usr/bin/env bash\nprintf \'{"stage":"ui"}\\n\' >> "$INSTALL_TEST_LOG"\n'
            '[[ "${INSTALL_TEST_FAIL:-}" != ui ]]\n', encoding="utf-8",
        )
        (remote / "setup/setup.ps1").write_text(
            '\'{"stage":"setup"}\' | Add-Content -LiteralPath $env:INSTALL_TEST_LOG\n'
            'if ($env:INSTALL_TEST_FAIL -eq "setup") { exit 17 }\n', encoding="utf-8",
        )
        (remote / "startMagicRagUI.bat").write_text(
            '@echo off\necho {"stage":"ui"}>>"%INSTALL_TEST_LOG%"\n'
            'if "%INSTALL_TEST_FAIL%"=="ui" exit /b 17\nexit /b 0\n', encoding="utf-8",
        )
        self.assert_success(self.run_command(["git", "init", "-b", "main", str(remote)]))
        self.assert_success(self.run_command(["git", "-C", str(remote), "add", "."]))
        self.assert_success(self.run_command([
            "git", "-C", str(remote), "-c", "user.name=Installer test", "-c", "user.email=test@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "-m", "Installer fixture",
        ]))
        self.assert_success(self.run_command([
            "git", "config", "--file", self.env["GIT_CONFIG_GLOBAL"],
            f"url.{remote.as_uri()}.insteadOf", "https://github.com/adidaniel1000/magic-rag.git",
        ]))

    def run_wrapper(self):
        suffix = "ps1" if self.shell == "powershell" else "sh"
        contents = (PROJECT_ROOT / "setup/wrapper" / f"install.{suffix}").read_text(encoding="utf-8")
        if self.shell == "powershell":
            # Like irm | iex: execute text with no script path/PSScriptRoot.
            self.env["INSTALL_TEST_SCRIPT"] = contents
            return self.run_command([POWERSHELL, "-NoProfile", "-Command", "Invoke-Expression $env:INSTALL_TEST_SCRIPT"])
        return self.run_command([BASH], input=contents)

    def test_setup_creates_and_reuses_environment_from_another_directory(self):
        self.prepare_setup()
        self.assert_success(self.run_setup())
        self.assertEqual(self.stages(), ["node", "venv", "pip", "sqlite", "ci", "build"])
        commands = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(Path(commands[-1]["cwd"]), self.checkout / "web")
        self.log.unlink()
        self.assert_success(self.run_setup())
        self.assertEqual(self.stages(), ["node", "pip", "sqlite", "ci", "build"])

    def test_setup_stops_at_each_failed_stage(self):
        self.prepare_setup()
        stages = ["node", "venv", "pip", "sqlite", "ci", "build"]
        for stage in stages:
            with self.subTest(stage=stage):
                venv_dir = self.checkout / "index/.venv"
                if venv_dir.exists():
                    shutil.rmtree(venv_dir)
                self.log.unlink(missing_ok=True)
                self.env["INSTALL_TEST_FAIL"] = stage
                result = self.run_setup()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.stages(), stages[:stages.index(stage) + 1])

    def test_launcher_forwards_arguments_and_exit_status(self):
        self.prepare_setup()
        if self.shell == "powershell":
            command = [os.environ["COMSPEC"], "/d", "/c", str(self.checkout / "startMagicRagUI.bat")]
        else:
            command = [BASH, str(self.checkout / "startMagicRagUI.sh")]
        self.assertNotEqual(self.run_command(command).returncode, 0)
        self.assert_success(self.run_setup())
        self.env["INSTALL_TEST_FAIL"] = "ui"
        result = self.run_command(command + ["--no-browser", "--port", "32190"])
        self.assertEqual(result.returncode, 17, result.stdout + result.stderr)
        last = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(last["args"][-3:], ["--no-browser", "--port", "32190"])

    def test_piped_wrapper_clones_sets_up_and_launches(self):
        self.prepare_remote()
        self.assert_success(self.run_wrapper())
        self.assertEqual(self.stages(), ["setup", "ui"])
        self.assertTrue((self.root / "magic-rag/.git").is_dir())

    def test_wrapper_honors_custom_destination_and_preserves_existing_files(self):
        self.prepare_remote()
        destination = self.root / "custom installation"
        self.env["MAGIC_RAG_INSTALL_DIR"] = str(destination)
        self.assert_success(self.run_wrapper())
        marker = destination / "keep.txt"
        marker.write_text("user data", encoding="utf-8")
        self.log.unlink()
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stdout + result.stderr)
        self.assertEqual(self.stages(), [])
        self.assertEqual(marker.read_text(), "user data")

    def test_wrapper_does_not_launch_after_setup_failure(self):
        self.prepare_remote()
        self.env["INSTALL_TEST_FAIL"] = "setup"
        self.assertNotEqual(self.run_wrapper().returncode, 0)
        self.assertEqual(self.stages(), ["setup"])

    def test_wrapper_reports_launcher_failure(self):
        self.prepare_remote()
        self.env["INSTALL_TEST_FAIL"] = "ui"
        self.assertNotEqual(self.run_wrapper().returncode, 0)
        self.assertEqual(self.stages(), ["setup", "ui"])

    def test_wrapper_does_not_run_setup_after_clone_failure(self):
        self.assert_success(self.run_command([
            "git", "config", "--file", self.env["GIT_CONFIG_GLOBAL"],
            f"url.{(self.root / 'missing remote').as_uri()}.insteadOf",
            "https://github.com/adidaniel1000/magic-rag.git",
        ]))
        self.assertNotEqual(self.run_wrapper().returncode, 0)
        self.assertEqual(self.stages(), [])


@unittest.skipUnless(POWERSHELL and shutil.which("git"), "Windows PowerShell and Git are required")
class PowerShellInstallerTests(InstallerFixture, unittest.TestCase):
    shell = "powershell"


@unittest.skipUnless(BASH and shutil.which("git"), "Bash and Git are required")
class BashInstallerTests(InstallerFixture, unittest.TestCase):
    shell = "bash"


if __name__ == "__main__":
    unittest.main()
