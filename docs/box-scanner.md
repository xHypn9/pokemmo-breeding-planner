# PokeMMO Box Scanner architecture

## Trust boundary

The scanner accepts pixels from one window selected by the user. It never reads the PokeMMO process, network, installation, account, or ability name. Captured images do not leave the computer. Production scans are not saved unless the user explicitly enables local debug saving.

## Pipeline

```text
desktopCapturer window frame
  -> normalized ROI crops (Sharp)
  -> Species/Nature/IV OCR (local Tesseract.js worker)
  -> Alpha/HA/Gender color-and-shape evidence
  -> closed-dictionary normalization and validation
  -> editable Review Queue
  -> existing validated inventory.bulkCreate transaction
```

The bundled species dataset supplies species names and gender metadata. The existing closed Nature list supplies the Nature dictionary. IV parsing requires exactly six slash-separated integers, each in the range 0–31. Invalid text is never guessed into range.

## Regions and calibration

`ScannerCalibration` stores `x`, `y`, `width`, and `height` in the range 0–1 for Species, Gender, IVs, Nature, Alpha, HA and the change-detection fingerprint. The UI overlays every ROI on a fresh source-window preview and persists the profile in `app_settings`.

The default profile was validated against a private local PokeMMO frame. User-provided screenshots are excluded from the public repository; the two visual regression tests run only when `tests/fixtures/pokemmo-butterfree-alpha-ha.png` is present locally.

## Confidence and review

Confidence thresholds live in one calibration object. The default policy is:

- 0.90 or higher: verified
- 0.70–0.89: needs review
- below 0.70 or impossible data: error

Manual edits receive confidence 1.0 and immediately re-run dataset validation. HA remains a nullable uncertain field in the queue; only a reviewed boolean can be imported.

## Live and manual capture

Live mode polls only a compact fingerprint ROI. OCR begins after the configured number of stable frames and does not run for an unchanged panel. Renderer background throttling is disabled so this continues while PokeMMO is foreground.

The configurable Electron global shortcut calls the same single-scan service and displays a local Windows notification. It only signals this application to capture; it does not send a keyboard event to PokeMMO. Manual captures are never content-deduplicated, so visually identical Pokémon can be entered separately.

## Packaging

Tesseract.js and its WebAssembly core run locally. `@tesseract.js-data/eng` provides `eng.traineddata.gz`; electron-builder copies it to `resources/ocr`. No model is downloaded at runtime. Tesseract worker files and Sharp's native modules are unpacked from ASAR as required by Electron.
