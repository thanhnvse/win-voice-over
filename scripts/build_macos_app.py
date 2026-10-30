"""Build win-voice-over.app for macOS and install it.

It is a menu bar app (packaging/macos/main.swift) that runs the VieNeu-TTS server behind
the extension's VieNeu engine. Opening it starts the server and puts a W in the menu bar;
the W's one menu item, Stop VieNeu, stops the server and quits.

The bundle holds only that small binary. It runs ``python -m apps.openai_speech`` from a
VieNeu-TTS checkout, which means:

* updating VieNeu-TTS (git pull) takes effect on the next launch, with no rebuild;
* moving the checkout, or renaming its virtualenv, needs a rebuild.

Run it with any Python 3 (it uses only the standard library); it needs swiftc, which the
Xcode command line tools provide:

    python3 scripts/build_macos_app.py

``--vieneu`` picks another checkout than ./VieNeu-TTS, ``--dest`` another folder than
/Applications, e.g. ``~/Applications``.
"""

from __future__ import annotations

import argparse
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "win-voice-over"
BUNDLE_ID = "io.github.thanhnvse.win-voice-over"
SOURCE = ROOT / "packaging" / "macos" / "main.swift"
VERSION = "0.5.0"


class BuildError(Exception):
    pass


def run(*command: str) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise BuildError(f"{command[0]} failed ({result.returncode}):\n{result.stderr or result.stdout}")


def find_python(vieneu: Path) -> Path:
    # Not resolved: Python finds its venv from the path it was started as.
    for venv in (".venv.nosync", ".venv"):
        python = vieneu / venv / "bin" / "python"
        if python.is_file():
            return python
    raise BuildError(f"No virtualenv in {vieneu}; set VieNeu-TTS up first (see README.md, VieNeu).")


def info_plist(vieneu: Path, python: Path) -> dict:
    return {
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleExecutable": APP_NAME,
        "CFBundleIconFile": "AppIcon",
        "CFBundlePackageType": "APPL",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        # Menu bar only: no Dock icon, no Cmd+Tab entry.
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
        # The health check is plain HTTP to 127.0.0.1.
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "VieNeuDir": str(vieneu),
        "VieNeuPython": str(python),
    }


def build_bundle(app: Path, workdir: Path, vieneu: Path, python: Path) -> None:
    macos_dir = app / "Contents" / "MacOS"
    resources = app / "Contents" / "Resources"
    macos_dir.mkdir(parents=True)
    resources.mkdir(parents=True)

    executable = macos_dir / APP_NAME
    run("swiftc", "-O", "-swift-version", "5", "-o", str(executable), str(SOURCE))
    # The binary draws its own icon, so the menu bar W and the app icon cannot drift apart.
    iconset = workdir / "AppIcon.iconset"
    run(str(executable), "--render-icon", str(iconset))
    run("iconutil", "--convert", "icns", str(iconset), "--output", str(resources / "AppIcon.icns"))
    with open(app / "Contents" / "Info.plist", "wb") as handle:
        plistlib.dump(info_plist(vieneu, python), handle)

    # Ad-hoc: no Apple developer identity needed; it seals Info.plist and the icon.
    run("codesign", "--force", "--sign", "-", "--identifier", BUNDLE_ID, str(app))
    run("codesign", "--verify", "--strict", str(app))


def is_running(app: Path) -> bool:
    # Exact match on the command, not `pgrep -f`: that would also match any process
    # that merely mentions the path (an editor, `tail`).
    executable = str(app / "Contents" / "MacOS" / APP_NAME)
    try:
        listing = subprocess.run(
            ["ps", "-axww", "-o", "command="], capture_output=True, text=True, check=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        # Refuse rather than guess: False would let install() delete a running bundle.
        raise BuildError(f"Could not check whether {APP_NAME} is running: {exc}") from exc
    return any(
        line.strip() == executable or line.strip().startswith(executable + " ")
        for line in listing.splitlines()
    )


def install(built: Path, target: Path) -> None:
    if target.exists():
        try:
            with open(target / "Contents" / "Info.plist", "rb") as handle:
                bundle_id = plistlib.load(handle).get("CFBundleIdentifier")
        except (OSError, plistlib.InvalidFileException) as exc:
            raise BuildError(f"{target} exists and is not a readable app bundle: {exc}") from exc
        if bundle_id != BUNDLE_ID:
            raise BuildError(f"{target} belongs to {bundle_id!r}; not replacing it.")
        if is_running(target):
            raise BuildError(f"{APP_NAME} is running. Stop it from the menu bar W first.")
        shutil.rmtree(target)
    # ditto, not copytree: it is the macOS tool for copying bundles intact.
    run("ditto", str(built), str(target))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vieneu", type=Path, default=ROOT / "VieNeu-TTS")
    parser.add_argument("--dest", type=Path, default=Path("/Applications"))
    args = parser.parse_args()

    if sys.platform != "darwin":
        print("This builds a macOS app; run it on a Mac.", file=sys.stderr)
        return 1
    vieneu = args.vieneu.expanduser().resolve()
    dest = args.dest.expanduser()
    target = dest / f"{APP_NAME}.app"
    try:
        python = find_python(vieneu)
        dest.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            built = Path(tmp) / f"{APP_NAME}.app"
            build_bundle(built, Path(tmp), vieneu, python)
            install(built, target)
    # OSError: swiftc or iconutil missing, permissions on --dest, or a symlink in the way.
    except (BuildError, OSError) as exc:
        print(f"Build failed: {exc}", file=sys.stderr)
        return 1

    print(f"Installed {target}")
    print(f"It runs {python} -m apps.openai_speech in {vieneu}; logs go to ~/Library/Logs/{APP_NAME}.log.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
