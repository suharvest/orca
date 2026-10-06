"""Windowless, signed update-gap experiment. Only touches private app copies and reads one FDA byte."""

import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120)


def requirement(bundle):
    result = command('/usr/bin/codesign', '--display', '-r-', str(bundle))
    return next(line for line in (result.stderr + '\n' + result.stdout).splitlines() if line.startswith('designated => '))


def probe(runtime, kind='node'):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(20)
        connection.connect(str(runtime / 'daemon.sock'))
        connection.sendall(json.dumps({'type': kind}).encode())
        result = json.loads(connection.recv(4096))
        return result['code']


def launch(bundle, role, root, jobs):
    runtime = root / str(uuid.uuid4())[:8]
    runtime.mkdir(mode=0o700)
    label = 'com.stablyai.orca.tcc-update-test.' + str(uuid.uuid4())
    domain = 'gui/' + str(os.getuid())
    script = pathlib.Path(__file__).with_name(role + '.cjs').resolve()
    plist = runtime / 'launch.plist'
    plist.write_bytes(plistlib.dumps({
        'Label': label,
        'ProgramArguments': [str(bundle / 'Contents/MacOS/Orca'), str(script), str(runtime)],
        'EnvironmentVariables': {'ELECTRON_RUN_AS_NODE': '1', 'ORCA_BACKGROUND_LAUNCH': '1'},
        'RunAtLoad': True,
        'KeepAlive': False,
        'AbandonProcessGroup': True,
        'StandardErrorPath': str(runtime / 'startup.log'),
    }))
    plist.chmod(0o600)
    command('/bin/launchctl', 'bootstrap', domain, str(plist))
    jobs.append((domain + '/' + label, runtime))
    for _ in range(200):
        if (runtime / 'ready.json').exists():
            return runtime
        if (runtime / 'error.json').exists():
            raise RuntimeError((runtime / 'error.json').read_text())
        time.sleep(0.1)
    raise RuntimeError('Test daemon did not become ready; see ' + str(runtime / 'startup.log'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path, default=pathlib.Path('/Applications/Orca.app'))
    parser.add_argument('--identity', required=True, help='Developer ID signing identity matching the app')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This experiment requires macOS with Orca already granted Full Disk Access')
    root = pathlib.Path(tempfile.mkdtemp(prefix='orca-tcc-update-', dir='/tmp'))
    root.chmod(0o700)
    source = root / 'Orca.app'
    incoming = root / 'Incoming.app'
    stable = root / 'Stable' / 'Orca.app'
    jobs = []
    results = {'platform': command('/usr/bin/sw_vers', '-productVersion').stdout.strip(), 'observations': {}}
    observations = results['observations']
    try:
        original_requirement = requirement(args.app)
        command('/bin/cp', '-cR', str(args.app), str(source))
        command('/usr/bin/plutil', '-replace', 'CFBundleVersion', '-string', '13921.' + str(time.time_ns()), str(source / 'Contents/Info.plist'))
        entitlements = root / 'entitlements.plist'
        entitlements.write_text(command('/usr/bin/codesign', '--display', '--entitlements', '-', '--xml', str(args.app)).stdout)
        command('/usr/bin/codesign', '--force', '--sign', args.identity, '--options', 'runtime', '--entitlements', str(entitlements), str(source))
        command('/usr/bin/codesign', '--verify', '--deep', '--strict', str(source))
        if requirement(source) != original_requirement:
            raise RuntimeError('Test signing changed the app designated requirement')
        results['requirement_sha256'] = hashlib.sha256(original_requirement.encode()).hexdigest()
        warm = launch(source, 'parent', root, jobs)
        observations['before_update_helper'] = probe(warm)
        if observations['before_update_helper'] != 'ok':
            raise RuntimeError('Baseline access is unavailable; no permission is changed by this test')
        cold = launch(source, 'parent', root, jobs)
        stable.parent.mkdir()
        command('/bin/cp', '-cR', str(source), str(stable))
        isolated = launch(stable, 'daemon', root, jobs)
        command('/bin/cp', '-cR', str(source), str(incoming))
        parked = root / 'com.stablyai.orca.ShipIt.old' / 'Orca.app'
        parked.parent.mkdir()
        source.rename(parked)
        incoming.rename(source)
        shutil.rmtree(parked.parent)
        observations['warm_helper_after_image_deletion'] = probe(warm)
        gap = root / 'com.stablyai.orca.ShipIt.gap'
        source.rename(gap)
        try:
            observations['cold_helper_during_gap'] = probe(cold, 'native')
            observations['stable_daemon_during_gap'] = probe(isolated)
        finally:
            gap.rename(source)
        observations['cold_helper_after_path_restored'] = probe(cold)
        fresh = launch(source, 'parent', root, jobs)
        observations['fresh_helper_after_path_restored'] = probe(fresh)
        observations['stable_daemon_after_path_restored'] = probe(isolated)
        results['reproduced'] = (
            observations['cold_helper_during_gap'] == 'EPERM'
            and observations['cold_helper_after_path_restored'] == 'EPERM'
            and observations['fresh_helper_after_path_restored'] == 'ok'
        )
        results['stable_launch_passed'] = (
            observations['stable_daemon_during_gap'] == 'ok'
            and observations['stable_daemon_after_path_restored'] == 'ok'
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(results, indent=2))
    finally:
        all_exited = True
        for service, runtime in jobs:
            try:
                probe(runtime, 'exit')
            except (OSError, KeyError):
                pass
            ready_file = runtime / 'ready.json'
            if ready_file.exists():
                pid = json.loads(ready_file.read_text())['pid']
                for _ in range(100):
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(0.05)
                else:
                    all_exited = False
            subprocess.run(['/bin/launchctl', 'bootout', service], capture_output=True)
        if all_exited:
            shutil.rmtree(root)
        else:
            print('Preserved runtime for an unverified process: ' + str(root), file=sys.stderr)
    return 0 if results.get('reproduced') and results.get('stable_launch_passed') else 2


if __name__ == '__main__':
    sys.exit(main())
