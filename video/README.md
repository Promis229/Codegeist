# Kairos demo video

A 4 min 53 s motion-design presentation of the whole product, made with [Remotion](https://remotion.dev).
Everything shown is captured from the real application; the narration is generated with edge-tts.

```bash
npm install
node scripts/capture.mjs                     # stills and screen recordings of the app (APP_URL, CHROME env vars)
python scripts/voiceover.py                  # English voice-over + word timings (needs the edge-tts package)
bash scripts/audio.sh                        # music bed and sound effects, synthesised with ffmpeg
npx remotion render src/index.ts Kairos out/kairos-demo.mp4
```

Scene lengths follow the voice-over (`src/theme.ts`), so editing a line of narration re-times the video automatically.
`scripts/frames.mjs` prints the start frame of every scene, handy for `npx remotion still`.
