import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
  Img,
  // Audio, // ← un-comment to add a voiceover (see VOICEOVER note at bottom)
} from "remotion";
import { loadFont as loadHeebo } from "@remotion/google-fonts/Heebo";
import { loadFont as loadPlayfair } from "@remotion/google-fonts/PlayfairDisplay";
import { brand, VIDEO } from "./brand";

const { fontFamily: heebo } = loadHeebo();
const { fontFamily: playfair } = loadPlayfair();

/* ---------- Shared brand background: charcoal marble with gold glow ---------- */
const MarbleBg: React.FC<{ shine?: number }> = ({ shine = 0 }) => {
  const frame = useCurrentFrame();
  const sweep = interpolate(frame % 150, [0, 150], [-30, 130]);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 80% at 50% 18%, ${brand.char800} 0%, ${brand.char950} 62%), ${brand.char950}`,
      }}
    >
      {/* marble veining */}
      <AbsoluteFill
        style={{
          opacity: 0.1,
          mixBlendMode: "screen",
          filter: "blur(1px)",
          background: `repeating-linear-gradient(115deg, transparent 0 60px, oklch(1 0 0 / .5) 60px 62px),
                       repeating-linear-gradient(60deg, transparent 0 90px, ${brand.gold500} 90px 91px)`,
        }}
      />
      {/* moving gold light sweep — grows in the final "shine" scene */}
      <AbsoluteFill
        style={{
          opacity: 0.35 + shine * 0.4,
          background: `linear-gradient(105deg, transparent ${sweep - 22}%, ${brand.goldGlow} ${sweep}%, transparent ${sweep + 22}%)`,
          filter: "blur(8px)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ---------- Animated caption block ---------- */
const Caption: React.FC<{
  kicker?: string;
  lines: React.ReactNode[];
  vo: string; // burned-in subtitle / voiceover line
}> = ({ kicker, lines, vo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 18, mass: 0.6 } });
  const y = interpolate(rise, [0, 1], [60, 0]);
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        padding: "0 90px",
        fontFamily: heebo,
        color: brand.white,
        transform: `translateY(${y}px)`,
        opacity: rise,
      }}
    >
      {kicker && (
        <div
          style={{
            fontWeight: 800,
            fontSize: 34,
            letterSpacing: "0.12em",
            color: brand.gold500,
            marginBottom: 34,
          }}
        >
          {kicker}
        </div>
      )}
      <div
        style={{
          fontFamily: playfair,
          fontWeight: 800,
          fontSize: 96,
          lineHeight: 1.1,
          textShadow: `0 8px 40px oklch(0.17 0.006 264 / .6)`,
        }}
      >
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {/* subtitle bar */}
      <div
        style={{
          marginTop: 54,
          fontSize: 44,
          fontWeight: 500,
          lineHeight: 1.4,
          color: "oklch(0.99 0 0 / .92)",
          maxWidth: 840,
        }}
      >
        {vo}
      </div>
    </AbsoluteFill>
  );
};

const Gold = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: brand.gold500 }}>{children}</span>
);

/* ---------- Brand lockup (logo + wordmark) ---------- */
const BrandLockup: React.FC = () => (
  <div
    style={{
      position: "absolute",
      bottom: 70,
      left: 0,
      right: 0,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      gap: 22,
      fontFamily: playfair,
    }}
  >
    <Img
      src={staticFile("logo.jpg")}
      style={{ width: 78, height: 78, borderRadius: 16, objectFit: "cover" }}
    />
    <span style={{ color: brand.white, fontWeight: 700, fontSize: 46 }}>
      Mr. Polish<span style={{ color: brand.gold500 }}>.</span>
    </span>
  </div>
);

/* ---------- Gold progress bar (top) ---------- */
const Progress: React.FC = () => {
  const frame = useCurrentFrame();
  const pct = interpolate(frame, [0, VIDEO.durationInFrames], [0, 100]);
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 8 }}>
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${brand.gold500}, ${brand.gold700})`,
          boxShadow: `0 0 18px ${brand.goldGlow}`,
        }}
      />
    </div>
  );
};

/* ===================================================================== */
export const MarbleReel: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: brand.char950 }}>
      {/* ===== Scene 1 · 0–3s · HOOK ===== */}
      <Sequence durationInFrames={90}>
        <MarbleBg />
        <Caption
          kicker="Mr. Polish · 3 שניות שמצילות את השיש ⏱️"
          lines={[<>נשפך קפה</>, <Gold>על השיש?</Gold>]}
          vo="אל תיכנסו ללחץ — אבל תפעלו נכון."
        />
      </Sequence>

      {/* ===== Scene 2 · 3–7s · STEP 1 ===== */}
      <Sequence from={90} durationInFrames={120}>
        <MarbleBg />
        <Caption
          kicker="שלב 1"
          lines={[<>סופגים <Gold>בעדינות</Gold></>]}
          vo="לא משפשפים — שפשוף רק מפזר את הכתם."
        />
      </Sequence>

      {/* ===== Scene 3 · 7–11s · STEP 2 ===== */}
      <Sequence from={210} durationInFrames={120}>
        <MarbleBg />
        <Caption
          kicker="שלב 2"
          lines={[<>שוטפים <Gold>במים פושרים</Gold></>]}
          vo="ומנגבים מיד — עד יבש."
        />
      </Sequence>

      {/* ===== Scene 4 · 11–15s · SHINE + CTA ===== */}
      <Sequence from={330} durationInFrames={120}>
        <ShineOutro />
      </Sequence>

      <Progress />
    </AbsoluteFill>
  );
};

/* ---------- Final scene: shine reveal + CTA ---------- */
const ShineOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shine = interpolate(frame, [0, 40], [0, 1], { extrapolateRight: "clamp" });
  const pop = spring({ frame: frame - 16, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill>
      <MarbleBg shine={shine} />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          fontFamily: heebo,
          color: brand.white,
          padding: "0 90px",
        }}
      >
        <div
          style={{
            fontFamily: playfair,
            fontWeight: 800,
            fontSize: 86,
            lineHeight: 1.12,
            opacity: shine,
          }}
        >
          הכתם נשאר? <br />
          <Gold>אנחנו נחזיר את הברק.</Gold> 💎
        </div>
        <div
          style={{
            marginTop: 56,
            transform: `scale(${pop})`,
            background: `linear-gradient(135deg, ${brand.gold500}, ${brand.gold700})`,
            color: brand.char950,
            fontWeight: 900,
            fontSize: 50,
            padding: "34px 66px",
            borderRadius: 80,
            boxShadow: `0 22px 64px ${brand.goldGlow}`,
          }}
        >
          הצעת מחיר חינם 📲
        </div>
      </AbsoluteFill>
      <BrandLockup />

      {/* VOICEOVER (optional):
          1) Drop an mp3 at  public/vo.mp3
          2) Un-comment the Audio import at the top of this file
          3) Place <Audio src={staticFile("vo.mp3")} /> at the root of MarbleReel
          Suggested VO script (he):
          "נשפך קפה על השיש? אל תיכנסו ללחץ. סופגים בעדינות, בלי לשפשף.
           שוטפים במים פושרים ומנגבים מיד. ואם הכתם נשאר — אנחנו, Mr. Polish, נחזיר לו את הברק."
      */}
    </AbsoluteFill>
  );
};
