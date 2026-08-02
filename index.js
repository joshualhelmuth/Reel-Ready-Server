const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const OpenAI = require("openai");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.get("/", (req, res) => {
  res.json({ status: "Reel Ready server is running" });
});

function shell(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function ensureYtDlp() {
  try { await shell("yt-dlp --version"); }
  catch { await shell("pip install yt-dlp"); }
}

async function downloadVideo(url, outputPath) {
  console.log("Downloading video:", url);
  await shell(`yt-dlp -f "best[height<=720][ext=mp4]/best[height<=720]/best" -o "${outputPath}" "${url}" --no-playlist`);
}

async function extractFrames(videoPath, framesDir) {
  fs.mkdirSync(framesDir, { recursive: true });
  const duration = await shell(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
  );
  const dur = parseFloat(duration);
  console.log("Video duration:", dur);

  const timestamps = [2];
  const numFrames = 12;
  for (let i = 1; i < numFrames; i++) {
    const t = Math.round((dur / numFrames) * i);
    if (t > 3 && t < dur - 1) timestamps.push(t);
  }

  const framePaths = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(framesDir, `frame_${i.toString().padStart(3,"0")}.jpg`);
    try {
      await shell(`ffmpeg -ss ${timestamps[i]} -i "${videoPath}" -vframes 1 -q:v 2 -vf "scale=1280:-1" "${outPath}" -y 2>/dev/null`);
      if (fs.existsSync(outPath)) framePaths.push({ path: outPath, timestamp: timestamps[i] });
    } catch(e) { console.log(`Frame ${i} failed:`, e.message); }
  }
  console.log(`Extracted ${framePaths.length} frames`);
  return framePaths;
}

async function transcribeAudio(videoPath, audioPath) {
  console.log("Extracting audio...");
  await shell(`ffmpeg -i "${videoPath}" -vn -acodec mp3 -ab 128k "${audioPath}" -y 2>/dev/null`);
  console.log("Transcribing with Whisper...");
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "text",
  });
  return transcription;
}

function buildPrompt(submission, transcript, frames) {
  const { role, marketSize, experience, hasSlate, concern, focus } = submission;

  return `You are Josh Helmuth — 17-year TV news veteran, National Murrow Award winner, five-time Regional Murrow Award winner, four-time Regional Emmy Award winner. You give the honest reel feedback most journalists never get. You are reviewing an actual demo reel. You can SEE the video frames provided and you have the full audio transcript.

This rubric is built on nearly 20 years of direct feedback from news directors, GMs, agents, and big-market anchors — combined with published guidance from industry sources including: Mort Meisner (Mort Meisner Associates talent agency), OTA Talent TV News Agents, NBC News Academy (Anzio Williams, SVP NBCUniversal owned stations), NewsLab (Gene Kirkconnell, 30+ years ND experience, 10,000+ reels reviewed), Sportscasters Talent Agency of America, Reel Reporting/IJNet, and the blog Survive Your TV News Job. Where perspectives differ — for example, Anzio Williams recommends starting with a slate while Josh Helmuth and most working NDs consider it a waste of time — flag the disagreement honestly and explain both sides.

JOSH HELMUTH REEL RUBRIC — CORE STANDARDS:

FIRST 5-10 SECONDS (MOST CRITICAL):
- Must open with a clear, close shot of the journalist face. No VO opening, no turned back, not far away.
- The news director is asking one question: Do I want this person on my screen? Professional? Buttoned up? Trustworthy? Sound great?
- Opening Slate: Most NDs consider it a waste of 3-4 seconds — email goes in video description. NOTE: Anzio Williams (NBCUniversal) does prefer a slate with name/contact/social handles. Flag this disagreement if relevant.
- Average ND spends 10 seconds on a reel before deciding whether to keep watching. (Source: Reel Reporting/IJNet, confirmed by multiple agents)
- Fail the first 10 seconds = they're gone.

OPENING MONTAGE (target 60-80 seconds, NEVER past 80):
- Every single shot must demonstrate a DIFFERENT skill. No repeating.
- Skills: walking/talking, studio anchor, breaking news live shot, social media/TikTok live clip (HUGE bonus), creative/demonstrative standup, prop use, live interview, improvising on scene.
- Mix of field and desk — Mort Meisner recommends ~50% standups, ~50% anchor desk for anchor/reporter reels.
- Memorability matters — one remarkable, unexpected clip can make the difference. (Source: Mort Meisner Associates)
- Past 80 seconds: deduct score. Closer to 60 is better per STAA.

PACKAGES (2-3 total, NEVER more than 3):
- Breaking news is #1 priority. Remarkable pkg under pressure, extra points if MMJd.
- MMJ work = own distinct skill. Flag and reward explicitly. Note it if self-shot/edited.
- Scrappy production forgivable if journalism and storytelling are exceptional.
- Feature stories ONLY impressive at NPPA/Murrow/Boyd Huppert/Steve Hartman standards. Merely good features are common — not enough.
- Investigative beats feature for general reporter roles. Rarer, shows digging ability.
- Two packages fine if both remarkable. Three is ideal. Never more than three.
- NDs want different tones — hard news balanced with something lighter to see your personality. (Source: Survive Your TV News Job)
- Stories should have aired on broadcast when possible — live supers, time/temp visible. (Source: Anzio Williams/NBC News Academy)

ROLE-SPECIFIC:
- General reporter: breaking news + investigative or truly exceptional feature.
- Anchor/Reporter: lead with anchor presence, mix of desk and field, toss quality critical.
- MMJ: reward self-shooting, self-editing, solo live shots. Note it on the reel.
- Sports: serious journalism not just highlights. Versatility valued.
- Photographer: shot composition, nat sound, visual storytelling.

IT FACTOR:
- NDs want to feel a connection — they want to be pleasantly surprised and have their confidence confirmed. (Source: NewsLab/Gene Kirkconnell)
- Personality matters. Hard news journalist doesn't mean robotic. Show your smile, your warmth. (Source: Survive Your TV News Job)
- Be authentic. If hired, the station expects the person they saw on the reel. (Source: SportsTVJobs)

SCORING PHILOSOPHY:
- Be honest. Don't sugarcoat. This is the feedback most people never get.
- Give specific, actionable improvement recs in EVERY section.
- Reference what you actually see in frames and hear in the transcript.
- Sound like a mentor sitting across a desk, not a rubric being read aloud.
- Use broadcast terminology: lede, SOT, NAT sound, standup, button, toss, package, MMJ, live shot, kicker, slate, lower third.

SUBMISSION:
- Role applying for: ${role}
- Target market: ${marketSize}
- Experience: ${experience}
- Opens with Opening Slate: ${hasSlate === "yes" ? "YES — note the industry debate on this" : "No — opens with footage"}
- Biggest concern: ${concern || "Not specified"}
- Specific focus: ${focus || "General overall feedback"}

AUDIO TRANSCRIPT FROM THE REEL:
${transcript || "Transcript unavailable"}

FRAME TIMESTAMPS ANALYZED: ${frames.map(f => `${f.timestamp}s`).join(", ")}

You can SEE the frames and READ the transcript. Reference what you actually observe — their appearance, presence, writing, production quality. Call out specifically what you see at the opening frame. Reference actual language from the transcript. This is real video analysis, not guesswork.

Respond ONLY with valid JSON, no markdown, no preamble:

{"marketReadinessScore":<int 1-100>,"scoreBreakdown":{"firstImpression":<int 0-100>,"delivery":<int 0-100>,"writing":<int 0-100>,"storytelling":<int 0-100>,"technical":<int 0-100>},"sections":[{"num":"01","title":"First Impression (0-10 Seconds)","content":"<3-5 sentences — reference what you actually SEE in the opening frame>","fix":"<one concrete fix>"},{"num":"02","title":"Standup Quality","content":"<3-5 sentences — reference observed body language, presence, confidence>","fix":"<one concrete fix>"},{"num":"03","title":"Writing and Storytelling","content":"<3-5 sentences — reference actual transcript language>","fix":"<one concrete fix>"},{"num":"04","title":"Package Structure","content":"<3-5 sentences — evaluate breaking news first>","fix":"<one concrete fix>"},{"num":"05","title":"Live Shot Performance","content":"<3-5 sentences>","fix":"<one concrete fix>"},{"num":"06","title":"Technical Presentation","content":"<3-5 sentences — reference observed lighting, lower thirds, graphics>","fix":"<one concrete fix>"},{"num":"07","title":"Reel Architecture","content":"<3-5 sentences — montage length, skill differentiation, opening slate debate if relevant>","fix":"<one concrete fix>"},{"num":"08","title":"The It Factor Assessment","content":"<3-5 sentences — honest take on presence, personality, warmth, memorability>","fix":"<one concrete fix or affirmation>"},{"num":"09","title":"Market Fit","content":"<3-5 sentences — specific about what market tier this reel is ready for RIGHT NOW>","fix":"<what needs to change to move up one market tier>"},{"num":"10","title":"Top 3 Action Items","content":"1. <most impactful fix>\\n2. <second priority>\\n3. <third priority>"}]}`;
}

app.post("/analyze", async (req, res) => {
  const tmpDir = `/tmp/reel-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const videoPath = path.join(tmpDir, "reel.mp4");
  const audioPath = path.join(tmpDir, "audio.mp3");
  const framesDir = path.join(tmpDir, "frames");

  try {
    const submission = req.body;
    if (!submission.reelUrl) return res.status(400).json({ error: "No reel URL provided" });

    console.log("=== Starting reel analysis ===", submission.reelUrl);

    await ensureYtDlp();
    await downloadVideo(submission.reelUrl, videoPath);
    const frames = await extractFrames(videoPath, framesDir);

    let transcript = "";
    try {
      transcript = await transcribeAudio(videoPath, audioPath);
      console.log("Transcript length:", transcript.length);
    } catch(e) {
      console.log("Transcription failed, continuing without:", e.message);
    }

    const imageMessages = frames.slice(0, 10).map(f => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: fs.readFileSync(f.path).toString("base64")
      }
    }));

    const prompt = buildPrompt(submission, transcript, frames);

    console.log("Calling Claude Vision...");
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-5",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [...imageMessages, { type: "text", text: prompt }]
        }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        timeout: 120000
      }
    );

    const text = claudeRes.data.content.map(b => b.text || "").join("");
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log("=== Analysis complete. Score:", result.marketReadinessScore);
    res.json({ success: true, result });

  } catch(err) {
    console.error("Analysis error:", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Reel Ready server running on port ${PORT}`));
