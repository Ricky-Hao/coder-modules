"""Synthetic keys and loopback only; no account credentials or remote hosts."""
import contextlib
import io
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import git_ssh
import runtime
import safety
import test_install as fixtures

try:
    import paramiko
except ImportError:
    paramiko = None


class GitTrustTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='module-git-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "toolset space ' %"
        (self.root / 'runtime').mkdir(parents=True, mode=0o700)
        safety.git_trust(self.root, 'fixture')
        self.store = self.root / 'runtime/git'

    def remember(self, host, key):
        with contextlib.redirect_stdout(io.StringIO()):
            git_ssh.remember(self.store, 'HOSTNAME', host, 'ssh-ed25519', key)

    def test_first_changed_key_alias_and_other_hosts_preserved_atomically(self):
        self.remember('[fixture.invalid]:2222', 'A' * 44)
        self.remember('other.invalid', 'B' * 44)
        self.remember('[fixture.invalid]:2222', 'C' * 44)
        file = self.store / 'known_hosts'
        self.assertEqual(file.read_text(), f'other.invalid ssh-ed25519 {"B" * 44}\n[fixture.invalid]:2222 ssh-ed25519 {"C" * 44}\n')
        before = file.read_bytes()
        safety.git_trust(self.root, 'fixture')
        self.assertEqual(file.read_bytes(), before)
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(file.stat().st_nlink, 1)
        self.assertFalse(list(self.store.glob('.host-*')))
        with self.assertRaises(ValueError):
            self.remember('invalid host', 'C' * 44)

    def test_identity_and_arguments_are_preserved_and_failures_do_not_retry(self):
        fake = self.base / 'coder-gitssh'
        log = self.base / 'args.json'
        fake.write_text('#!/usr/bin/python3\nimport json, sys\nfrom pathlib import Path\n'
                        f'p=Path({str(log)!r}); assert not p.exists(); p.write_text(json.dumps(sys.argv[1:]))\n'
                        'print("PRIVATE-AUTH-URL-KEY", file=sys.stderr)\nsys.exit(17)\n')
        fake.chmod(0o700)
        env = {git_ssh.BASE: shlex.join([str(fake), '--identity', 'synthetic-identity', '--', '-o', 'ForwardAgent=no']), 'PATH': '/usr/bin:/bin'}
        arguments = ['-p', '2222', '-o', 'HostKeyAlias=alias.invalid', '-o', 'StrictHostKeyChecking=accept-new',
                     '-o', 'UserKnownHostsFile=/explicit', 'user@fixture.invalid', 'git-upload-pack repo']
        response = subprocess.run(['python3', '-B', git_ssh.__file__, str(self.store), *arguments], env=env, capture_output=True, text=True)
        self.assertEqual(response.returncode, 17)
        actual = json.loads(log.read_text())
        self.assertEqual(actual[:5], ['--identity', 'synthetic-identity', '--', '-o', 'ForwardAgent=no'])
        self.assertEqual(actual[-len(arguments):], arguments)
        self.assertEqual(response.stderr, 'OPENCODE_GIT_SSH_FAILED\n')
        for options in [['-o', 'UpdateHostKeys=yes'], ['-oVerifyHostKeyDNS=yes'], ['-o', 'KnownHostsCommand=custom']]:
            result = subprocess.run(['python3', '-B', git_ssh.__file__, str(self.store), *options, 'fixture.invalid'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 255)
            self.assertEqual(result.stderr, 'OPENCODE_GIT_SSH_OPTIONS_UNSUPPORTED\n')
        first = git_ssh.environment({'GIT_SSH_COMMAND': env[git_ssh.BASE], 'PATH': '/inherited'}, self.root, Path(git_ssh.__file__).parent)
        second = git_ssh.environment(first, self.root, Path(git_ssh.__file__).parent)
        self.assertEqual(first, second)
        self.assertEqual(second['PATH'], '/inherited')

    def test_permission_entry_defaults_explicit_and_saved_choices(self):
        self.assertEqual(runtime.acpx_arguments(['opencode', 'exec', 'fixture'])[:3], ['--approve-all', '--non-interactive-permissions', 'deny'])
        self.assertEqual(runtime.acpx_arguments(['--deny-all', 'opencode'])[-2:], ['--deny-all', 'opencode'])
        self.assertEqual(runtime.opencode_arguments(['run', 'fixture']), ['run', '--auto', 'fixture'])
        for arguments in [['run', '--auto=false', 'fixture'], ['run', '--no-auto'], ['run', '--session=old'], ['run', '--continue'], ['run', '--continue=true'], ['run', '-s=old'], ['acp'], []]:
            self.assertEqual(runtime.opencode_arguments(arguments), arguments)

    def test_install_cache_preserves_trust_and_old_tasks_without_scanning(self):
        fixture = fixtures.InstallerTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.install()
        root = fixture.root
        store = root / 'runtime/git'
        with contextlib.redirect_stdout(io.StringIO()):
            git_ssh.remember(store, 'HOSTNAME', 'fixture.invalid', 'ssh-ed25519', 'A' * 44)
        old = root / 'runtime/tasks'; old.mkdir(mode=0o700)
        file = old / 'private-old'; file.write_text('old task not scanned')
        before = (store / 'known_hosts').read_bytes()
        config = root / 'runtime/home/.acpx/config.json'
        saved = json.loads(config.read_text()); saved['defaultPermissions'] = 'deny-all'; config.write_text(json.dumps(saved))
        fixture.install()
        self.assertEqual((store / 'known_hosts').read_bytes(), before)
        self.assertEqual(file.read_text(), 'old task not scanned')
        self.assertEqual(json.loads(config.read_text())['defaultPermissions'], 'deny-all')
        self.assertFalse((root / 'runtime/tasks-v3').exists())

    @unittest.skipUnless(paramiko, 'optional native OpenSSH loopback fixture needs paramiko')
    def test_native_openssh_accepts_first_and_changed_key_for_actual_port_and_alias(self):
        # Keys exist only in memory. Authentication deliberately fails after host
        # verification, proving trust changes do not convert auth denial to success.
        class Server(paramiko.ServerInterface):
            def check_auth_none(self, username):
                return paramiko.AUTH_FAILED

        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        env = {'PATH': '/usr/bin:/bin', git_ssh.BASE: 'ssh'}
        for alias in (None, 'fixture-alias'):
            keys = []
            caller_file = self.base / 'caller_known_hosts'
            for _ in range(2):
                key = paramiko.RSAKey.generate(2048); keys.append(key.get_base64())
                target = alias or f'[127.0.0.1]:{port}'
                if len(keys) == 1:
                    caller_file.write_text(f'{target} ssh-rsa {key.get_base64()}\nother.invalid ssh-ed25519 {"A" * 44}\n')
                saved_caller = caller_file.read_bytes()
                def serve():
                    connection, _ = listener.accept()
                    transport = paramiko.Transport(connection)
                    try:
                        transport.add_server_key(key); transport.start_server(server=Server())
                        transport.accept(3)
                    except (EOFError, paramiko.SSHException):
                        pass
                    finally:
                        transport.close()
                thread = threading.Thread(target=serve); thread.start()
                args = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', str(port)]
                if alias:
                    args += ['-o', 'HostKeyAlias=' + alias, '-o', 'UserKnownHostsFile=' + str(caller_file),
                             '-o', 'StrictHostKeyChecking=accept-new']
                result = subprocess.run(['python3', '-B', git_ssh.__file__, str(self.store), *args, '127.0.0.1'], env=env, capture_output=True, text=True, timeout=8)
                thread.join(5); self.assertFalse(thread.is_alive())
                self.assertEqual(result.returncode, 255)
                self.assertEqual(result.stderr, 'OPENCODE_GIT_SSH_FAILED\n')
                records = (self.store / 'known_hosts').read_text()
                self.assertEqual(caller_file.read_bytes(), saved_caller)
                self.assertIn(key.get_base64(), records)
                self.assertIn(target + ' ssh-rsa ', records)
            self.assertNotIn(keys[0], (self.store / 'known_hosts').read_text())


if __name__ == '__main__':
    unittest.main()
