"""Run an owned health probe without delaying supervisor stop propagation."""
import subprocess
import time


def health_probe(args, *, env, cwd, deadline, stop_requested):
    probe = subprocess.Popen(
        args,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    probe_deadline = min(deadline, time.monotonic() + 10)
    try:
        while probe.poll() is None:
            if stop_requested() or time.monotonic() >= probe_deadline:
                probe.terminate()
                try:
                    probe.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    probe.kill()
                    probe.communicate()
                return None
            time.sleep(0.05)
        probe.communicate()
        return probe
    except BaseException:
        if probe.poll() is None:
            probe.kill()
        probe.communicate()
        raise
