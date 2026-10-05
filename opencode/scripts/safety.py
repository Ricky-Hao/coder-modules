"""Private state primitives shared by the installer and runtime."""
import json
import os
from pathlib import Path
import stat
import tempfile


def directory(path, create=False):
    path = Path(path)
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('directory must be private and owned by this UID')
    return path


def regular(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise ValueError('unsafe managed file')


def ancestors(path):
    # Every ancestor must prevent replacement by untrusted writers. Sticky shared
    # directories protect our root/current-UID children (e.g. /tmp).
    # Only the immediate installation parent may be nonsticky group-writable:
    # an intentional PVC boundary whose group includes us and is fully trusted.
    groups = {os.getegid(), *os.getgroups()}
    for parent in Path(path).parents:
        info = parent.lstat()
        sticky = bool(info.st_mode & stat.S_ISVTX)
        shared_mount = parent == Path(path).parent and info.st_gid in groups
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid())
                or not sticky and (info.st_mode & 0o002
                                   or info.st_mode & 0o020 and not shared_mount)):
            raise ValueError('unsafe installation parent')
    parent = Path(path).parent
    info = parent.lstat()
    if not info.st_mode & 0o222 or not os.access(parent, os.W_OK | os.X_OK, effective_ids=True):
        raise ValueError('installation parent must already be writable by this user')


def write_json(path, value):
    path = Path(path)
    if os.path.lexists(path):
        regular(path)
    fd, temp = tempfile.mkstemp(prefix='.json-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def owner(root, workspace):
    directory(root)
    regular(root / 'owner.json')
    if json.loads((root / 'owner.json').read_text()) != {
            'schema': 1, 'uid': os.getuid(), 'workspace_id': workspace}:
        raise ValueError('state belongs to a different UID or workspace')
