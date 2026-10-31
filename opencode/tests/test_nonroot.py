"""root 只准备隔离目录，再由普通 UID 验证真实启动及只读入口。"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class NonrootTests(unittest.TestCase):
    @unittest.skipUnless(os.getuid() == 0 and shutil.which('node'), '需要 root 降权及已有 Node，不下载工具')
    def test_nonroot_startup_cache_pvc_and_readonly_commands(self):
        module = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='opencode-nonroot-', dir='/tmp') as temporary:
            base = Path(temporary)
            base.chmod(0o755)
            source = base / 'source'
            shutil.copytree(module, source, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '.terraform'))
            for file in source.rglob('*'):
                file.chmod(0o755 if file.is_dir() else 0o644)
            node = base / 'node'
            shutil.copyfile(shutil.which('node'), node)
            node.chmod(0o755)
            work = base / 'work'
            work.mkdir(mode=0o700)
            os.chown(work, 65534, 65534)
            pvc = base / 'pvc'
            pvc.mkdir()
            os.chown(pvc, 0, 65533)
            pvc.chmod(0o2770)
            before = (pvc.stat().st_uid, pvc.stat().st_gid, pvc.stat().st_mode)
            response = subprocess.run(['/usr/bin/python3', '-B', str(source / 'tests/nonroot_fixture.py'),
                                       str(work), str(node), str(pvc)], cwd=work,
                                      env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                                           'TEST_TMP_ROOT': str(work)},
                                      user=65534, group=65534, extra_groups=[65533],
                                      capture_output=True, text=True, timeout=90)
            self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
            self.assertIn('nonroot readonly/startup/cache/trust: passed; uid=65534', response.stdout)
            self.assertEqual(before, (pvc.stat().st_uid, pvc.stat().st_gid, pvc.stat().st_mode))
