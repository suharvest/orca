"""Exercise the rebuilt production launcher and PTYs in signed, windowless private app copies."""
import argparse
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from run import command, requirement


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path, default=pathlib.Path('/Applications/Orca.app'))
    parser.add_argument('--identity', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Requires macOS and an existing Orca FDA grant')
    repo = pathlib.Path(__file__).resolve().parents[3]
    root = pathlib.Path(tempfile.mkdtemp(prefix='orca-tcc-product-', dir='/tmp'))
    root.chmod(0o700)
    (root / 'test-owned').write_text(str(uuid.uuid4()))
    source = root / 'Orca.app'
    profile = root / 'profile'
    profile.mkdir(mode=0o700)
    driver = root / 'driver.cjs'
    command(str(repo / 'node_modules/.bin/esbuild'), str(pathlib.Path(__file__).with_name('product-launch.ts')), '--bundle', '--platform=node', '--external:electron', '--external:original-fs', '--outfile=' + str(driver))
    original_requirement = requirement(args.app)
    command('/bin/cp', '-cR', str(args.app), str(source))
    built = repo / 'out/main'
    if not (built / 'daemon-entry.js').exists():
        raise RuntimeError('Build Orca before running this test')
    target = source / 'Contents/Resources/app.asar.unpacked/out/main'
    shutil.rmtree(target)
    shutil.copytree(built, target)
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node is required to apply the packaging hook')
    packaging = repo / 'config/scripts/macos-folder-usage-descriptions.cjs'
    command(node, '-e', "require(process.argv[1]).applyMacHelperFolderUsageDescriptions(process.argv[2], 'Orca')", str(packaging), str(source))
    descriptions = json.loads(command(node, '-e', "console.log(JSON.stringify(require(process.argv[1]).MACOS_FOLDER_USAGE_DESCRIPTIONS))", str(packaging)).stdout)
    info_path = source / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(descriptions)
    info_path.write_bytes(plistlib.dumps(info))
    for helper in (source / 'Contents/Frameworks').glob('Orca Helper*.app'):
        before = requirement(helper)
        helper_entitlements = root / 'helper-entitlements.plist'
        helper_entitlements.write_text(command('/usr/bin/codesign', '--display', '--entitlements', '-', '--xml', str(helper)).stdout)
        command('/usr/bin/codesign', '--force', '--sign', args.identity, '--options', 'runtime', '--entitlements', str(helper_entitlements), str(helper))
        if requirement(helper) != before:
            raise RuntimeError('Packaging changed a Helper designated requirement')
    entitlements = root / 'entitlements.plist'
    entitlements.write_text(command('/usr/bin/codesign', '--display', '--entitlements', '-', '--xml', str(args.app)).stdout)
    for version in range(3):
        bundle = source if version == 0 else root / ('incoming-' + str(version) + '.app')
        if version:
            command('/bin/cp', '-cR', str(source), str(bundle))
        command('/usr/bin/plutil', '-replace', 'CFBundleVersion', '-string', '13921.' + str(version) + '.' + str(time.time_ns()), str(bundle / 'Contents/Info.plist'))
        command('/usr/bin/codesign', '--force', '--sign', args.identity, '--options', 'runtime', '--entitlements', str(entitlements), str(bundle))
        command('/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle))
        if requirement(bundle) != original_requirement:
            raise RuntimeError('Signing changed the installed app designated requirement')
    label = 'com.stablyai.orca.tcc-product-test.' + str(uuid.uuid4())
    service = 'gui/' + str(os.getuid()) + '/' + label
    plist = root / 'launch.plist'
    plist.write_bytes(plistlib.dumps({
        'Label': label,
        'ProgramArguments': [str(source / 'Contents/MacOS/Orca'), str(driver), str(profile)],
        'EnvironmentVariables': {'ELECTRON_RUN_AS_NODE': '1', 'ORCA_BACKGROUND_LAUNCH': '1', 'HOME': str(pathlib.Path.home()), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'},
        'RunAtLoad': True, 'KeepAlive': False, 'AbandonProcessGroup': True,
        'StandardOutPath': str(root / 'product.log'), 'StandardErrorPath': str(root / 'product.log')
    }))
    plist.chmod(0o600)
    try:
        command('/bin/launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist))
        for _ in range(1200):
            state = subprocess.run(['/bin/launchctl', 'print', service], capture_output=True, text=True)
            if '\n\tstate = not running\n' in state.stdout and 'last exit code = ' in state.stdout:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Test did not finish; retained at ' + str(root))
        result = root / 'results.json'
        if not result.exists():
            raise RuntimeError('Product check failed; see ' + str(root / 'product.log'))
        data = json.loads(result.read_text())
        if 'last exit code = 0' not in state.stdout:
            raise RuntimeError('Cleanup failed; see ' + str(root / 'product.log'))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(data, indent=2) + '\n')
        print(json.dumps(data, indent=2))
        return 0
    finally:
        subprocess.run(['/bin/launchctl', 'bootout', service], capture_output=True)
        # Preserve artifacts and runtime on failure or unverified process usage.
        inactive = subprocess.run(['/usr/sbin/lsof', '-F', 'p', '+D', str(root)], capture_output=True, text=True, timeout=10)
        if inactive.returncode == 1 and not inactive.stdout.strip() and not inactive.stderr.strip() and (root / 'results.json').exists():
            shutil.rmtree(root)
        else:
            print('Retained test artifacts: ' + str(root), file=sys.stderr)


if __name__ == '__main__':
    sys.exit(main())
