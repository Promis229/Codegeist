import React from "react";
import { AbsoluteFill, Audio, Composition, Sequence, cancelRender, continueRender, delayRender, interpolate, staticFile } from "remotion";
import { Backdrop } from "./lib";
import { SCENE_COMPONENTS } from "./scenes";
import { FPS, H, SCENES, TOTAL, W } from "./theme";

// Fonts are bundled locally (no network at render time).
const useFonts = () => {
  const [handle] = React.useState(() => delayRender("fonts"));
  React.useEffect(() => {
    const faces = [
      new FontFace("KFraunces", `url(${staticFile("fonts/fraunces-latin-wght-normal.woff2")})`, { weight: "100 900" }),
      new FontFace("KHanken", `url(${staticFile("fonts/hanken-grotesk-latin-wght-normal.woff2")})`, { weight: "100 900" }),
    ];
    Promise.all(faces.map((f) => f.load())).then((l) => { l.forEach((f) => document.fonts.add(f)); continueRender(handle); }).catch((e) => cancelRender(e));
  }, [handle]);
};

const Kairos: React.FC = () => {
  useFonts();
  return (
  <AbsoluteFill style={{ background: "#0f0b09" }}>
    <Backdrop />
    <Audio src={staticFile("audio/music.mp3")} volume={(f) => interpolate(f, [0, 60, TOTAL - 90, TOTAL], [0, 0.16, 0.16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
    {SCENES.map((s) => {
      const Comp = SCENE_COMPONENTS[s.key];
      return (
        <Sequence key={s.key} from={s.start} durationInFrames={s.dur} premountFor={30}>
          <Comp />
        </Sequence>
      );
    })}
  </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition id="Kairos" component={Kairos} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
);
