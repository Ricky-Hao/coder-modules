#!/usr/bin/env python3
"""Workspace-private launcher. Preserve cwd/argv; credentials require named opt-in."""
import json
import os
from pathlib import Path
import re
import sys
import fcntl

# The active symlink resolves once: a concurrent upgrade cannot mix version files.
VERSION = Path(__file__).resolve().parent
sys.path.insert(0, str(VERSION))
from safety import ancestors, directory, owner, regular
import profiles

NORMAL_ENV = {
    'PATH', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'SHELL', 'USER', 'LOGNAME',
    'DISPLAY', 'WAYLAND_DISPLAY', 'EDITOR', 'VISUAL', 'PAGER', 'NO_COLOR', 'FORCE_COLOR',
    'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYENV_ROOT', 'NVM_DIR',
    'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'OPENCODE_MODULE_CONFIG', 'OPENCODE_ACP_REQUIRED_MODEL', 'OPENCODE_ACP_REQUIRED_VARIANT',
    'OPENCODE_ACP_CATALOG_TIMEOUT_MS',
}
RESERVED = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
            'TMPDIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_DISABLE_AUTOUPDATE'}


def environment(environ, root, allowlist, profile='none', workspace_id=None, arguments=()):
    if profile not in ('none', 'env'):
        raise ValueError('unknown runtime profile')
    keys = NORMAL_ENV | set(allowlist) | {k for k in environ if k.startswith('LC_')}
    child = {k: environ[k] for k in keys - RESERVED if k in environ
             and not k.startswith(('LC_TASK_CALLBACK', 'OPENCODE_TASK_CALLBACK'))
             and not re.search(r'tcb_[A-Za-z0-9_-]{43}', environ[k])}
    state = root / 'runtime'
    child.update({'HOME': str(state / 'home'), 'PATH': environ.get('PATH', '/usr/bin:/bin'),
                  'XDG_CONFIG_HOME': str(state / 'config'), 'XDG_DATA_HOME': str(state / 'data'),
                  'XDG_CACHE_HOME': str(state / 'cache'), 'XDG_STATE_HOME': str(state / 'state'),
                  'TMPDIR': str(state / 'tmp'), 'OPENCODE_CONFIG_DIR': str(state / 'config/opencode'),
                  'OPENCODE_DISABLE_AUTOUPDATE': 'true'})
    config_path = environ.get('OPENCODE_MODULE_CONFIG')
    if profiles.harmless(list(arguments)):
        for name in profiles.PROFILE_KEYS:
            child.pop(name, None)
        return child
    config = None
    if config_path:
        # No interpolation or file generation. Secrets must remain {env:NAME} references.
        path = Path(config_path).absolute()
        config = json.loads(path.read_text())
        child['OPENCODE_CONFIG'] = str(path)
    elif profile == 'env':
        config, automatic = profiles.configuration(environ, VERSION)
        # Disabled MCP credentials cannot leak through user extras in env mode.
        for name in profiles.PROFILE_KEYS:
            child.pop(name, None)
        child.update({name: environ[name] for name in automatic if name in environ})
        child['OPENCODE_CONFIG'] = str(profiles.materialize(root, workspace_id, config))
    if config is not None:
        selected = config.get('model')
        if selected is not None:
            # An explicit model without a variant must not inherit a stale variant.
            child.pop('OPENCODE_ACP_REQUIRED_VARIANT', None)
        if isinstance(selected, str):
            target, separator, variant = selected.partition('#')
            child['OPENCODE_ACP_REQUIRED_MODEL'] = target
            if separator:
                if not variant or '#' in variant:
                    raise ValueError('invalid configured model variant')
                child['OPENCODE_ACP_REQUIRED_VARIANT'] = variant
        elif isinstance(selected, dict):
            child['OPENCODE_ACP_REQUIRED_MODEL'] = selected['providerID'] + '/' + selected['model']
            if selected.get('variant'):
                child['OPENCODE_ACP_REQUIRED_VARIANT'] = selected['variant']
        elif selected is not None:
            raise ValueError('invalid configured model selection')
    target = child.get('OPENCODE_ACP_REQUIRED_MODEL')
    if target and not re.fullmatch(r'[^/\s]+/\S+', target):
        raise ValueError('invalid explicit provider/model target')
    deadline = child.setdefault('OPENCODE_ACP_CATALOG_TIMEOUT_MS', '30000')
    if not deadline.isascii() or not deadline.isdecimal() or not 100 <= int(deadline) <= 120000:
        raise ValueError('invalid catalog deadline')
    return child


def acpx_arguments(arguments):
    # Project acpx config must not silently broaden the module's deny-all default.
    defaults = []
    if not any(flag in arguments for flag in ('--approve-all', '--approve-reads', '--deny-all')):
        defaults.append('--deny-all')
    if not any(arg == '--non-interactive-permissions' or arg.startswith('--non-interactive-permissions=') for arg in arguments):
        defaults.extend(['--non-interactive-permissions', 'deny'])
    return [*defaults, *arguments]


def main():
    os.umask(0o077)
    settings = json.loads((VERSION / 'settings.json').read_text())
    root = Path(settings['install_root'])
    ancestors(root)
    owner(root, settings['workspace_id'])
    directory(VERSION)
    directory(root / 'runtime')
    for name in ('home', 'config', 'data', 'cache', 'state', 'tmp'):
        directory(root / 'runtime' / name)
    tool, arguments = sys.argv[1], sys.argv[2:]
    if tool not in ('opencode', 'acpx', 'opencode-task'):
        raise ValueError('unknown command')
    profile = settings.get('runtime_profile', 'none')
    if arguments == ['--module-profile-info']:
        print(json.dumps(profiles.information(profile, bool(os.environ.get('OPENCODE_MODULE_CONFIG')),
                                              os.environ, VERSION), sort_keys=True))
        return
    task_arguments = arguments
    if tool == 'opencode-task':
        tasks = root / 'runtime/tasks'
        # Serialize first marker creation and submit dedupe on a trusted directory.
        runtime_fd = os.open(root / 'runtime', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(runtime_fd, fcntl.LOCK_EX)
            created = False
            try:
                tasks.mkdir(mode=0o700)
                created = True
            except FileExistsError:
                pass
            directory(tasks)
            if created:
                from safety import write_json
                write_json(tasks / 'owner.json', {'schema': 1, 'uid': os.getuid(), 'workspace_id': settings['workspace_id']})
            owner(tasks, settings['workspace_id'])
        finally:
            os.close(runtime_fd)
        lockpath = tasks / 'submit.lock'
        if arguments[:1] == ['resolve']:
            if len(arguments) < 2 or not re.fullmatch(r'task_[a-f0-9]{64}', arguments[1]):
                raise ValueError('invalid task resolution')
            lockpath = directory(tasks / arguments[1]) / 'worker.lock'
        if arguments[:1] == ['_worker']:
            if len(arguments) != 2 or not re.fullmatch(r'task_[a-f0-9]{64}', arguments[1]):
                raise ValueError('invalid task worker')
            task_dir = directory(tasks / arguments[1])
            lockpath = task_dir / 'worker.lock'
            regular(task_dir / 'task.json')
            task_state = json.loads((task_dir / 'task.json').read_text())
            if task_state['state'] != 'queued' or os.path.lexists(task_dir / 'cancel.json'):
                task_arguments = ['--help']  # Passive watch/outbox needs no provider credentials.
        elif arguments[:1] != ['submit']:
            if arguments[:1] != ['recover'] or not os.environ.get('LLM_API_KEY'):
                task_arguments = ['--help']
        if arguments[:1] in (['submit'], ['_worker'], ['resolve']):
            task_lock = os.open(lockpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            regular(lockpath)
            try:
                fcntl.flock(task_lock, fcntl.LOCK_EX | (0 if arguments[:1] == ['submit'] else fcntl.LOCK_NB))
            except BlockingIOError:
                if arguments[:1] == ['_worker']:
                    return
                raise
            os.set_inheritable(task_lock, True)
    child = environment(os.environ, root, settings['runtime_env_allowlist'], profile,
                         settings['workspace_id'], task_arguments)
    if tool == 'opencode' and 'acp' in arguments and not child.get('OPENCODE_ACP_REQUIRED_MODEL'):
        raise ValueError('ACP requires an explicit provider/model from config or environment')
    if tool == 'opencode':
        binary, argv = VERSION / 'opencode', arguments
    elif tool == 'acpx':
        # Do not prepend private Node to PATH: project subprocesses retain their own Node.
        binary, argv = VERSION / 'node/bin/node', [str(VERSION / 'node_modules/acpx/dist/cli.js'), *acpx_arguments(arguments)]
    else:
        binary, argv = VERSION / 'node/bin/node', [str(VERSION / 'task-cli.mjs'), *arguments]
    regular(binary)
    os.execve(binary, [str(binary), *argv], child)


if __name__ == '__main__':
    try:
        main()
    except profiles.ProfileError as error:
        print(str(error) + '; supply valid values at launch (values hidden).', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print('OpenCode launcher refused: check private state and explicit runtime configuration (values hidden).', file=sys.stderr)
        sys.exit(1)
