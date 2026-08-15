const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const OpenAI = require("openai");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("ffmpeg path:", ffmpegPath);
console.log("ffprobe path:", ffprobePath);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Reel Ready server is running", ffmpeg: !!ffmpegPath });
});

// ─── Shell helper ────────────────────────────────────────────────────────────
function shell(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd.slice(0, 80)}`));
    }, timeoutMs);
  });
}

// ─── Ensure yt-dlp ───────────────────────────────────────────────────────────
async function ensureYtDlp() {
  try {
    await shell("yt-dlp --version", 10000);
    console.log("yt-dlp already installed");
  } catch {
    console.log("Installing yt-dlp...");
    await shell("pip install yt-dlp", 60000);
    console.log("yt-dlp installed");
  }
}

// ─── Download video ──────────────────────────────────────────────────────────
async function downloadVideo(url, outputPath) {
  console.log("Downloading video:", url);
  // Use yt-dlp to download — limit to 720p to keep file size manageable
  await shell(
    `yt-dlp -f "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best" ` +
    `--no-playlist --max-filesize 150m ` +
    `-o "${outputPath}" "${url}"`,
    180000
  );
  const stats = fs.statSync(outputPath);
  console.log(`Video downloaded: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
}

// ─── Extract frames using bundled ffmpeg ─────────────────────────────────────
async function extractFrames(videoPath, framesDir) {
  fs.mkdirSync(framesDir, { recursive: true });

  // Get duration using bundled ffprobe
  const durationRaw = await shell(
    `"${ffprobePath}" -v error -show_entries format=duration ` +
    `-of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
    30000
  );
  const dur = parseFloat(durationRaw);
  console.log("Video duration:", dur, "seconds");

  if (isNaN(dur) || dur <= 0) throw new Error("Could not read video duration");

  // Always grab frame at 2s (first impression), then spread 9 more evenly
  const timestamps = [2];
  for (let i = 1; i <= 9; i++) {
    const t = Math.round((dur / 10) * i);
    if (t > 3 && t < dur - 1) timestamps.push(t);
  }

  const framePaths = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(framesDir, `frame_${i.toString().padStart(3, "0")}.jpg`);
    try {
      await shell(
        `"${ffmpegPath}" -ss ${timestamps[i]} -i "${videoPath}" ` +
        `-vframes 1 -q:v 3 -vf "scale=960:-1" "${outPath}" -y`,
        30000
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        framePaths.push({ path: outPath, timestamp: timestamps[i] });
      }
    } catch (e) {
      console.log(`Frame at ${timestamps[i]}s failed:`, e.message);
    }
  }

  console.log(`Extracted ${framePaths.length} frames`);
  return framePaths;
}

// ─── Extract audio and transcribe with Whisper ───────────────────────────────
async function transcribeAudio(videoPath, audioPath) {
  console.log("Extracting audio...");
  await shell(
    `"${ffmpegPath}" -i "${videoPath}" -vn -acodec mp3 -ab 96k -ar 16000 "${audioPath}" -y`,
    60000
  );

  const audioStats = fs.statSync(audioPath);
  console.log(`Audio extracted: ${(audioStats.size / 1024).toFixed(0)}KB`);

  console.log("Transcribing with Whisper...");
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "text",
  });
  return transcription;
}

// ─── Build Claude Vision prompt ───────────────────────────────────────────────
function buildPrompt(submission, transcript, frames) {
  const { role, marketSize, experience, hasSlate, concern, focus } = submission;

  return `You are Josh Helmuth — 17-year TV news veteran, National Murrow Award winner, five-time Regional Murrow Award winner, five-time Regional Emmy Award winner. You give the honest reel feedback most journalists never get. You are reviewing an actual demo reel. You can SEE the video frames provided and you have the full audio transcript.

This rubric is built on nearly 20 years of direct feedback from news directors, GMs, agents, and big-market anchors — combined with published guidance from: Mort Meisner (Mort Meisner Associates), OTA Talent TV News Agents, NBC News Academy (Anzio Williams, SVP NBCUniversal), NewsLab (Gene Kirkconnell, 30+ years ND, 10,000+ reels reviewed), Sportscasters Talent Agency of America, Reel Reporting/IJNet, and Survive Your TV News Job.

JOSH HELMUTH REEL RUBRIC — APPLY WITHOUT EXCEPTION:

FIRST 5-10 SECONDS (MOST CRITICAL):
- Must open with a clear, close shot of the journalist's face. No VO opening, no turned back, not far away.
- News director asking: Do I want this person on my screen? Professional? Trustworthy? Sound great?
- Opening Slate: Most NDs consider it a waste of 3-4 seconds. NOTE: Anzio Williams (NBCUniversal) does prefer a slate. Flag disagreement if relevant.
- Average ND spends 10 seconds before deciding. Fail this = they're gone.

OPENING MONTAGE (60-80 seconds, NEVER past 80):
- Every shot must demonstrate a DIFFERENT skill. No repeating.
- Skills: walking/talking, studio anchor, breaking news live shot, social media/TikTok live clip (HUGE bonus — flag explicitly), creative standup, prop use, live interview, improvising on scene.
- Past 80 seconds = deduct score. Closer to 60 is better.
- Memorability matters — one remarkable unexpected clip can make the difference.

PACKAGES (2-3 total, NEVER more than 3):
- Breaking news #1 priority. Remarkable pkg under pressure, extra points if MMJd.
- MMJ work = own distinct skill. Flag and reward explicitly.
- Scrappy production forgivable if journalism is exceptional.
- Feature stories ONLY impressive at NPPA/Murrow/Boyd Huppert/Steve Hartman standards.
- Investigative beats feature for general reporter roles.
- Stories should have aired on broadcast — live supers, time/temp visible preferred.

ROLE-SPECIFIC:
- General reporter: breaking news + investigative or truly exceptional feature.
- Anchor/Reporter: anchor presence, mix of desk and field, toss quality critical.
- MMJ: reward self-shooting, self-editing, solo live shots.
- Sports: serious journalism not just highlights.
- Photographer: shot composition, nat sound, visual storytelling.

IT FACTOR:
- NDs want connection — pleasantly surprised, confidence confirmed.
- Personality matters. Hard news doesn't mean robotic. Show warmth.
- Be authentic. The station expects the person they saw on the reel.

SUBMISSION:
- Role applying for: ${role}
- Target market: ${marketSize}
- Experience: ${experience}
- Opens with Opening Slate: ${hasSlate === "yes" ? "YES — note the industry debate" : "No — opens with footage"}
- Biggest concern: ${concern || "Not specified"}
- Specific focus: ${focus || "General overall feedback"}

AUDIO TRANSCRIPT:
${transcript ? transcript.slice(0, 3000) : "Transcript unavailable"}

FRAME TIMESTAMPS ANALYZED: ${frames.map(f => `${f.timestamp}s`).join(", ")}

You can SEE the frames and READ the transcript. Reference what you actually observe — appearance, presence, writing, technical quality. Call out what you see at the opening frame specifically. Reference actual language from the transcript. Real video analysis, not guesswork.

Respond ONLY with valid JSON, no markdown, no preamble:

{"marketReadinessScore":<int 1-100>,"scoreBreakdown":{"firstImpression":<int 0-100>,"delivery":<int 0-100>,"writing":<int 0-100>,"storytelling":<int 0-100>,"technical":<int 0-100>},"sections":[{"num":"01","title":"First Impression (0-10 Seconds)","content":"<3-5 sentences referencing what you SEE in the opening frame>","fix":"<one concrete fix>"},{"num":"02","title":"Standup Quality","content":"<3-5 sentences referencing observed body language and presence>","fix":"<one concrete fix>"},{"num":"03","title":"Writing and Storytelling","content":"<3-5 sentences referencing actual transcript language>","fix":"<one concrete fix>"},{"num":"04","title":"Package Structure","content":"<3-5 sentences evaluating breaking news first>","fix":"<one concrete fix>"},{"num":"05","title":"Live Shot Performance","content":"<3-5 sentences>","fix":"<one concrete fix>"},{"num":"06","title":"Technical Presentation","content":"<3-5 sentences referencing observed lighting, lower thirds, graphics>","fix":"<one concrete fix>"},{"num":"07","title":"Reel Architecture","content":"<3-5 sentences on montage length, skill differentiation, slate>","fix":"<one concrete fix>"},{"num":"08","title":"The It Factor Assessment","content":"<3-5 sentences on presence, personality, warmth, memorability>","fix":"<one concrete fix or affirmation>"},{"num":"09","title":"Market Fit","content":"<3-5 sentences on what market tier this reel is ready for RIGHT NOW>","fix":"<what changes to move up one tier>"},{"num":"10","title":"Top 3 Action Items","content":"1. <most impactful fix>\\n2. <second priority>\\n3. <third priority>"}]}`;
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
    if (!submission.reelUrl) {
      return res.status(400).json({ error: "No reel URL provided" });
    }

    console.log("=== Starting reel analysis ===");
    console.log("URL:", submission.reelUrl);
    console.log("Role:", submission.role, "| Market:", submission.marketSize);

    // Step 1: Install yt-dlp if needed
    await ensureYtDlp();

    // Step 2: Download video
    await downloadVideo(submission.reelUrl, videoPath);

    // Step 3: Extract frames
    const frames = await extractFrames(videoPath, framesDir);
    if (frames.length === 0) {
      throw new Error("Could not extract any frames from the video");
    }

    // Step 4: Transcribe audio (non-blocking — continue without if it fails)
    let transcript = "";
    try {
      transcript = await transcribeAudio(videoPath, audioPath);
      console.log("Transcript ready, length:", transcript.length);
    } catch (e) {
      console.log("Transcription failed, continuing without:", e.message);
    }

    // Step 5: Build vision message with frames
    const imageMessages = frames.slice(0, 10).map(f => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: fs.readFileSync(f.path).toString("base64")
      }
    }));

    const prompt = buildPrompt(submission, transcript, frames);

    // Step 6: Call Claude Vision
    console.log("Calling Claude Vision with", imageMessages.length, "frames...");
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

    const responseText = claudeRes.data.content.map(b => b.text || "").join("");
    const clean = responseText.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    console.log("=== Analysis complete. Score:", result.marketReadinessScore, "===");
    res.json({ success: true, result });

  } catch (err) {
    console.error("=== Analysis error ===", err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Reel Ready server running on port ${PORT}`);
  console.log(`ffmpeg: ${ffmpegPath}`);
  console.log(`ffprobe: ${ffprobePath}`);
});
