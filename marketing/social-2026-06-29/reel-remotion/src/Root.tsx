import { Composition } from "remotion";
import { MarbleReel } from "./MarbleReel";
import { VIDEO } from "./brand";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MarbleReel"
      component={MarbleReel}
      durationInFrames={VIDEO.durationInFrames}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  );
};
