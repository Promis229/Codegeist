import React from "react";
import { AbsoluteFill, Audio, Composition, Sequence, interpolate, staticFile } from "remotion";
import { Backdrop } from "./lib";
import { SCENE_COMPONENTS } from "./scenes";
import { FPS, H, SCENES, TOTAL, W } from "./theme";

const Kairos: React.FC = () => (
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

export const RemotionRoot: React.FC = () => (
  <Composition id="Kairos" component={Kairos} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
);
