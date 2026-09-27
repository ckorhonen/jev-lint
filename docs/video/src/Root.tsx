import { Composition } from "remotion";
import { JevLintVideo, TOTAL } from "./Video";

export const RemotionRoot = () => (
  <>
    <Composition id="JevLint" component={JevLintVideo} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="JevLintSquare" component={JevLintVideo} durationInFrames={TOTAL} fps={30} width={1080} height={1080} />
  </>
);
