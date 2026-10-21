"""Startup transport regression: real env/bash exec, no provider/model/network."""
import errno
import os
import subprocess
import unittest

import test_install as fixtures
from bootstrap_fixture import SCRIPT_BUDGET, render, unpack, verify_startup


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
