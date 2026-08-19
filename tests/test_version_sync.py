import subprocess
import sys
from pathlib import Path
import unittest


class VersionSyncTests(unittest.TestCase):
    def test_python_and_npm_packages_share_one_version(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [sys.executable, "scripts/check_versions.py"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        version = subprocess.run(
            [sys.executable, "scripts/check_versions.py", "--print-version"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(completed.stdout.strip(), f"Versions synchronized: {version}")

    def test_version_can_be_printed_for_release_automation(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [sys.executable, "scripts/check_versions.py", "--print-version"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertRegex(completed.stdout.strip(), r"^[0-9]+\.[0-9]+\.[0-9]+$")

    def test_release_tag_must_match_the_package_version(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [sys.executable, "scripts/check_versions.py", "--tag", "v9.9.9"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("does not match", completed.stderr)


if __name__ == "__main__":
    unittest.main()
