"""Module env-profile regression. All credentials/endpoints are synthetic."""
import copy
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_install as fixtures

sys.path.insert(0, str(fixtures.SCRIPTS))
import profiles


def concurrent_profile_launch(root, config, creator, created, resume, observations, results):
    """Pause A after mkdir; observe B's real lock attempt without sleeps/retries."""
    mkdir, flock = Path.mkdir, profiles.fcntl.flock

    def paused_mkdir(path, *args, **kwargs):
        result = mkdir(path, *args, **kwargs)
        if path == root / 'runtime/module-profiles':
            created.set()
            if not resume.wait(10):
                raise TimeoutError('creator was not resumed')
        return result

    def observed_flock(fd, operation):
        try:
            flock(fd, operation | profiles.fcntl.LOCK_NB)
        except BlockingIOError:
            observations.put('blocked')
            return flock(fd, operation)
        observations.put('acquired')

    try:
        with patch.object(Path, 'mkdir', paused_mkdir if creator else mkdir), patch.object(
                profiles.fcntl, 'flock', flock if creator else observed_flock):
            path = profiles.materialize(root, 'test-workspace', config)
        results.put(('ok', str(path)))
    except Exception as error:
        results.put(('error', type(error).__name__))


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.base = self.fixture.base
        self.fixture.bundle['config']['runtime_profile'] = 'env'
        self.env = {'PATH': '/usr/bin:/bin', 'LLM_BASE_URL': 'https://llm.example.invalid/v1',
                    'LLM_API_KEY': 'SENTINEL-LLM-NEVER-IN-FILES',
                    'CODER_AGENT_TOKEN': 'SENTINEL-CODER', 'GITHUB_TOKEN': 'SENTINEL-GIT',
                    'SSH_AUTH_SOCK': '/synthetic/socket', 'OPENCODE_CONFIG_CONTENT': 'SENTINEL-OVERRIDE'}

    def call(self, tool='opencode', args=None, env=None):
        return subprocess.run([str(self.root / 'bin' / tool), *(args if args is not None else ['acp'])],
                              env=self.env if env is None else env, cwd=self.base,
                              capture_output=True, text=True)

    def enable(self, name):
        self.env.update({name + '_MCP_ENABLED': '1', name + '_MCP_URL': 'http://mcp.example.invalid/mcp',
                         name + '_MCP_API_KEY': 'SENTINEL-' + name})

    def no_serialized_values(self):
        forbidden = [v.encode() for k, v in self.env.items()
                     if k.endswith(('API_KEY', 'TOKEN', '_URL')) or k == 'OPENCODE_CONFIG_CONTENT']
        for path in self.root.rglob('*'):
            if path.is_file():
                for value in forbidden:
                    self.assertNotIn(value, path.read_bytes(), path.name)

    def test_full_snapshot_catalog_and_policy(self):
        cfg = json.loads((fixtures.SCRIPTS / 'profile-env.json').read_text())
        self.assertEqual(hashlib.sha256(json.dumps(cfg['providers']['copilot']['models'], sort_keys=True).encode()).hexdigest(),
                         '0c04351f5ad2436498e638cffd04d1e10599e26ff6a24419dc31978ec2b40f3d')
        self.assertEqual(len(cfg['providers']['copilot']['models']), 9)
        self.assertEqual(cfg['compaction'], {'buffer': 13600})
        self.assertEqual(cfg['experimental']['policies'], [
            {'action': 'provider.use', 'resource': '*', 'effect': 'deny'},
            {'action': 'provider.use', 'resource': 'copilot', 'effect': 'allow'}])

    def test_default_profile_launch_and_idempotent_private_config(self):
        self.fixture.install()
        self.assertFalse((self.root / 'runtime/module-profiles').exists())
        self.env['FIRECRAWL_MCP_API_KEY'] = 'SENTINEL-DISABLED'
        self.env['FIRECRAWL_MCP_URL'] = 'not even a valid URL while disabled'
        result = self.call(args=['run', 'argument with spaces', '', '$HOME', "a'b"])
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        child = actual['env']
        self.assertEqual(actual['argv'], ['run', 'argument with spaces', '', '$HOME', "a'b"])
        self.assertEqual(actual['cwd'], str(self.base))
        self.assertEqual(child['PATH'], self.env['PATH'])
        self.assertEqual(child['LLM_API_KEY'], self.env['LLM_API_KEY'])
        self.assertEqual(child['OPENCODE_ACP_REQUIRED_MODEL'], 'copilot/gpt-6-astra')
        self.assertEqual(child['OPENCODE_ACP_REQUIRED_VARIANT'], 'medium')
        self.assertEqual(child['OPENCODE_ACP_CATALOG_TIMEOUT_MS'], '30000')
        for name in ('FIRECRAWL_MCP_API_KEY', 'FIRECRAWL_MCP_URL', 'CODER_AGENT_TOKEN',
                     'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'OPENCODE_CONFIG_CONTENT'):
            self.assertNotIn(name, child)
        path = Path(child['OPENCODE_CONFIG'])
        self.assertEqual(path.parent, self.root / 'runtime/module-profiles')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        cfg = json.loads(path.read_text())
        self.assertEqual(cfg['mcp']['servers'], {})
        self.assertEqual(cfg['providers']['copilot']['settings']['apiKey'], '{env:LLM_API_KEY}')
        before = (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes())
        self.assertEqual(self.call().returncode, 0)
        self.assertEqual(before, (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes()))
        self.assertFalse((self.root / 'runtime/config/opencode/opencode.json').exists())
        self.no_serialized_values()

    def test_explicit_enable_headers_schemes_and_disabled_extras(self):
        self.fixture.bundle['config']['runtime_env_allowlist'] = ['CONTEXT7_MCP_API_KEY', 'TEST_PROVIDER_KEY']
        self.fixture.install()
        self.env['TEST_PROVIDER_KEY'] = 'SENTINEL-USER-EXTRA'
        for name in profiles.MCP_NAMES:
            self.enable(name)
        self.env['GITHUB_MCP_AUTH_HEADER'] = 'Authorization'
        self.env['GITHUB_ACTIONS_MCP_AUTH_HEADER'] = 'X-Custom-Key'
        self.env['GITHUB_ACTIONS_MCP_AUTH_SCHEME'] = 'Token'
        self.env['CONTEXT7_MCP_AUTH_SCHEME'] = ''
        result = self.call()
        self.assertEqual(result.returncode, 0, result.stderr)
        child = json.loads(result.stdout)['env']
        self.assertEqual(child['TEST_PROVIDER_KEY'], self.env['TEST_PROVIDER_KEY'])
        cfg = json.loads(Path(child['OPENCODE_CONFIG']).read_text())['mcp']['servers']
        for name in profiles.MCP_NAMES:
            server = cfg[name.lower().replace('_', '-')]
            self.assertFalse(server['disabled'])
            self.assertFalse(server['oauth'])
            self.assertEqual(server['url'], '{env:' + name + '_MCP_URL}')
            self.assertEqual(child[name + '_MCP_ENABLED'], '1')
        self.assertEqual(cfg['context7']['headers'], {'Authorization': '{env:CONTEXT7_MCP_API_KEY}'})
        self.assertEqual(cfg['firecrawl']['headers'], {'X-MCP-API-Key': '{env:FIRECRAWL_MCP_API_KEY}'})
        self.assertEqual(cfg['github']['headers'], {'Authorization': 'Bearer {env:GITHUB_MCP_API_KEY}'})
        self.assertEqual(cfg['github-actions']['headers'], {'X-Custom-Key': 'Token {env:GITHUB_ACTIONS_MCP_API_KEY}'})
        self.env['CONTEXT7_MCP_ENABLED'] = '0'
        self.env['CONTEXT7_MCP_AUTH_HEADER'] = 'bad header ignored while disabled'
        child = json.loads(self.call().stdout)['env']
        self.assertNotIn('CONTEXT7_MCP_API_KEY', child)  # Extras cannot undo disabled-service gating.
        self.assertNotIn('CONTEXT7_MCP_AUTH_HEADER', child)
        self.no_serialized_values()

    def test_missing_and_invalid_values_fail_before_exec_with_names_only(self):
        self.fixture.install()
        invalid = {
            'LLM_API_KEY': ['', 'SECRET\nBAD', 'SECRET"BAD', 'SECRET\\BAD', '{env:SECRET}', 'é'],
            'LLM_BASE_URL': ['http://remote.example.invalid', 'https://user:SECRET@example.invalid',
                             'https://example.invalid?SECRET=1', 'https://example.invalid#SECRET',
                             'https://example.invalid:invalid', 'https://bad host.invalid', 'file:///SECRET'],
            'CONTEXT7_MCP_ENABLED': ['', 'true', '2', ' 1'],
            'CONTEXT7_MCP_URL': ['', 'http://u:SECRET@example.invalid', 'http:///SECRET'],
            'CONTEXT7_MCP_API_KEY': ['', 'SECRET\rBAD'],
            'CONTEXT7_MCP_AUTH_HEADER': ['', 'SECRET:Bad', 'SECRET\nBad'],
            'CONTEXT7_MCP_AUTH_SCHEME': ['SECRET Bad', 'SECRET\nBad'],
        }
        for name, values in invalid.items():
            for bad in values:
                with self.subTest(name=name):
                    env = dict(self.env, CONTEXT7_MCP_ENABLED='1', CONTEXT7_MCP_API_KEY='synthetic-key',
                               CONTEXT7_MCP_URL='http://mcp.example.invalid/mcp')
                    env[name] = bad
                    result = self.call(env=env)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')
                    self.assertIn(name, result.stderr)
                    self.assertNotIn('SECRET', result.stderr)
        result = self.call(env={'PATH': '/usr/bin:/bin'})
        self.assertIn('LLM_API_KEY', result.stderr)
        self.assertIn('LLM_BASE_URL', result.stderr)
        self.assertFalse((self.root / 'runtime/module-profiles').exists())
        profiles.endpoint({'LLM_BASE_URL': 'http://127.0.0.1:123/v1'}, 'LLM_BASE_URL')

    def test_help_version_and_module_info_without_credentials_or_writes(self):
        self.fixture.install()
        for tool in ('opencode', 'acpx'):
            for args in (['--version'], ['-v'], ['-V'], ['--help'], ['mcp', '--help']):
                result = self.call(tool, args, {'PATH': '/usr/bin:/bin', 'LLM_API_KEY': 'INVALID\nSECRET',
                                              'FIRECRAWL_MCP_ENABLED': 'invalid'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('INVALID', result.stdout)
            result = self.call(tool, ['--module-profile-info'], {'PATH': '/usr/bin:/bin'})
            self.assertEqual(result.returncode, 0, result.stderr)
            info = json.loads(result.stdout)
            self.assertEqual(info['source'], 'env')
            self.assertEqual(info['model']['variant'], 'medium')
            self.assertEqual(info['enabled_mcp'], [])
            self.assertEqual(info['required_environment_names'], ['LLM_API_KEY', 'LLM_BASE_URL'])
        self.assertFalse((self.root / 'runtime/module-profiles').exists())
        self.assertFalse(profiles.harmless(['run', '--', '--help']))
        self.assertFalse(profiles.harmless(['run', 'prompt with spaces', '--help']))

    def test_external_config_overrides_profile_without_automatic_credentials(self):
        self.fixture.install()
        self.assertEqual(self.call().returncode, 0)  # Leave a prior generated profile to test isolation.
        external = self.base / 'external config.json'
        external.write_text(json.dumps({'model': 'external/model', 'providers': {}}))
        env = dict(self.env, OPENCODE_MODULE_CONFIG=str(external), OPENCODE_ACP_REQUIRED_VARIANT='stale',
                   CONTEXT7_MCP_ENABLED='invalid')
        for tool in ('opencode', 'acpx'):
            result = self.call(tool, ['acp'] if tool == 'opencode' else ['opencode', 'exec', 'fixture'], env)
            self.assertEqual(result.returncode, 0, result.stderr)
            child = json.loads(result.stdout)['env']
            self.assertEqual(child['OPENCODE_CONFIG'], str(external))
            self.assertEqual(child['OPENCODE_ACP_REQUIRED_MODEL'], 'external/model')
            self.assertNotIn('OPENCODE_ACP_REQUIRED_VARIANT', child)
            self.assertNotIn('LLM_API_KEY', child)
            self.assertNotIn('CONTEXT7_MCP_ENABLED', child)
        self.fixture.bundle['config']['runtime_env_allowlist'].append('LLM_API_KEY')
        self.fixture.install()
        result = self.call(env=env)
        self.assertEqual(json.loads(result.stdout)['env']['LLM_API_KEY'], env['LLM_API_KEY'])
        self.assertEqual(json.loads(self.call(args=['--module-profile-info'], env=env).stdout)['source'], 'external')

    def test_no_profile_legacy_behavior_and_no_stale_native_config(self):
        self.fixture.install()
        self.assertEqual(self.call().returncode, 0)
        self.fixture.bundle['config']['runtime_profile'] = 'none'
        self.fixture.install()
        result = self.call(args=['run', 'fixture'])
        self.assertEqual(result.returncode, 0, result.stderr)
        child = json.loads(result.stdout)['env']
        self.assertNotIn('LLM_API_KEY', child)
        self.assertNotIn('OPENCODE_CONFIG', child)
        self.assertNotIn('OPENCODE_ACP_REQUIRED_MODEL', child)
        self.assertNotEqual(self.call().returncode, 0)
        self.assertEqual(json.loads(self.call(args=['--module-profile-info']).stdout)['source'], 'none')

    def test_concurrent_first_launch_serializes_directory_and_marker(self):
        self.fixture.install()
        config, _ = profiles.configuration(self.env, fixtures.SCRIPTS)
        context = multiprocessing.get_context('fork')
        created, resume = context.Event(), context.Event()
        observations, results = context.Queue(), context.Queue()
        workers = [context.Process(target=concurrent_profile_launch, args=(
            self.root, config, creator, created, resume, observations, results))
            for creator in (True, False)]
        outcomes = []
        try:
            workers[0].start()
            self.assertTrue(created.wait(10), 'A did not reach the mkdir/marker gap')
            store = self.root / 'runtime/module-profiles'
            self.assertTrue(store.is_dir())
            self.assertFalse((store / 'owner.json').exists())
            workers[1].start()
            observation = observations.get(timeout=10)
            if observation == 'acquired':
                # Old implementation: let B finish while A is still paused, making
                # its missing-marker failure deterministic rather than scheduler-dependent.
                outcomes.append(results.get(timeout=10))
            resume.set()
            while len(outcomes) < 2:
                outcomes.append(results.get(timeout=10))
            self.assertEqual([item[0] for item in outcomes], ['ok', 'ok'], outcomes)
            self.assertEqual(observation, 'blocked')
            self.assertEqual(outcomes[0][1], outcomes[1][1])
            path = Path(outcomes[0][1])
            self.assertEqual(path.read_bytes(), profiles.encoded(config))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(list(store.glob('*.json'))), 2)
            profiles.private_file(store / 'owner.json')
        finally:
            resume.set()
            for worker in workers:
                if worker.pid is not None:
                    worker.join(10)
                    if worker.is_alive():
                        worker.terminate()
                        worker.join(10)
            observations.close()
            results.close()

    def test_atomic_store_rejects_unmanaged_links_owners_and_changed_content(self):
        self.fixture.install()
        store = self.root / 'runtime/module-profiles'
        store.mkdir(mode=0o700)
        (store / 'unmanaged.json').write_text('user content')
        self.assertNotEqual(self.call().returncode, 0)
        self.assertEqual((store / 'unmanaged.json').read_text(), 'user content')
        (store / 'unmanaged.json').unlink()
        store.rmdir()
        store.symlink_to(self.base)
        self.assertNotEqual(self.call().returncode, 0)
        store.unlink()
        result = self.call()
        path = Path(json.loads(result.stdout)['env']['OPENCODE_CONFIG'])
        data = path.read_bytes()
        for kind in ('symlink', 'hardlink', 'foreign', 'mode', 'changed'):
            if kind == 'foreign' and os.getuid() != 0:
                continue
            with self.subTest(kind=kind):
                path.unlink()
                if kind == 'symlink': path.symlink_to(self.base / 'absent')
                else:
                    path.write_bytes(data)
                    path.chmod(0o600)
                    if kind == 'hardlink': os.link(path, self.base / 'hardlink')
                    elif kind == 'foreign': os.chown(path, 12345, 12345)
                    elif kind == 'mode': path.chmod(0o644)
                    else: path.write_text('unmanaged user config')
                self.assertNotEqual(self.call().returncode, 0)
                if kind == 'changed': self.assertEqual(path.read_text(), 'unmanaged user config')
        path.unlink()
        cfg, _ = profiles.configuration(self.env, fixtures.SCRIPTS)
        with patch.object(profiles.os, 'link', side_effect=OSError('simulated publication failure')):
            with self.assertRaises(OSError): profiles.materialize(self.root, 'test-workspace', cfg)
        self.assertFalse(path.exists())
        self.assertFalse(list(store.glob('.profile-*')))

    def test_acpx_to_opencode_readiness_env_and_deny_defaults(self):
        node_program = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1:] == ['--version']:
    print('v22.22.0')
elif sys.argv[1].endswith('npm-cli.js'):
    dest=Path('node_modules/acpx/dist');dest.mkdir(parents=True)
    (dest/'cli.js').write_text('fixture only')
elif sys.argv[-1] == '--version':
    print('0.19.3')
else:
    assert sys.argv[2:5] == ['--deny-all','--non-interactive-permissions','deny']
    assert os.environ['OPENCODE_ACP_REQUIRED_MODEL'] == 'copilot/gpt-6-astra'
    assert os.environ['OPENCODE_ACP_REQUIRED_VARIANT'] == 'medium'
    assert 'CONTEXT7_MCP_API_KEY' not in os.environ
    assert 'FIRECRAWL_MCP_API_KEY' not in os.environ
    config=json.loads((Path(os.environ['HOME'])/'.acpx/config.json').read_text())
    argv=config['agents']['opencode']['argv']
    os.execve(argv[0], argv, dict(os.environ))
'''
        fixtures.archive(self.fixture.node, {
            'node-v22.22.0-linux-x64/bin/node': node_program,
            'node-v22.22.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js': 'fixture'})
        self.fixture.bundle['config']['runtime_env_allowlist'] += [
            'CONTEXT7_MCP_API_KEY', 'FIRECRAWL_MCP_API_KEY']
        self.fixture.install()
        self.env.update(CONTEXT7_MCP_ENABLED='0', CONTEXT7_MCP_API_KEY='SENTINEL-DISABLED-CONTEXT7',
                        FIRECRAWL_MCP_API_KEY='SENTINEL-ABSENT-FLAG-FIRECRAWL')
        self.enable('GITHUB_ACTIONS')
        self.env['GITHUB_ACTIONS_MCP_AUTH_HEADER'] = 'Authorization'
        self.env['GITHUB_ACTIONS_MCP_AUTH_SCHEME'] = 'Token'
        result = self.call('acpx', ['opencode', 'exec', 'fixture prompt'])
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['argv'], ['acp'])
        self.assertEqual(actual['cwd'], str(self.base))
        self.assertEqual(actual['env']['PATH'], self.env['PATH'])
        self.assertEqual(actual['env']['OPENCODE_ACP_REQUIRED_VARIANT'], 'medium')
        self.assertEqual(actual['env']['GITHUB_ACTIONS_MCP_AUTH_SCHEME'], 'Token')
        self.assertNotIn('CONTEXT7_MCP_API_KEY', actual['env'])
        self.assertNotIn('FIRECRAWL_MCP_API_KEY', actual['env'])
        self.assertEqual(len(list((self.root / 'runtime/module-profiles').glob('*.json'))), 2)
        self.no_serialized_values()

    def test_profile_cache_upgrade_payload_fingerprint_and_rollback(self):
        # Self-contained prior settings fixture; no private history/source dependency.
        old_bundle = copy.deepcopy(self.fixture.bundle)
        old_bundle['config']['runtime_profile'] = 'none'
        with self.fixture.fixtures():
            fixtures.installer.install(old_bundle)
        previous = (self.root / 'active').resolve()
        old_inventory = fixtures.installer.inventory(previous)
        self.fixture.install()
        upgraded = os.readlink(self.root / 'active')
        self.assertNotEqual((self.root / 'active').resolve(), previous)
        self.assertEqual(old_inventory, fixtures.installer.inventory(previous))
        count = self.fixture.downloads
        self.fixture.install()
        self.assertEqual(self.fixture.downloads, count)
        self.assertEqual(os.readlink(self.root / 'active'), upgraded)
        self.fixture.bundle['files']['profiles.py'] += '\n# Changed offline payload fixture\n'
        self.fixture.install()
        self.assertNotEqual(os.readlink(self.root / 'active'), upgraded)
        self.assertEqual(self.call().returncode, 0)
        count = self.fixture.downloads
        with self.fixture.fixtures():
            fixtures.installer.install(old_bundle)
        self.assertEqual(self.fixture.downloads, count)
        self.assertEqual((self.root / 'active').resolve(), previous)
        child = json.loads(self.call(args=['run', 'fixture']).stdout)['env']
        self.assertNotIn('OPENCODE_CONFIG', child)
        self.assertNotIn('LLM_API_KEY', child)

    def test_payload_allowlist_profile_validation_and_cached_profile_inventory(self):
        for name in ('profiles.py', 'profile-env.json', 'shell_path.py'):
            bundle = copy.deepcopy(self.fixture.bundle)
            bundle['files'].pop(name)
            with self.assertRaisesRegex(ValueError, 'payload'):
                fixtures.installer.install(bundle)
        bundle = copy.deepcopy(self.fixture.bundle)
        bundle['config']['runtime_profile'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'profile'):
            fixtures.installer.install(bundle)
        self.assertEqual(self.fixture.downloads, 0)
        self.fixture.install()
        (self.root / 'active/profile-env.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'cached installation'):
            self.fixture.install()
        self.assertEqual(self.fixture.downloads, 2)


if __name__ == '__main__':
    unittest.main()
