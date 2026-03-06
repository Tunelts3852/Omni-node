#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import tempfile
from typing import Optional

try:
    import resource
except ImportError:  # pragma: no cover
    resource = None


def _apply_limits(mem_limit_mb: int, cpu_limit_sec: int) -> None:
    if resource is None:
        return

    mem_bytes = mem_limit_mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
    except (ValueError, OSError):
        pass

    try:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit_sec, cpu_limit_sec))
    except (ValueError, OSError):
        pass


def _run_script(
    script_path: str,
    timeout_sec: int,
    mem_limit_mb: int,
    cpu_limit_sec: int,
) -> dict:
    preexec_fn = None
    if os.name == "posix":
        def _safe_preexec() -> None:
            try:
                _apply_limits(mem_limit_mb, cpu_limit_sec)
            except Exception:
                return

        preexec_fn = _safe_preexec

    try:
        result = subprocess.run(
            [sys.executable, script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec,
            preexec_fn=preexec_fn,
            check=False,
        )
        status = "ok" if result.returncode == 0 else "error"
        return {
            "status": status,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "timeout",
            "exit_code": None,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "error",
            "exit_code": None,
            "stdout": "",
            "stderr": str(exc),
        }


def _load_script(code: Optional[str], script: Optional[str]) -> tuple[str, Optional[str]]:
    if script:
        return script, None

    temp_file = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)
    temp_file.write(code or "")
    temp_file.flush()
    temp_file.close()
    return temp_file.name, temp_file.name


def main() -> int:
    parser = argparse.ArgumentParser(description="Omni-node ephemeral Python sandbox executor")
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument("--script", type=str, help="Path to python script file")
    target_group.add_argument("--code", type=str, help="Inline python code to execute")
    parser.add_argument("--timeout", type=int, default=10, help="Execution timeout in seconds")
    parser.add_argument("--mem-limit-mb", type=int, default=200, help="Memory limit in MB")
    parser.add_argument("--cpu-limit-sec", type=int, default=10, help="CPU time limit in seconds")
    args = parser.parse_args()

    script_path, temp_path = _load_script(args.code, args.script)
    payload = _run_script(
        script_path=script_path,
        timeout_sec=args.timeout,
        mem_limit_mb=args.mem_limit_mb,
        cpu_limit_sec=args.cpu_limit_sec,
    )

    print(json.dumps(payload, ensure_ascii=False))

    if temp_path:
        try:
            os.unlink(temp_path)
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
