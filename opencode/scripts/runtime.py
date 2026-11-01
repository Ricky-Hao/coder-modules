#!/usr/bin/env python3
"""私有 launcher；继承环境并应用模块覆盖。"""
import json
import os
from pathlib import Path
import re
import sys
import fcntl

# 固定本次版本。
VERSION = Path(__file__).resolve().parent
sys.path.insert(0, str(VERSION))
from safety import ancestors, directory, owner, regular, sync_directory
import profiles
import git_ssh

RESERVED = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
            'TMPDIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_DISABLE_AUTOUPDATE'}


def filtered_environment(environ, preserve=()):
    # 回调不进入模型环境。
    return {k: value for k, value in environ.items() if k not in RESERVED - set(preserve)
            and (not k.startswith('OPENCODE_MODULE_') or k in ('OPENCODE_MODULE_CONFIG', git_ssh.BASE) or k in preserve)
            and not k.startswith(('LC_TASK_CALLBACK', 'OPENCODE_TASK_CALLBACK'))
            and not re.search(r'tcb_[A-Za-z0-9_-]{43}', value)}


def environment(environ, root, profile='none', workspace_id=None, arguments=(), task=None):
    if profile not in ('none', 'env'):
        raise ValueError('unknown runtime profile')
    child = filtered_environment(environ)
    state = root / 'runtime'
    child.setdefault('PATH', '/usr/bin:/bin')
    child.update({'HOME': str(state / 'home'),
                  'XDG_CONFIG_HOME': str(state / 'config'), 'XDG_DATA_HOME': str(state / 'data'),
                  'XDG_CACHE_HOME': str(state / 'cache'), 'XDG_STATE_HOME': str(state / 'state'),
                  'TMPDIR': str(state / 'tmp'), 'OPENCODE_CONFIG_DIR': str(state / 'config/opencode'),
                  'OPENCODE_DISABLE_AUTOUPDATE': 'true'})
    config_path = task['modelConfig'] if task else child.get('OPENCODE_MODULE_CONFIG')
    model = task.get('model') if task else None
    if profiles.harmless(list(arguments)):
        return child
    child = git_ssh.environment(child, root)
    config = None
    if config_path:
        # 不展开秘密；配置只保留 {env:NAME} 引用。
        path = Path(config_path).absolute()
        config = json.loads(path.read_text())
        child['OPENCODE_CONFIG'] = str(path)
    elif profile == 'env':
        config = profiles.configuration(child, VERSION)
    if task and task['modelProfile'] == 'env':
        # 快照位于自动发现目录外；仍校验该任务的 env 契约。
        profiles.configuration(child, VERSION, model['id'].split('/', 1)[0])
    if config is not None and not config_path:
        child['OPENCODE_CONFIG'] = str(profiles.materialize(root, workspace_id, config))
    if model is not None:
        if profiles.selection(config['model']) != model:
            raise ValueError('TASK_MODEL_CONFIG_CONFLICT')
    if config is not None:
        if config.get('model') is not None:
            selected = profiles.selection(config['model'])
            # 显式模型不能继承环境中残留的 variant。
            child.pop('OPENCODE_ACP_REQUIRED_VARIANT', None)
            child['OPENCODE_ACP_REQUIRED_MODEL'] = selected['id']
            if selected.get('variant'):
                child['OPENCODE_ACP_REQUIRED_VARIANT'] = selected['variant']
    target = child.get('OPENCODE_ACP_REQUIRED_MODEL')
    if target and not re.fullmatch(r'[^/\s]+/\S+', target):
        raise ValueError('invalid explicit provider/model target')
    deadline = child.setdefault('OPENCODE_ACP_CATALOG_TIMEOUT_MS', '30000')
    if not deadline.isascii() or not deadline.isdecimal() or not 100 <= int(deadline) <= 120000:
        raise ValueError('invalid catalog deadline')
    return child


def acpx_arguments(arguments):
    # Explicit CLI permissions and native policy still take precedence.
    defaults = []
    if not any(flag in arguments for flag in ('--approve-all', '--approve-reads', '--deny-all')):
        defaults.append('--approve-all')
    if not any(arg == '--non-interactive-permissions' or arg.startswith('--non-interactive-permissions=') for arg in arguments):
        defaults.extend(['--non-interactive-permissions', 'deny'])
    return [*defaults, *arguments]


def opencode_arguments(arguments):
    # Native --auto approves asks but still respects explicit policy denials.
    # ACP gets the saved acpx permissions; interactive/continued sessions stay native.
    if arguments[:1] != ['run'] or any(arg in ('-c', '--continue', '-s', '--session') or arg.startswith(
            ('--session=', '-s=', '--continue=', '-c=', '--auto', '--no-auto', '--yolo', '--dangerously-skip-permissions')) for arg in arguments):
        return arguments
    return ['run', '--auto', *arguments[1:]]


class SelectionError(ValueError):
    """固定的选择阶段定位，不保存原异常。"""
    def __init__(self, field, reason):
        assert field in ('model_config', 'provider') and reason in ('read_failed', 'snapshot_failed', 'invalid')
        super().__init__('LAUNCH_SELECTION_INVALID')
        self.field, self.reason = field, reason


def selection_diagnostic(error):
    if isinstance(error, profiles.ProfileError):
        return {'code': 'LAUNCH_ENVIRONMENT_INVALID', 'stage': 'selection', 'field': 'environment',
                'reason': error.reason, 'environment_names': error.names}
    fields = {'INVALID_MODEL': 'model', 'INVALID_VARIANT': 'variant',
              'TASK_MODEL_CONFIG_REQUIRED': 'model_config', 'TASK_TITLE_LOW_UNAVAILABLE': 'model_config'}
    code = str(error) if isinstance(error, ValueError) and str(error) in fields else 'LAUNCH_SELECTION_INVALID'
    return {'code': code, 'stage': 'selection', 'field': fields.get(code, 'selection') if not isinstance(error, SelectionError) else error.field,
            'reason': error.reason if isinstance(error, SelectionError) else 'unknown'}


def launch_selection(settings, request):
    """解析非秘密选择，复用 profile 校验与快照。"""
    source = filtered_environment(os.environ)
    saved = request.get('saved')
    if saved:
        regular(Path(saved['modelConfig']))
        source['OPENCODE_MODULE_CONFIG'] = saved['modelConfig']
    config_path = source.get('OPENCODE_MODULE_CONFIG')
    failed = False
    try:
        if config_path:
            config = json.loads(Path(config_path).read_text())
        elif settings.get('runtime_profile') == 'env':
            config = json.loads((VERSION / 'profile-env.json').read_text())
        else:
            raise ValueError('TASK_MODEL_CONFIG_REQUIRED')
    except (OSError, json.JSONDecodeError):
        failed = True
    if failed:
        raise SelectionError('model_config', 'read_failed')
    profile = saved['modelProfile'] if saved else 'external' if config_path else 'env'
    default = saved['model'] if saved else profiles.selection(config.get('model'))
    provider, model = default['id'].split('/', 1)
    target = request.get('provider', provider) + '/' + request.get('model', model)
    changed = target != default['id'] if saved else 'provider' in request or 'model' in request
    variant = request.get('variant', default.get('variant') if saved and not changed else None)
    if profile == 'env':
        if target.split('/', 1)[0] not in profiles.PROVIDERS:
            raise SelectionError('provider', 'invalid')
        current = profiles.configuration(source, VERSION, target.split('/', 1)[0])
        if not saved:
            config = current
    model = profiles.task_configuration(config, target if changed or saved else None, variant)
    failed = False
    try:
        snapshot = profiles.materialize(Path(settings['install_root']), settings['workspace_id'], config)
    except (OSError, ValueError, KeyError, TypeError):
        failed = True
    if failed:
        raise SelectionError('model_config', 'snapshot_failed')
    return {'model': model, 'modelConfig': str(snapshot), 'modelProfile': profile}


def main():
    os.umask(0o077)
    tool, arguments = sys.argv[1], sys.argv[2:]
    readonly = tool == 'opencode-task' and (arguments[:1] in (['list'], ['status'], ['result'], ['doctor'])
                                           or not arguments or arguments == ['help'] or profiles.harmless(arguments))
    if readonly:
        from diagnostics import ReadError, doctor, error_code, read_json, task_root
        try:
            field = 'settings'
            settings = read_json(VERSION / 'settings.json')
            root = Path(settings['install_root'])
            if arguments in (['doctor'], ['doctor', '--quick']):
                value = doctor(root, VERSION, quick=arguments == ['doctor', '--quick'])
                print(json.dumps(value, ensure_ascii=False))
                return 0 if value['ok'] else 1
            if arguments[:1] == ['doctor'] and not profiles.harmless(arguments):
                raise ReadError('INVALID_ARGUMENTS')
            if arguments[:1] in (['list'], ['status'], ['result']) and not profiles.harmless(arguments):
                field = 'task_store'
                task_root(root)
            # 查询没有初始化、锁文件或 profile materialize；Node 只运行命令投影。
            binary = VERSION / 'node/bin/node'
            field = 'installation'
            regular(binary)
            child = environment(os.environ, root, arguments=['--help'])
            os.execve(binary, [str(binary), str(VERSION / 'task-cli.mjs'), *arguments], child)
        except (OSError, ValueError, KeyError, TypeError, ImportError) as error:
            code = error_code(error)
            print(json.dumps({'error': {'code': code, 'stage': 'read' if field == 'task_store' else 'runtime', 'field': field,
                                       'category': 'storage', 'reason': 'unknown',
                                       'action': 'inspect_record' if field == 'task_store' else 'check_installation',
                                       'hint': '核对所列安装或存储项；查询不会创建目录、恢复或改写旧记录。缺失记录不授权重放。'}}, ensure_ascii=False), file=sys.stderr)
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
            print(json.dumps(launch_selection(settings, json.loads(sys.stdin.buffer.read(65537)))))
            return 0
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(json.dumps({'error': selection_diagnostic(error)}))
            return 1
    task_arguments = arguments
    if tool == 'opencode-task':
        tasks = root / 'runtime/tasks-v3'
        tasks.mkdir(mode=0o700, exist_ok=True)
        sync_directory(tasks.parent)
        if arguments[:1] == ['_run']:
            if len(arguments) < 2 or not re.fullmatch(r'task_[a-f0-9]{64}', arguments[1]):
                raise ValueError('invalid task control')
            task_dir = tasks / arguments[1]
            lockpath = task_dir / 'control.lock'
            regular(task_dir / 'task.json')
        task_arguments = ['--help']  # 控制/恢复免凭据；实际 agent 启动才校验已存选择的环境。
        if arguments[:1] == ['_run']:
            task_lock = os.open(lockpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            regular(lockpath)
            if os.fstat(task_lock).st_mode & 0o077:
                raise ValueError('task lock must be private')
            try:
                fcntl.flock(task_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                if '--ready' in arguments[2:]:
                    os.write(3, b'{"already_running":true}\n')
                return
            os.set_inheritable(task_lock, True)
    if tool == 'opencode-task' and arguments[:1] == ['launch']:
        # Git 沿调用者的 HOME/SSH/PATH；选择和 agent 再走各自的模块环境。
        caller_paths = {'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR'}
        child = filtered_environment(os.environ, caller_paths)
        child = git_ssh.environment(child, root)
    else:
        child = environment(os.environ, root, profile, settings['workspace_id'], task_arguments, task)
    if tool == 'opencode' and 'acp' in arguments and not child.get('OPENCODE_ACP_REQUIRED_MODEL'):
        raise ValueError('ACP requires an explicit provider/model from config or environment')
    if tool == 'opencode':
        binary, argv = VERSION / 'opencode', opencode_arguments(arguments)
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
        if sys.argv[1:2] == ['opencode-task']:
            print(json.dumps({'error': selection_diagnostic(error)}), file=sys.stderr)
        else:
            print(str(error) + '; supply valid values at launch (values hidden).', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        if sys.argv[1:2] == ['opencode-task']:
            print(json.dumps({'error': {'code': 'TASK_OPERATION_FAILED', 'stage': 'runtime', 'field': 'installation',
                                       'category': 'unknown', 'reason': 'unknown', 'action': 'check_installation',
                                       'hint': '任务 launcher 拒绝运行，底层类别未知；核对私有安装和配置，保留原 task，不自动重发。'}}, ensure_ascii=False),
                  file=sys.stdout if sys.argv[2:3] == ['_selection'] else sys.stderr)
        else:
            print('OpenCode launcher refused: check private state and explicit runtime configuration (values hidden).', file=sys.stderr)
        sys.exit(1)
