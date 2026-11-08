#!/usr/bin/env python3
"""Build both Android providers and inspect the packaged DEX, including an FCM -> off rebuild."""
import os
from pathlib import Path
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
demo = root / "demo"
day = os.environ.get("DAY_BIN", "day")
for flavor in ("fcm", "fdroid"):
    subprocess.run([day, "build", "-t", "android-material", "--flavor", flavor], cwd=demo, check=True)
    apk = demo / "build/android/app/build/outputs/apk/debug/app-debug.apk"
    with zipfile.ZipFile(apk) as archive:
        dex = [archive.read(name) for name in archive.namelist() if name.endswith(".dex")]
    if not dex:
        raise SystemExit("APK contains no DEX files")
    signatures = (b"Lcom/google/firebase/", b"Lcom/google/android/gms/", b"Ldev/daybrite/push/DayMessagingService;")
    for signature in signatures:
        present = any(signature in data for data in dex)
        if present != (flavor == "fcm"):
            raise SystemExit(f"{flavor}: unexpected presence={present} for {signature.decode()}")
    print(f"{flavor}: packaged provider dependencies verified", flush=True)
