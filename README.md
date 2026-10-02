# Black of Duty — Android wrapper

Builds the APK for [Claude of Duty](https://github.com/Inkflow-Gab/Claude-of-Duty).

**This repository contains no game code.** It is the wrapper and the workflow that
assembles it around the game as an external input. One source of truth for the
game, and the APK can only ever lag or match it.

## Build

Actions tab → **Build APK** → *Run workflow*. Or push a change to this repo.

The APK appears under the run's **Artifacts** section, as
`black-of-duty-debug-apk`, retained 90 days.

## What is in here

| file | why it exists |
|---|---|
| `capacitor.config.ts` | the wrapper config — `webDir`, app id, and the `https` scheme Capacitor needs for WebGL |
| `android-overrides/AndroidManifest.xml` | landscape lock, no permissions, explicit hardware acceleration |
| `android-overrides/MainActivity.java` | immersive mode, keep-screen-on |
| `android-overrides/strings.xml` | launcher name |
| `build-apk.sh` | generates the Android project and copies the overrides over it |
| `APK.md` | what an APK does and does not buy, and what has **not** been verified |

The `android/` project is *generated* by `npx cap add android` in CI rather than
committed, because it is large, almost entirely boilerplate, and a commit that
touches it is a hundred generated-file diffs nobody reviews. Only the four files
above carry intent.

## The honest caveats

- **The APK has never been run on a device.** This build pipeline is new and its
  first execution is untested.
- **An APK will not make the game faster.** Same WebView, same GPU, same GL
  extensions as the browser. What it buys is enumerated in `APK.md`: OS-enforced
  landscape, no browser chrome, no pull-to-refresh reload, and it works offline.
- The game itself has never been pixel-verified — that needs a real GPU, and see
  `AGENTS.md` in the game repo for why the sandbox it was written in cannot do it.
