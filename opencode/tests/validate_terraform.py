"""Validate/render actual module with a mocked Coder provider; never apply.

Python 3.11+, Terraform 1.7+ (mock provider support). Pass --provider-dir to use a
preinstalled provider mirror offline. Scratch must be a new directory outside source.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--terraform', type=Path, required=True)
    parser.add_argument('--provider-dir', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    args = parser.parse_args()
    module = Path(__file__).resolve().parents[1]
    scratch = args.scratch.absolute()
    scratch.mkdir(mode=0o700)
    for path in module.glob('*.tf'):
        shutil.copyfile(path, scratch / path.name)
    shutil.copyfile(module / '.terraform.lock.hcl', scratch / '.terraform.lock.hcl')
    shutil.copytree(module / 'scripts', scratch / 'scripts')
    (scratch / 'tests').mkdir()
    shutil.copyfile(module / 'tests/defaults.tftest.hcl', scratch / 'tests/defaults.tftest.hcl')
    env = {'HOME': str(scratch), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'TF_CLI_CONFIG_FILE': '/dev/null', 'CHECKPOINT_DISABLE': '1', 'TF_IN_AUTOMATION': '1'}
    records = {}

    def run(label, *argv):
        result = subprocess.run([str(args.terraform), *argv], cwd=scratch, env=env,
                                capture_output=True, text=True, timeout=120)
        (scratch / (label + '.stdout')).write_text(result.stdout)
        (scratch / (label + '.stderr')).write_text(result.stderr)
        records[label] = {'arguments': argv, 'exit_code': result.returncode}
        (scratch / 'commands.json').write_text(json.dumps(records, indent=2) + '\n')
        if result.returncode:
            raise RuntimeError(label + ' failed; see scratch logs')
        return result.stdout

    run('init', 'init', '-backend=false', '-input=false', '-no-color', '-lockfile=readonly',
        '-plugin-dir=' + str(args.provider_dir.absolute()))
    run('validate', 'validate', '-no-color')
    schema = json.loads(run('schema', 'providers', 'schema', '-json'))
    coder = schema['provider_schemas']['registry.terraform.io/coder/coder']
    attrs = coder['resource_schemas']['coder_script']['block']['attributes']
    for key in ('script', 'agent_id', 'display_name'):
        assert attrs[key]['required'] and attrs[key]['type'] == 'string'
    assert attrs['start_blocks_login']['type'] == 'bool'
    assert coder['data_source_schemas']['coder_workspace']['block']['attributes']['id']['type'] == 'string'
    output = run('mock-tests', 'test', '-no-color', '-json', '-verbose')
    plans = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
    scripts = []

    def visit(value):
        if isinstance(value, dict):
            if value.get('type') == 'coder_script' and 'change' in value:
                script = value['change'].get('after', {}).get('script')
                if script and script not in scripts:
                    scripts.append(script)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(plans)
    assert len(scripts) >= 2, 'verbose mock plans must expose both actual rendered scripts'
    for record in plans:
        plan = record.get('test_plan', {})
        preparation = plan.get('output_changes', {}).get('volume_prepare_script', {}).get('after')
        if preparation:
            assert preparation.startswith((module / 'scripts/prepare_volume.py').read_text())
            compile(preparation, '<volume-preparation>', 'exec')
            prepared_config = json.loads(base64.b64decode(
                preparation.rsplit("base64.b64decode('", 1)[1].split("')", 1)[0]))
            assert prepared_config == {'mount_path': '/mnt/opencode',
                                       'install_root': '/mnt/opencode/toolset',
                                       'workspace_id': '11111111-1111-4111-8111-111111111111'}
            (scratch / 'volume-prepare.py').write_text(preparation)
        for resource in plan.get('resource_changes', []):
            if resource.get('type') != 'coder_script':
                continue
            script = resource['change']['after']['script']
            config = json.loads(base64.b64decode(
                script.split("base64.b64decode('", 1)[1].split("')", 1)[0]))['config']
            if config['install_root']:
                for tool in ('opencode', 'acpx'):
                    command = plan['output_changes'][tool + '_command']['after']
                    assert shlex.split(command) == [config['install_root'] + '/bin/' + tool]
    configs = []
    for number, script in enumerate(scripts):
        encoded = script.split("base64.b64decode('", 1)[1].split("')", 1)[0]
        bundle = json.loads(base64.b64decode(encoded))
        configs.append(bundle['config'])
        assert set(bundle['files']) == {'install.py', 'runtime.py', 'safety.py', 'profiles.py',
                                       'profile-env.json', 'shell_path.py', 'package.json', 'package-lock.json'}
        for name, text in bundle['files'].items():
            assert text == (module / 'scripts' / name).read_text()
            if name.endswith('.py'):
                compile(text, name, 'exec')
        path = scratch / ('rendered-' + str(number) + '.sh')
        path.write_text(script)
        subprocess.run(['bash', '-n', str(path)], check=True, env=env)
        body = script.split("<<'OPENCODE_BOOTSTRAP'\n", 1)[1].rsplit('\nOPENCODE_BOOTSTRAP', 1)[0]
        compile(body, '<bootstrap>', 'exec')
    assert any(c['install_root'] == '' and c['runtime_profile'] == 'env' for c in configs)
    assert any(c['install_root'] == '/mnt/opencode/toolset' and c['runtime_profile'] == 'none' for c in configs)
    assert (scratch / 'volume-prepare.py').is_file()
    print('PASS: cached init, validate, provider schema, mock plans, actual payload render, Bash/Python syntax; no apply')


if __name__ == '__main__':
    main()
