// Bootstrap for the STRIX MCP Tool Gateway marketing video.
//
// Mounts <Stage> + <GVMovie> from gateway_video_scenes.jsx into #root.
// Pulled out of the HTML as an external <script> so the CSP for
// /marketing/(.*) can stay 'unsafe-eval' (needed by Babel) WITHOUT also
// allowing 'unsafe-inline'.

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <Stage
    width={1920}
    height={1080}
    duration={55}
    background="#070C18"
    loop={true}
    autoplay={true}
    persistKey="strix-mcp-gateway-video"
  >
    <GVMovie />
  </Stage>,
);
