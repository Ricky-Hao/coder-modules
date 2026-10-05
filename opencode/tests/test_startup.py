"""Self-contained HOME/PVC startup fixtures; no real installer downloads or services."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_install as fixtures

sys.path.insert(0, str(fixtures.SCRIPTS))
import shell_path
import safety


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.home = self.fixture.home
        self.base = self.fixture.base

    def test_agent_default_home_startup_restart_and_help_without_keys(self):
        self.fixture.bundle['config']['install_root'] = ''
        self.fixture.bundle['config'].pop('runtime_profile')
        root = self.home / '.coder-opencode'
        self.fixture.install()
        settings = json.loads((root / 'active/settings.json').read_text())
        self.assertEqual(settings['install_root'], str(root))
        self.assertEqual(settings['runtime_profile'], 'env')
        self.assertEqual(root.stat().st_uid, os.getuid())
        self.assertEqual(root.stat().st_mode & 0o777, 0o700)
        first = (os.readlink(root / 'active'), (self.home / '.profile').read_bytes())
        self.fixture.install()  # A later startup, same mount/HOME and identity.
        self.assertEqual(self.fixture.downloads, 2)
        self.assertEqual(first, (os.readlink(root / 'active'), (self.home / '.profile').read_bytes()))
        for tool in ('opencode', 'acpx'):
            result = subprocess.run([str(root / 'bin' / tool), '--version'],
                                    env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(root / 'bin/opencode'), 'acp'], env={'PATH': '/usr/bin:/bin'},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('LLM_API_KEY', result.stderr)
        self.assertIn('LLM_BASE_URL', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_writable_dedicated_mount_child_restart_identity_and_no_parent_changes(self):
        mount = self.base / 'mount'
        mount.mkdir(mode=0o750)
        before = (mount.stat().st_uid, mount.stat().st_gid, mount.stat().st_mode)
        root = mount / 'toolset'
        self.fixture.bundle['config']['install_root'] = str(root)
        self.fixture.install()
        active = os.readlink(root / 'active')
        self.fixture.install()
        self.assertEqual(self.fixture.downloads, 2)
        self.assertEqual(active, os.readlink(root / 'active'))
        self.assertEqual(before, (mount.stat().st_uid, mount.stat().st_gid, mount.stat().st_mode))
        self.assertEqual({p.name for p in mount.iterdir()}, {'toolset'})
        self.fixture.bundle['config']['workspace_id'] = 'another-test-workspace'
        with self.assertRaisesRegex(ValueError, 'different UID or workspace'):
            self.fixture.install()

    def test_missing_unwritable_and_linked_mount_refused(self):
        mount = self.base / 'mount'
        self.fixture.bundle['config']['install_root'] = str(mount / 'toolset')
        with self.assertRaises(FileNotFoundError):
            self.fixture.install()
        mount.mkdir(mode=0o500)
        with self.assertRaisesRegex(ValueError, 'writable'):
            self.fixture.install()
        self.assertFalse((mount / 'toolset').exists())
        mount.chmod(0o700)
        mount.rmdir()
        mount.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.fixture.install()
        self.assertFalse((self.home / 'toolset').exists())

    @unittest.skipUnless(os.getuid() == 0, 'creating foreign ownership requires root fixture')
    def test_foreign_mount_and_home_and_uid_change_refused(self):
        mount = self.base / 'mount'
        mount.mkdir(mode=0o777)
        os.chown(mount, 65534, 65534)
        self.fixture.bundle['config']['install_root'] = str(mount / 'toolset')
        with self.assertRaises(ValueError):
            self.fixture.install()
        os.chown(self.home, 65534, 65534)
        with self.assertRaises(ValueError):
            self.fixture.install()
        os.chown(self.home, 0, 0)

    def test_existing_empty_unmarked_root_is_not_adopted(self):
        root = self.fixture.root
        root.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'unmarked'):
            self.fixture.install()
        self.assertEqual(list(root.iterdir()), [])

    def test_world_writable_higher_ancestor_refused_for_install_and_home(self):
        # Root execution creates the exact root-owned 0777 intermediate case;
        # ordinary nonroot execution checks the same policy for the current UID.
        unsafe = self.base / 'unsafe'
        unsafe.mkdir(mode=0o700)
        unsafe.chmod(0o777)
        parent = unsafe / 'safe-parent'
        parent.mkdir(mode=0o700)
        home = parent / 'home'
        home.mkdir(mode=0o700)
        for kind in ('install', 'home', 'profiles'):
            with self.subTest(kind=kind):
                with self.assertRaises(ValueError):
                    if kind == 'install':
                        safety.ancestors(parent / 'toolset')
                    elif kind == 'home':
                        fd = shell_path.home_fd(str(home))
                        os.close(fd)
                    else:
                        shell_path.install(str(home), '/example/toolset/bin')
        self.assertFalse((parent / 'toolset').exists())
        self.assertEqual(list(home.iterdir()), [])

    def test_group_sharing_only_at_immediate_installation_boundary(self):
        shared = self.base / 'shared'
        shared.mkdir(mode=0o700)
        shared.chmod(0o2770)
        # Explicit writable mount: this process belongs to its group.
        safety.ancestors(shared / 'toolset')
        with patch.object(safety.os, 'getegid', return_value=shared.stat().st_gid + 1), \
                patch.object(safety.os, 'getgroups', return_value=[]):
            with self.assertRaises(ValueError):
                safety.ancestors(shared / 'toolset')
        parent = shared / 'safe-parent'
        parent.mkdir(mode=0o700)
        home = parent / 'home'
        home.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            safety.ancestors(parent / 'toolset')
        with self.assertRaises(ValueError):
            fd = shell_path.home_fd(str(home))
            os.close(fd)
        # HOME does not grant an implicit shared-PVC exception even immediately above it.
        with self.assertRaises(ValueError):
            fd = shell_path.home_fd(str(parent))
            os.close(fd)

    def test_sticky_shared_ancestor_remains_usable(self):
        shared = self.base / 'sticky'
        shared.mkdir(mode=0o700)
        shared.chmod(0o1777)
        parent = shared / 'safe-parent'
        parent.mkdir(mode=0o700)
        home = parent / 'home'
        home.mkdir(mode=0o700)
        safety.ancestors(shared / 'direct-toolset')
        safety.ancestors(parent / 'toolset')
        fd = shell_path.home_fd(str(home))
        os.close(fd)
        shell_path.install(str(home), '/example/toolset/bin')
        self.assertTrue((home / '.profile').is_file())

    def test_invalid_home_and_root_paths_never_expand_shell(self):
        config = self.fixture.bundle['config']
        for name in ('relative', '/tmp/../test', '/tmp//test', '/tmp/./test', '/tmp/test/', '/tmp/a:b', '/tmp/a\nb'):
            with self.subTest(path=name):
                with self.assertRaises(ValueError):
                    fixtures.installer.validate(dict(config, install_root=name))
        for home in ('', '/', str(self.home) + '/.', str(self.home) + '/'):
            with self.assertRaises(ValueError):
                shell_path.home_fd(home)
        linked = self.base / 'home-link'
        linked.symlink_to(self.home)
        with self.assertRaises(OSError):
            shell_path.home_fd(str(linked))

    def test_bash_profiles_preserve_bytes_precedence_path_and_quoting(self):
        root = self.base / "tool ' $HOME $(false)"
        self.fixture.bundle['config']['install_root'] = str(root)
        original = b'# user bytes, no final newline'
        preferred = self.home / '.bash_profile'
        preferred.write_bytes(original)
        preferred.chmod(0o640)
        inode, mode = preferred.stat().st_ino, preferred.stat().st_mode
        self.fixture.install()
        self.assertFalse((self.home / '.profile').exists())
        self.assertTrue(preferred.read_bytes().startswith(original))
        self.assertEqual((preferred.stat().st_ino, preferred.stat().st_mode), (inode, mode))
        env = {'HOME': str(self.home), 'PATH': '/project/bin:/usr/bin:/bin'}
        # A fresh login shell with system profiles disabled; source the preferred
        # user profile explicitly so host /etc/profile cannot replace fixture HOME.
        for args in (['--noprofile', '-lc', '. "$HOME/.bash_profile"; printf "%s" "$PATH"'],
                     ['--noprofile', '--norc', '-ic', '. "$HOME/.bashrc"; printf "%s" "$PATH"']):
            result = subprocess.run(['bash', *args], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, env['PATH'] + ':' + str(root / 'bin'))
            self.assertNotIn('/node/bin', result.stdout)
        self.assertEqual(env['PATH'], '/project/bin:/usr/bin:/bin')
        self.fixture.install()
        self.assertEqual(preferred.read_bytes().count(shell_path.MARKER), 1)

    def test_lower_login_profile_selection_and_unsafe_profiles(self):
        login = self.home / '.bash_login'
        login.write_text('# preferred login\n')
        shell_path.install(str(self.home), '/example/toolset/bin')
        self.assertFalse((self.home / '.bash_profile').exists())
        self.assertFalse((self.home / '.profile').exists())
        self.assertIn(shell_path.MARKER, login.read_bytes())
        original = login.read_bytes()
        login.write_bytes(original + b'# user edit\n')
        with self.assertRaises(ValueError):
            shell_path.install(str(self.home), '/example/toolset/bin')
        login.unlink()
        login.symlink_to(self.home / 'absent')
        with self.assertRaises(ValueError):
            shell_path.install(str(self.home), '/example/toolset/bin')

    def test_same_startup_owns_profile_helper_and_fingerprint(self):
        self.fixture.install()
        root = self.fixture.root
        manifest = json.loads((root / 'active/installed.json').read_text())
        self.assertIn('shell_path.py', manifest['files'])
        self.assertIn(str(root / 'bin').encode(), (self.home / '.profile').read_bytes())
        active = os.readlink(root / 'active')
        # No caller snippet is needed: changed helper is installed as a new version.
        self.fixture.bundle['files']['shell_path.py'] += '\n# fixture revision\n'
        self.fixture.install()
        self.assertNotEqual(active, os.readlink(root / 'active'))


if __name__ == '__main__':
    unittest.main()
