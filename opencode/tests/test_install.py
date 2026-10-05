"""Offline fixtures: real installer/wrappers; fake release, Node and npm executables."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('installer', SCRIPTS / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def payload():
    return {name: (SCRIPTS / name).read_text() for name in sorted(installer.PAYLOAD_FILES)}


def archive(path, files):
    with tarfile.open(path, 'w:gz') as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.mode = 0o755 if name.endswith(('opencode', 'node')) else 0o644
            data = content.encode()
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


def release(path, tag):
    program = '''#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:] == ['--version']:
    print('opencode TAG')
else:
    print(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd(),'env':dict(os.environ)}))
'''.replace('TAG', tag)
    meta = {'version': tag[1:], 'target': installer.TARGET, 'repository': 'Ricky-Hao/opencode',
            'source_tag': tag, 'source_dirty': False, 'source_commit': '1' * 40,
            'binary_sha256': hashlib.sha256(program.encode()).hexdigest()}
    archive(path, {'opencode': program, 'LICENSE': 'TEST FIXTURE ONLY', 'metadata.json': json.dumps(meta)})


def node(path):
    program = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
if sys.argv[1:] == ['--version']:
    print('v22.22.0')
elif sys.argv[1].endswith('npm-cli.js'):
    assert sys.argv[2:] == ['ci','--ignore-scripts','--no-audit','--no-fund']
    dest=Path('node_modules/acpx/dist');dest.mkdir(parents=True)
    (dest/'cli.js').write_text('fixture only')
elif sys.argv[-1] == '--version':
    print('0.19.3')
else:
    print(json.dumps({'argv':sys.argv[2:],'cwd':os.getcwd(),'env':dict(os.environ)}))
'''
    archive(path, {'node-v22.22.0-linux-x64/bin/node': program,
                   'node-v22.22.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js': 'fixture'})


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='offline-', dir=os.environ.get('TEST_TMP_ROOT'))
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'home'
        self.home.mkdir(mode=0o700)
        self.root = self.base / 'tool root with spaces'
        self.tar = self.base / 'release.tar.gz'
        self.node = self.base / 'node.tar.gz'
        release(self.tar, 'v2.0.19-ricky.1')
        node(self.node)
        self.bundle = {'files': payload(), 'config': {
            'install_root': str(self.root), 'workspace_id': 'test-workspace',
            'release_tag': 'v2.0.19-ricky.1',
            'release_asset': 'opencode-linux-x64-baseline-v2.0.19-ricky.1.tar.gz',
            'release_sha256': installer.digest(self.tar), 'runtime_profile': 'none',
            'runtime_env_allowlist': ['TEST_PROVIDER_KEY']}}
        self.downloads = 0
        self.original_run = subprocess.run

    def fixture_run(self, argv, **kwargs):
        if argv[0] == 'curl':
            self.downloads += 1
            source = self.node if 'nodejs.org' in argv[-3] else self.tar
            shutil.copyfile(source, argv[-1])
            return subprocess.CompletedProcess(argv, 0)
        return self.original_run(argv, **kwargs)

    @contextlib.contextmanager
    def fixtures(self):
        with patch.dict(os.environ, {'HOME': str(self.home), 'PATH': '/usr/bin:/bin'}, clear=True), \
                patch.object(installer, 'NODE_SHA256', installer.digest(self.node)), \
                patch.object(installer.subprocess, 'run', side_effect=self.fixture_run):
            yield

    def install(self):
        with self.fixtures():
            installer.install(self.bundle)

    def next_release(self):
        config = self.bundle['config']
        config['release_tag'] = 'v2.0.19-ricky.2'
        config['release_asset'] = 'opencode-linux-x64-baseline-v2.0.19-ricky.2.tar.gz'
        release(self.tar, config['release_tag'])
        config['release_sha256'] = installer.digest(self.tar)

    def test_success_cache_reuse_and_private_permissions(self):
        self.install()
        active = os.readlink(self.root / 'active')
        self.assertEqual(self.downloads, 2)
        self.install()
        self.assertEqual(self.downloads, 2)
        self.assertEqual(os.readlink(self.root / 'active'), active)
        self.assertEqual(json.loads((self.root / 'status.json').read_text())['state'], 'ready')
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        for name in ('opencode', 'acpx'):
            self.assertFalse((self.root / 'bin' / name).is_symlink())
        cfg = json.loads((self.root / 'runtime/home/.acpx/config.json').read_text())
        self.assertEqual(cfg['defaultPermissions'], 'deny-all')
        self.assertEqual(cfg['nonInteractivePermissions'], 'deny')

    def test_checksum_mismatch_preserves_active(self):
        self.install()
        active = os.readlink(self.root / 'active')
        self.next_release()
        self.bundle['config']['release_sha256'] = '0' * 64  # Deliberately invalid offline fixture input.
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.install()
        self.assertEqual(os.readlink(self.root / 'active'), active)
        self.assertEqual(json.loads((self.root / 'status.json').read_text())['state'], 'failed')

    def test_sigterm_during_install_preserves_active_and_nonzero(self):
        self.install()
        active = os.readlink(self.root / 'active')
        self.next_release()
        original = self.fixture_run

        def interrupted(argv, **kwargs):
            if len(argv) > 1 and str(argv[1]).endswith('npm-cli.js'):
                os.kill(os.getpid(), signal.SIGTERM)
            return original(argv, **kwargs)

        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            with self.fixtures(), patch.object(installer, 'BUNDLE', self.bundle, create=True), \
                    patch.object(installer.subprocess, 'run', side_effect=interrupted):
                self.assertEqual(installer.main(), 1)
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
        self.assertEqual(os.readlink(self.root / 'active'), active)
        self.assertEqual(json.loads((self.root / 'status.json').read_text())['error'], 'InterruptedError')
        self.assertFalse(list((self.root / 'versions').glob('.staging-*')))

    def test_runtime_argv_cwd_path_env_and_no_credential_serialization(self):
        sentinel = 'NOT-A-REAL-CREDENTIAL-DO-NOT-PERSIST'
        with patch.dict(os.environ, {'CODER_AGENT_TOKEN': sentinel, 'GITHUB_TOKEN': sentinel, 'TEST_PROVIDER_KEY': sentinel}):
            self.install()
        project = self.base / 'project space'
        project.mkdir()
        config = project / 'selected.json'
        config.write_text(json.dumps({'model': {'providerID': 'fixture', 'model': 'chosen', 'variant': 'test'},
                                      'providers': {'fixture': {'options': {'apiKey': '{env:TEST_PROVIDER_KEY}'}}}}))
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(project),
               'VIRTUAL_ENV': '/project/.venv', 'TEST_PROVIDER_KEY': sentinel,
               'CODER_AGENT_TOKEN': sentinel, 'GITHUB_TOKEN': sentinel, 'SSH_AUTH_SOCK': '/secret/socket',
               'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': sentinel,
               'OPENCODE_MODULE_CONFIG': str(config), 'OPENCODE_CONFIG_CONTENT': sentinel}
        for tool in ('opencode', 'acpx'):
            args = ['argument with spaces', "'quoted'", '$HOME', '--flag=value']
            result = self.original_run([str(self.root / 'bin' / tool), *args], cwd=project,
                                       env=env, capture_output=True, text=True, check=True)
            actual = json.loads(result.stdout)
            defaults = ['--deny-all', '--non-interactive-permissions', 'deny'] if tool == 'acpx' else []
            self.assertEqual(actual['argv'], defaults + args)
            self.assertEqual(actual['cwd'], str(project))
            child = actual['env']
            self.assertEqual(child['PATH'], env['PATH'])
            self.assertEqual(child['VIRTUAL_ENV'], env['VIRTUAL_ENV'])
            self.assertEqual(child['TEST_PROVIDER_KEY'], sentinel)
            self.assertEqual(child['OPENCODE_ACP_REQUIRED_MODEL'], 'fixture/chosen')
            self.assertEqual(child['OPENCODE_ACP_REQUIRED_VARIANT'], 'test')
            self.assertEqual(child['OPENCODE_CONFIG'], str(config))
            for key in ('CODER_AGENT_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_CONFIG_COUNT', 'OPENCODE_CONFIG_CONTENT'):
                self.assertNotIn(key, child)
            self.assertEqual(child['HOME'], str(self.root / 'runtime/home'))
        for path in self.root.rglob('*'):
            if path.is_file():
                self.assertNotIn(sentinel.encode(), path.read_bytes(), str(path))

    def test_acp_without_explicit_model_fails_before_execution(self):
        self.install()
        result = self.original_run([str(self.root / 'bin/opencode'), 'acp'], env={'PATH': '/usr/bin:/bin'},
                                   capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_wrapper_path_is_not_shell_expanded(self):
        self.root = self.base / "private space ' $HOME $(false)"
        self.bundle['config']['install_root'] = str(self.root)
        self.install()
        result = self.original_run([str(self.root / 'bin/opencode'), '--version'],
                                   env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), 'opencode v2.0.19-ricky.1')

    def test_string_model_variant_and_explicit_permission_opt_in(self):
        self.install()
        config = self.base / 'model.json'
        config.write_text(json.dumps({'model': 'fixture/chosen#test'}))
        env = {'PATH': '/usr/bin:/bin', 'OPENCODE_MODULE_CONFIG': str(config)}
        args = ['--approve-all', '--non-interactive-permissions=fail', 'arbitrary argument']
        result = self.original_run([str(self.root / 'bin/acpx'), *args], env=env,
                                   capture_output=True, text=True, check=True)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['argv'], args)
        self.assertEqual(actual['env']['OPENCODE_ACP_REQUIRED_MODEL'], 'fixture/chosen')
        self.assertEqual(actual['env']['OPENCODE_ACP_REQUIRED_VARIANT'], 'test')

    def test_unsupported_platform_status(self):
        with patch.object(installer.platform, 'machine', return_value='aarch64'):
            with self.assertRaises(installer.UnsupportedPlatform):
                self.install()
        self.assertFalse((self.root / 'active').exists())
        self.assertEqual(self.downloads, 0)
        self.assertEqual(json.loads((self.root / 'status.json').read_text())['state'], 'failed')

    def test_foreign_root_symlink_and_global_paths(self):
        self.root.mkdir(mode=0o700)
        (self.root / 'unrelated').write_text('leave intact')
        with self.assertRaisesRegex(ValueError, 'foreign'):
            self.install()
        self.assertEqual(list(self.root.iterdir()), [self.root / 'unrelated'])
        self.root.rename(self.base / 'foreign')
        self.root.symlink_to(self.base / 'foreign')
        with self.assertRaises(ValueError):
            self.install()
        for path in ('/usr/local/bin/opencode', '/etc/opencode', '/opt/opencode'):
            config = dict(self.bundle['config'], install_root=path)
            with self.assertRaisesRegex(ValueError, 'global'):
                installer.validate(config)

    def test_foreign_wrapper_and_workspace_identity(self):
        self.install()
        active = os.readlink(self.root / 'active')
        (self.root / 'bin/opencode').write_text('foreign command')
        with self.assertRaisesRegex(ValueError, 'another installation'):
            self.install()
        self.assertEqual(os.readlink(self.root / 'active'), active)
        self.bundle['config']['workspace_id'] = 'different-workspace'
        with self.assertRaisesRegex(ValueError, 'different UID or workspace'):
            self.install()

    @unittest.skipUnless(os.getuid() == 0, 'foreign UID creation requires disposable root test')
    def test_foreign_uid_not_adopted(self):
        self.root.mkdir(mode=0o700)
        os.chown(self.root, 65534, 65534)
        try:
            with self.assertRaisesRegex(ValueError, 'owned by this UID'):
                self.install()
            self.assertEqual(self.root.stat().st_uid, 65534)
        finally:
            os.chown(self.root, 0, 0)

    def test_cache_tamper_fails_without_download(self):
        self.install()
        (self.root / 'active/opencode').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'cached installation'):
            self.install()
        self.assertEqual(self.downloads, 2)

    def test_lock_excludes_second_writer(self):
        self.install()
        with (self.root / 'install.lock').open('r') as lock:
            installer.fcntl.flock(lock, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.install()
        self.assertEqual(self.downloads, 2)

    def test_archive_traversal_links_and_special_files(self):
        for kind in ('traversal', 'absolute', 'symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                path = self.base / (kind + '.tar.gz')
                dest = self.base / kind
                dest.mkdir()
                with tarfile.open(path, 'w:gz') as tar:
                    member = tarfile.TarInfo({'traversal': '../outside', 'absolute': '/outside'}.get(kind, 'link'))
                    if kind in ('symlink', 'hardlink', 'fifo'):
                        member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE}[kind]
                        member.linkname = '../outside'
                    tar.addfile(member)
                with self.assertRaises(ValueError):
                    installer.extract(path, dest)
                self.assertFalse((self.base / 'outside').exists())


if __name__ == '__main__':
    unittest.main()
