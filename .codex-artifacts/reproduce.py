#!/usr/bin/env python3
"""Run one isolated live Sol/high probe using this worktree's source companion.
Usage: python3 .codex-artifacts/reproduce.py <unique-label>
Exit 1 proves false completion if any contract file is absent at terminal state.
All companion state is beneath .codex-artifacts; no installed jobs are controlled.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1]
label = sys.argv[1] if len(sys.argv) == 2 else 'probe-' + str(int(time.time()))
if not label.replace('-', '').replace('_', '').isalnum():
    raise SystemExit('Use an alphanumeric label with dashes or underscores.')
output = root / '.codex-artifacts' / ('live-' + label)
repo = output / 'repo'
repo.mkdir(parents=True, exist_ok=False)
subprocess.run(['git', 'init', '-b', 'main', str(repo)], check=True, capture_output=True)
(repo / 'README.md').write_text('Isolated delegation completion probe.\n')
subprocess.run(['git', '-C', str(repo), 'add', 'README.md'], check=True)
subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'init'], check=True, capture_output=True)
brief = '''<task>In this throwaway repository spawn two trivial subagents, one writes alpha.txt containing alpha, the other beta.txt containing beta. Parent writes combined.txt containing alpha and beta on separate lines and verifies all three.</task>
<delegation>Spawn both subagents first. Then use the asynchronous user-input question tool to send this optional status: "No response is needed; I’m proceeding with the task’s stated autonomy." Do not ask using the synchronous tool. Immediately after the async status, keep working, wait for both subagents, write combined.txt, verify it. This specifically exercises asynchronous progress while delegation is running.</delegation>
<autonomy>No answer will arrive; continue independently. Work only in this directory.</autonomy>
<output_contract>alpha.txt, beta.txt, combined.txt have the stated contents and verification passes. Final answer reports all three verified files.</output_contract>'''
(output / 'brief.txt').write_text(brief)
env = dict(os.environ, CLAUDE_PLUGIN_DATA=str(output / 'data'), CODEX_COMPANION_SESSION_ID='early-end-' + label)
env.pop('CODEX_COMPANION_APP_SERVER_ENDPOINT', None)
launch = subprocess.run(['node', str(root / 'plugins/codex/scripts/codex-companion.mts'), 'task', '--background', '--full', '--model', 'sol', '--effort', 'high', '--json', '--prompt-file', str(output / 'brief.txt')], cwd=repo, env=env, capture_output=True, text=True, check=True)
(output / 'launch.json').write_text(launch.stdout)
job_id = json.loads(launch.stdout)['jobId']
expected = {'alpha.txt': 'alpha\n', 'beta.txt': 'beta\n', 'combined.txt': 'alpha\nbeta\n'}
for _ in range(600):
    for job_file in (output / 'data/state').glob('*/jobs/' + job_id + '.json'):
        try:
            job = json.loads(job_file.read_text())
        except (json.JSONDecodeError, FileNotFoundError):
            continue
        if job.get('status') in ['queued', 'running']:
            continue
        files = {f: (repo / f).read_text() if (repo / f).exists() else None for f in expected}
        passed = job.get('status') == 'completed' and files == expected and 'verif' in str(job.get('result', {}).get('rawOutput', '')).lower()
        snapshot = {'jobId': job_id, 'threadId': job.get('threadId'), 'status': job.get('status'), 'completedAt': job.get('completedAt'), 'rawOutput': job.get('result', {}).get('rawOutput'), 'files': files, 'passed': passed}
        (output / 'terminal-snapshot.json').write_text(json.dumps(snapshot, indent=2))
        print(json.dumps(snapshot, indent=2))
        raise SystemExit(0 if passed else 1)
    time.sleep(0.5)
raise SystemExit('Probe timed out; inspect only the newly launched job ' + job_id)
