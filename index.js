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

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Reel Ready server is running" });
});

// ─── Shell helper ────────────────────────────────────────────────────────────
function shell(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ─── Ensure yt-dlp ───────────────────────────────────────────────────────────
async function ensureYtDlp() {
  try { await shell("yt-dlp --version"); }
  catch { await shell("pip install yt-dlp"); }
}

// ─── Download video ──────────────────────────────────────────────────────────
async function downloadVideo(url, outputPath) {
  console.log("Downloading video:", url);
  await shell(`yt-dlp -f "best[height<=720][ext=mp4]/best[height<=720]/best" -o "${outputPath}" "${url}" --no-playlist`);
}

// ─── Extract frames ──────────────────────────────────────────────────────────
async function extractFrames(videoPath, framesDir) {
  fs.mkdirSync(framesDir, { recursive: true });

  const duration = await shell(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
  );
  const dur = parseFloat(duration);
  console.log("Video duration:", dur);

  // Frame at 2s (first impression), then evenly spread 11 more
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

// ─── Transcribe audio ─────────────────────────────────────────────────────────
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

// ─── Build prompt ─────────────────────────────────────────────────────────────
function buildPrompt(submission, transcript, frames) {
  const { role, marketSize, experience, hasSlate, concern, focus } = submission;

  return `You are Josh Helmuth — 17-year TV news veteran, National Murrow Award winner, five-time Regional Murrow Award winner, four-time Regional Emmy Award winner. You give the honest reel feedback most journalists never get. You are reviewing an actual demo reel. You can SEE the video frames provided and you have the full audio transcript. Your feedback is built on nearly 20 years of direct input from news directors, general managers, agents, and big-market anchors.

JOSH HELMUTH REEL RUBRIC — APPLY WITHOUT EXCEPTION:

FIRST 5-10 SECONDS (MOST CRITICAL):
- Must open with a clear, close shot of the journalist's face. No VO opening, no turned back, not far away.
- News director is asking one question: Do I want this person on my screen? Do they look professional, buttoned up, trustworthy? Do they sound great?
- Opening Slate (title card with name/contact info before footage) = automatic red flag. Wastes 3-4 seconds. Email goes in the video description only.
- Fail this = news director is gone. Score harshly.

OPENING MONTAGE (target 60-80 seconds, NEVER past 80):
- Every single shot must demonstrate a DIFFERENT skill. No repeating.
- Skills to look for: walking/talking, studio anchor, breaking news live shot, social media/TikTok live clip (HUGE bonus — flag explicitly), creative standup, prop use, live interview, improvising on scene.
- The more remarkable and differentiated each shot, the higher the score.
- Past 80 seconds = deduct score. Want them craving more.

PACKAGES (2-3 total, NEVER more than 3):
- Breaking news is #1 priority. Did they put together a remarkable package under pressure? Extra points if MMJd.
- MMJ work (shot and reported solo) = its own distinct skill. Flag and reward explicitly.
- Scrappy production is forgivable IF the journalism and storytelling are exceptional.
- Feature stories ONLY impressive at NPPA/Murrow/Boyd Huppert/Steve Hartman standards. A merely good feature is not enough.
- Investigative beats feature for general reporter roles — rarer, shows digging ability.
- Two packages fine if both are remarkable. Three is ideal. Never more than three.

ROLE-SPECIFIC STANDARDS:
- General reporter: breaking news + investigative or truly exceptional feature.
- MMJ: reward self-shooting, self-editing, solo live shots.
- Anchor: desk presence, toss quality, reading authority, warmth.
- Sports: serious journalism not just highlights.
- Photographer: shot composition, nat sound, visual storytelling.

SUBMISSION:
- Role applying for: ${role}
- Target market: ${marketSize}
- Experience: ${experience}
- Opens with Opening Slate: ${hasSlate === "yes" ? "YES — flag this as a serious mistake" : "No — opens with footage (good)"}
- Biggest concern: ${concern || "Not specified"}
- Specific focus: ${focus || "General overall feedback"}

AUDIO TRANSCRIPT FROM THE REEL:
${transcript || "Transcript unavailable"}

FRAME TIMESTAMPS ANALYZED: ${frames.map(f => `${f.timestamp}s`).join(", ")}

You can SEE the frames and READ the transcript. Give feedback that references what you actually observe — their appearance, presence, writing, technical quality. Call out specifically what you see at the opening frame. Reference actual language from the transcript when evaluating writing. This is real video analysis.

Respond ONLY with valid JSON, no markdown, no preamble:

{"marketReadinessScore":<int 1-100>,"scoreBreakdown":{"firstImpression":<int 0-100>,"delivery":<int 0-100>,"writing":<int 0-100>,"storytelling":<int 0-100>,"technical":<int 0-100>},"sections":[{"num":"01","title":"First Impression (0-10 Seconds)","content":"<3-5 sentences — reference what you actually SEE in the opening frame>","fix":"<one concrete fix>"},{"num":"02","title":"Standup Quality","content":"<3-5 sentences — reference observed body language, presence, confidence from frames>","fix":"<one concrete fix>"},{"num":"03","title":"Writing and Storytelling","content":"<3-5 sentences — reference actual language from the transcript>","fix":"<one concrete fix>"},{"num":"04","title":"Package Structure","content":"<3-5 sentences — evaluate breaking news first, then feature/investigative>","fix":"<one concrete fix>"},{"num":"05","title":"Live Shot Performance","content":"<3-5 sentences>","fix":"<one concrete fix>"},{"num":"06","title":"Technical Presentation","content":"<3-5 sentences — reference observed lighting, lower thirds, graphics from frames>","fix":"<one concrete fix>"},{"num":"07","title":"Reel Architecture","content":"<3-5 sentences — montage length, skill differentiation, opening slate>","fix":"<one concrete fix>"},{"num":"08","title":"The It Factor Assessment","content":"<3-5 sentences — honest take on presence, voice, warmth from what you observe>","fix":"<one concrete fix or affirmation>"},{"num":"09","title":"Market Fit","content":"<3-5 sentences — specific about what market tier this reel is ready for RIGHT NOW>","fix":"<what needs to change to move up one market tier>"},{"num":"10","title":"Top 3 Action Items","content":"1. <most impactful fix>\\n2. <second priority>\\n3. <third priority>"}]}`;
}

// ─── Main analysis endpoint ───────────────────────────────────────────────────
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

    // Build vision message — send up to 10 frames
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
