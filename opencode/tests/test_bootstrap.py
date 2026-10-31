"""Startup transport regression: real env/bash exec, no provider/model/network."""
import errno
import json
import os
import subprocess
import unittest

import test_install as fixtures
from bootstrap_fixture import SCRIPT_BUDGET, launch, render, unpack, verify_startup


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_actual_exec_first_repeat_cache_and_private_task_recovery_startup(self):
        fixture = self.fixture
        script = render(fixture.bundle)
        self.assertLessEqual(len(script.encode()), SCRIPT_BUDGET)
        self.assertEqual(unpack(script), fixture.bundle)
        fixture_dir = fixture.base / 'execution'
        fixture.bundle['config']['install_root'] = str(fixture_dir / 'mount/toolset')
        result = verify_startup(render(fixture.bundle), fixture_dir)
        self.assertEqual(result['startup_recover_invocations'], 2)

    @unittest.skipUnless(os.sysconf('SC_PAGESIZE') == 4096, 'negative control requires the rollout kernel page size')
    def test_rollout_sized_single_argument_is_rejected_before_execution(self):
        # Independent OS negative control: a successful file/stdin launch cannot
        # stand in for the Coder single-argument startup contract.
        script = '# ' + 'x' * (153559 - 2)
        with self.assertRaises(OSError) as failure:
            subprocess.run(['/usr/bin/env', 'bash', '-c', script], env={'PATH': '/usr/bin:/bin'},
                           capture_output=True, timeout=10)
        self.assertEqual(failure.exception.errno, errno.E2BIG)

    def test_committed_source_bundle_and_corruption_refusal_preserve_existing_installation(self):
        module = fixtures.SCRIPTS.parent
        checked = subprocess.run(['python3', '-B', str(module / 'build_bundle.py'), '--check'],
                                 env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        fixture = self.fixture
        fixture.install()
        active = os.readlink(fixture.root / 'active')
        status = (fixture.root / 'status.json').read_bytes()
        bundle = json.loads((fixtures.SCRIPTS / 'source.json').read_text())
        template = (fixtures.SCRIPTS / 'install.sh.tftpl').read_text()
        # 损坏的摘要在执行 installer 及写 status 之前失败。
        script = (template.replace('${bundle}', bundle['data']).replace('${sha256}', '0' * 64)
                  .replace('${config}', 'e30='))
        response = launch(script, fixture.home, fixture.base, fixture.tar, fixture.node)
        self.assertEqual(response.returncode, 1)
        self.assertIn('source bundle checksum mismatch', response.stderr)
        self.assertEqual(os.readlink(fixture.root / 'active'), active)
        self.assertEqual((fixture.root / 'status.json').read_bytes(), status)
