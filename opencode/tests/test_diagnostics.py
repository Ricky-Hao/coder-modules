"""只读自检的实际 launcher、安装 inventory 与缺失/不安全状态回归。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_install as fixtures

sys.path.insert(0, str(fixtures.SCRIPTS))
spec = importlib.util.spec_from_file_location('diagnostics', fixtures.SCRIPTS / 'diagnostics.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


def snapshot(root):
    result = {}
    for file in sorted(root.rglob('*')):
        info = file.lstat()
        result[str(file.relative_to(root))] = (info.st_mode, info.st_mtime_ns, info.st_ctime_ns,
                                             fixtures.installer.digest(file) if file.is_file() else None)
    return result


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.install()
        self.root = self.fixture.root

    def call(self, extra=None, quick=False):
        return subprocess.run([str(self.root / 'bin/opencode-task'), 'doctor', *(['--quick'] if quick else [])], cwd=self.fixture.base,
                              env={'PATH': '/usr/bin:/bin', **(extra or {})}, capture_output=True, text=True, timeout=10)

    def test_installed_launcher_inventory_pins_and_profile_without_execution_or_writes(self):
        before = snapshot(self.root)
        response = self.call({'OPENCODE_MODULE_CONFIG': '/PRIVATE-CONFIG-MUST-NOT-OPEN',
                              'CODEX_API_KEY': 'SYNTHETIC-NEVER-PRINT', 'GITHUB_MCP_API_KEY': 'SYNTHETIC-NEVER-PRINT'})
        self.assertEqual(response.returncode, 0, response.stderr + response.stdout)
        value = json.loads(response.stdout)
        self.assertTrue(value['ok'])
        self.assertEqual(value['runtime']['node'], '22.23.4')
        self.assertEqual(value['runtime']['acpx'], '0.21.1')
        self.assertFalse(value['runtime']['executed'])
        self.assertEqual(value['profile']['source'], 'external')
        self.assertIn('inspect', value['features']['readonly_commands'])
        self.assertIn('provider_health', value['not_checked'])
        for secret in (str(self.root), 'PRIVATE-CONFIG', 'SYNTHETIC-NEVER-PRINT'):
            self.assertNotIn(secret, response.stdout + response.stderr)
        self.assertEqual(snapshot(self.root), before)

        with patch.object(subprocess, 'run', side_effect=AssertionError('doctor must not spawn tools')), \
                patch.object(os, 'execve', side_effect=AssertionError('doctor must not execute tools')):
            for quick in (False, True):
                value = diagnostics.doctor(self.root, quick=quick)
                self.assertTrue(value['ok'])
                self.assertEqual(value['profile'], {'source': 'none', 'automatic_environment_names': []})
        self.assertEqual(snapshot(self.root), before)

    def test_quick_skips_binary_reads_but_checks_scripts_and_rejects_unsafe_binary(self):
        original_read = os.read
        binary_bytes = 0
        version = (self.root / 'active').resolve()
        binaries = {version / 'opencode', version / 'node/bin/node'}

        def measured(fd, maximum):
            nonlocal binary_bytes
            data = original_read(fd, maximum)
            if Path(os.readlink('/proc/self/fd/' + str(fd))) in binaries:
                binary_bytes += len(data)
            return data

        before = snapshot(self.root)
        with patch.object(os, 'read', side_effect=measured):
            value = diagnostics.doctor(self.root, quick=True)
        self.assertTrue(value['ok'])
        self.assertEqual(binary_bytes, 0)
        checks = {check['name']: check for check in value['checks']}
        self.assertEqual(checks['opencode']['status'], 'not_checked')
        self.assertEqual(checks['node/bin/node']['status'], 'not_checked')
        self.assertEqual(checks['opencode:metadata']['status'], 'ok')
        self.assertEqual(snapshot(self.root), before)
        binary = self.root / 'active/opencode'
        original = binary.read_bytes()
        binary.write_bytes(original.replace(b'import', b'IMPORT', 1))
        self.assertEqual(self.call(quick=True).returncode, 0)
        self.assertEqual(self.call().returncode, 1)  # 默认仍发现内容篡改。
        binary.write_bytes(original)
        for kind in ('mode', 'symlink', 'fifo', 'hardlink', 'owner'):
            if kind == 'owner' and os.getuid() != 0:
                continue
            with self.subTest(kind=kind):
                binary.unlink()
                if kind == 'symlink':
                    binary.symlink_to('/PRIVATE-TARGET')
                elif kind == 'fifo':
                    os.mkfifo(binary, 0o700)
                elif kind == 'hardlink':
                    os.link(self.root / 'active/task-cli.mjs', binary)
                else:
                    binary.write_bytes(original)
                    binary.chmod(0o770 if kind == 'mode' else 0o700)
                    if kind == 'owner':
                        os.chown(binary, 65534, 65534)
                response = self.call(quick=True)
                self.assertEqual(response.returncode, 1)
                self.assertFalse(json.loads(response.stdout)['ok'])
                self.assertNotIn('PRIVATE-', response.stdout + response.stderr)
                binary.unlink()
                binary.write_bytes(original)
                binary.chmod(0o700)
        script = self.root / 'active/task-cli.mjs'
        script.write_text('tampered small script')
        self.assertEqual(self.call(quick=True).returncode, 1)

    def test_incomplete_installation_reports_missing_and_unknown_pins_without_repair(self):
        (self.root / 'active/node/bin/node').unlink()
        before = snapshot(self.root)
        response = self.call()
        self.assertEqual(response.returncode, 1)
        value = json.loads(response.stdout)
        self.assertFalse(value['ok'])
        failed = {check['name']: check for check in value['checks'] if check['status'] == 'failed'}
        self.assertEqual(failed['node/bin/node:metadata']['code'], 'MISSING')
        self.assertIsNone(value['runtime'])
        self.assertEqual(snapshot(self.root), before)

    def test_launch_store_is_optional_private_and_preserved(self):
        tasks = self.root / 'runtime/tasks'
        if not tasks.exists():
            tasks.mkdir(mode=0o700)
            (tasks / 'owner.json').write_text(json.dumps({'schema': 1, 'uid': os.getuid(),
                                                        'workspace_id': self.fixture.bundle['config']['workspace_id']}))
            (tasks / 'owner.json').chmod(0o600)
        store = tasks / '.launches'
        store.mkdir(mode=0o700)
        (store / 'private-intent').write_text('not inspected by doctor')
        before = snapshot(self.root)
        self.assertEqual(self.call(quick=True).returncode, 0)
        self.assertEqual(snapshot(self.root), before)
        store.chmod(0o755)
        self.assertEqual(self.call(quick=True).returncode, 1)
        store.chmod(0o700)
        store.rename(tasks / '.saved-launches')
        store.symlink_to(tasks / '.saved-launches', target_is_directory=True)
        self.assertEqual(self.call(quick=True).returncode, 1)

    def test_env_profile_reports_names_without_keys_or_generated_configuration(self):
        self.fixture.bundle['config']['runtime_profile'] = 'env'
        self.fixture.install()
        before = snapshot(self.root)
        response = self.call()
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        value = json.loads(response.stdout)
        self.assertEqual(value['profile']['source'], 'env')
        self.assertIn('CODEX_API_KEY', value['profile']['required_environment_names'])
        self.assertEqual(snapshot(self.root), before)
        self.assertFalse((self.root / 'runtime/module-profiles').exists())

    def test_missing_installation_is_read_only_and_does_not_claim_coverage(self):
        missing = self.fixture.base / 'not-installed'
        value = diagnostics.doctor(missing)
        self.assertFalse(value['ok'])
        self.assertIsNone(value['runtime'])
        self.assertIsNone(value['features'])
        self.assertFalse(missing.exists())
        response = subprocess.run(['python3', '-B', str(fixtures.SCRIPTS / 'diagnostics.py'), '--root', str(missing)],
                                  env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=5)
        self.assertEqual(response.returncode, 1)
        self.assertFalse(json.loads(response.stdout)['ok'])

    def test_invalid_inventory_unsafe_file_and_wrong_wrapper_are_safe_failures(self):
        version = (self.root / 'active').resolve()
        for kind in ('mode', 'symlink', 'fifo', 'changed'):
            file = version / 'task-cli.mjs'
            original = file.read_bytes()
            file.unlink()
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    file.symlink_to('/PRIVATE-TARGET')
                elif kind == 'fifo':
                    os.mkfifo(file, 0o600)
                else:
                    file.write_bytes(original if kind == 'mode' else b'PRIVATE-RAW-ERROR')
                    file.chmod(0o644 if kind == 'mode' else 0o600)
                response = self.call()
                self.assertEqual(response.returncode, 1)
                value = json.loads(response.stdout)
                self.assertFalse(value['ok'])
                self.assertIsNone(value['features'])
                self.assertNotIn('PRIVATE-', response.stdout + response.stderr)
            file.unlink()
            file.write_bytes(original)
            file.chmod(0o600)
        (self.root / 'bin/acpx').write_text('PRIVATE-FOREIGN-WRAPPER')
        value = json.loads(self.call().stdout)
        self.assertTrue(any(check['name'] == 'bin/acpx' and check['status'] == 'failed' for check in value['checks']))

    def test_atomic_record_replacement_reopens_only_valid_unlinked_inode(self):
        file = self.fixture.base / 'sample.json'
        file.write_text('{"version":1}')
        file.chmod(0o600)
        original_stat = os.fstat
        replaced = []

        def replace(fd):
            if not replaced:
                temporary = file.with_suffix('.new')
                temporary.write_text('{"version":2}')
                temporary.chmod(0o600)
                os.replace(temporary, file)
                replaced.append(original_stat(fd).st_nlink)
            return original_stat(fd)

        with patch.object(os, 'fstat', side_effect=replace):
            self.assertEqual(diagnostics.read_json(file), {'version': 2})
        self.assertEqual(replaced, [0])
        file.chmod(0o644)
        with self.assertRaisesRegex(diagnostics.ReadError, 'UNSAFE_FILE'):
            diagnostics.read_json(file)


if __name__ == '__main__':
    unittest.main()
