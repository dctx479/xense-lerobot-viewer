// Real Chromium/H.264 regression checks for media events crossing React commits.
// Run with `bun run test:video-playback`; requires ffmpeg and Chrome/Chromium.
// Set VIDEO_PLAYBACK_STRESS=1 for continuous eight-camera playback under load.
// VIDEO_PLAYBACK_DATASET may point to a TacCap v3 dataset with eight camera MP4s.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(repo, ".tmp-playback-test-"));
let browser, server, socket;
try {
  const chrome =
    process.env.CHROME_BIN ||
    ["google-chrome", "chromium", "chromium-browser"]
      .map((name) => Bun.which(name))
      .find(Boolean);
  assert.ok(chrome, "Install Chrome/Chromium or set CHROME_BIN");
  assert.ok(Bun.which("ffmpeg"), "Install ffmpeg for H.264 fixtures");
  const clip = path.join(temp, "clip.mp4");
  const made = Bun.spawnSync([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=192x108:rate=30:duration=60",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-movflags",
    "+faststart",
    "-y",
    clip,
  ]);
  assert.equal(made.exitCode, 0, made.stderr.toString());
  const entry = path.join(temp, "entry.tsx");
  const modulePath = (name) => JSON.stringify(path.join(repo, "src", name));
  // Optional real eight-camera dataset, without changing or transcoding it.
  const dataset = process.env.VIDEO_PLAYBACK_DATASET;
  const fixtureFrames = dataset
    ? JSON.parse(
        await fs.readFile(path.join(dataset, "meta/info.json"), "utf8"),
      ).total_frames
    : 1800;
  const cameraNames = [
    "left_wrist",
    "head_left",
    "head_right",
    "right_wrist",
    "left_tactile_left",
    "left_tactile_right",
    "right_tactile_left",
    "right_tactile_right",
  ];
  await fs.writeFile(
    entry,
    `
    import React, {useCallback, useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LocaleProvider} from ${modulePath("context/locale-context.tsx")};
    import {TimeProvider,useTimeControls} from ${modulePath("context/time-context.tsx")};
    import {SimpleVideosPlayer} from ${modulePath("components/simple-videos-player.tsx")};
    import Replay from ${modulePath("components/urdf-video-overlay.tsx")};
    import {ReplayPlaybackDriver} from ${modulePath("components/replay-playback-driver.tsx")};
    import {useDocumentVisible} from ${modulePath("hooks/use-document-visible.ts")};
    import PlaybackBar from ${modulePath("components/playback-bar.tsx")};
    import {REPLAY_VIDEO_SYNC} from ${modulePath("utils/replayVideoSync.ts")};
    window.replaySyncTolerance=REPLAY_VIDEO_SYNC.HARD_SEEK_SECONDS;
    const params=new URLSearchParams(location.search);
    const segmented = params.has('episodes');
    const cameras=Number(params.get('cameras'))||2;
    window.fixtureId=location.search;
    window.cameraCount=cameras;
    window.setDocumentVisible=visible=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>!visible});
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const videos = Array.from({length:cameras},(_,i)=>({
      filename:${JSON.stringify(cameraNames)}[i]??('camera_'+i),
      url:${dataset ? "'/camera.mp4?camera='+i" : "'/clip.mp4'"},
      ...(segmented?{isSegmented:true,segmentStart:1,segmentEnd:55}:{})
    }));
    function Controls() {
      const controls=useTimeControls();
      // Queue boundary events in the SAME task as pause, before React commits.
      window.pauseAtBoundary=()=>{
        controls.setIsPlaying(false);
        for (const video of document.querySelectorAll('video')) {
          Object.defineProperty(video,'currentTime',{
            configurable:true, get:()=>54.98,
            set(value){ delete this.currentTime; this.currentTime=value; }
          });
          video.dispatchEvent(new Event('timeupdate'));
          video.dispatchEvent(new Event('ended'));
          delete video.currentTime;
        }
      };
      window.seekPaused=time=>controls.seek(time);
      return null;
    }
    function ReplayFixture() {
      const [active,setActive]=useState(true);
      const documentVisible=useDocumentVisible();
      const mediaActive=active&&documentVisible;
      const [playing,setPlaying]=useState(false);
      const [frame,setFrame]=useState(9);
      const [revision,setRevision]=useState(0);
      const frameRef=useRef(9),smoothTimeRef=useRef(null);
      const timeAtRow=useCallback(row=>row/30,[]);
      const time=timeAtRow(frame);
      window.replayTime=time;
      window.replayPlaying=mediaActive&&playing;
      const setTime=time=>{frameRef.current=Math.round(time*30);setFrame(frameRef.current)};
      window.setActive=setActive;
      window.isActive=active;
      window.toggle=()=>setPlaying(v=>!v);
      window.pauseWithLateClock=()=>{
        setPlaying(false);
        setTimeout(()=>setTime(Math.max(0,document.querySelector('video').currentTime-.45)),35);
      };
      window.seekPaused=time=>{setTime(time);setRevision(v=>v+1)};
      return <><ReplayPlaybackDriver playing={mediaActive&&playing} rowsPerSecond={30}
        replayRevision={revision} totalFrames={${fixtureFrames}} frameRef={frameRef} setFrame={setFrame}
        smoothTimeRef={smoothTimeRef} timeAtRow={timeAtRow}/>
        <Replay active={mediaActive} datasetKey="fixture" episodeId={0} videos={videos}
        playing={playing} episodeTimeSeconds={time} replayRevision={revision}/></>;
    }
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode><LocaleProvider initialLocale="en">{segmented?
        <TimeProvider duration={54} resetKey="fixture"><Controls/>
          <SimpleVideosPlayer datasetKey="fixture" episodeId={0} videosInfo={videos}/>
          <PlaybackBar/>
        </TimeProvider>:<ReplayFixture/>}
      </LocaleProvider></React.StrictMode>
    );
  `,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  });
  assert.ok(built.success, JSON.stringify(built.logs));
  const bundle = await built.outputs[0].text();
  const bytes = new Uint8Array(await fs.readFile(clip));
  const cameraBytes = dataset
    ? await Promise.all(
        cameraNames.map(
          async (name) =>
            new Uint8Array(
              await fs.readFile(
                path.join(
                  dataset,
                  "videos",
                  "observation.images." + name,
                  "chunk-000/file-000.mp4",
                ),
              ),
            ),
        ),
      )
    : [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/app.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/clip.mp4" || url.pathname === "/camera.mp4") {
        const media =
          cameraBytes[Number(url.searchParams.get("camera"))] ?? bytes;
        const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2]
          ? Math.min(Number(range[2]), media.length - 1)
          : media.length - 1;
        return new Response(media.slice(start, end + 1), {
          status: range ? 206 : 200,
          headers: {
            "accept-ranges": "bytes",
            "content-type": "video/mp4",
            "content-length": String(end - start + 1),
            ...(range
              ? { "content-range": `bytes ${start}-${end}/${media.length}` }
              : {}),
          },
        });
      }
      return new Response(
        `<!doctype html><meta charset="utf-8">
        <style>body{background:#172033}.visible{visibility:visible}.invisible{visibility:hidden}
          video{width:240px;height:180px} [data-video-frame-state]{position:relative}</style>
        <div id="root"></div><script>
          window.metrics={seeks:[],loads:0,phases:[],errors:[]};
          window.seekDetails=[];
          const proto=HTMLMediaElement.prototype;
          const current=Object.getOwnPropertyDescriptor(proto,'currentTime');
          Object.defineProperty(proto,'currentTime',{configurable:true,
            get(){return current.get.call(this)},
            set(value){metrics.seeks.push(value);seekDetails.push({target:value,before:current.get.call(this),paused:this.paused,ended:this.ended,playing:window.replayPlaying});current.set.call(this,value)}});
          const load=proto.load; proto.load=function(){metrics.loads++;return load.call(this)};
          new MutationObserver(records=>{for(const r of records){
            metrics.phases.push([r.oldValue,r.target.dataset.videoFrameState]);
          }}).observe(document,{subtree:true,attributes:true,attributeOldValue:true,
            attributeFilter:['data-video-frame-state']});
          addEventListener('error',e=>metrics.errors.push(e.message));
          addEventListener('unhandledrejection',e=>metrics.errors.push(String(e.reason)));
        </script><script type="module" src="/app.js"></script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const profile = path.join(temp, "chrome");
  const stderrPath = path.join(temp, "chrome-stderr.log");
  const stderrHandle = await fs.open(stderrPath, "w");
  try {
    browser = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-proxy-server",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profile,
        "about:blank",
      ],
      { stdout: "ignore", stderr: stderrHandle.fd },
    );
  } finally {
    await stderrHandle.close();
  }
  let active;
  const startupDeadline = performance.now() + 30_000;
  while (performance.now() < startupDeadline) {
    if (browser.exitCode !== null) break;
    try {
      const contents = await fs.readFile(
        path.join(profile, "DevToolsActivePort"),
        "utf8",
      );
      const [port, endpoint] = contents.trim().split("\n");
      if (
        Number.isInteger(Number(port)) &&
        Number(port) > 0 &&
        Number(port) <= 65535 &&
        endpoint?.startsWith("/devtools/browser/")
      ) {
        active = contents;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await Bun.sleep(50);
  }
  if (!active) {
    const diagnostic = (await fs.readFile(stderrPath, "utf8")).slice(-8192);
    throw new Error(
      "Chrome did not start (" +
        chrome +
        "; exit " +
        (browser.exitCode ?? "still running") +
        ")\n" +
        diagnostic,
    );
  }
  const [port, endpoint] = active.trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Browser command timed out: " + method));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const target = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  await call("Target.activateTarget", { targetId: target.targetId });
  await call("Page.enable", {}, sessionId);
  await call("Page.stopLoading", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 240; i++) {
      if (await evaluate(expression)) return;
      await Bun.sleep(25);
    }
    throw Error(
      "Timeout: " +
        expression +
        " " +
        JSON.stringify(await evaluate("window.metrics")),
    );
  };
  const reset =
    "window.metrics={seeks:[],loads:0,phases:[],errors:[]};window.seekDetails=[]";
  const ready =
    "document.querySelectorAll('[data-video-frame-state=ready]').length===window.cameraCount";
  const mediaPaused = (value) =>
    `[...document.querySelectorAll('video')].length===window.cameraCount && [...document.querySelectorAll('video')].every(v=>v.paused===${value})`;
  const assertUnchanged = async (label, allowPlayingDrift = false) => {
    await until(ready);
    const metrics = await evaluate("window.metrics");
    if (allowPlayingDrift && metrics.seeks.length) {
      const details = await evaluate("window.seekDetails");
      const tolerance = await evaluate("window.replaySyncTolerance");
      assert.equal(details.length, metrics.seeks.length);
      for (const detail of details) {
        assert.ok(
          detail.playing && (!detail.paused || detail.ended),
          label + ": seek while paused: " + JSON.stringify(detail),
        );
        assert.ok(
          Math.abs(detail.target - detail.before) >= tolerance,
          label + ": unnecessary decoder seek: " + JSON.stringify(detail),
        );
      }
      assert.equal(metrics.loads, 0, label + ": unexpected media reload");
      assert.deepEqual(metrics.errors, []);
      assert.deepEqual(
        metrics.phases,
        [],
        label + ": playback hides decoded frames",
      );
      console.log(
        label +
          ": validated " +
          details.length +
          " genuine playing drift corrections",
      );
    } else {
      assert.deepEqual(
        metrics,
        { seeks: [], loads: 0, phases: [], errors: [] },
        label + ": " + JSON.stringify(metrics),
      );
    }
    assert.equal(await evaluate(ready), true, label + ": frames ready");
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>getComputedStyle(v).visibility==='visible')",
      ),
      true,
      label + ": frames visible",
    );
  };
  if (process.env.VIDEO_PLAYBACK_STRESS) {
    await call("Emulation.setCPUThrottlingRate", { rate: 4 }, sessionId);
    await call(
      "Page.navigate",
      { url: server.url.toString() + "?replay&cameras=8" },
      sessionId,
    );
    await until(ready);
    await evaluate("window.toggle()");
    await until(mediaPaused(false));
    await Bun.sleep(800);
    await until(ready);
    await evaluate(reset);
    // A heavy Canvas/React task delays RAF while the media clock keeps playing.
    for (let i = 0; i < 3; i++) {
      await evaluate(
        "{const end=performance.now()+650;while(performance.now()<end){}};",
      );
      await Bun.sleep(500);
    }
    await Bun.sleep(1000);
    await until(ready);
    const stalls = await evaluate("window.metrics");
    console.log(
      "eight-camera playback through main-thread stalls:",
      JSON.stringify(stalls),
    );
    assert.deepEqual(stalls, { seeks: [], loads: 0, phases: [], errors: [] });

    // Small drift must converge without resetting all eight GOP decoders.
    await evaluate(
      "for(const v of document.querySelectorAll('video'))v.currentTime-=.3;",
    );
    await Bun.sleep(100);
    await until(ready);
    await evaluate(reset);
    await Bun.sleep(6000);
    await assertUnchanged("eight-camera soft drift recovery");
    assert.ok(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>Math.abs(v.currentTime-window.replayTime)<.2)",
      ),
    );
    await evaluate(
      "for(const v of document.querySelectorAll('video'))v.currentTime+=2;",
    );
    await Bun.sleep(100);
    await evaluate(reset);
    await until("window.metrics.seeks.length>0");
    await Bun.sleep(500);
    await assertUnchanged(
      "eight-camera large drift recovery retains frames",
      true,
    );

    await evaluate(`window.seekPaused(${fixtureFrames / 30 - 0.6})`);
    await Bun.sleep(100);
    await until(ready);
    await evaluate(reset);
    await Bun.sleep(1800);
    await assertUnchanged("eight-camera loop recovery retains frames", true);
    assert.ok(await evaluate("window.replayTime<3"), "timeline loops");
    assert.ok(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>v.currentTime<3&&!v.paused)",
      ),
      "all cameras resume after looping",
    );
    console.log(
      "eight-camera continuous playback and soft drift recovery passed" +
        (dataset ? " with real dataset" : ""),
    );
  }
  for (const { mode, cameras, cycles, cpu } of process.env.VIDEO_PLAYBACK_STRESS
    ? []
    : [
        { mode: "episodes", cameras: 2, cycles: 400, cpu: 1 },
        { mode: "replay", cameras: 2, cycles: 400, cpu: 1 },
        { mode: "replay", cameras: 8, cycles: 200, cpu: 4 },
      ]) {
    const label = `${mode} (${cameras} cameras, CPU x${cpu})`;
    const query = "?" + mode + "&cameras=" + cameras;
    await call("Emulation.setCPUThrottlingRate", { rate: cpu }, sessionId);
    await call(
      "Page.navigate",
      { url: server.url.toString() + query },
      sessionId,
    );
    await until(`window.fixtureId===${JSON.stringify(query)} && ${ready}`);
    // Finish Strict Mode's first mount/readiness and its queued media events.
    await Bun.sleep(100);
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Play]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(false));
    await Bun.sleep(300);
    await evaluate(reset);
    await evaluate(
      mode === "episodes"
        ? "window.pauseAtBoundary()"
        : "window.pauseWithLateClock()",
    );
    await until(mediaPaused(true));
    await Bun.sleep(180);
    await assertUnchanged(label + " pause race");

    // Explicit paused seeks must still update the actual decoder position.
    await evaluate("window.seekPaused(.8)");
    const targetTime = mode === "episodes" ? 1.8 : 0.8;
    await until(
      `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-${targetTime})<.05)`,
    );
    await evaluate(reset);
    for (let i = 0; i < cycles; i++) {
      await evaluate(
        mode === "episodes"
          ? "document.querySelector('button[title^=Play]').click()"
          : "window.toggle()",
      );
      await until(mediaPaused(false));
      await Bun.sleep(8 + (i % 13));
      await evaluate(
        mode === "episodes"
          ? "document.querySelector('button[title^=Pause]').click()"
          : "window.toggle()",
      );
      await until(mediaPaused(true));
      await Bun.sleep(8);
    }
    await assertUnchanged(
      label + " " + cycles + " play/pause cycles",
      mode === "replay",
    );
    await evaluate(reset);
    if (mode === "replay") {
      // Continuous playback intentionally corrects material drift; paused
      // clocks and sub-threshold offsets must still never cause a decoder seek.
      await evaluate("window.toggle()");
      await until(mediaPaused(false));
      await Bun.sleep(100);
      await evaluate("document.querySelector('video').currentTime+=2;" + reset);
      await until("window.metrics.seeks.length>0 && " + ready);
      await evaluate("window.toggle()");
      await until(mediaPaused(true));
      await assertUnchanged(label + " intentional drift recovery", true);
      await evaluate(reset);
      for (let i = 0; i < 40; i++) {
        await evaluate("window.setActive(false)");
        await until("window.isActive===false");
        await evaluate("window.setActive(true)");
        await until("window.isActive===true");
        await Bun.sleep(8);
      }
      await assertUnchanged(
        "replay visibility toggles retain the paused frame",
      );
      // A seek issued while inactive must wait, then apply exactly on return.
      await evaluate("window.setActive(false)");
      await until("window.isActive===false");
      const retainedTime = await evaluate(
        "document.querySelector('video').currentTime",
      );
      await evaluate("window.seekPaused(2.4)");
      await Bun.sleep(40);
      assert.equal(
        await evaluate("document.querySelector('video').currentTime"),
        retainedTime,
      );
      await evaluate("window.setActive(true)");
      await until(
        `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-2.4)<.05)`,
      );
      await evaluate(reset);
    }
    for (let i = 0; i < 40; i++) {
      await evaluate("window.setDocumentVisible(false)");
      await Bun.sleep(8);
      await evaluate("window.setDocumentVisible(true)");
      await Bun.sleep(8);
    }
    await assertUnchanged(label + " browser visibility changes");
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Play]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(false));
    for (let i = 0; i < 20; i++) {
      await evaluate("window.setDocumentVisible(false)");
      await until(mediaPaused(true));
      await evaluate("window.setDocumentVisible(true)");
      await until(mediaPaused(false));
      await Bun.sleep(8);
    }
    if (mode === "replay") {
      for (let i = 0; i < 20; i++) {
        await evaluate("window.setActive(false)");
        await until(mediaPaused(true));
        await evaluate("window.setActive(true)");
        await until(mediaPaused(false));
        await Bun.sleep(8);
      }
    }
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Pause]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(true));
    await assertUnchanged(
      label + " visibility changes during playback",
      mode === "replay",
    );
    console.log(
      `${label}: pause race, explicit seek, ${cycles} play/pause cycles and visibility changes passed`,
    );
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        socket.send(
          JSON.stringify({
            id: Number.MAX_SAFE_INTEGER,
            method: "Browser.close",
          }),
        );
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  socket?.close();
  server?.stop(true);
  if (browser) {
    browser.kill();
    await browser.exited;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
