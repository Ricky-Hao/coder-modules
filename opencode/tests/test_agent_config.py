"""Real local Git, atomic publication, offline fallback and public-entry ordering."""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

from agent_config_fixture import source
import test_install as fixtures

sys.path.insert(0, str(fixtures.SCRIPTS))
import agent_config
from safety import write_json


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agent-config-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repo, shim = source(self.base)
        self.env = {'PATH': str(shim) + ':/usr/bin:/bin', 'HOME': str(self.base),
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        self.root = self.base / 'toolset'
        for path in (self.root, self.root / 'runtime', self.root / 'runtime/config'):
            path.mkdir(mode=0o700)
        write_json(self.root / 'owner.json', {'schema': 1, 'uid': os.getuid(), 'workspace_id': 'sync-test'})
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        self.config = self.root / 'runtime/config/opencode'
        self.store = self.root / 'runtime/agent-config'

    def sync(self, **kwargs):
        return agent_config.synchronize(self.root, 'sync-test', self.env, **kwargs)

    def commit(self, message='update'):
        for args in (['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', message]):
            subprocess.run(['/usr/bin/git', '-C', str(self.repo), *args], env=self.env, check=True, capture_output=True)

    def test_success_complete_package_and_same_tree_never_replaces_targets(self):
        first = self.sync()
        self.assertEqual((self.config / 'AGENTS.md').read_bytes(), (self.repo / 'AGENTS.md').read_bytes())
        for name in ('SKILL.md', 'references/guide.md', 'LICENSE'):
            self.assertEqual((self.config / 'skills/agent-config/example' / name).read_bytes(),
                             (self.repo / 'skills/example' / name).read_bytes())
        paths = [self.store / 'current', self.config / 'AGENTS.md', self.config / 'skills/agent-config']
        before = [(p.lstat().st_ino, p.lstat().st_mtime_ns) for p in paths]
        self.assertEqual(self.sync(), first)
        self.commit('same content, new main commit')
        second = self.sync()
        self.assertEqual(second['tree'], first['tree'])
        self.assertNotEqual(second['revision'], first['revision'])
        self.assertEqual([(p.lstat().st_ino, p.lstat().st_mtime_ns) for p in paths], before)

    def test_remote_failure_keeps_complete_copy_and_first_failure_is_explicit(self):
        first = self.sync()
        self.repo.rename(self.base / 'offline-source')
        with contextlib.redirect_stderr(io.StringIO()) as warning:
            self.assertEqual(self.sync(), first)
        self.assertIn('using complete cached', warning.getvalue())
        self.assertEqual((self.config / 'skills/agent-config/example/references/guide.md').read_text(), 'Synthetic reference v1.\n')
        shutil.rmtree(self.store)
        (self.config / 'AGENTS.md').unlink()
        with self.assertRaisesRegex(agent_config.SyncError, 'unavailable_no_cache'):
            self.sync()
        self.assertFalse((self.root / 'runtime/tasks-v3').exists())

    def test_unmanaged_targets_and_modified_cache_are_preserved(self):
        self.config.mkdir(mode=0o700)
        personal = self.config / 'AGENTS.md'
        personal.write_text('my existing rules')
        with self.assertRaisesRegex(agent_config.SyncError, 'target_conflict'):
            self.sync()
        self.assertEqual(personal.read_text(), 'my existing rules')
        personal.unlink()
        skills = self.config / 'skills'
        unrelated = skills / 'personal'
        unrelated.mkdir(mode=0o700)
        (unrelated / 'SKILL.md').write_text('my personal skill')
        occupied = skills / 'agent-config'
        occupied.mkdir(mode=0o700)
        (occupied / 'keep').write_text('user data')
        with self.assertRaisesRegex(agent_config.SyncError, 'target_conflict'):
            self.sync()
        self.assertEqual((occupied / 'keep').read_text(), 'user data')
        shutil.rmtree(occupied)
        self.sync()
        personal.write_text('edited through managed link')
        with self.assertRaisesRegex(agent_config.SyncError, 'cache_modified'):
            self.sync()
        self.assertEqual(personal.read_text(), 'edited through managed link')
        self.assertEqual((unrelated / 'SKILL.md').read_text(), 'my personal skill')

    def test_invalid_new_tree_never_replaces_complete_old_package(self):
        first = self.sync()
        (self.repo / 'skills/example/escape').symlink_to('/private/never-read')
        self.commit()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.sync(), first)
        self.assertFalse((self.store / 'current/skills/example/escape').exists())
        self.assertFalse(list((self.store / 'snapshots').glob('.staging-*')))

    def test_raw_git_export_preserves_ignored_references_and_executable_permissions(self):
        (self.repo / '.gitattributes').write_text('skills/example/references/guide.md export-ignore\n*.md export-subst\n')
        reference = self.repo / 'skills/example/references/guide.md'
        reference.write_text('Raw reference $Format:%H$\n')
        script = self.repo / 'skills/example/run.sh'
        script.write_text('#!/bin/sh\nprintf example\n')
        script.chmod(0o700)
        self.commit()
        self.sync()
        installed = self.config / 'skills/agent-config/example'
        self.assertEqual((installed / 'references/guide.md').read_bytes(), reference.read_bytes())
        self.assertEqual((installed / 'run.sh').stat().st_mode & 0o777, 0o700)
        (installed / 'run.sh').chmod(0o600)
        with self.assertRaisesRegex(agent_config.SyncError, 'cache_modified'):
            self.sync()

    def test_concurrent_refresh_always_exposes_a_complete_snapshot(self):
        old = self.sync()
        (self.repo / 'AGENTS.md').write_text('Synthetic shared instructions v2.\n' * 10000)
        (self.repo / 'skills/example/references/guide.md').write_text('Synthetic reference v2.\n' * 10000)
        self.commit()
        unrelated = self.config / 'skills/unrelated'
        unrelated.mkdir(mode=0o700)
        (unrelated / 'keep').write_text('keep')
        observations = 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            calls = [pool.submit(self.sync) for _ in range(4)]
            while not all(call.done() for call in calls):
                repo = (self.store / 'current').resolve(strict=True)
                version = 'v1' if repo.parent.name == old['tree'] else 'v2'
                self.assertIn(version, (repo / 'AGENTS.md').read_text())
                self.assertIn(version, (repo / 'skills/example/references/guide.md').read_text())
                self.assertTrue((repo / 'skills/example/LICENSE').is_file())
                # Readers use the real global paths; each file/package must always be complete.
                self.assertIn((self.config / 'AGENTS.md').read_text(),
                              ('Synthetic shared instructions v1.\n', 'Synthetic shared instructions v2.\n' * 10000))
                reference = (self.config / 'skills/agent-config/example/references/guide.md').read_text()
                self.assertIn(reference, ('Synthetic reference v1.\n', 'Synthetic reference v2.\n' * 10000))
                observations += 1
                time.sleep(0.002)
            results = [call.result() for call in calls]
        self.assertGreater(observations, 0)
        self.assertTrue(all(result == results[0] for result in results))
        self.assertNotEqual(results[0]['tree'], old['tree'])
        self.assertEqual((unrelated / 'keep').read_text(), 'keep')
        self.assertFalse(list((self.store / 'snapshots').glob('.staging-*')))

    def test_publication_failure_restores_old_content_and_interrupted_publication_is_completed(self):
        from unittest.mock import patch
        first = self.sync()
        (self.repo / 'AGENTS.md').write_text('Complete new instructions\n')
        (self.repo / 'skills/example/references/guide.md').write_text('Complete new reference\n')
        self.commit()
        original = agent_config.publish_instruction

        def fail_new(path, repo):
            if repo.parent.name != first['tree']:
                raise OSError('synthetic publication failure')
            return original(path, repo)

        with patch.object(agent_config, 'publish_instruction', side_effect=fail_new), self.assertRaises(OSError):
            self.sync()
        self.assertEqual((self.config / 'AGENTS.md').read_text(), 'Synthetic shared instructions v1.\n')
        self.assertEqual((self.config / 'skills/agent-config/example/references/guide.md').read_text(), 'Synthetic reference v1.\n')
        new = next(p / 'repo' for p in (self.store / 'snapshots').iterdir() if p.name != first['tree'])
        # A killed publisher can leave two complete generations at the two load paths.
        # The next entry reconciles them under the same lock, without business task recovery.
        agent_config.replace_link(self.store / 'current', new.relative_to(self.store))
        self.repo.rename(self.base / 'offline-source')
        with contextlib.redirect_stderr(io.StringIO()):
            self.sync()
        self.assertEqual((self.config / 'AGENTS.md').read_text(), 'Complete new instructions\n')
        self.assertEqual((self.config / 'skills/agent-config/example/references/guide.md').read_text(), 'Complete new reference\n')
        self.assertFalse((self.root / 'runtime/tasks-v3').exists())

    def test_codex_uses_same_content_and_protects_existing_rules(self):
        codex = self.base / 'codex-home'
        codex.mkdir(mode=0o755)
        codex.chmod(0o755)
        (codex / 'skills').mkdir(mode=0o755)
        (codex / 'skills').chmod(0o755)
        self.sync(codex_home=codex)
        self.assertTrue((codex / 'AGENTS.md').samefile(self.config / 'AGENTS.md'))
        self.assertEqual((codex / 'skills/agent-config/example/references/guide.md').read_bytes(),
                         (self.repo / 'skills/example/references/guide.md').read_bytes())
        (codex / 'AGENTS.md').unlink()
        (codex / 'AGENTS.md').write_text('user codex rules')
        with self.assertRaisesRegex(agent_config.SyncError, 'target_conflict'):
            self.sync(codex_home=codex)
        self.assertEqual((codex / 'AGENTS.md').read_text(), 'user codex rules')
        (codex / 'AGENTS.md').unlink()
        (codex / 'AGENTS.override.md').write_text('user override')
        with self.assertRaisesRegex(agent_config.SyncError, 'target_conflict'):
            self.sync(codex_home=codex)
        self.assertEqual((codex / 'AGENTS.override.md').read_text(), 'user override')

    def test_network_deadline_kills_hanging_git_and_its_child(self):
        shim = Path(self.env['PATH'].split(':')[0]) / 'git'
        shim.write_text('#!/usr/bin/python3\nimport os,subprocess,time\nfrom pathlib import Path\n'
                        'child=subprocess.Popen(["/usr/bin/python3","-c","import time;time.sleep(30)"])\n'
                        f'Path({str(self.base / "pids")!r}).write_text(str(os.getpid())+" "+str(child.pid))\n'
                        'time.sleep(30)\n')
        from unittest.mock import patch
        start = time.monotonic()
        with patch.object(agent_config, 'NETWORK_SECONDS', 0.3), self.assertRaisesRegex(agent_config.SyncError, 'unavailable_no_cache'):
            self.sync()
        self.assertLess(time.monotonic() - start, 2)
        for pid in (self.base / 'pids').read_text().split():
            status = Path('/proc') / pid / 'stat'
            if status.exists():
                self.assertIn(status.read_text().split(') ', 1)[1].split()[0], ('Z', 'X'))

    def test_lock_wait_is_bounded_and_preserves_complete_cache(self):
        from unittest.mock import patch
        import fcntl
        first = self.sync()
        with (self.store / 'sync.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(agent_config, 'LOCK_SECONDS', 0.1), self.assertRaisesRegex(agent_config.SyncError, 'busy'):
                self.sync()
        self.assertEqual(agent_config.cached(self.store).parent.name, first['tree'])
        self.assertEqual((self.config / 'AGENTS.md').read_text(), 'Synthetic shared instructions v1.\n')


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.install()
        self.root = self.fixture.root
        self.env = {'PATH': str(self.fixture.git_bin) + ':/usr/bin:/bin'}

    def test_every_public_entry_syncs_before_routing_without_business_replay(self):
        # Each command gets a fresh center commit, including invalid/missing-record queries.
        entries = [('opencode-task', args) for args in ([], ['help'], ['--help'], ['--version'],
                   ['launch', '--help'], ['list'], ['status', 'missing'], ['result', 'missing'],
                   ['doctor'], ['doctor', '--quick'], ['recover', '--help'], ['cancel', '--help'])]
        entries += [('opencode', ['--version']), ('acpx', ['--version'])]
        tasks = self.root / 'runtime/tasks'
        tasks.mkdir(mode=0o700)
        (tasks / 'keep').write_bytes(b'old namespace')
        config = self.root / 'runtime/config/opencode/AGENTS.md'
        for index, (tool, args) in enumerate(entries):
            text = f'entry sync {index}\n'
            (self.fixture.config_repo / 'AGENTS.md').write_text(text)
            for command in (['add', '.'], ['commit', '-m', f'entry {index}']):
                subprocess.run(['/usr/bin/git', '-C', str(self.fixture.config_repo), *command], check=True, capture_output=True)
            subprocess.run([str(self.root / 'bin' / tool), *args], env=self.env, capture_output=True, timeout=10)
            self.assertEqual(config.read_text(), text, (tool, args))
            self.assertFalse((self.root / 'runtime/tasks-v3').exists(), (tool, args))
            self.assertFalse((self.root / 'runtime/module-profiles').exists())
            self.assertEqual((tasks / 'keep').read_bytes(), b'old namespace')

    def test_first_failure_stops_even_help_and_install_failure_preserves_previous_active(self):
        active = os.readlink(self.root / 'active')
        # A new release with an unreachable center can still use the old complete rules.
        self.fixture.config_repo.rename(self.fixture.base / 'offline-source')
        self.fixture.next_release()
        self.fixture.install()
        self.assertNotEqual(os.readlink(self.root / 'active'), active)
        shutil.rmtree(self.root / 'runtime/agent-config')
        (self.root / 'runtime/config/opencode/AGENTS.md').unlink()
        response = subprocess.run([str(self.root / 'bin/opencode-task'), '--help'], env=self.env, capture_output=True, text=True)
        self.assertEqual(response.returncode, 1)
        self.assertEqual(json.loads(response.stderr)['error']['reason'], 'unavailable_no_cache')
        self.assertEqual(response.stdout, '')
        active = os.readlink(self.root / 'active')
        with self.assertRaises(subprocess.CalledProcessError):
            self.fixture.install()
        self.assertEqual(os.readlink(self.root / 'active'), active)

    def test_reinitialization_preserves_updated_cache_sessions_tasks_and_unrelated_skills(self):
        config = self.root / 'runtime/config/opencode'
        unrelated = config / 'skills/personal'
        unrelated.mkdir(mode=0o700)
        (unrelated / 'SKILL.md').write_text('keep personal skill')
        for name in ('runtime/tasks/private', 'runtime/cache/private', 'runtime/home/.acpx/session'):
            path = self.root / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(b'private bytes')
        (self.fixture.config_repo / 'AGENTS.md').write_text('new shared instructions\n')
        for args in (['add', '.'], ['commit', '-m', 'new shared instructions']):
            subprocess.run(['/usr/bin/git', '-C', str(self.fixture.config_repo), *args], check=True, capture_output=True)
        result = subprocess.run([str(self.root / 'bin/opencode-task'), '--version'], env=self.env, capture_output=True)
        self.assertEqual(result.returncode, 0)
        current = os.readlink(self.root / 'runtime/agent-config/current')
        self.fixture.install()
        self.assertEqual(os.readlink(self.root / 'runtime/agent-config/current'), current)
        self.assertEqual((config / 'AGENTS.md').read_text(), 'new shared instructions\n')
        self.assertEqual((unrelated / 'SKILL.md').read_text(), 'keep personal skill')
        for name in ('runtime/tasks/private', 'runtime/cache/private', 'runtime/home/.acpx/session'):
            self.assertEqual((self.root / name).read_bytes(), b'private bytes')

    def test_public_sync_keeps_coder_ssh_identity_caller_home_and_path_without_leaking_stderr(self):
        executable = self.fixture.base / 'synthetic coder'
        record = self.fixture.base / 'ssh-call.json'
        secret = 'SYNTHETIC-SSH-STDERR-SECRET'
        executable.write_text('#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\n'
                              f'Path({str(record)!r}).write_text(json.dumps({{"argv":sys.argv[1:],"home":os.environ["HOME"],'
                              '"path":os.environ["PATH"],"socket":os.environ["SSH_AUTH_SOCK"]}))\n'
                              f'print({secret!r},file=sys.stderr)\nsys.exit(255)\n')
        executable.chmod(0o700)
        shim = self.fixture.git_bin / 'git'
        shim.write_text('#!/usr/bin/python3\nimport os,shlex,subprocess,sys\n'
                        'result=subprocess.run([*shlex.split(os.environ["GIT_SSH_COMMAND"]),"-p","2222",'
                        '"git@fixture.invalid","git-upload-pack /synthetic"]);sys.exit(result.returncode)\n')
        env = dict(self.env, HOME=str(self.fixture.home), SSH_AUTH_SOCK='/synthetic/coder/socket',
                   GIT_SSH_COMMAND=shlex.join([str(executable), 'gitssh', '--']))
        response = subprocess.run([str(self.root / 'bin/opencode-task'), '--version'], env=env,
                                  capture_output=True, text=True)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertIn('using complete cached', response.stderr)
        self.assertNotIn(secret, response.stdout + response.stderr)
        observed = json.loads(record.read_text())
        self.assertEqual(observed['argv'][:2], ['gitssh', '--'])
        self.assertIn('KnownHostsCommand=', ' '.join(observed['argv']))
        self.assertEqual(observed['home'], env['HOME'])
        self.assertEqual(observed['path'], env['PATH'])
        self.assertEqual(observed['socket'], env['SSH_AUTH_SOCK'])


if __name__ == '__main__':
    unittest.main()
