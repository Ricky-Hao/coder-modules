#!/usr/bin/env python3
"""私有 launcher；继承环境并应用模块覆盖。"""
import json
import os
from pathlib import Path
import re
import sys
import fcntl
import hashlib
import signal

# 固定本次版本。
VERSION = Path(__file__).resolve().parent
sys.path.insert(0, str(VERSION))
from safety import ancestors, directory, owner, regular
import profiles

RESERVED = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
            'TMPDIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_MODULE_TASK_SELECTION',
            'OPENCODE_MODULE_TASK_CONFIG', 'OPENCODE_MODULE_TASK_PROFILE', 'OPENCODE_MODULE_SESSION_LOCK',
            'OPENCODE_MODULE_MONITOR_PID', 'OPENCODE_MODULE_TASK_LOCKS', 'OPENCODE_MODULE_LAUNCH_LOCK'}


def environment(environ, root, profile='none', workspace_id=None, arguments=(), task=None, submit=False):
    if profile not in ('none', 'env'):
        raise ValueError('unknown runtime profile')
    # 回调不进入模型环境。
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


def launch_selection(settings):
    """从 stdio 解析选择；复用 profile 校验与快照，不读取任务业务输入。"""
    request = json.loads(sys.stdin.buffer.read(65537))
    source = dict(os.environ)
    saved = request.get('saved')
    if saved:
        regular(Path(saved['modelConfig']))
        source['OPENCODE_MODULE_CONFIG'] = saved['modelConfig']
    config_path = source.get('OPENCODE_MODULE_CONFIG')
    if config_path:
        config = json.loads(Path(config_path).read_text())
    elif settings.get('runtime_profile') == 'env':
        config = json.loads((VERSION / 'profile-env.json').read_text())
    else:
        raise ValueError('TASK_MODEL_CONFIG_REQUIRED')
    default = saved['model'] if saved else profiles.selection(config.get('model'))
    provider, model = default['id'].split('/', 1)
    target = request.get('provider', provider) + '/' + request.get('model', model)
    changed = target != default['id'] if saved else 'provider' in request or 'model' in request
    arguments = ['submit']
    if changed or saved:
        arguments.extend(['--model', target])
    variant = request.get('variant', default.get('variant') if saved and not changed else None)
    if variant is not None:
        arguments.extend(['--variant', variant])
    child = environment(source, Path(settings['install_root']), settings.get('runtime_profile', 'none'),
                        settings['workspace_id'], arguments, submit=True)
    if 'OPENCODE_MODULE_TASK_SELECTION' not in child:
        raise ValueError('TASK_MODEL_CONFIG_REQUIRED')
    if saved and saved['modelProfile'] == 'env':
        profiles.configuration(child, VERSION, json.loads(child['OPENCODE_MODULE_TASK_SELECTION'])['id'].split('/', 1)[0])
    print(json.dumps({'model': json.loads(child['OPENCODE_MODULE_TASK_SELECTION']),
                      'modelConfig': child['OPENCODE_MODULE_TASK_CONFIG'],
                      'modelProfile': saved['modelProfile'] if saved else child['OPENCODE_MODULE_TASK_PROFILE']}))


def follow_monitor():
    # Linux clears PDEATHSIG on fork: an acpx owner survives its replaceable driver.
    # Set it before any blocking lock/setup, and close the parent-exit race.
    import ctypes
    parent = os.getppid()
    expected = int(os.environ.get('OPENCODE_MODULE_MONITOR_PID', parent))
    if parent != expected or parent == 1 or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise ValueError('task monitor unavailable')
    if os.getppid() != parent:
        raise SystemExit(1)


def main():
    os.umask(0o077)
    tool, arguments = sys.argv[1], sys.argv[2:]
    readonly = tool == 'opencode-task' and (arguments[:1] in (['list'], ['inspect'], ['status'], ['result'], ['doctor'])
                                           or not arguments or arguments == ['help'] or profiles.harmless(arguments))
    if readonly:
        from diagnostics import ReadError, doctor, error_code, read_json, task_root
        try:
            settings = read_json(VERSION / 'settings.json')
            root = Path(settings['install_root'])
            if arguments in (['doctor'], ['doctor', '--quick']):
                value = doctor(root, VERSION, quick=arguments == ['doctor', '--quick'])
                print(json.dumps(value, ensure_ascii=False))
                return 0 if value['ok'] else 1
            if arguments[:1] == ['doctor']:
                raise ReadError('INVALID_ARGUMENTS')
            if arguments[:1] in (['list'], ['inspect'], ['status'], ['result']):
                task_root(root, settings)
            # 查询没有初始化、锁文件或 profile materialize；Node 只运行命令投影。
            binary = VERSION / 'node/bin/node'
            regular(binary)
            child = environment(os.environ, root, arguments=['--help'])
            os.execve(binary, [str(binary), str(VERSION / 'task-cli.mjs'), *arguments], child)
        except (OSError, ValueError, KeyError, TypeError, ImportError) as error:
            code = error_code(error)
            print(json.dumps({'error': {'code': code,
                                       'hint': '核对安装及任务存储；查询不会创建目录、恢复或改写旧记录。'}}, ensure_ascii=False), file=sys.stderr)
            return 1
    settings = json.loads((VERSION / 'settings.json').read_text())
    root = Path(settings['install_root'])
    ancestors(root)
    owner(root, settings['workspace_id'])
    directory(VERSION)
    directory(root / 'runtime')
    for name in ('home', 'config', 'data', 'cache', 'state', 'tmp'):
        directory(root / 'runtime' / name)
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
    if tool == 'opencode-task' and arguments == ['_selection']:
        try:
            launch_selection(settings)
            return 0
        except (OSError, ValueError, KeyError, TypeError):
            print(json.dumps({'error': {'code': 'LAUNCH_SELECTION_INVALID'}}))
            return 1
    task_arguments = arguments
    session_lock = None
    if tool == 'opencode-task':
        tasks = root / 'runtime/tasks'
        # 锁覆盖 owner 创建与 submit 去重。
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
        if arguments[:1] in (['resolve'], ['_fail_launch']):
            if len(arguments) < 2 or not re.fullmatch(r'task_[a-f0-9]{64}', arguments[1]):
                raise ValueError('invalid task finalization')
            lockpath = directory(tasks / arguments[1]) / 'worker.lock'
            monitor_path = tasks / arguments[1] / 'monitor.lock'
            monitor_lock = os.open(monitor_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            regular(monitor_path)
            if os.fstat(monitor_lock).st_mode & 0o077:
                raise ValueError('task lock must be private')
            fcntl.flock(monitor_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.set_inheritable(monitor_lock, True)
        if arguments[:1] in (['_worker'], ['_observe'], ['_supervise']):
            if len(arguments) not in (2, 3) or not re.fullmatch(r'task_[a-f0-9]{64}', arguments[1]):
                raise ValueError('invalid task worker')
            task_dir = directory(tasks / arguments[1])
            lockpath = task_dir / ('monitor.lock' if arguments[0] == '_supervise' else 'worker.lock')
            regular(task_dir / 'task.json')
            task_state = json.loads((task_dir / 'task.json').read_text())
            if arguments[0] != '_supervise':
                follow_monitor()
            if arguments[0] != '_worker' or task_state['state'] != 'queued' or os.path.lexists(task_dir / 'cancel.json'):
                task_arguments = ['--help']  # 被动观察免凭据。
            elif task_state.get('model'):
                task = task_state
                session_lock = tasks / ('.model-' + hashlib.sha256(task_state['sessionKey'].encode()).hexdigest() + '.lock')
            elif profile == 'env' and not os.environ.get('OPENCODE_MODULE_CONFIG'):
                # 旧记录不套用新模型默认。
                print('TASK_MODEL_UNRECORDED: use the original installed launcher or original external config for this queued task.', file=sys.stderr)
                raise SystemExit(1)
        elif arguments[:1] != ['submit']:
            task_arguments = ['--help']
        if arguments[:1] in (['submit'], ['launch'], ['_worker'], ['_observe'], ['_supervise'], ['resolve'], ['_fail_launch']):
            task_lock = os.open(lockpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            regular(lockpath)
            if os.fstat(task_lock).st_mode & 0o077:
                raise ValueError('task lock must be private')
            try:
                fcntl.flock(task_lock, fcntl.LOCK_EX | (0 if arguments[:1] in (['submit'], ['launch']) else fcntl.LOCK_NB))
            except BlockingIOError:
                if arguments[:1] == ['_supervise']:
                    if arguments[2:] == ['--ready']:
                        os.write(3, b'ready\n')
                    return
                if arguments[:1] in (['_worker'], ['_observe']):
                    raise SystemExit(75)
                raise
            os.set_inheritable(task_lock, True)
    # 只锁初始化与选择。
    selection_lock = None
    if session_lock is not None:
        selection_lock = os.open(session_lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        regular(session_lock)
        fcntl.flock(selection_lock, fcntl.LOCK_EX)
        os.set_inheritable(selection_lock, True)
    if tool == 'opencode-task' and arguments[:1] == ['launch']:
        # Git 沿调用者的 HOME/SSH/PATH；选择和 worker 再走各自的模块环境。
        caller_paths = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR'}
        child = {k: v for k, v in os.environ.items() if k not in RESERVED - caller_paths
                 and not k.startswith(('LC_TASK_CALLBACK', 'OPENCODE_TASK_CALLBACK'))
                 and not re.search(r'tcb_[A-Za-z0-9_-]{43}', v)}
        child['OPENCODE_MODULE_LAUNCH_LOCK'] = str(task_lock)
    else:
        child = environment(os.environ, root, profile,
                          settings['workspace_id'], task_arguments, task,
                          submit=tool == 'opencode-task' and arguments[:1] == ['submit'])
    if selection_lock is not None:
        child['OPENCODE_MODULE_SESSION_LOCK'] = str(selection_lock)
    if tool == 'opencode-task' and arguments[:1] in (['resolve'], ['_fail_launch']):
        child['OPENCODE_MODULE_TASK_LOCKS'] = json.dumps([task_lock, monitor_lock])
    if tool == 'opencode' and 'acp' in arguments and not child.get('OPENCODE_ACP_REQUIRED_MODEL'):
        raise ValueError('ACP requires an explicit provider/model from config or environment')
    if tool == 'opencode':
        binary, argv = VERSION / 'opencode', arguments
    elif tool == 'acpx':
        # 私有 Node 不进 PATH。
        binary, argv = VERSION / 'node/bin/node', [str(VERSION / 'node_modules/acpx/dist/cli.js'), *acpx_arguments(arguments)]
    else:
        binary, argv = VERSION / 'node/bin/node', [str(VERSION / 'task-cli.mjs'), *arguments]
    regular(binary)
    os.execve(binary, [str(binary), *argv], child)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except profiles.ProfileError as error:
        print(str(error) + '; supply valid values at launch (values hidden).', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print('OpenCode launcher refused: check private state and explicit runtime configuration (values hidden).', file=sys.stderr)
        sys.exit(1)
