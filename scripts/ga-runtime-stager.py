#!/usr/bin/env python3
"""Stage the pinned GenericAgent runtime for OzawaAgent's Tauri bundle.

The staged tree is intentionally a read-only *source* tree.  The bridge copies
it to a writable per-user runtime before importing GenericAgent, so installed
program files never receive sessions, memory, logs, or credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

PINNED_COMMIT = "51f769295b3f20c9be62edc658b4462dae97525a"
ADAPTER_SOURCE = Path("runtime/ga/ga_bridge_adapter.py")
MANIFEST_SOURCE = Path("runtime/ga/runtime_manifest.json")

# Keep this list explicit.  It is reviewed when the pinned GenericAgent
# commit changes; git archive must never accidentally include user data.
GA_RUNTIME_FILES = (
    "agentmain.py",
    "agent_loop.py",
    "ga.py",
    "llmcore.py",
    "simphtml.py",
    "TMWebDriver.py",
    "mykey_template.py",
    "mykey_template_en.py",
    "frontends/desktop_bridge.py",
    "frontends/plan_state.py",
    "frontends/cost_tracker.py",
    "frontends/conductor.py",
    "frontends/conductor.html",
    "frontends/desktop/static/app.js",
    "frontends/desktop/static/assets/fonts/README.md",
    "frontends/desktop/static/assets/fonts/azonix-wordmark.woff2",
    "frontends/desktop/static/assets/fonts/fonts.css",
    "frontends/desktop/static/assets/fonts/jetbrains-mono-latin.woff2",
    "frontends/desktop/static/assets/fonts/lexend-latin.woff2",
    "frontends/desktop/static/assets/fonts/noto-sans-latin.woff2",
    "frontends/desktop/static/fallback.html",
    "frontends/desktop/static/ga-web.js",
    "frontends/desktop/static/i18n.js",
    "frontends/desktop/static/index.html",
    "frontends/desktop/static/loading.html",
    "frontends/desktop/static/phosphor-icons.js",
    "frontends/desktop/static/styles.css",
    "frontends/desktop/static/vendor/marked.min.js",
    "reflect/agent_team_worker.py",
    "reflect/autonomous.py",
    "reflect/checklist_master.py",
    "reflect/goal_mode.py",
    "reflect/scheduler.py",
    "plugins/__init__.py",
    "plugins/hooks.py",
    "plugins/project_mode.py",
    "assets/tools_schema.json",
    "assets/sys_prompt.txt",
    "assets/sys_prompt_en.txt",
    "assets/global_mem_insight_template.txt",
    "assets/global_mem_insight_template_en.txt",
    "assets/insight_fixed_structure.txt",
    "assets/insight_fixed_structure_en.txt",
    "assets/code_run_header.py",
)

EXCLUDED_NAMES = {
    ".git",
    "__pycache__",
    ".pytest_cache",
    "temp",
    "memory",
    "mykey.py",
    "mykey.json",
    "auth.json",
}


def _run_git(root: Path, *args: str, input_text: str | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        input=input_text.encode("utf-8") if input_text is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _assert_clean_relative(path: str) -> None:
    p = PurePosixPath(path)
    if (
        p.is_absolute()
        or not path
        or "\\" in path
        or ".." in p.parts
        or any(part in EXCLUDED_NAMES for part in p.parts)
    ):
        raise ValueError(f"unsafe runtime path: {path!r}")


def _safe_extract(archive: bytes, output: Path) -> None:
    """Extract only regular, relative members; compatible with Python 3.10."""
    output = output.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or "\\" in member.name:
                raise RuntimeError(f"unsafe archive member: {member.name!r}")
            destination = (output / Path(*name.parts)).resolve()
            if destination != output and output not in destination.parents:
                raise RuntimeError(f"archive member escapes output: {member.name!r}")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise RuntimeError(f"unsupported archive member: {member.name!r}")
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError(f"archive member has no data: {member.name!r}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("wb") as target:
                shutil.copyfileobj(source, target)


def _copy_runtime_files(repo: Path, commit: str, output: Path) -> None:
    """Copy reviewed files as exact Git blobs (avoid checkout line-ending filters)."""
    for path in GA_RUNTIME_FILES:
        _assert_clean_relative(path)
        destination = output / Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(_git_file(repo, commit, path))


def _git_file(repo: Path, commit: str, path: str) -> bytes:
    _assert_clean_relative(path)
    return _run_git(repo, "show", f"{commit}:{path}")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _source_file(root: Path, value: Path) -> Path:
    candidate = value if value.is_absolute() else root / value
    candidate = candidate.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"source file is outside OzawaAgent root: {candidate}")
    if not candidate.is_file():
        raise FileNotFoundError(f"OzawaAgent source file is missing: {candidate}")
    return candidate


def stage(
    ga_repo: Path,
    output: Path,
    *,
    ozawaagent_root: Path | None = None,
    commit: str = PINNED_COMMIT,
    adapter: Path = ADAPTER_SOURCE,
    manifest: Path = MANIFEST_SOURCE,
) -> dict:
    ga_repo = ga_repo.resolve()
    ozawaagent_root = (ozawaagent_root or Path(__file__).resolve().parents[1]).resolve()
    output = output.resolve()
    if not (ga_repo / ".git").exists():
        raise ValueError(f"not a Git checkout: {ga_repo}")
    actual_commit = _run_git(ga_repo, "rev-parse", commit).decode("ascii").strip()
    if actual_commit != commit:
        raise RuntimeError(f"pinned commit resolved unexpectedly: {actual_commit}")

    adapter_src = _source_file(ozawaagent_root, adapter)
    manifest_src = _source_file(ozawaagent_root, manifest)
    script_src = Path(__file__).resolve()
    protected_sources = (adapter_src, manifest_src, script_src)
    if output == ga_repo or ga_repo in output.parents:
        raise ValueError("staging output must not be inside the GenericAgent checkout")
    if any(output == source or output in source.parents for source in protected_sources):
        raise ValueError("staging output would remove an OzawaAgent source file")

    # Read all mutable-source inputs before replacing an existing staging tree.
    adapter_bytes = adapter_src.read_bytes()
    manifest_doc = json.loads(manifest_src.read_text(encoding="utf-8"))
    bridge_bytes = _git_file(ga_repo, commit, "frontends/desktop_bridge.py")
    bridge_sha256 = _sha256_bytes(bridge_bytes)
    expected_bridge_sha256 = manifest_doc.get("official_bridge", {}).get("sha256")
    if expected_bridge_sha256 and bridge_sha256 != expected_bridge_sha256:
        raise RuntimeError(
            "GenericAgent bridge hash differs from the pinned OzawaAgent manifest: "
            f"expected {expected_bridge_sha256}, got {bridge_sha256}"
        )
    if manifest_doc.get("official_bridge", {}).get("path") != "frontends/desktop_bridge.py":
        raise RuntimeError("OzawaAgent manifest has an unexpected official bridge path")

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    _copy_runtime_files(ga_repo, commit, output)
    (output / "ga_bridge_adapter.py").write_bytes(adapter_bytes)
    sidecar_files: list[str] = []
    for sidecar_dir, suffixes in (("command_packs", (".json",)), ("command_plugins", (".py",))):
        source_dir = ozawaagent_root / "runtime" / "ga" / sidecar_dir
        if not source_dir.is_dir():
            continue
        for path in sorted(source_dir.iterdir()):
            if not path.is_file() or path.is_symlink() or path.suffix not in suffixes:
                continue
            relative = f"{sidecar_dir}/{path.name}"
            (output / sidecar_dir).mkdir(parents=True, exist_ok=True)
            (output / relative).write_bytes(path.read_bytes())
            sidecar_files.append(relative)
    manifest_doc["ga_commit"] = commit
    manifest_doc["official_bridge"]["sha256"] = bridge_sha256
    manifest_doc.setdefault("staging", {})
    manifest_doc["staging"].update({
        "schema_version": 1,
        "files": list(GA_RUNTIME_FILES),
        "excluded": sorted(EXCLUDED_NAMES),
        "official_bridge_sha256": bridge_sha256,
        "ozawaagent_sidecar": sidecar_files,
    })
    (output / "runtime_manifest.json").write_text(
        json.dumps(manifest_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest_doc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ga-repo", "--repo", dest="ga_repo", type=Path, required=True)
    parser.add_argument(
        "--ozawaagent-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="OzawaAgent checkout containing runtime/ga (default: repository root)",
    )
    parser.add_argument(
        "--commit",
        default=PINNED_COMMIT,
        help=f"Pinned GenericAgent commit (default: {PINNED_COMMIT})",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    manifest = stage(
        args.ga_repo,
        args.output,
        ozawaagent_root=args.ozawaagent_root,
        commit=args.commit,
    )
    print(json.dumps({"output": str(args.output.resolve()), "ga_commit": manifest["ga_commit"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
