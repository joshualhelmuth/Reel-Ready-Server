const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");
const OpenAI = require("openai");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Reel Ready server is running" });
});

// ─── Helper: run shell command as promise ───────────────────────────────────
function shell(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ─── Helper: ensure yt-dlp is available ─────────────────────────────────────
async function ensureYtDlp() {
  try {
    await shell("yt-dlp --version");
  } catch {
    console.log("Installing yt-dlp...");
    await shell("pip install yt-dlp");
  }
}

// ─── Helper: ensure ffmpeg is available ─────────────────────────────────────
async function ensureFfmpeg() {
  try {
    await shell("ffmpeg -version");
  } catch {
    console.log("Installing ffmpeg...");
    await shell("apt-get install -y ffmpeg 2>/dev/null || brew install ffmpeg 2>/dev/null || echo 'ffmpeg not installed'");
  }
}

// ─── Download video ──────────────────────────────────────────────────────────
async function downloadVideo(url, outputPath) {
  console.log("Downloading video:", url);
  await shell(`yt-dlp -f "best[height<=720][ext=mp4]/best[height<=720]/best" -o "${outputPath}" "${url}"`);
}

// ─── Extract frames ──────────────────────────────────────────────────────────
async function extractFrames(videoPath, framesDir, numFrames = 12) {
  fs.mkdirSync(framesDir, { recursive: true });
  // Get video duration first
  const duration = await shell(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
  );
  const dur = parseFloat(duration);

  // Always grab frame at 2 seconds (critical first impression)
  // Then spread remaining frames across the reel
  const timestamps = [2];
  const interval = dur / (numFrames - 1);
  for (let i = 1; i < numFrames; i++) {
    const t = Math.min(i * interval, dur - 1);
    if (t > 3) timestamps.push(Math.round(t));
  }

  const framePaths = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(framesDir, `frame_${i.toString().padStart(3, "0")}.jpg`);
    await shell(
      `ffmpeg -ss ${timestamps[i]} -i "${videoPath}" -vframes 1 -q:v 2 -vf "scale=1280:-1" "${outPath}" -y 2>/dev/null`
    );
    if (fs.existsSync(outPath)) framePaths.push({ path: outPath, timestamp: timestamps[i] });
  }
  return framePaths;
}

// ─── Extract audio and transcribe ────────────────────────────────────────────
async function transcribeAudio(videoPath, audioPath) {
  console.log("Extracting audio...");
  await shell(`ffmpeg -i "${videoPath}" -vn -acodec mp3 -ab 128k "${audioPath}" -y 2>/dev/null`);

  console.log("Transcribing with Whisper...");
  const audioStream = fs.createReadStream(audioPath);
  const transcription = await openai.audio.transcriptions.create({
    file: audioStream,
    model: "whisper-1",
    response_format: "text",
  });
  return transcription;
}

// ─── Encode frame to base64 ──────────────────────────────────────────────────
function frameToBase64(framePath) {
  const data = fs.readFileSync(framePath);
  return data.toString("base64");
}

// ─── Build Claude Vision prompt ──────────────────────────────────────────────
function buildVisionPrompt(submission, transcript, frameMeta) {
  const {
    role, marketSize, experience, hasSlate, reelLength,
    montageClips, packages, concern, focus
  } = submission;

  const montageDesc = montageClips
    .map((c, i) => `  Clip ${i + 1}: ${c.type} | ${c.length} | ${c.desc}`)
    .join("\n");

  const pkgDesc = packages
    .map((p, i) => `  Package ${i + 1}: ${p.type} | Length: ${p.length} | MMJ: ${p.mmj} | Topic: ${p.topic} | ${p.desc}`)
    .join("\n");

  return `You are Josh Helmuth — 17-year TV news veteran, National Murrow Award winner, five-time Regional Murrow Award winner, four-time Regional Emmy Award winner. You give the honest reel feedback most people never get. You are reviewing an actual demo reel. You can SEE the video frames provided and you have the full audio transcript.

JOSH HELMUTH REEL RUBRIC — APPLY WITHOUT EXCEPTION:

FIRST 5-10 SECONDS (MOST CRITICAL):
- Must open with clear close shot of journalist face. No VO opening, no turned back, not far away.
- News director asking: Do I want this person on my screen? Professional? Trustworthy? Sound great?
- Opening Slate (title card with name/contact before footage) = automatic red flag. Wastes 3-4 seconds.
- Fail this = news director is gone. Score harshly.

OPENING MONTAGE (60-80 seconds, never past 80):
- Every shot must demonstrate a DIFFERENT skill. No repeating.
- Social media/TikTok breaking news clip = HUGE bonus.
- Past 80 seconds = deduct score.

PACKAGES (2-3 total, NEVER more than 3):
- Breaking news #1 priority. Extra points if MMJd.
- MMJ work = own distinct skill. Flag and reward.
- Scrappy production ok if journalism exceptional.
- Feature ONLY impressive at NPPA/Murrow/Boyd Huppert/Steve Hartman standards.
- Investigative beats feature for general reporter roles.

ROLE-SPECIFIC:
- General reporter: breaking news + investigative or truly exceptional feature.
- MMJ: reward self-shooting, editing, solo live shots.
- Anchor: desk presence, toss quality, reading authority, warmth.
- Sports: serious journalism not just highlights.

WHAT YOU CAN NOW ASSESS FROM THE FRAMES AND TRANSCRIPT:
- Whether they look professional, polished, and trustworthy on screen
- Their physical presence, confidence, and body language in standups
- Eye contact with camera
- Lighting quality, lower thirds, graphic consistency, technical production
- Whether the opening shot is a tight close-up of their face
- Their actual writing — lede quality, conversational vs wire service language, story structure
- SOT setup quality, nat sound use, whether scripts sound human
- Voice and delivery patterns from the transcript

SUBMISSION DETAILS:
- Role applying for: ${role}
- Target market: ${marketSize}
- Experience: ${experience}
- Total reel length: ${reelLength}
- Opens with Opening Slate: ${hasSlate === "yes" ? "YES — flag this as a serious mistake" : "No — opens with footage (good)"}
- Opening montage clips (user-described):
${montageDesc}
- Packages on reel (user-described):
${pkgDesc}
- Biggest concern: ${concern || "Not specified"}
- Specific focus: ${focus || "General overall feedback"}

AUDIO TRANSCRIPT FROM THE REEL:
${transcript || "Transcript not available"}

FRAME TIMESTAMPS ANALYZED: ${frameMeta.map(f => `${f.timestamp}s`).join(", ")}

Now analyze the frames you can see AND the transcript. Give specific feedback that references what you actually observe — their appearance, their writing, their presence. This is real video analysis, not guesswork.

Respond ONLY with valid JSON, no markdown, no preamble:

{"marketReadinessScore":<int 1-100>,"scoreBreakdown":{"firstImpression":<int 0-100>,"delivery":<int 0-100>,"writing":<int 0-100>,"storytelling":<int 0-100>,"technical":<int 0-100>},"sections":[{"num":"01","title":"First Impression (0-10 Seconds)","content":"<3-5 sentences — reference what you actually SEE in the opening frames>","fix":"<one concrete fix>"},{"num":"02","title":"Standup Quality","content":"<3-5 sentences — reference observed body language, presence, confidence>","fix":"<one concrete fix>"},{"num":"03","title":"Writing and Storytelling","content":"<3-5 sentences — reference actual transcript language>","fix":"<one concrete fix>"},{"num":"04","title":"Package Structure","content":"<3-5 sentences — evaluate breaking news first>","fix":"<one concrete fix>"},{"num":"05","title":"Live Shot Performance","content":"<3-5 sentences>","fix":"<one concrete fix>"},{"num":"06","title":"Technical Presentation","content":"<3-5 sentences — reference observed lighting, lower thirds, graphics>","fix":"<one concrete fix>"},{"num":"07","title":"Reel Architecture","content":"<3-5 sentences — montage length, skill differentiation, opening slate assessment>","fix":"<one concrete fix>"},{"num":"08","title":"The It Factor Assessment","content":"<3-5 sentences — honest take on presence and warmth from what you observe>","fix":"<one concrete fix or affirmation>"},{"num":"09","title":"Market Fit","content":"<3-5 sentences — specific about what market tier this reel is ready for RIGHT NOW>","fix":"<what changes to move up one market tier>"},{"num":"10","title":"Top 3 Action Items","content":"1. <most impactful fix>\\n2. <second priority>\\n3. <third priority>"}]}`;
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
    const { reelUrl } = submission;

    if (!reelUrl) {
      return res.status(400).json({ error: "No reel URL provided" });
    }

    console.log("=== Starting reel analysis ===");
    console.log("URL:", reelUrl);

    // Step 1: Ensure tools
    await ensureYtDlp();
    await ensureFfmpeg();

    // Step 2: Download video
    await downloadVideo(reelUrl, videoPath);
    console.log("Video downloaded");

    // Step 3: Extract frames
    const frames = await extractFrames(videoPath, framesDir, 12);
    console.log(`Extracted ${frames.length} frames`);

    // Step 4: Transcribe audio
    let transcript = "";
    try {
      transcript = await transcribeAudio(videoPath, audioPath);
      console.log("Transcription complete, length:", transcript.length);
    } catch (e) {
      console.log("Transcription failed, continuing without:", e.message);
    }

    // Step 5: Build vision message with frames
    const imageMessages = frames.slice(0, 10).map(f => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: frameToBase64(f.path)
      }
    }));

    const prompt = buildVisionPrompt(submission, transcript, frames);

    // Step 6: Call Claude Vision
    console.log("Calling Claude Vision...");
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-5",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              ...imageMessages,
              { type: "text", text: prompt }
            ]
          }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        }
      }
    );

    const responseText = claudeRes.data.content
      .map(b => b.text || "")
      .join("");

    const clean = responseText.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    // Step 7: Clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log("=== Analysis complete ===");
    res.json({ success: true, result });

  } catch (err) {
    console.error("Analysis error:", err.message);
    // Clean up on error
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Reel Ready server running on port ${PORT}`);
});
