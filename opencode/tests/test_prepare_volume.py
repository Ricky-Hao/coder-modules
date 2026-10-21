"""Offline root init fixtures. Mount identity is explicitly mocked; no real mounts."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import test_install as fixtures

sys.path.insert(0, str(fixtures.SCRIPTS))
import prepare_volume
import safety


@unittest.skipUnless(os.getuid() == 0, 'root preparation fixtures require root; nonroot refusal tested separately')
class VolumePreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.base / 'rootfs'
        self.root.mkdir(mode=0o755)
        self.root.chmod(0o755)
        (self.root / 'mnt').mkdir(mode=0o755)
        (self.root / 'mnt').chmod(0o755)
        self.mount = self.root / 'mnt/opencode'
        self.mount.mkdir()
        self.mount.chmod(0o777)
        self.config = {'mount_path': '/mnt/opencode', 'install_root': '/mnt/opencode/toolset',
                       'workspace_id': 'test-workspace'}
        self.fixture.bundle['config']['install_root'] = str(self.mount / 'toolset')

    @contextlib.contextmanager
    def boundary(self, mounted=True):
        original_open = os.open

        def anchored_open(path, *args, **kwargs):
            return original_open(str(self.root) if path == '/' else path, *args, **kwargs)

        def verify(fd):
            if not mounted:
                raise ValueError('not a mount fixture')

        with patch.object(prepare_volume.os, 'open', side_effect=anchored_open), \
                patch.object(prepare_volume, 'verify_mount', side_effect=verify):
            yield

    def prepare(self):
        with self.boundary():
            prepare_volume.prepare(self.config)

    def test_exact_reported_mode_fails_then_opt_in_prep_install_and_cache_pass(self):
        self.assertEqual(self.root.stat().st_mode & 0o7777, 0o755)
        self.assertEqual((self.root / 'mnt').stat().st_mode & 0o7777, 0o755)
        self.assertEqual(self.mount.stat().st_uid, 0)
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o777)
        self.assertFalse((self.mount / 'toolset').exists())
        with self.assertRaisesRegex(ValueError, 'unsafe installation parent'):
            self.fixture.install()
        self.assertEqual(self.fixture.downloads, 0)
        self.prepare()
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o1777)
        self.fixture.install()
        active = os.readlink(self.mount / 'toolset/active')
        manifest = (self.mount / 'toolset/active/installed.json').read_bytes()
        self.prepare()
        self.fixture.install()
        self.assertEqual(self.fixture.downloads, 2)
        self.assertEqual(os.readlink(self.mount / 'toolset/active'), active)
        self.assertEqual((self.mount / 'toolset/active/installed.json').read_bytes(), manifest)

    def test_exact_scope_no_mount_and_foreign_owner_refused(self):
        for path in ('/', '/mnt', '/home', '/tmp', '/project', '/mnt/shared', '/mnt/opencode/../opencode'):
            with self.subTest(path=path), self.boundary():
                with self.assertRaises(ValueError):
                    prepare_volume.prepare(dict(self.config, mount_path=path))
        with self.boundary(mounted=False), self.assertRaises(ValueError):
            prepare_volume.prepare(self.config)
        os.chown(self.mount, 65534, 65534)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o777)

    def test_unsafe_ancestor_and_mount_symlink_refused(self):
        (self.root / 'mnt').chmod(0o777)
        with self.assertRaises(ValueError):
            self.prepare()
        (self.root / 'mnt').chmod(0o755)
        self.root.chmod(0o777)
        with self.assertRaises(ValueError):
            self.prepare()
        self.root.chmod(0o755)
        target = self.fixture.base / 'target'
        self.mount.rename(target)
        self.mount.symlink_to(target)
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(target.stat().st_mode & 0o7777, 0o777)

    def test_sibling_content_survives_first_and_repeat_preparation(self):
        tasks = self.mount / 'tasks'
        tasks.mkdir(mode=0o700)
        record = tasks / 'task.md'
        record.write_text('keep task checkpoint\n')
        other = self.mount / 'unrelated'
        other.write_text('keep sibling file\n')
        link = self.mount / 'unrelated-link'
        link.symlink_to(self.fixture.base / 'missing-sibling-target')
        pipe = self.mount / 'unrelated-pipe'
        os.mkfifo(pipe, 0o600)
        siblings = (tasks, record, other, link, pipe)

        def snapshot():
            result = {}
            for path in siblings:
                info = path.lstat()
                result[str(path.relative_to(self.mount))] = (
                    info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
                    info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            return result

        before = snapshot()
        self.prepare()
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o1777)
        self.assertEqual(snapshot(), before)
        self.fixture.install()
        self.prepare()
        self.prepare()
        self.fixture.install()
        self.assertEqual(snapshot(), before)
        self.assertEqual(record.read_text(), 'keep task checkpoint\n')
        self.assertEqual(other.read_text(), 'keep sibling file\n')
        self.assertEqual(os.readlink(link), str(self.fixture.base / 'missing-sibling-target'))
        self.assertEqual(self.fixture.downloads, 2)

    def test_unmarked_linked_or_non_directory_child_refused_with_siblings(self):
        other = self.mount / 'unrelated'
        other.write_text('keep')
        child = self.mount / 'toolset'
        child.mkdir(mode=0o700)
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        child.rmdir()
        for target in (self.fixture.home, self.fixture.base / 'missing-toolset-target'):
            with self.subTest(target=target):
                child.symlink_to(target)
                with self.assertRaises(OSError):
                    self.prepare()
                child.unlink()
        child.write_text('not an installation directory')
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(child.read_text(), 'not an installation directory')
        self.assertEqual(other.read_text(), 'keep')
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o777)

    def test_foreign_workspace_marker_and_unsafe_child_entries_refused(self):
        self.prepare()
        self.fixture.install()
        child = self.mount / 'toolset'
        (self.mount / 'tasks').mkdir(mode=0o700)
        self.config['workspace_id'] = 'other-test-workspace'
        with self.assertRaisesRegex(ValueError, 'another workspace or UID'):
            self.prepare()
        self.config['workspace_id'] = 'test-workspace'
        (child / 'foreign').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'unexpected private-child content'):
            self.prepare()
        (child / 'foreign').unlink()
        (child / 'active').unlink()
        (child / 'active').symlink_to('/tmp')
        with self.assertRaisesRegex(ValueError, 'unsafe active link'):
            self.prepare()

    def test_safe_modes_respected_and_descriptor_does_not_follow_substitution(self):
        for mode in (0o700, 0o750, 0o755, 0o770, 0o2770, 0o1777):
            self.mount.chmod(mode)
            self.prepare()
            self.assertEqual(self.mount.stat().st_mode & 0o7777, mode)
        self.mount.chmod(0o777)
        other = self.fixture.base / 'replacement'
        other.mkdir(mode=0o700)
        other.chmod(0o777)
        saved = self.fixture.base / 'opened-volume'
        fchmod = os.fchmod

        def swap(fd, mode):
            # A root-adversary substitution is outside the trust boundary, but
            # even this mock must never redirect chmod to a substituted path.
            self.mount.rename(saved)
            self.mount.symlink_to(other)
            fchmod(fd, mode)

        with self.boundary(), patch.object(prepare_volume.os, 'fchmod', side_effect=swap):
            prepare_volume.prepare(self.config)
        self.assertEqual(saved.stat().st_mode & 0o7777, 0o1777)
        self.assertEqual(other.stat().st_mode & 0o7777, 0o777)


class MountIdentityTests(unittest.TestCase):
    def test_mount_id_must_match_exact_mountpoint_no_runtime_bypass(self):
        def files(fdinfo, mountinfo):
            def read(path, *args, **kwargs):
                return io.StringIO(fdinfo if path.startswith('/proc/self/fdinfo/') else mountinfo)
            return read

        for mountinfo in ('9 1 0:1 / /mnt/opencode rw - tmpfs tmpfs rw\n',
                          '7 1 0:1 / /mnt/elsewhere rw - tmpfs tmpfs rw\n'):
            with patch('builtins.open', side_effect=files('mnt_id:\t7\n', mountinfo)):
                with self.assertRaises(ValueError):
                    prepare_volume.verify_mount(42)
        with patch('builtins.open', side_effect=files('mnt_id:\t7\n',
                '7 1 0:1 / /mnt/opencode rw - tmpfs tmpfs rw\n')):
            prepare_volume.verify_mount(42)

    def test_nonroot_cannot_prepare_even_with_explicit_opt_in(self):
        config = {'mount_path': '/mnt/opencode', 'install_root': '/mnt/opencode/toolset',
                  'workspace_id': 'test-workspace'}
        with patch.object(prepare_volume.os, 'getuid', return_value=65534):
            with self.assertRaisesRegex(ValueError, 'root init'):
                prepare_volume.prepare(config)


if __name__ == '__main__':
    unittest.main()
