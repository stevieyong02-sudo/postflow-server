// PostFlow Video Composition — Remotion
// Renders beautiful 9:16 social media videos server-side

import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring, Img, staticFile } from 'remotion';

// ─── Theme ───────────────────────────────────────────────────────────────────
const THEME = {
  bg:      '#1a1a1a',
  gold:    '#D4A853',
  cream:   '#F5ECD7',
  emerald: '#2D6A4F',
  overlay: 'rgba(10,10,10,0.65)',
};

// ─── Animated Text ───────────────────────────────────────────────────────────
function FadeUp({ children, delay = 0, style = {} }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay, fps, config: { damping: 20, stiffness: 80 } });
  return (
    <div style={{
      opacity: interpolate(progress, [0, 1], [0, 1]),
      transform: `translateY(${interpolate(progress, [0, 1], [30, 0])}px)`,
      ...style,
    }}>
      {children}
    </div>
  );
}

// ─── Slide 1 — Hook ──────────────────────────────────────────────────────────
function HookSlide({ imageUrl, title, subtitle, label }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: THEME.bg, fontFamily: 'serif' }}>
      {imageUrl && (
        <Img src={imageUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.45 }} />
      )}
      <div style={{ position: 'absolute', inset: 0, background: THEME.overlay }} />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 60px', gap: 20 }}>
        <FadeUp delay={5}>
          <div style={{ fontSize: 28, letterSpacing: 6, color: THEME.gold, fontFamily: 'sans-serif', fontWeight: 600, textAlign: 'center', marginBottom: 16 }}>
            {label || '✦ FENG SHUI SECRETS ✦'}
          </div>
        </FadeUp>
        <FadeUp delay={10}>
          <div style={{ fontSize: 88, fontWeight: 700, color: THEME.cream, textAlign: 'center', lineHeight: 1.1 }}>
            {title}
          </div>
        </FadeUp>
        <FadeUp delay={18}>
          <div style={{ fontSize: 56, color: THEME.gold, textAlign: 'center', marginTop: 8 }}>
            {subtitle}
          </div>
        </FadeUp>
        <FadeUp delay={22}>
          <div style={{ width: 100, height: 2, background: THEME.gold, marginTop: 20 }} />
        </FadeUp>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ─── Slide 2-4 — Tip ─────────────────────────────────────────────────────────
function TipSlide({ imageUrl, number, headline, body, direction = 'right' }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const imgProgress = spring({ frame, fps, config: { damping: 18, stiffness: 60 } });
  const imgTranslate = direction === 'right'
    ? interpolate(imgProgress, [0, 1], [200, 0])
    : direction === 'left'
    ? interpolate(imgProgress, [0, 1], [-200, 0])
    : 0;
  const imgScale = direction === 'scale'
    ? interpolate(imgProgress, [0, 1], [0.85, 1])
    : 1;

  return (
    <AbsoluteFill style={{ background: THEME.bg, fontFamily: 'serif' }}>
      {/* Image top 55% */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '55%',
        overflow: 'hidden', borderRadius: '0 0 32px 32px',
        transform: `translateX(${imgTranslate}px) scale(${imgScale})`,
      }}>
        {imageUrl
          ? <Img src={imageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ width: '100%', height: '100%', background: '#2a2a2a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontSize: 48, opacity: 0.3 }}>🏠</div>
            </div>
        }
      </div>

      {/* Text bottom 45% */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '45%', padding: '40px 60px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FadeUp delay={8}>
          <div style={{ fontSize: 72, fontWeight: 700, color: THEME.emerald, lineHeight: 1 }}>{number}</div>
        </FadeUp>
        <FadeUp delay={12}>
          <div style={{ fontSize: 52, fontWeight: 700, color: THEME.cream, lineHeight: 1.2 }}>{headline}</div>
        </FadeUp>
        <FadeUp delay={16}>
          <div style={{ fontSize: 34, color: `${THEME.cream}cc`, lineHeight: 1.5 }}>{body}</div>
        </FadeUp>
      </div>
    </AbsoluteFill>
  );
}

// ─── Slide 5 — CTA ───────────────────────────────────────────────────────────
function CTASlide({ imageUrl, headline, subtitle, cta }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const circleScale = spring({ frame, fps, config: { damping: 15, stiffness: 100 } });

  return (
    <AbsoluteFill style={{ background: THEME.bg, fontFamily: 'serif' }}>
      {imageUrl && (
        <Img src={imageUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }} />
      )}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.70)' }} />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 60px', gap: 24 }}>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: THEME.emerald, transform: `scale(${circleScale})` }} />
        <FadeUp delay={8}>
          <div style={{ fontSize: 72, fontWeight: 700, color: THEME.cream, textAlign: 'center', lineHeight: 1.15 }}>{headline}</div>
        </FadeUp>
        <div style={{ width: 100, height: 2, background: THEME.gold }} />
        <FadeUp delay={14}>
          <div style={{ fontSize: 40, color: THEME.gold, textAlign: 'center', letterSpacing: 2 }}>{subtitle}</div>
        </FadeUp>
        <FadeUp delay={20}>
          <div style={{ fontSize: 28, color: `${THEME.cream}99`, textAlign: 'center', fontFamily: 'sans-serif' }}>{cta}</div>
        </FadeUp>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ─── Main Composition ─────────────────────────────────────────────────────────
export function PostFlowVideo({ slides = [] }) {
  const { fps } = useVideoConfig();
  const SLIDE_DURATION = 4 * fps; // 4 seconds per slide

  const defaultSlides = [
    { type: 'hook', label: '✦ FENG SHUI SECRETS ✦', title: 'Attract Wealth & Abundance', subtitle: 'Into Your Home' },
    { type: 'tip', number: '01', headline: 'Activate Your Wealth Corner', body: 'Place plants, crystals, or a water feature in the Southeast corner of your home.', direction: 'right' },
    { type: 'tip', number: '02', headline: 'Clear Your Front Entrance', body: 'Your front door is the mouth of chi. Keep it clean, bright, and clutter-free.', direction: 'left' },
    { type: 'tip', number: '03', headline: 'Add Flowing Water', body: 'A water fountain near your entrance symbolizes wealth flowing into your life.', direction: 'scale' },
    { type: 'cta', headline: 'Your Home Is Your Greatest Asset', subtitle: 'Align Your Space. Attract Abundance.', cta: 'Save & Share' },
  ];

  const videoSlides = slides.length ? slides : defaultSlides;

  return (
    <AbsoluteFill>
      {videoSlides.map((slide, i) => (
        <Sequence key={i} from={i * SLIDE_DURATION} durationInFrames={SLIDE_DURATION}>
          {slide.type === 'hook' && <HookSlide {...slide} />}
          {slide.type === 'tip'  && <TipSlide  {...slide} />}
          {slide.type === 'cta'  && <CTASlide  {...slide} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

// ─── Root for Remotion ────────────────────────────────────────────────────────
import { registerRoot, Composition } from 'remotion';

export function RemotionRoot() {
  return (
    <Composition
      id="PostFlowVideo"
      component={PostFlowVideo}
      durationInFrames={120} // 5 slides × 4s × 30fps = 120 frames (but we use 24fps below)
      fps={24}
      width={1080}
      height={1920}
      defaultProps={{ slides: [] }}
    />
  );
}

registerRoot(RemotionRoot);
