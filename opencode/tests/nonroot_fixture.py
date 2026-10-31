"""普通 UID 的隔离验收；由 test_nonroot.py 准备并降权。"""
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

import test_install as fixtures
from bootstrap_fixture import render, verify_startup
from test_diagnostics import snapshot


def main(work, node, pvc):
    assert os.getuid() == os.geteuid() == 65534
    fixture = fixtures.InstallerTests()
    fixture.setUp()
    try:
        # 通过真实 env bash -c 参数路径启动，并核对缓存及旧 task/session/cache 原字节。
        for mode in ('home', 'dedicated'):
            target = work / mode
            fixture.bundle['config']['install_root'] = '' if mode == 'home' else str(target / 'mount/toolset')
            result = verify_startup(render(fixture.bundle), target)
            assert result['uid'] == 65534 and result['startup_recover_invocations'] == 0

        fixture.root = pvc / 'toolset'
        fixture.bundle['config']['install_root'] = str(fixture.root)
        fixture.install()
        fixture.install()
        assert fixture.downloads == 2
        root = fixture.root
        version = (root / 'active').resolve()
        assert root.stat().st_uid == 65534 and root.stat().st_mode & 0o777 == 0o700
        # 只读路径使用真实私有 Node；不模拟 Node 的命令投影。
        shutil.copyfile(node, version / 'node/bin/node')
        (version / 'node/bin/node').chmod(0o700)
        manifest = json.loads((version / 'installed.json').read_text())
        manifest['files'] = fixtures.installer.inventory(version)
        (version / 'installed.json').write_text(json.dumps(manifest))

        def query(*args, ok=True):
            response = subprocess.run([str(root / 'bin/opencode-task'), *args], cwd=work,
                                      env={'PATH': '/usr/bin:/bin', 'OPENCODE_MODULE_CONFIG': '/PRIVATE-DO-NOT-OPEN'},
                                      capture_output=True, text=True, timeout=10)
            assert response.returncode == (0 if ok else 1), response.stdout + response.stderr
            assert 'PRIVATE-' not in response.stdout + response.stderr
            return json.loads(response.stdout if response.stdout else response.stderr)

        for args in (('doctor',), ('doctor', '--quick')):
            before = snapshot(root)
            value = query(*args)
            assert value['ok'] and not value['runtime']['executed']
            assert snapshot(root) == before

        tasks = root / 'runtime/tasks'
        assert not tasks.exists()
        before = snapshot(root)
        for args in (('list',), ('status', 'task_' + 'a' * 64)):
            assert query(*args, ok=False)['error']['code'] == 'TASK_STORE_MISSING'
        assert snapshot(root) == before and not tasks.exists()
        tasks.mkdir(mode=0o700)
        (tasks / 'owner.json').write_text(json.dumps({'schema': 1, 'uid': os.getuid(), 'workspace_id': fixture.bundle['config']['workspace_id']}))
        (tasks / 'owner.json').chmod(0o600)

        calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(True)
                self.send_response(500)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            task_id = 'task_' + 'a' * 64
            task = tasks / task_id
            task.mkdir(mode=0o700)
            record = task / 'task.json'
            record.write_text(json.dumps({'version': 2, 'id': task_id, 'requestId': 'fixture-request',
                'cwd': str(work), 'prompt': 'synthetic prompt', 'sessionKey': 'fixture-session',
                'model': {'id': 'codex/gpt-6.1-sol', 'variant': 'max'},
                'modelConfig': str(root / 'runtime/fixture-config.json'), 'modelProfile': 'env',
                'permissions': {'mode': 'deny-all', 'policy': {}}, 'createdAt': 1000,
                'progress': {'at': 1000, 'tick': 0, 'clock': None}, 'noProgressMs': 900000,
                'result': {'status': 'success', 'output': 'sealed fixture output', 'truncated': False,
                           'at': 2000, 'source': 'turn.result', 'outputSource': 'assistant_output'},
                'state': 'completed', 'callbackState': 'outbox', 'notificationKind': 'request_result', 'callback': {'callback_id': 'tcb_' + 'q' * 43,
                'callback_url': f'http://127.0.0.1:{server.server_port}/api/agents/task-callbacks'},
                'body': json.dumps({'version': 1, 'callback_id': 'tcb_' + 'q' * 43,
                                    'status': 'success', 'output': 'sealed fixture output'}), 'nextAttemptAt': 0}))
            record.chmod(0o600)
            before = snapshot(root)
            page = query('list')
            assert page['items'] and page['items'][0]['task_id'] == task_id, page['errors']
            inspected = query('status', task_id)
            assert inspected['result_status'] == 'success'
            assert inspected['callback_state'] == 'outbox'
            assert snapshot(root) == before and not calls
            record.chmod(0o640)
            assert query('status', task_id, ok=False)['error']['code'] == 'UNSAFE_TASK_FILE'
            record.chmod(0o600)
            assert not (tasks / 'submit.lock').exists()
            assert not (root / 'runtime/module-profiles').exists()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

        (version / 'node/bin/node').unlink()
        before = snapshot(root)
        assert not query('doctor', '--quick', ok=False)['ok']
        assert query('list', ok=False)['error']['code'] == 'MISSING'
        assert snapshot(root) == before

        # HOME 与 UID 是独立的私有边界，不能借 PVC group 例外放宽。
        fixture.home.chmod(0o770)
        try:
            try:
                fixture.install()
            except ValueError as error:
                assert 'HOME' in str(error)
            else:
                raise AssertionError('group-writable HOME was accepted')
        finally:
            fixture.home.chmod(0o700)
        owner = root / 'owner.json'
        saved = owner.read_bytes()
        value = json.loads(saved)
        value['uid'] = 0
        owner.write_text(json.dumps(value))
        try:
            try:
                fixture.install()
            except ValueError as error:
                assert 'different UID or workspace' in str(error)
            else:
                raise AssertionError('foreign UID marker was accepted')
        finally:
            owner.write_bytes(saved)
        print('nonroot readonly/startup/cache/trust: passed; uid=65534')
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main(*(Path(value) for value in sys.argv[1:]))
