"""Synthetic center, real local Git transport; never use Workspace credentials."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

REMOTE = 'ssh://git@git.rickyhao.com:2222/RickyHao/agent-config.git'


def source(base):
    repo = base / 'config-source'
    repo.mkdir(mode=0o700)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(base), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    def run(*args):
        return subprocess.run(['git', '-C', str(repo), *args], env=env, check=True, capture_output=True)
    run('init', '--initial-branch=main')
    run('config', 'user.name', 'Fixture')
    run('config', 'user.email', 'fixture@example.invalid')
    (repo / 'AGENTS.md').write_text('Synthetic shared instructions v1.\n')
    skill = repo / 'skills/example'
    skill.mkdir(mode=0o700, parents=True)
    (skill / 'SKILL.md').write_text('---\nname: example\ndescription: Synthetic complete package.\n---\nRead [reference](references/guide.md).\n')
    (skill / 'references').mkdir(mode=0o700)
    (skill / 'references/guide.md').write_text('Synthetic reference v1.\n')
    (skill / 'LICENSE').write_text('Synthetic license fixture.\n')
    run('add', '.')
    run('commit', '-m', 'initial fixture')
    shim = base / 'git-bin'
    shim.mkdir(mode=0o700)
    command = shim / 'git'
    command.write_text('#!/bin/sh\nexec /usr/bin/git -c ' + shlex.quote('url.' + str(repo) + '.insteadOf=' + REMOTE) + ' "$@"\n')
    command.chmod(0o700)
    return repo, shim


def seed(root, version, workspace):
    repo, shim = source(root.parent)
    for name in ('runtime', 'runtime/config', 'runtime/git'):
        (root / name).mkdir(mode=0o700, exist_ok=True)
    marker = root / 'owner.json'
    if not marker.exists():
        marker.write_text(json.dumps({'schema': 1, 'uid': os.getuid(), 'workspace_id': workspace}))
        marker.chmod(0o600)
    env = {'PATH': str(shim) + ':/usr/bin:/bin', 'HOME': str(root.parent),
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    result = subprocess.run([sys.executable, '-B', str(version / 'agent_config.py')], env=env, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return {'source': str(repo), 'path': env['PATH']}


if __name__ == '__main__':
    print(json.dumps(seed(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])))
