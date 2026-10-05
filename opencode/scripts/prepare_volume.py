"""Explicit root init for one dedicated mounted volume; never relax installer checks."""
import fcntl
import json
import os
import re
import stat
import sys

MOUNT = '/mnt/opencode'
CHILD = 'toolset'
SAFE_MODES = {0o700, 0o750, 0o755, 0o770, 0o775, 0o2770, 0o2775, 0o1770, 0o1777}


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def verify_mount(fd):
    """Linux mount ID ties the opened descriptor to the exact mounted path.

    A directory merely named /mnt/opencode is insufficient, including same-device
    bind mounts for which st_dev alone cannot distinguish a mount boundary.
    """
    with open('/proc/self/fdinfo/' + str(fd)) as stream:
        match = re.search(r'^mnt_id:\s*(\d+)$', stream.read(), re.M)
    if match is None:
        raise ValueError('mount descriptor identity unavailable')
    with open('/proc/self/mountinfo') as stream:
        records = [line.split() for line in stream]
    if not any(parts[0] == match[1] and parts[4] == MOUNT for parts in records if len(parts) > 5):
        raise ValueError('expected the exact dedicated mount')


def child_snapshot(fd, workspace_id):
    names = os.listdir(fd)
    if not names:
        return ()
    if names != [CHILD]:
        raise ValueError('unexpected dedicated-volume content')
    child = os.open(CHILD, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        info = os.fstat(child)
        if stat.S_IMODE(info.st_mode) not in (0o700, 0o2700):
            raise ValueError('existing child must be private')
        uid = info.st_uid
        marker = os.open('owner.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=child)
        try:
            before = os.fstat(marker)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid
                    or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600
                    or before.st_size > 1024):
                raise ValueError('unsafe child owner marker')
            raw = os.read(marker, 1025)
            if identity(before) != identity(os.fstat(marker)):
                raise ValueError('child owner marker changed')
            if json.loads(raw) != {'schema': 1, 'uid': uid, 'workspace_id': workspace_id}:
                raise ValueError('child belongs to another workspace or UID')
        finally:
            os.close(marker)
        entries = os.listdir(child)
        allowed = {'owner.json', 'install.lock', 'status.json', 'versions', 'bin', 'runtime', 'active'}
        if not set(entries) <= allowed:
            raise ValueError('unexpected private-child content')
        snapshot = []
        for name in sorted(entries):
            item = os.stat(name, dir_fd=child, follow_symlinks=False)
            if item.st_uid != uid:
                raise ValueError('foreign child entry')
            if name in ('versions', 'bin', 'runtime'):
                if not stat.S_ISDIR(item.st_mode) or stat.S_IMODE(item.st_mode) not in (0o700, 0o2700):
                    raise ValueError('unsafe child directory')
            elif name == 'active':
                if not stat.S_ISLNK(item.st_mode) or not re.fullmatch(
                        r'versions/v\d+\.\d+\.\d+-ricky\.[1-9]\d*-[0-9a-f]{20}', os.readlink(name, dir_fd=child)):
                    raise ValueError('unsafe active link')
            elif (not stat.S_ISREG(item.st_mode) or item.st_nlink != 1
                  or stat.S_IMODE(item.st_mode) != 0o600):
                raise ValueError('unsafe child file')
            snapshot.append((name, identity(item)))
        if identity(info) != identity(os.fstat(child)) or identity(info) != identity(
                os.stat(CHILD, dir_fd=fd, follow_symlinks=False)):
            raise ValueError('private child changed')
        return (identity(info), tuple(snapshot), raw)
    finally:
        os.close(child)


def prepare(config):
    if (set(config) != {'mount_path', 'install_root', 'workspace_id'}
            or config['mount_path'] != MOUNT or config['install_root'] != MOUNT + '/' + CHILD
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', config['workspace_id'])):
        raise ValueError('only the explicit dedicated mount and private child are supported')
    if os.getuid() != 0 or os.geteuid() != 0:
        raise ValueError('dedicated-volume preparation requires root init')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Descriptors anchor traversal and fchmod. Never reopen an absolute target
        # after validation, and never chmod ancestors or follow substituted links.
        for part in ('mnt', 'opencode'):
            parent = os.fstat(fd)
            if parent.st_uid != 0 or parent.st_mode & 0o022:
                raise ValueError('unsafe dedicated-volume ancestor')
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        info = os.fstat(fd)
        mode = stat.S_IMODE(info.st_mode)
        if info.st_uid != 0 or mode not in SAFE_MODES | {0o777}:
            raise ValueError('unsupported dedicated-volume owner or mode')
        verify_mount(fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = child_snapshot(fd, config['workspace_id'])
        verify_mount(fd)
        if identity(info) != identity(os.fstat(fd)):
            raise ValueError('dedicated volume changed during validation')
        if mode == 0o777:
            os.fchmod(fd, 0o1777)  # The only permitted mutation; never chown/recurse.
            os.fsync(fd)
        if before != child_snapshot(fd, config['workspace_id']):
            # Do not weaken back to 0777: fail init with the sticky protection retained.
            raise ValueError('dedicated-volume content changed during preparation')
        verify_mount(fd)
        print('Dedicated OpenCode volume checked; preparation complete.')
    finally:
        os.close(fd)


def main(config):
    try:
        prepare(config)
    except (OSError, ValueError, KeyError, TypeError):
        print('OpenCode volume preparation refused: check root init, exact mount, ownership and content.', file=sys.stderr)
        return 1
    return 0
