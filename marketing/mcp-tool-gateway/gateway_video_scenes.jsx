// gateway_video_scenes.jsx
// STRIX MCP Tool Gateway · branded marketing video
// 1920x1080 landscape · ~55 seconds
// Embeds assets/mcp-tool-gateway.mp4 as the live demo segment.

const GV_BLUE   = '#2F81F7';
const GV_ALLOW  = '#3FB950';
const GV_DENY   = '#F85149';
const GV_AMBER  = '#D29922';
const GV_BG0    = '#070C18';
const GV_BG1    = '#0E1629';
const GV_BG2    = '#121C33';
const GV_BG3    = '#17223E';
const GV_FG1    = '#FFFFFF';
const GV_FG2    = '#E6EDF3';
const GV_FG3    = '#B4C0CC';
const GV_FG4    = '#7D8590';
const GV_BORDER = '#1E2A47';
const GV_BORDER2= '#2A3A5C';

const GV_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";
const GV_SANS = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

// Scene timing table (single source of truth)
const GV_SCENE_TIMES = {
  open:    { start: 0,    end: 4.5  },
  problem: { start: 4.5,  end: 10.0 },
  gateway: { start: 10.0, end: 15.0 },
  demo:    { start: 15.0, end: 39.0 },
  caps:    { start: 39.0, end: 46.5 },
  cta:     { start: 46.5, end: 55.0 },
};

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENT LAYERS
// ═══════════════════════════════════════════════════════════════════════

function GVBackdrop() {
  const t = useTime();
  const pulse = 0.08 + 0.03 * Math.sin(t * 0.7);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `radial-gradient(ellipse 70% 60% at 50% 45%, #0E1A30 0%, ${GV_BG0} 70%)`,
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage:
          `linear-gradient(${GV_BORDER} 1px, transparent 1px),
           linear-gradient(90deg, ${GV_BORDER} 1px, transparent 1px)`,
        backgroundSize: '80px 80px',
        opacity: 0.38,
        maskImage: 'radial-gradient(ellipse at 50% 50%, #000 25%, transparent 80%)',
        WebkitMaskImage: 'radial-gradient(ellipse at 50% 50%, #000 25%, transparent 80%)',
      }}/>
      <div style={{
        position: 'absolute',
        left: '50%', top: '50%',
        width: 1600, height: 900,
        transform: 'translate(-50%, -50%)',
        background: `radial-gradient(ellipse at center, rgba(47,129,247,${pulse}) 0%, transparent 60%)`,
        pointerEvents: 'none',
      }}/>
    </div>
  );
}

function GVChrome() {
  const t = useTime();
  return (
    <>
      {/* Logomark + wordmark — top-left */}
      <div style={{
        position: 'absolute', left: 56, top: 44,
        display: 'flex', alignItems: 'center', gap: 16,
        zIndex: 50,
      }}>
        <img src="strix-logomark.svg" alt=""
             style={{
               width: 38, height: 38, display: 'block',
               filter: `drop-shadow(0 0 10px rgba(47,129,247,0.6)) drop-shadow(0 0 22px rgba(47,129,247,0.35))`,
             }}/>
        <div style={{
          fontFamily: GV_SANS, fontWeight: 800, fontSize: 22,
          letterSpacing: '0.36em', color: GV_FG1,
        }}>STRIX</div>
        <div style={{
          marginLeft: 8, paddingLeft: 18,
          borderLeft: `1px solid ${GV_BORDER2}`,
          fontFamily: GV_MONO, fontSize: 13,
          letterSpacing: '0.22em', textTransform: 'uppercase',
          color: GV_FG4,
        }}>MCP Tool Gateway</div>
      </div>

      {/* Live indicator + product line — top-right */}
      <div style={{
        position: 'absolute', right: 56, top: 50,
        display: 'flex', alignItems: 'center', gap: 12,
        fontFamily: GV_MONO, fontSize: 12,
        letterSpacing: '0.22em', textTransform: 'uppercase',
        color: GV_FG4, zIndex: 50,
      }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 4,
          background: GV_BLUE,
          boxShadow: `0 0 12px ${GV_BLUE}`,
          opacity: 0.5 + 0.5 * Math.abs(Math.sin(t * 2.4)),
        }}/>
        Execution Control Layer
      </div>
    </>
  );
}

function GVProgressBar() {
  const { time, duration } = useTimeline();
  const pct = duration > 0 ? clamp(time / duration, 0, 1) : 0;
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0,
      height: 3, background: 'rgba(255,255,255,0.04)',
      zIndex: 60,
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${pct * 100}%`,
        background: `linear-gradient(90deg, ${GV_BLUE}, ${GV_ALLOW})`,
        boxShadow: `0 0 12px ${GV_BLUE}`,
      }}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function Eyebrow({ children, color = GV_BLUE, op = 1, x = 0, y = 0, align = 'center' }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: y,
      transform: x ? `translateX(${x}px)` : undefined,
      textAlign: align,
      fontFamily: GV_SANS, fontWeight: 700, fontSize: 14,
      letterSpacing: '0.4em', textTransform: 'uppercase',
      color, opacity: op,
    }}>{children}</div>
  );
}

function Headline({ children, op = 1, y = 220, size = 88, ty = 0, color = GV_FG1, weight = 800, align = 'center' }) {
  return (
    <div style={{
      position: 'absolute', left: 80, right: 80, top: y,
      transform: `translateY(${ty}px)`,
      opacity: op,
      fontFamily: GV_SANS, fontWeight: weight, fontSize: size,
      color, letterSpacing: '-0.025em', lineHeight: 1.02,
      textAlign: align, textWrap: 'balance',
    }}>{children}</div>
  );
}

function Subhead({ children, op = 1, y = 380, size = 26, ty = 0, color = GV_FG3, align = 'center' }) {
  return (
    <div style={{
      position: 'absolute', left: 120, right: 120, top: y,
      transform: `translateY(${ty}px)`,
      opacity: op,
      fontFamily: GV_SANS, fontWeight: 400, fontSize: size,
      color, letterSpacing: '-0.005em', lineHeight: 1.4,
      textAlign: align, textWrap: 'balance',
    }}>{children}</div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 1 · OPEN  (0 – 4.5s)
// ═══════════════════════════════════════════════════════════════════════
function GVScene1Open() {
  const { localTime } = useSprite();
  const eyeOp = animate({ from: 0, to: 1, start: 0.1, end: 0.7 })(localTime);
  const hOp   = animate({ from: 0, to: 1, start: 0.3, end: 1.0, ease: Easing.easeOutCubic })(localTime);
  const hY    = animate({ from: 24, to: 0, start: 0.3, end: 1.0, ease: Easing.easeOutCubic })(localTime);
  const sOp   = animate({ from: 0, to: 1, start: 0.9, end: 1.5 })(localTime);
  const lineOp = animate({ from: 0, to: 1, start: 1.4, end: 2.0 })(localTime);
  const fade  = localTime > 3.9 ? 1 - clamp((localTime - 3.9) / 0.6, 0, 1) : 1;

  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Eyebrow op={eyeOp} y={340}>STRIX · MCP TOOL GATEWAY</Eyebrow>
      <Headline op={hOp} ty={hY} y={400} size={104}>
        Govern every tool<br/>your AI agent calls.
      </Headline>
      <Subhead op={sOp} y={680} size={28}>
        Inline. Local-first. Default-DENY. Signed.
      </Subhead>

      {/* Decorative under-line */}
      <div style={{
        position: 'absolute', left: '50%', top: 760,
        transform: `translateX(-50%) scaleX(${lineOp})`,
        transformOrigin: 'center',
        width: 220, height: 2,
        background: `linear-gradient(90deg, transparent, ${GV_BLUE}, transparent)`,
        boxShadow: `0 0 12px ${GV_BLUE}`,
        opacity: lineOp,
      }}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 2 · PROBLEM (4.5 – 10s)
// AI agents fire tool calls directly at execution surfaces with no control.
// ═══════════════════════════════════════════════════════════════════════
function GVScene2Problem() {
  const { localTime } = useSprite();
  const eyeOp = animate({ from: 0, to: 1, start: 0.0, end: 0.6 })(localTime);
  const hOp   = animate({ from: 0, to: 1, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);
  const hY    = animate({ from: 18, to: 0, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);

  // Left column reveal
  const leftOp = animate({ from: 0, to: 1, start: 1.0, end: 1.7, ease: Easing.easeOutCubic })(localTime);
  // Right column reveal
  const rightOp = animate({ from: 0, to: 1, start: 1.5, end: 2.2, ease: Easing.easeOutCubic })(localTime);
  // Lines / packets across
  const linesOp = animate({ from: 0, to: 1, start: 2.0, end: 2.6 })(localTime);
  // Warning stamp
  const warnOp = animate({ from: 0, to: 1, start: 3.4, end: 3.9, ease: Easing.easeOutBack })(localTime);

  const fade = localTime > 5.0 ? 1 - clamp((localTime - 5.0) / 0.5, 0, 1) : 1;

  const agents = [
    'Claude Code', 'Cursor', 'OpenClaw',
    'MCP Clients', 'Autonomous Agents',
  ];
  const surfaces = [
    { name: 'Filesystem',   meta: 'fs.write · fs.delete' },
    { name: 'Shell',        meta: 'exec · spawn' },
    { name: 'MCP Server',   meta: 'tool.call' },
    { name: 'HTTP API',     meta: 'POST · PUT · DELETE' },
    { name: 'Cloud',        meta: 'aws · gcp · azure' },
  ];

  // Animated packets across the gap
  const numPackets = 14;
  const packets = Array.from({ length: numPackets }, (_, i) => {
    const phase = ((localTime * 0.45 + i * 0.13) % 1 + 1) % 1;
    const lane = i % 5;
    return { phase, lane, i };
  });

  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Eyebrow op={eyeOp} y={150} color={GV_DENY}>WITHOUT A GATEWAY</Eyebrow>
      <Headline op={hOp} ty={hY} y={200} size={68}>
        Every agent. Every tool. <span style={{ color: GV_DENY }}>No control.</span>
      </Headline>

      {/* Left column: agents */}
      <div style={{
        position: 'absolute', left: 140, top: 380,
        width: 380,
        opacity: leftOp,
      }}>
        <div style={{
          fontFamily: GV_SANS, fontWeight: 700, fontSize: 13,
          letterSpacing: '0.32em', color: GV_FG4,
          marginBottom: 18,
        }}>AI AGENTS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {agents.map((a, i) => (
            <div key={i} style={{
              padding: '14px 20px',
              background: GV_BG2,
              border: `1px solid ${GV_BORDER2}`,
              borderLeft: `3px solid ${GV_BLUE}`,
              borderRadius: 4,
              fontFamily: GV_MONO, fontSize: 18, fontWeight: 500,
              color: GV_FG2,
              opacity: clamp((localTime - 1.0 - i * 0.08) / 0.4, 0, 1),
            }}>{a}</div>
          ))}
        </div>
      </div>

      {/* Right column: execution surfaces */}
      <div style={{
        position: 'absolute', right: 140, top: 380,
        width: 380,
        opacity: rightOp,
      }}>
        <div style={{
          fontFamily: GV_SANS, fontWeight: 700, fontSize: 13,
          letterSpacing: '0.32em', color: GV_FG4,
          marginBottom: 18,
          textAlign: 'right',
        }}>EXECUTION SURFACES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {surfaces.map((s, i) => (
            <div key={i} style={{
              padding: '14px 20px',
              background: GV_BG2,
              border: `1px solid ${GV_BORDER2}`,
              borderRight: `3px solid ${GV_DENY}`,
              borderRadius: 4,
              opacity: clamp((localTime - 1.5 - i * 0.08) / 0.4, 0, 1),
            }}>
              <div style={{
                fontFamily: GV_SANS, fontWeight: 700, fontSize: 18,
                color: GV_FG1,
              }}>{s.name}</div>
              <div style={{
                fontFamily: GV_MONO, fontSize: 12,
                color: GV_FG4, marginTop: 4,
              }}>{s.meta}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Chaotic packets streaming left→right with no checkpoint */}
      <div style={{
        position: 'absolute',
        left: 520, right: 520, top: 420, height: 460,
        opacity: linesOp,
      }}>
        {packets.map(p => {
          const x = p.phase * 100;
          const y = p.lane * 80 + 16;
          return (
            <div key={p.i} style={{
              position: 'absolute',
              left: `${x}%`, top: y,
              transform: 'translateX(-50%)',
              width: 22, height: 6,
              background: GV_DENY,
              borderRadius: 1,
              boxShadow: `0 0 12px ${GV_DENY}`,
              opacity: Math.min(1, Math.min(p.phase, 1 - p.phase) * 6),
            }}/>
          );
        })}
        {/* Lanes */}
        {[0,1,2,3,4].map(i => (
          <div key={`l${i}`} style={{
            position: 'absolute',
            left: 0, right: 0,
            top: i * 80 + 18,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${GV_BORDER2} 20%, ${GV_BORDER2} 80%, transparent)`,
            opacity: 0.5,
          }}/>
        ))}
      </div>

      {/* Warning stamp */}
      <div style={{
        position: 'absolute',
        left: '50%', top: 900,
        transform: `translate(-50%, 0) scale(${0.92 + 0.08 * warnOp})`,
        opacity: warnOp,
        padding: '12px 28px',
        background: 'rgba(248,81,73,0.12)',
        border: `1px solid rgba(248,81,73,0.5)`,
        borderRadius: 4,
        fontFamily: GV_SANS, fontWeight: 700, fontSize: 16,
        letterSpacing: '0.24em', textTransform: 'uppercase',
        color: GV_DENY,
        boxShadow: `0 0 24px rgba(248,81,73,0.25)`,
      }}>
        ✕  UNGOVERNED · UNSIGNED · UNAUDITABLE
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 3 · GATEWAY (10 – 15s)
// The gateway snaps in between agent and surface.
// ═══════════════════════════════════════════════════════════════════════
function GVScene3Gateway() {
  const { localTime } = useSprite();
  const eyeOp = animate({ from: 0, to: 1, start: 0.0, end: 0.6 })(localTime);
  const hOp   = animate({ from: 0, to: 1, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);
  const hY    = animate({ from: 18, to: 0, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);
  // Two side boxes
  const sideOp = animate({ from: 0, to: 1, start: 0.8, end: 1.4 })(localTime);
  // Gateway slams in
  const gwOp    = animate({ from: 0, to: 1, start: 1.4, end: 1.9 })(localTime);
  const gwScale = animate({ from: 0.88, to: 1, start: 1.4, end: 1.9, ease: Easing.easeOutBack })(localTime);
  // Decision badges
  const decOp = animate({ from: 0, to: 1, start: 2.3, end: 3.0 })(localTime);
  // Caption
  const capOp = animate({ from: 0, to: 1, start: 3.0, end: 3.6 })(localTime);
  const fade = localTime > 4.5 ? 1 - clamp((localTime - 4.5) / 0.5, 0, 1) : 1;

  // Pulses through the gateway
  const pulses = [0, 0.5];
  const cy = 540;

  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Eyebrow op={eyeOp} y={150}>STRIX MCP TOOL GATEWAY</Eyebrow>
      <Headline op={hOp} ty={hY} y={200} size={64}>
        One inline checkpoint between intent and execution.
      </Headline>

      {/* Left: AI agent */}
      <div style={{
        position: 'absolute',
        left: 140, top: cy - 100,
        width: 320, height: 200,
        background: GV_BG1,
        border: `1px solid ${GV_BORDER2}`,
        borderRadius: 6,
        padding: 24,
        opacity: sideOp,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{ fontFamily: GV_SANS, fontWeight: 700, fontSize: 12, letterSpacing: '0.24em', color: GV_FG4 }}>AI AGENT</div>
        <div style={{ fontFamily: GV_SANS, fontWeight: 700, fontSize: 26, color: GV_FG1, letterSpacing: '-0.01em' }}>
          Claude Code<br/>
          <span style={{ color: GV_FG3, fontSize: 18, fontWeight: 400 }}>· Cursor · MCP Client</span>
        </div>
        <div style={{ fontFamily: GV_MONO, fontSize: 12, color: GV_FG4 }}>tool.call("notion.update")</div>
      </div>

      {/* Right: Execution surface */}
      <div style={{
        position: 'absolute',
        right: 140, top: cy - 100,
        width: 320, height: 200,
        background: GV_BG1,
        border: `1px solid ${GV_BORDER2}`,
        borderRadius: 6,
        padding: 24,
        opacity: sideOp,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{ fontFamily: GV_SANS, fontWeight: 700, fontSize: 12, letterSpacing: '0.24em', color: GV_FG4 }}>EXECUTION SURFACE</div>
        <div style={{ fontFamily: GV_SANS, fontWeight: 700, fontSize: 26, color: GV_FG1, letterSpacing: '-0.01em' }}>
          Filesystem<br/>
          <span style={{ color: GV_FG3, fontSize: 18, fontWeight: 400 }}>· Shell · MCP · HTTP</span>
        </div>
        <div style={{ fontFamily: GV_MONO, fontSize: 12, color: GV_FG4 }}>irreversible side-effects</div>
      </div>

      {/* Connector line */}
      <div style={{
        position: 'absolute',
        left: 460, right: 460, top: cy - 1,
        height: 2,
        background: GV_BORDER2,
        opacity: sideOp,
      }}>
        {/* Pulses */}
        {pulses.map((p, i) => {
          const phase = ((localTime * 0.7 + p) % 1.4) / 1.4;
          if (localTime < 1.6) return null;
          return (
            <div key={i} style={{
              position: 'absolute',
              left: `${phase * 100}%`,
              top: -3, width: 60, height: 6,
              transform: 'translateX(-50%)',
              background: `linear-gradient(90deg, transparent, ${GV_BLUE}, transparent)`,
              boxShadow: `0 0 12px ${GV_BLUE}`,
            }}/>
          );
        })}
      </div>

      {/* CENTER: STRIX Gateway */}
      <div style={{
        position: 'absolute',
        left: '50%', top: cy,
        transform: `translate(-50%, -50%) scale(${gwScale})`,
        opacity: gwOp,
        width: 460, height: 260,
        background: `linear-gradient(180deg, #122545 0%, #081226 100%)`,
        border: `1px solid ${GV_BLUE}`,
        borderRadius: 8,
        boxShadow: `0 0 0 1px rgba(47,129,247,0.32), 0 0 80px rgba(47,129,247,0.4), 0 30px 60px rgba(0,0,0,0.55)`,
        padding: 28,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="strix-logomark.svg" alt="" style={{ width: 20, height: 20 }}/>
          <div style={{ fontFamily: GV_SANS, fontWeight: 700, fontSize: 12, letterSpacing: '0.32em', color: GV_BLUE }}>STRIX GATEWAY</div>
        </div>
        <div style={{ fontFamily: GV_SANS, fontWeight: 800, fontSize: 34, color: GV_FG1, letterSpacing: '0.02em', marginTop: 4 }}>
          EVALUATE
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {[
            'policy.evaluate(tool, args)',
            'signature.attach(decision)',
            'ledger.append(receipt)',
          ].map((line, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontFamily: GV_MONO, fontSize: 13, color: GV_FG3,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: 3, background: GV_BLUE, boxShadow: `0 0 6px ${GV_BLUE}` }}/>
              {line}
            </div>
          ))}
        </div>
        <div style={{
          marginTop: 6,
          display: 'inline-block', alignSelf: 'flex-start',
          padding: '3px 10px', borderRadius: 3,
          background: 'rgba(47,129,247,0.14)',
          border: '1px solid rgba(47,129,247,0.4)',
          fontFamily: GV_SANS, fontWeight: 700, fontSize: 11,
          letterSpacing: '0.16em', color: GV_BLUE,
        }}>DEFAULT · DENY</div>
      </div>

      {/* Three decision badges floating below */}
      <div style={{
        position: 'absolute',
        left: '50%', top: cy + 200,
        transform: 'translateX(-50%)',
        opacity: decOp,
        display: 'flex', gap: 18,
      }}>
        {[
          { label: 'ALLOW',     color: GV_ALLOW,  icon: '✓' },
          { label: 'INTERCEPT', color: GV_AMBER,  icon: '!' },
          { label: 'DENY',      color: GV_DENY,   icon: '✕' },
        ].map((d, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 18px',
            background: GV_BG2,
            border: `1px solid ${d.color}66`,
            borderRadius: 4,
            boxShadow: `0 0 24px ${d.color}30`,
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 11,
              border: `1.5px solid ${d.color}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: GV_SANS, fontWeight: 800, fontSize: 13,
              color: d.color,
            }}>{d.icon}</div>
            <div style={{
              fontFamily: GV_SANS, fontWeight: 700, fontSize: 13,
              letterSpacing: '0.18em', color: d.color,
            }}>{d.label}</div>
          </div>
        ))}
      </div>

      {/* Caption */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 940,
        textAlign: 'center', opacity: capOp,
        fontFamily: GV_SANS, fontSize: 22, color: GV_FG2,
      }}>
        Every tool call is evaluated, signed, and recorded before it executes.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 4 · DEMO (15 – 39s)
// Real CLI demo with timed callouts.
// ═══════════════════════════════════════════════════════════════════════
function GVScene4Demo() {
  const { localTime } = useSprite();
  const { time: stageTime } = useTimeline();
  const videoRef = React.useRef(null);

  // Sync video playback with timeline window (15..36s window for the 21s clip; clip auto-stops)
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const t = stageTime - GV_SCENE_TIMES.demo.start;
    // play during the active window
    if (t >= 0 && t < 21.5) {
      // soft sync — only resync if drift > 0.3s
      if (Math.abs(v.currentTime - t) > 0.3) {
        try { v.currentTime = Math.min(t, 21.0); } catch {}
      }
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
    }
  }, [stageTime]);

  const eyeOp = animate({ from: 0, to: 1, start: 0.0, end: 0.6 })(localTime);
  const hOp   = animate({ from: 0, to: 1, start: 0.1, end: 0.7, ease: Easing.easeOutCubic })(localTime);
  const hY    = animate({ from: 14, to: 0, start: 0.1, end: 0.7, ease: Easing.easeOutCubic })(localTime);
  const frameOp = animate({ from: 0, to: 1, start: 0.5, end: 1.2 })(localTime);
  const frameScale = animate({ from: 0.96, to: 1, start: 0.5, end: 1.2, ease: Easing.easeOutCubic })(localTime);
  const fade = localTime > 22.8 ? 1 - clamp((localTime - 22.8) / 1.0, 0, 1) : 1;

  // Step callouts — appear in time with the video segments
  // Demo localTime ~1.5 onwards video begins playing
  const VIDEO_OFFSET = 1.7; // localTime when video begins playing (stage t = 15.0 + 1.7 = 16.7s)
  const steps = [
    { in: 0.0,  out: 5.0,  cmd: 'npx strix-gateway init',          note: 'Ed25519 keypair · policy.json · 7 rules · default DENY',  badge: 'INIT' },
    { in: 5.0,  out: 8.0,  cmd: 'npx strix-gateway keys jwks',     note: 'Active key ID published in JWKS',                          badge: 'KEYS' },
    { in: 8.0,  out: 11.5, cmd: 'npx strix-gateway verify',        note: '0 / 5 receipts VERIFIED · keyring errors surfaced',         badge: 'VERIFY' },
    { in: 11.5, out: 15.5, cmd: 'npx strix-gateway receipts list', note: 'Notion calls · DENY · risk: MEDIUM · timestamped',          badge: 'RECEIPTS' },
    { in: 15.5, out: 21.5, cmd: 'npx strix-gateway chain',         note: '@strixgov/verifier validates the full receipt chain',       badge: 'CHAIN' },
  ];
  const tVid = localTime - VIDEO_OFFSET;
  const activeStep = steps.find(s => tVid >= s.in && tVid < s.out) || steps[0];

  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Eyebrow op={eyeOp} y={150}>LIVE · CLI WALKTHROUGH</Eyebrow>
      <Headline op={hOp} ty={hY} y={200} size={56} align="left">
        <div style={{ paddingLeft: 56 }}>
          Local-first. <span style={{ color: GV_BLUE }}>One command to start.</span>
        </div>
      </Headline>

      {/* LEFT: animated step list */}
      <div style={{
        position: 'absolute',
        left: 80, top: 380,
        width: 540,
      }}>
        <div style={{
          fontFamily: GV_SANS, fontWeight: 700, fontSize: 12,
          letterSpacing: '0.32em', color: GV_FG4,
          marginBottom: 18,
        }}>WHAT YOU&apos;RE SEEING</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {steps.map((s, i) => {
            const isActive = s === activeStep && tVid >= 0;
            const seenAlready = tVid >= s.out;
            return (
              <div key={i} style={{
                padding: '14px 18px',
                background: isActive ? 'rgba(47,129,247,0.10)' : GV_BG2,
                border: `1px solid ${isActive ? GV_BLUE : GV_BORDER2}`,
                borderLeft: `3px solid ${isActive ? GV_BLUE : (seenAlready ? GV_ALLOW : GV_BORDER2)}`,
                borderRadius: 4,
                opacity: tVid < 0 ? clamp((localTime - 0.6 - i * 0.08) / 0.4, 0, 1) : (isActive ? 1 : 0.55),
                transition: 'all 200ms',
                boxShadow: isActive ? `0 0 24px rgba(47,129,247,0.22)` : 'none',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  marginBottom: 6,
                }}>
                  <div style={{
                    fontFamily: GV_SANS, fontWeight: 700, fontSize: 10,
                    letterSpacing: '0.24em',
                    color: isActive ? GV_BLUE : (seenAlready ? GV_ALLOW : GV_FG4),
                  }}>{seenAlready ? '✓ ' : (isActive ? '▶ ' : '○ ')}{s.badge}</div>
                </div>
                <div style={{
                  fontFamily: GV_MONO, fontSize: 16, fontWeight: 500,
                  color: isActive ? GV_FG1 : GV_FG3,
                }}>{s.cmd}</div>
                <div style={{
                  fontFamily: GV_SANS, fontSize: 13,
                  color: GV_FG4, marginTop: 4,
                  lineHeight: 1.4,
                }}>{s.note}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT: terminal/window chrome with embedded video */}
      <div style={{
        position: 'absolute',
        right: 80, top: 280,
        width: 1080, height: 720,
        opacity: frameOp,
        transform: `scale(${frameScale})`,
        transformOrigin: 'center',
        background: '#0C1426',
        border: `1px solid ${GV_BORDER2}`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: `0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(47,129,247,0.18), 0 0 60px rgba(47,129,247,0.18)`,
      }}>
        {/* Title bar */}
        <div style={{
          height: 38,
          display: 'flex', alignItems: 'center',
          padding: '0 16px',
          background: 'linear-gradient(180deg, #182640, #0E1A2E)',
          borderBottom: `1px solid ${GV_BORDER2}`,
        }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ width: 12, height: 12, borderRadius: 6, background: '#FF5F57' }}/>
            <div style={{ width: 12, height: 12, borderRadius: 6, background: '#FEBC2E' }}/>
            <div style={{ width: 12, height: 12, borderRadius: 6, background: '#28C840' }}/>
          </div>
          <div style={{
            flex: 1, textAlign: 'center',
            fontFamily: GV_MONO, fontSize: 12,
            color: GV_FG3, letterSpacing: '0.12em',
          }}>
            powershell · strix-gateway
          </div>
          <div style={{
            fontFamily: GV_MONO, fontSize: 11,
            color: GV_FG4, letterSpacing: '0.12em',
          }}>● REC</div>
        </div>
        {/* Video */}
        <div style={{
          width: '100%', height: 'calc(100% - 38px)',
          background: '#000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}>
          <video
            ref={videoRef}
            src="assets/mcp-tool-gateway.mp4"
            muted
            playsInline
            preload="auto"
            style={{
              maxWidth: '100%', maxHeight: '100%',
              display: 'block',
            }}
          />
          {/* Step badge overlay (top-right corner of video) */}
          {tVid >= 0 && (
            <div style={{
              position: 'absolute',
              top: 16, right: 16,
              padding: '6px 12px',
              background: 'rgba(11,17,32,0.85)',
              border: `1px solid ${GV_BLUE}`,
              borderRadius: 3,
              fontFamily: GV_SANS, fontWeight: 700, fontSize: 11,
              letterSpacing: '0.24em', color: GV_BLUE,
              backdropFilter: 'blur(4px)',
            }}>
              STEP · {activeStep.badge}
            </div>
          )}
          {/* Pre-roll overlay */}
          {tVid < 0 && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(7,12,24,0.85)',
              fontFamily: GV_MONO, fontSize: 16,
              color: GV_FG3, letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>
              <span style={{
                width: 10, height: 10, borderRadius: 5, background: GV_BLUE,
                marginRight: 12,
                boxShadow: `0 0 12px ${GV_BLUE}`,
                opacity: 0.4 + 0.6 * Math.abs(Math.sin(localTime * 4)),
              }}/>
              Starting demo…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 5 · CAPABILITIES (39 – 46.5s)
// ═══════════════════════════════════════════════════════════════════════
function GVScene5Caps() {
  const { localTime } = useSprite();
  const eyeOp = animate({ from: 0, to: 1, start: 0.0, end: 0.6 })(localTime);
  const hOp   = animate({ from: 0, to: 1, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);
  const hY    = animate({ from: 16, to: 0, start: 0.1, end: 0.8, ease: Easing.easeOutCubic })(localTime);
  const fade  = localTime > 6.8 ? 1 - clamp((localTime - 6.8) / 0.5, 0, 1) : 1;

  const caps = [
    {
      cmd: 'init',
      title: 'Local-first setup',
      body: 'Ed25519 keypair · policy.json · 7 baseline rules · default DENY',
    },
    {
      cmd: 'keys jwks',
      title: 'Verifiable identity',
      body: 'Publishes the active key ID via JWKS. Anyone can verify your decisions.',
    },
    {
      cmd: 'verify',
      title: 'Cryptographic proof',
      body: 'Re-checks every receipt against the published keys. Zero trust required.',
    },
    {
      cmd: 'receipts list',
      title: 'Full audit log',
      body: 'Each governed call: timestamp · decision · risk · capability · args.',
    },
    {
      cmd: 'chain',
      title: 'Tamper-evident chain',
      body: 'Append-only hash chain, verified end-to-end by @strixgov/verifier.',
    },
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <Eyebrow op={eyeOp} y={130}>WHAT YOU GET</Eyebrow>
      <Headline op={hOp} ty={hY} y={180} size={64}>
        A complete control plane. <span style={{ color: GV_BLUE }}>In five commands.</span>
      </Headline>

      <div style={{
        position: 'absolute',
        left: 96, right: 96, top: 380,
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 16,
      }}>
        {caps.map((c, i) => {
          const op = clamp((localTime - 0.8 - i * 0.18) / 0.5, 0, 1);
          const ty = (1 - op) * 18;
          return (
            <div key={i} style={{
              opacity: op,
              transform: `translateY(${ty}px)`,
              padding: '24px 22px',
              background: GV_BG2,
              border: `1px solid ${GV_BORDER2}`,
              borderTop: `2px solid ${GV_BLUE}`,
              borderRadius: 6,
              minHeight: 280,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{
                fontFamily: GV_MONO, fontSize: 13, fontWeight: 600,
                color: GV_BLUE, letterSpacing: '0.06em',
              }}>strix-gateway {c.cmd}</div>
              <div style={{
                fontFamily: GV_SANS, fontWeight: 700, fontSize: 22,
                color: GV_FG1, letterSpacing: '-0.01em', marginTop: 8,
                lineHeight: 1.2,
              }}>{c.title}</div>
              <div style={{
                fontFamily: GV_SANS, fontSize: 14,
                color: GV_FG3, lineHeight: 1.5, marginTop: 4,
              }}>{c.body}</div>
            </div>
          );
        })}
      </div>

      {/* Pill row at bottom */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 880,
        textAlign: 'center',
        opacity: clamp((localTime - 2.6) / 0.5, 0, 1),
        display: 'flex', gap: 12, justifyContent: 'center',
        flexWrap: 'wrap',
      }}>
        {['Inline', 'Local-first', 'Default-DENY', 'Ed25519-signed', 'Tamper-evident', 'No vendor lock-in'].map((p, i) => (
          <span key={i} style={{
            padding: '8px 16px',
            background: 'rgba(47,129,247,0.08)',
            border: '1px solid rgba(47,129,247,0.3)',
            borderRadius: 999,
            fontFamily: GV_SANS, fontWeight: 600, fontSize: 13,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: GV_BLUE,
          }}>{p}</span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE 6 · CTA (46.5 – 55s)
// ═══════════════════════════════════════════════════════════════════════
function GVScene6CTA() {
  const { localTime } = useSprite();
  const logoOp    = animate({ from: 0, to: 1, start: 0.0, end: 0.7, ease: Easing.easeOutCubic })(localTime);
  const logoScale = animate({ from: 0.9, to: 1, start: 0.0, end: 0.7, ease: Easing.easeOutBack })(localTime);
  const tagOp     = animate({ from: 0, to: 1, start: 0.6, end: 1.2 })(localTime);
  const cmdOp     = animate({ from: 0, to: 1, start: 1.2, end: 1.8 })(localTime);
  const cmdScale  = animate({ from: 0.96, to: 1, start: 1.2, end: 1.8, ease: Easing.easeOutBack })(localTime);
  const subOp     = animate({ from: 0, to: 1, start: 1.9, end: 2.5 })(localTime);
  const urlOp     = animate({ from: 0, to: 1, start: 2.5, end: 3.1 })(localTime);

  return (
    <div style={{ position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 28,
    }}>
      {/* Logomark */}
      <div style={{
        opacity: logoOp,
        transform: `scale(${logoScale})`,
        display: 'flex', alignItems: 'center', gap: 24,
      }}>
        <img src="strix-logomark.svg" alt=""
             style={{
               width: 110, height: 144,
               filter: `drop-shadow(0 0 32px rgba(47,129,247,0.55))`,
             }}/>
        <div style={{
          fontFamily: GV_SANS, fontWeight: 900, fontSize: 92,
          color: '#fff', letterSpacing: '0.12em',
        }}>STRIX</div>
      </div>

      {/* Tagline */}
      <div style={{
        opacity: tagOp,
        fontFamily: GV_SANS, fontWeight: 400, fontSize: 28,
        color: GV_FG2, letterSpacing: '-0.005em',
        textAlign: 'center', marginTop: 4,
      }}>
        MCP Tool Gateway. Execution control for AI agents.
      </div>

      {/* Install command */}
      <div style={{
        opacity: cmdOp,
        transform: `scale(${cmdScale})`,
        marginTop: 32,
        padding: '22px 36px',
        background: GV_BG2,
        border: `1px solid ${GV_BLUE}`,
        borderRadius: 6,
        boxShadow: `0 0 0 1px rgba(47,129,247,0.32), 0 20px 60px rgba(47,129,247,0.35), 0 0 80px rgba(47,129,247,0.4)`,
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <span style={{ fontFamily: GV_MONO, fontSize: 28, color: GV_FG4 }}>$</span>
        <span style={{
          fontFamily: GV_MONO, fontSize: 32, fontWeight: 600,
          color: GV_FG1, letterSpacing: '0.01em',
        }}>npx strix-gateway init</span>
      </div>

      {/* Subline */}
      <div style={{
        opacity: subOp,
        fontFamily: GV_SANS, fontSize: 18,
        color: GV_FG4, letterSpacing: '0.04em',
        textAlign: 'center',
        marginTop: 8,
      }}>
        Sixty seconds to a governed agent. Zero infrastructure required.
      </div>

      {/* URL */}
      <div style={{
        opacity: urlOp,
        position: 'absolute',
        left: 0, right: 0, bottom: 80,
        textAlign: 'center',
        fontFamily: GV_MONO, fontSize: 16, fontWeight: 600,
        letterSpacing: '0.36em', textTransform: 'uppercase',
        color: GV_FG3,
      }}>
        strix.ai  ·  github.com/strixgov
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MASTER COMPOSITION
// ═══════════════════════════════════════════════════════════════════════
function GVMovie() {
  return (
    <>
      <GVBackdrop />
      <GVChrome />
      <Sprite start={GV_SCENE_TIMES.open.start}    end={GV_SCENE_TIMES.open.end}>    <GVScene1Open />      </Sprite>
      <Sprite start={GV_SCENE_TIMES.problem.start} end={GV_SCENE_TIMES.problem.end}> <GVScene2Problem />   </Sprite>
      <Sprite start={GV_SCENE_TIMES.gateway.start} end={GV_SCENE_TIMES.gateway.end}> <GVScene3Gateway />   </Sprite>
      <Sprite start={GV_SCENE_TIMES.demo.start}    end={GV_SCENE_TIMES.demo.end}>    <GVScene4Demo />      </Sprite>
      <Sprite start={GV_SCENE_TIMES.caps.start}    end={GV_SCENE_TIMES.caps.end}>    <GVScene5Caps />      </Sprite>
      <Sprite start={GV_SCENE_TIMES.cta.start}     end={GV_SCENE_TIMES.cta.end}>     <GVScene6CTA />       </Sprite>
      <GVProgressBar />
    </>
  );
}

Object.assign(window, {
  GVMovie, GVBackdrop, GVChrome, GVProgressBar,
  GVScene1Open, GVScene2Problem, GVScene3Gateway,
  GVScene4Demo, GVScene5Caps, GVScene6CTA,
});
