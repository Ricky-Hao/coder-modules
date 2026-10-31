#!/usr/bin/env python3
"""本机只读诊断。"""
import ctypes
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from safety import ancestors, directory


class ReadError(ValueError):
    pass


@contextmanager
def private_fd(path, maximum):
    # 同 fd 校验；原子替换有界重开。
    for _ in range(3):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ReadError('UNSAFE_FILE')
            if info.st_nlink == 0:
                continue
            if info.st_nlink != 1:
                raise ReadError('UNSAFE_FILE')
            if info.st_size > maximum:
                raise ReadError('READ_LIMIT')
            yield fd, info
            return
        finally:
            os.close(fd)
    raise ReadError('FILE_CHANGED')


def read_bytes(path, maximum):
    with private_fd(path, maximum) as (fd, _):
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
            if not chunk:
                return bytes(data)
            data.extend(chunk)
        raise ReadError('READ_LIMIT')


def read_json(path, maximum=65536):
    try:
        return json.loads(read_bytes(path, maximum))
    except (UnicodeError, json.JSONDecodeError):
        raise ReadError('INVALID_RECORD') from None


def error_code(error):
    if isinstance(error, ReadError):
        return str(error)
    if isinstance(error, FileNotFoundError):
        return 'MISSING'
    if isinstance(error, OSError):
        return 'UNSAFE_FILE' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'READ_FAILED'
    return 'INVALID_RECORD'


def task_root(root, settings):
    try:
        ancestors(root)
        for folder in (root, root / 'runtime', root / 'runtime/tasks'):
            directory(folder)
        expected = {'schema': 1, 'uid': os.getuid(), 'workspace_id': settings['workspace_id']}
        for marker in (root / 'owner.json', root / 'runtime/tasks/owner.json'):
            if read_json(marker) != expected:
                raise ReadError('OWNER_MISMATCH')
    except FileNotFoundError:
        raise ReadError('TASK_STORE_MISSING') from None


class Dirent(ctypes.Structure):
    # Linux x86-64 glibc ABI。
    _fields_ = [('ino', ctypes.c_ulong), ('offset', ctypes.c_long),
                ('length', ctypes.c_ushort), ('type', ctypes.c_ubyte), ('name', ctypes.c_char * 256)]


def directory_page(root, cursor, maximum):
    """按 libc cookie 续读。"""
    if not 1 <= maximum <= 200:
        raise ReadError('INVALID_ARGUMENTS')
    directory(root)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fdopendir.argtypes, libc.fdopendir.restype = [ctypes.c_int], ctypes.c_void_p
    libc.readdir.argtypes, libc.readdir.restype = [ctypes.c_void_p], ctypes.POINTER(Dirent)
    libc.telldir.argtypes, libc.telldir.restype = [ctypes.c_void_p], ctypes.c_long
    libc.seekdir.argtypes = [ctypes.c_void_p, ctypes.c_long]
    libc.closedir.argtypes = [ctypes.c_void_p]
    stream = libc.fdopendir(fd)
    if not stream:
        os.close(fd)
        raise ReadError('DIRECTORY_READ_FAILED')
    try:
        def identity():
            info = os.fstat(fd)
            return [str(value) for value in (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns)]
        before = identity()
        if cursor and cursor['directory'] != before:
            raise ReadError('CURSOR_STALE')
        if cursor:
            libc.seekdir(stream, int(cursor['position']))
        entries, ended = [], False
        for _ in range(maximum):
            ctypes.set_errno(0)
            entry = libc.readdir(stream)
            if not entry:
                if ctypes.get_errno():
                    raise ReadError('DIRECTORY_READ_FAILED')
                ended = True
                break
            # 隐藏其他名字，仍计入扫描。
            name = os.fsdecode(entry.contents.name)
            entries.append({'id': name if re.fullmatch(r'task_[a-f0-9]{64}', name) else None,
                            'position': str(libc.telldir(stream))})
        if before != identity():
            raise ReadError('CURSOR_STALE')
        return {'directory': before, 'entries': entries, 'ended': ended}
    finally:
        libc.closedir(stream)


def doctor(root, launched_version=None):
    import install
    import profiles
    files = dict.fromkeys(sorted(install.PAYLOAD_FILES | {'metadata.json', 'settings.json',
                         'node_modules/acpx/package.json', 'node_modules/acpx/dist/cli.js'}), 1024 * 1024)
    files.update({'opencode': 352 * 1024 * 1024, 'node/bin/node': 160 * 1024 * 1024})
    names = ['active_launcher', 'installed_inventory', 'settings', 'private_layout', *files,
             'runtime_pins', 'bin/opencode', 'bin/acpx', 'bin/opencode-task', 'module_profile', 'task_capabilities']
    checks = {name: {'name': name, 'status': 'not_checked'} for name in names}
    actual = profile = features = None
    current = 'active_launcher'

    def step(name):
        nonlocal current
        checks[current]['status'] = 'ok'
        current = name

    def require(condition):
        if not condition:
            raise ReadError('INSTALLATION_MISMATCH')

    def verify(name, maximum):
        expected = manifest['files'][name]
        file = version / name
        for parent in list(file.parents)[:len(Path(name).parts) - 1]:
            directory(parent)
        with private_fd(file, maximum) as (fd, info):
            digest, count = hashlib.sha256(), 0
            while chunk := os.read(fd, min(65536, maximum + 1 - count)):
                count += len(chunk)
                if count > maximum:
                    raise ReadError('READ_LIMIT')
                digest.update(chunk)
            require(digest.hexdigest() == expected['sha256'] and stat.S_IMODE(info.st_mode) == expected['mode'])
            require(name not in ('opencode', 'node/bin/node') or info.st_mode & 0o100)

    try:
        ancestors(root)
        directory(root)
        target = os.readlink(root / 'active')
        require(re.fullmatch(r'versions/v\d+\.\d+\.\d+-ricky\.[1-9]\d*-[0-9a-f]{20}', target))
        directory(root / 'versions')
        version = directory(root / target)
        require(launched_version is None or version == launched_version)
        step('installed_inventory')
        manifest = read_json(version / 'installed.json', 8 * 1024 * 1024)
        step('settings')
        settings = read_json(version / 'settings.json')
        install.validate(settings)
        step('private_layout')
        require(settings['install_root'] == str(root) and read_json(root / 'owner.json') == {
            'schema': 1, 'uid': os.getuid(), 'workspace_id': settings['workspace_id']})
        for name in ('bin', 'runtime', *('runtime/' + n for n in ('home', 'config', 'data', 'cache', 'state', 'tmp'))):
            directory(root / name)
        for name, maximum in files.items():
            step(name)
            verify(name, maximum)
        step('runtime_pins')
        identity = manifest['identity']
        meta = read_json(version / 'metadata.json')
        acpx = read_json(version / 'node_modules/acpx/package.json')
        require(all(identity[k] == settings[k] for k in ('release_tag', 'release_sha256')))
        require(identity['node'] == install.NODE_VERSION and identity['acpx'] == acpx['version'] == install.ACPX_VERSION)
        require(meta['source_tag'] == settings['release_tag'] and meta['version'] == settings['release_tag'][1:]
                and meta['binary_sha256'] == manifest['files']['opencode']['sha256'])
        actual = {'opencode': settings['release_tag'], 'node': install.NODE_VERSION, 'acpx': install.ACPX_VERSION,
                  'evidence': 'installed_inventory_and_metadata', 'executed': False}
        for tool in ('opencode', 'acpx', 'opencode-task'):
            step('bin/' + tool)
            with private_fd(root / 'bin' / tool, 8192) as (fd, info):
                require(os.read(fd, 8193).decode() == install.wrapper(root, tool) and info.st_mode & 0o100)
        step('module_profile')
        profile = profiles.information(settings.get('runtime_profile', 'none'),
                                       bool(os.environ.get('OPENCODE_MODULE_CONFIG')), os.environ, version)
        step('task_capabilities')
        status = read_json(root / 'status.json')
        require(status['state'] == 'ready' and status['features']['task_callbacks'] == 1)
        require(status['active'] == os.readlink(root / 'active') == target and status['versions'] == {
            key: actual[key] for key in ('opencode', 'node', 'acpx')})
        features = {'task_callbacks': 1, 'readonly_commands': ['list', 'inspect', 'doctor', 'status', 'result']}
        checks[current]['status'] = 'ok'
    except (OSError, ValueError, KeyError, TypeError) as error:
        checks[current].update(status='failed', code=error_code(error))
    return {'version': 1, 'read_only': True, 'ok': all(c['status'] == 'ok' for c in checks.values()),
            'checks': list(checks.values()), 'runtime': actual, 'features': features, 'profile': profile,
            'launcher': 'bin/opencode-task -> active/runtime.py',
            'not_checked': ['provider_health', 'mcp_health', 'external_config_contents', 'agent_execution',
                            'task_history', 'full_dependency_inventory', 'runtime_version_execution'],
            'guidance': '遇错即停；后续未检。核对私有安装。'}


def main():
    try:
        if len(sys.argv) == 5 and sys.argv[1] == '_page':
            value = directory_page(Path(sys.argv[2]), json.loads(sys.argv[3]), int(sys.argv[4]))
        elif len(sys.argv) == 3 and sys.argv[1] == '--root':
            value = doctor(Path(sys.argv[2]))
        else:
            raise ReadError('INVALID_ARGUMENTS')
        print(json.dumps(value, ensure_ascii=False))
        return 0 if value.get('ok', True) else 1
    except (OSError, ValueError, KeyError, TypeError, ImportError) as error:
        print(json.dumps({'error': {'code': error_code(error), 'hint': '核对命令及私有安装记录；不要修改历史记录来消除诊断。'}}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
