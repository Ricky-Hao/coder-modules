"""Synthetic keys and loopback only; no account credentials or remote hosts."""
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

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
        self.root = self.base / "toolset space ' % ${HOME}"
        (self.root / 'runtime').mkdir(parents=True, mode=0o700)
        safety.git_trust(self.root, 'fixture')
        self.store = self.root / 'runtime/git'
        self.version = self.root / 'version'; self.version.mkdir(mode=0o700)
        for name in ('git_ssh.py', 'safety.py'):
            shutil.copyfile(Path(git_ssh.__file__).parent / name, self.version / name)
        self.script = str(self.version / 'git_ssh.py')

    def hostfile(self, host):
        return self.store / (hashlib.sha256(host.encode()).hexdigest() + '.host')

    def records(self):
        return ''.join(file.read_text() for file in self.store.glob('*.host'))

    def remember(self, host, key):
        with contextlib.redirect_stdout(io.StringIO()):
            git_ssh.remember(self.store, 'HOSTNAME', host, 'ssh-ed25519', key)

    def test_first_changed_key_alias_and_other_hosts_preserved_atomically(self):
        self.remember('[fixture.invalid]:2222', 'A' * 44)
        self.remember('other.invalid', 'B' * 44)
        self.remember('[fixture.invalid]:2222', 'C' * 44)
        file = self.hostfile('[fixture.invalid]:2222')
        self.assertEqual(file.read_text(), f'[fixture.invalid]:2222 ssh-ed25519 {"C" * 44}\n')
        self.assertEqual(self.hostfile('other.invalid').read_text(), f'other.invalid ssh-ed25519 {"B" * 44}\n')
        before = file.read_bytes()
        safety.git_trust(self.root, 'fixture')
        self.assertEqual(file.read_bytes(), before)
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(file.stat().st_nlink, 1)
        self.assertFalse(list(self.store.glob('.host-*')))
        with self.assertRaises(ValueError):
            self.remember('invalid host', 'C' * 44)

    def test_concurrent_hosts_keep_both_records_without_read_modify_write(self):
        barrier = threading.Barrier(2); replace = os.replace
        def paused_replace(source, target):
            barrier.wait(5)
            return replace(source, target)
        with contextlib.redirect_stdout(io.StringIO()), patch.object(git_ssh.os, 'replace', paused_replace), ThreadPoolExecutor(2) as pool:
            results = [pool.submit(git_ssh.remember, self.store, 'HOSTNAME', host, 'ssh-ed25519', 'A' * 44)
                       for host in ('host-a.invalid', 'host-b.invalid')]
            for result in results:
                result.result(5)
        self.assertTrue(all(self.hostfile(host).exists() for host in ('host-a.invalid', 'host-b.invalid')))

    def test_identity_and_arguments_are_preserved_and_failures_do_not_retry(self):
        fake = self.base / 'coder-gitssh'
        log = self.base / 'args.json'
        fake.write_text('#!/usr/bin/python3\nimport json, sys\nfrom pathlib import Path\n'
                        f'p=Path({str(log)!r}); assert not p.exists(); p.write_text(json.dumps(sys.argv[1:]))\n'
                        'print("PRIVATE-AUTH-URL-KEY", file=sys.stderr)\nsys.exit(17)\n')
        fake.chmod(0o700)
        env = {git_ssh.BASE: shlex.join([str(fake), 'gitssh', '--']), 'PATH': '/usr/bin:/bin'}
        arguments = ['-p', '2222', '-o', 'HostKeyAlias=alias.invalid', '-o', 'StrictHostKeyChecking=accept-new',
                     '-o', 'UserKnownHostsFile=/explicit', 'user@fixture.invalid', 'git-upload-pack repo']
        response = subprocess.run(['python3', '-B', self.script, str(self.store), *arguments], env=env, capture_output=True, text=True)
        self.assertEqual(response.returncode, 17)
        actual = json.loads(log.read_text())
        self.assertEqual(actual[:2], ['gitssh', '--'])
        self.assertEqual(actual[-len(arguments):], arguments)
        self.assertEqual(response.stderr, 'OPENCODE_GIT_SSH_FAILED\n')
        for options in [['-o', 'UpdateHostKeys=yes'], ['-oVerifyHostKeyDNS=yes'], ['-o', 'KnownHostsCommand=custom'],
                        ['-voKnownHostsCommand=custom'], ['-vvo', 'UpdateHostKeys=yes']]:
            result = subprocess.run(['python3', '-B', self.script, str(self.store), *options, 'fixture.invalid'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 255)
            self.assertEqual(result.stderr, 'OPENCODE_GIT_SSH_OPTIONS_UNSUPPORTED\n')
        first = git_ssh.environment({'GIT_SSH_COMMAND': env[git_ssh.BASE], 'PATH': '/inherited'}, self.root)
        second = git_ssh.environment(first, self.root)
        self.assertEqual(first, second)
        self.assertEqual(second['PATH'], '/inherited')
        words, explicit = git_ssh.validate_options('ssh -vi synthetic-key', ['-voStrictHostKeyChecking=accept-new', 'fixture.invalid'])
        self.assertEqual(words, ['ssh', '-vi', 'synthetic-key']); self.assertIn('stricthostkeychecking', explicit)
        self.assertEqual(git_ssh.validate_options('ssh -i private#key', [])[0], ['ssh', '-i', 'private#key'])
        for base in ('ssh;exit 0', 'ssh $(unexpected)', 'ssh -i $PRIVATE', 'ssh | other',
                     'ssh & other', 'wrapper --identity unknown', 'ssh -i ~/private', 'ssh -i private*'):
            with self.assertRaises(ValueError):
                git_ssh.validate_options(base, ['fixture.invalid'])

    def test_git_preserves_injected_identity_and_refuses_implicit_config_fallback(self):
        repo = self.base / 'repo'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        fake, log = self.base / 'ssh', self.base / 'identity.json'
        fake.write_text('#!/usr/bin/python3\nimport json,sys,os\nfrom pathlib import Path\n'
                        f'Path({str(log)!r}).write_text(json.dumps({{"args":sys.argv[1:],"cwd":os.getcwd()}}))\nsys.exit(17)\n')
        fake.chmod(0o700)
        command = lambda name: shlex.join([str(fake), '-i', name])
        subprocess.run(['git', '-C', str(repo), 'config', 'core.sshCommand', command('config-identity')], check=True)
        env = git_ssh.environment({'PATH': '/usr/bin:/bin', 'GIT_SSH_VARIANT': 'ssh', 'GIT_SSH_COMMAND': command('env-identity')}, self.root)
        result = subprocess.run(['git', '-C', str(repo), '-c', 'core.sshCommand=must-not-replace-injected-identity',
                                 'ls-remote', 'ssh://fixture.invalid/repo'], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        actual = json.loads(log.read_text())
        self.assertEqual(actual['args'][:2], ['-i', 'env-identity']); self.assertEqual(actual['cwd'], str(repo))
        log.unlink()
        implicit = git_ssh.environment({'PATH': '/usr/bin:/bin', 'GIT_SSH_VARIANT': 'ssh'}, self.root)
        result = subprocess.run(['git', '-C', str(repo), 'ls-remote', 'ssh://fixture.invalid/repo'], env=implicit, capture_output=True)
        self.assertNotEqual(result.returncode, 0); self.assertFalse(log.exists())
        self.assertIn(b'OPENCODE_GIT_SSH_OPTIONS_UNSUPPORTED', result.stderr)

    def test_permission_entry_defaults_explicit_and_saved_choices(self):
        self.assertEqual(runtime.acpx_arguments(['opencode', 'exec', 'fixture'])[:3], ['--approve-all', '--non-interactive-permissions', 'deny'])
        self.assertEqual(runtime.acpx_arguments(['--deny-all', 'opencode'])[-2:], ['--deny-all', 'opencode'])
        self.assertEqual(runtime.opencode_arguments(['run', 'fixture']), ['run', '--auto', 'fixture'])
        for arguments in [['run', '--auto=false', 'fixture'], ['run', '--no-auto'], ['run', '--session=old'], ['run', '--continue'], ['run', '--continue=true'], ['run', '-s=old'], ['acp'], []]:
            self.assertEqual(runtime.opencode_arguments(arguments), arguments)

    def test_certificate_hook_defers_to_native_validation_without_record(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            git_ssh.remember(self.store, 'HOSTNAME', 'fixture.invalid', 'ssh-rsa-cert-v01@openssh.com', 'synthetic-certificate')
        self.assertEqual(output.getvalue(), '')
        self.assertFalse(list(self.store.glob('*.host')))

    def test_install_cache_preserves_trust_and_old_tasks_without_scanning(self):
        fixture = fixtures.InstallerTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.install()
        root = fixture.root
        store = root / 'runtime/git'
        with contextlib.redirect_stdout(io.StringIO()):
            git_ssh.remember(store, 'HOSTNAME', 'fixture.invalid', 'ssh-ed25519', 'A' * 44)
        old = root / 'runtime/tasks'; old.mkdir(mode=0o700)
        old_file = old / 'private-old'; old_file.write_text('old task not scanned')
        trust_file = store / (hashlib.sha256(b'fixture.invalid').hexdigest() + '.host')
        before = trust_file.read_bytes()
        config = root / 'runtime/home/.acpx/config.json'
        saved = json.loads(config.read_text()); saved['defaultPermissions'] = 'deny-all'; config.write_text(json.dumps(saved))
        fixture.install()
        self.assertEqual(trust_file.read_bytes(), before)
        self.assertEqual(old_file.read_text(), 'old task not scanned')
        self.assertEqual(json.loads(config.read_text())['defaultPermissions'], 'deny-all')
        self.assertFalse((root / 'runtime/tasks-v3').exists())

    @unittest.skipUnless(paramiko, 'optional native OpenSSH loopback fixture needs paramiko')
    def test_native_openssh_trusted_host_certificate_still_reaches_auth(self):
        ca = self.base / 'ca'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ca)], check=True)
        class CertificateKey(paramiko.RSAKey):
            def asbytes(self):
                return self.public_blob.key_blob
        raw = paramiko.RSAKey.generate(2048)
        public = self.base / 'host.pub'; public.write_text('ssh-rsa ' + raw.get_base64() + '\n')
        subprocess.run(['ssh-keygen', '-q', '-s', str(ca), '-I', 'fixture', '-h', '-n', 'fixture-cert', '-V', '-1m:+1h', str(public)], check=True)
        certificate = CertificateKey(key=raw.key); certificate.load_certificate(str(self.base / 'host-cert.pub'))
        known = self.base / 'ca_known_hosts'; known.write_text('@cert-authority fixture-cert ' + (self.base / 'ca.pub').read_text())
        auth = threading.Event()
        class Server(paramiko.ServerInterface):
            def check_auth_none(self, username):
                auth.set(); return paramiko.AUTH_FAILED
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
        self.addCleanup(listener.close)
        def serve():
            connection, _ = listener.accept(); transport = paramiko.Transport(connection)
            try:
                algorithm = 'rsa-sha2-512-cert-v01@openssh.com'
                transport._preferred_keys = (algorithm,)
                transport.server_key_dict[algorithm] = certificate
                transport.start_server(server=Server()); transport.accept(3)
            except (EOFError, paramiko.SSHException):
                pass
            finally:
                transport.close()
        worker = threading.Thread(target=serve); worker.start()
        result = subprocess.run(['python3', '-B', self.script, str(self.store), '-F', '/dev/null', '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=3', '-o', 'HostKeyAlias=fixture-cert', '-o', 'UserKnownHostsFile=' + str(known),
            '-o', 'StrictHostKeyChecking=yes', '-p', str(listener.getsockname()[1]), '127.0.0.1'],
            env={'PATH': '/usr/bin:/bin', git_ssh.BASE: 'ssh'}, capture_output=True, text=True, timeout=8)
        worker.join(5); self.assertFalse(worker.is_alive())
        self.assertTrue(auth.is_set(), result.stderr)
        self.assertEqual(result.returncode, 255); self.assertEqual(result.stderr, 'OPENCODE_GIT_SSH_FAILED\n')
        self.assertFalse(list(self.store.glob('*.host')))

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
                result = subprocess.run(['python3', '-B', self.script, str(self.store), *args, '127.0.0.1'], env=env, capture_output=True, text=True, timeout=8)
                thread.join(5); self.assertFalse(thread.is_alive())
                self.assertEqual(result.returncode, 255)
                self.assertEqual(result.stderr, 'OPENCODE_GIT_SSH_FAILED\n')
                records = self.records()
                self.assertEqual(caller_file.read_bytes(), saved_caller)
                self.assertIn(key.get_base64(), records)
                self.assertIn(target + ' ssh-rsa ', records)
            self.assertNotIn(keys[0], self.records())


if __name__ == '__main__':
    unittest.main()
