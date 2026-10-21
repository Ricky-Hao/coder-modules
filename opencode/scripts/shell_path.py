"""Append a literal wrappers PATH entry to the actual user's Bash profiles.

Called by the module installer in the same startup execution.
No installer/state access, shell execution, environment snapshot or global writes.
"""
import fcntl
import os
from pathlib import PurePosixPath
import shlex
import stat
import sys


MARKER = b"# >>> coder opencode PATH >>>"
PROFILES = (".bash_profile", ".bash_login", ".profile", ".bashrc")


def signature(info):
    # Reading a profile may update atime; all mutation-relevant fields matter.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def safe_file(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o022
            or info.st_mode & 0o600 != 0o600):
        raise ValueError("profile must be a readable/writable, user-owned regular file")


def home_fd(home):
    path = PurePosixPath(home)
    if not path.is_absolute() or str(path) != home or home == "/" or ".." in path.parts:
        raise ValueError("expected canonical user HOME")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        info = os.fstat(fd)
        if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise ValueError("unsafe HOME ancestor")
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # HOME has no implicit shared-PVC exception. Inspect each opened
            # ancestor, not just the final HOME; sticky /tmp remains legitimate.
            if (info.st_uid not in (0, os.getuid())
                    or info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise ValueError("unsafe HOME ancestor")
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("unsafe HOME ownership/permissions")
        return fd
    except BaseException:
        os.close(fd)
        raise


def install(home, bin_dir):
    path = PurePosixPath(bin_dir)
    if (not path.is_absolute() or str(path) != bin_dir or ".." in path.parts
            or any(char in bin_dir for char in "\n\r\0:")):
        raise ValueError("expected an absolute PATH entry")
    literal = shlex.quote(bin_dir)
    block = ("\n\n" + MARKER.decode() + "\n"
             'case ":${PATH-}:" in\n'
             f"  *:{literal}:*) ;;\n"
             f'  *) export PATH="${{PATH-}}":{literal} ;;\n'
             "esac\n# <<< coder opencode PATH <<<\n").encode()
    directory = home_fd(home)
    opened = []
    try:
        # Serialize cooperating startup invocations without creating a lock file.
        fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = {}
        for name in PROFILES:
            try:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                before[name] = None
            else:
                safe_file(info)  # Reject links/foreign files, even at lower precedence.
                before[name] = signature(info)
        # Never create a higher-precedence file that would mask an existing profile.
        login = next((name for name in PROFILES[:3] if before[name] is not None), ".profile")
        pending = []
        for name in (login, ".bashrc"):
            fd = None
            if before[name] is not None:
                fd = os.open(name, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, dir_fd=directory)
                opened.append(fd)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if signature(os.fstat(fd)) != before[name]:
                    raise ValueError("profile changed while opening")
                chunks = []
                while chunk := os.read(fd, 65536):
                    chunks.append(chunk)
                content = b"".join(chunks)
                if MARKER in content:
                    if content.count(MARKER) != 1 or not content.endswith(block):
                        raise ValueError("managed block changed or is no longer last")
                    continue
            pending.append((name, fd))
        # Validate the entire selection again before the first write.
        for name in PROFILES:
            try:
                now = signature(os.stat(name, dir_fd=directory, follow_symlinks=False))
            except FileNotFoundError:
                now = None
            if now != before[name]:
                raise ValueError("profile selection changed concurrently")
        for name, fd in pending:
            if fd is None:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
                opened.append(fd)
            elif signature(os.fstat(fd)) != before[name] or signature(
                    os.stat(name, dir_fd=directory, follow_symlinks=False)) != before[name]:
                raise ValueError("profile changed before append")
            # Append only: preserve every existing byte, inode, owner and mode.
            remaining = memoryview(block)
            while remaining:
                remaining = remaining[os.write(fd, remaining):]
            os.fsync(fd)
        os.fsync(directory)
    finally:
        for fd in opened:
            os.close(fd)
        os.close(directory)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected wrappers bin directory")
        install(os.environ["HOME"], sys.argv[1])
    except (OSError, ValueError, KeyError) as error:
        sys.exit("OpenCode PATH integration refused unsafe/changed HOME or profiles ("
                 + type(error).__name__ + ").")
