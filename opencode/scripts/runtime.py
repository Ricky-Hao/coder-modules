#!/usr/bin/env python3
"""Workspace-private launcher. Inherit the caller environment with module overrides."""
import json
import os
from pathlib import Path
import re
import sys
import fcntl
import hashlib

# The active symlink resolves once: a concurrent upgrade cannot mix version files.
VERSION = Path(__file__).resolve().parent
sys.path.insert(0, str(VERSION))
from safety import ancestors, directory, owner, regular
import profiles

RESERVED = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
            'TMPDIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_MODULE_TASK_SELECTION',
            'OPENCODE_MODULE_TASK_CONFIG', 'OPENCODE_MODULE_TASK_PROFILE', 'OPENCODE_MODULE_SESSION_LOCK'}


def environment(environ, root, profile='none', workspace_id=None, arguments=(), task=None, submit=False):
    if profile not in ('none', 'env'):
        raise ValueError('unknown runtime profile')
    # Callback capability fields are private to the task protocol, never model input.
    child = {k: value for k, value in environ.items() if k not in RESERVED
             and not k.startswith(('LC_TASK_CALLBACK', 'OPENCODE_TASK_CALLBACK'))
             and not re.search(r'tcb_[A-Za-z0-9_-]{43}', value)}
    state = root / 'runtime'
    child.setdefault('PATH', '/usr/bin:/bin')
    child.update({'HOME': str(state / 'home'),
                  'XDG_CONFIG_HOME': str(state / 'config'), 'XDG_DATA_HOME': str(state / 'data'),
                  'XDG_CACHE_HOME': str(state / 'cache'), 'XDG_STATE_HOME': str(state / 'state'),
                  'TMPDIR': str(state / 'tmp'), 'OPENCODE_CONFIG_DIR': str(state / 'config/opencode'),
                  'OPENCODE_DISABLE_AUTOUPDATE': 'true'})
    config_path = task.get('modelConfig') if task else child.get('OPENCODE_MODULE_CONFIG')
    model = task.get('model') if task else None
    model_profile = task['modelProfile'] if task else 'env' if profile == 'env' and not config_path else 'external'
    model_flag = arguments[arguments.index('--model') + 1] if submit and '--model' in arguments else None
    variant_flag = arguments[arguments.index('--variant') + 1] if submit and '--variant' in arguments else None
    if profiles.harmless(list(arguments)):
        return child
    config = None
    if config_path:
        # No interpolation or file generation. Secrets must remain {env:NAME} references.
        path = Path(config_path).absolute()
        config = json.loads(path.read_text())
        child['OPENCODE_CONFIG'] = str(path)
    elif profile == 'env':
        provider = (model['id'] if model else model_flag or 'codex/').split('/', 1)[0]
        config = profiles.configuration(child, VERSION, provider)
    if task and model_profile == 'env':
        # A saved task config is external to discovery but still uses the bundled env contract.
        profiles.configuration(child, VERSION, model['id'].split('/', 1)[0])
    if submit and config is not None:
        model = profiles.task_configuration(config, model_flag, variant_flag)
    elif submit and (model_flag is not None or variant_flag is not None):
        raise ValueError('TASK_MODEL_CONFIG_REQUIRED')
    if config is not None and (submit or not config_path):
        child['OPENCODE_CONFIG'] = str(profiles.materialize(root, workspace_id, config))
    if model is not None:
        if profiles.selection(config['model']) != model:
            raise ValueError('TASK_MODEL_CONFIG_CONFLICT')
        child['OPENCODE_MODULE_TASK_SELECTION'] = json.dumps(model, sort_keys=True)
        child['OPENCODE_MODULE_TASK_CONFIG'] = child['OPENCODE_CONFIG']
        child['OPENCODE_MODULE_TASK_PROFILE'] = model_profile
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
    task = None
    if tool == 'opencode' and arguments[:1] == ['--module-task']:
        if len(arguments) != 6 or arguments[-1] != 'acp' or arguments[4] not in ('env', 'external'):
            raise ValueError('invalid task launch')
        task = {'modelConfig': arguments[1], 'model': profiles.selection(arguments[2], arguments[3] or None),
                'modelProfile': arguments[4]}
        regular(Path(arguments[1]))
        arguments = ['acp']
    if tool not in ('opencode', 'acpx', 'opencode-task'):
        raise ValueError('unknown command')
    profile = settings.get('runtime_profile', 'none')
    if arguments == ['--module-profile-info']:
        print(json.dumps(profiles.information(profile, bool(os.environ.get('OPENCODE_MODULE_CONFIG')),
                                              os.environ, VERSION), sort_keys=True))
        return
    task_arguments = arguments
    session_lock = None
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
            elif task_state.get('model'):
                task = task_state
                session_lock = tasks / ('.model-' + hashlib.sha256(task_state['sessionKey'].encode()).hexdigest() + '.lock')
            elif profile == 'env' and not os.environ.get('OPENCODE_MODULE_CONFIG'):
                # Old records did not snapshot model intent. Never reinterpret one as the new default.
                print('TASK_MODEL_UNRECORDED: use the original installed launcher or original external config for this queued task.', file=sys.stderr)
                raise SystemExit(1)
        elif arguments[:1] != ['submit']:
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
    # Serialize only initialization/selection, not execution or the session queue.
    selection_lock = None
    if session_lock is not None:
        selection_lock = os.open(session_lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        regular(session_lock)
        fcntl.flock(selection_lock, fcntl.LOCK_EX)
        os.set_inheritable(selection_lock, True)
    child = environment(os.environ, root, profile,
                          settings['workspace_id'], task_arguments, task,
                          submit=tool == 'opencode-task' and arguments[:1] == ['submit'])
    if selection_lock is not None:
        child['OPENCODE_MODULE_SESSION_LOCK'] = str(selection_lock)
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
