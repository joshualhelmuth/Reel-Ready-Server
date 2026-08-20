const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const OpenAI = require("openai");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.get("/", (req, res) => {
  res.json({ status: "Reel Ready server is running", time: new Date().toISOString() });
});

function shell(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    console.log("CMD:", cmd.slice(0, 120));
    const proc = exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr ? stderr.slice(0, 300) : err.message));
      else resolve(stdout.trim());
    });
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("Timed out after " + (timeoutMs/1000) + "s"));
    }, timeoutMs);
    proc.on("close", () => clearTimeout(timer));
  });
}

function getFfmpegPath() {
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) {
      try { fs.chmodSync(p, "755"); } catch {}
      console.log("ffmpeg-static found:", p);
      return p;
    }
  } catch(e) { console.log("ffmpeg-static error:", e.message); }
  console.log("Falling back to system ffmpeg");
  return "ffmpeg";
}

function getFfprobePath() {
  try {
    const p = require("ffprobe-static").path;
    if (p && fs.existsSync(p)) {
      try { fs.chmodSync(p, "755"); } catch {}
      console.log("ffprobe-static found:", p);
      return p;
    }
  } catch(e) { console.log("ffprobe-static error:", e.message); }
  return "ffprobe";
}

function getYtDlpCmd() {
  const candidates = [
    "yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    (process.env.HOME || "/root") + "/.local/bin/yt-dlp",
    "/root/.local/bin/yt-dlp"
  ];
  for (const c of candidates) {
    try {
      const r = require("child_process").execSync(c + " --version 2>/dev/null", { timeout: 5000 }).toString().trim();
      if (r) { console.log("yt-dlp at:", c); return c; }
    } catch {}
  }
  return null;
}

async function ensureYtDlp() {
  let cmd = getYtDlpCmd();
  if (cmd) return cmd;
  console.log("yt-dlp not found — installing via curl...");
  try {
    await shell("curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp", 60000);
  } catch(e) {
    console.log("curl install failed:", e.message);
    try {
      await shell("pip install -q yt-dlp --break-system-packages --user", 90000);
    } catch(e2) {
      await shell("pip3 install -q yt-dlp --break-system-packages --user", 90000);
    }
  }
  cmd = getYtDlpCmd();
  if (!cmd) throw new Error("Could not find or install yt-dlp");
  console.log("yt-dlp ready at:", cmd);
  return cmd;
}

async function getYouTubeTranscript(url, tmpDir, ytdlp) {
  console.log("Trying YouTube auto-captions...");
  const outBase = path.join(tmpDir, "transcript");
  const proxyHost = process.env.PROXY_HOST || "p.webshare.io";
  const proxyPort = process.env.PROXY_PORT || "80";
  const proxyUser = process.env.PROXY_USERNAME || "";
  const proxyPass = process.env.PROXY_PASSWORD || "";
  const proxyUrl = proxyUser ? `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}` : "";
  const proxyFlag = proxyUrl ? `--proxy "${proxyUrl}"` : "";
  try {
    await shell(
      '"' + ytdlp + '" --skip-download --write-auto-subs --sub-lang en --sub-format vtt ' + proxyFlag + ' --output "' + outBase + '" "' + url + '"',
      60000
    );
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".vtt"));
    if (files.length > 0) {
      const vtt = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
      const text = vtt.split("\n")
        .filter(l => l.trim() && !l.startsWith("WEBVTT") && !l.startsWith("NOTE") && !l.match(/^\d{2}:/) && !l.includes("-->") && !l.match(/^\d+$/))
        .map(l => l.replace(/<[^>]+>/g, "").trim())
        .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      console.log("YouTube captions transcript length:", text.length);
      return text || null;
    }
  } catch(e) { console.log("YouTube captions failed:", e.message); }
  return null;
}

async function downloadVideo(url, outputPath, ytdlp) {
  console.log("Downloading video...");
  const proxyHost = process.env.PROXY_HOST || "p.webshare.io";
  const proxyPort = process.env.PROXY_PORT || "80";
  const proxyUser = process.env.PROXY_USERNAME || "";
  const proxyPass = process.env.PROXY_PASSWORD || "";
  const proxyUrl = proxyUser ? `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}` : "";
  const proxyFlag = proxyUrl ? `--proxy "${proxyUrl}"` : "";
  console.log("Using proxy:", proxyUrl ? `${proxyHost}:${proxyPort}` : "none");
  await shell(
    '"' + ytdlp + '" -f "worst[height>=360]/best[height<=480]/best" --no-playlist --max-filesize 100m ' + proxyFlag + ' -o "' + outputPath + '" "' + url + '"',
    180000
  );
  if (!fs.existsSync(outputPath)) throw new Error("Video file not found after download");
  console.log("Downloaded:", (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1) + "MB");
}

async function extractFrames(videoPath, framesDir, ffmpeg, ffprobe) {
  fs.mkdirSync(framesDir, { recursive: true });
  let dur = 240;
  try {
    const raw = await shell(
      '"' + ffprobe + '" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + videoPath + '"',
      20000
    );
    dur = parseFloat(raw) || 240;
    console.log("Duration:", dur, "seconds");
  } catch(e) { console.log("Duration detection failed, assuming 240s:", e.message); }

  const timestamps = [2];
  for (let i = 1; i <= 8; i++) {
    const t = Math.round((dur / 9) * i);
    if (t > 3 && t < dur - 2) timestamps.push(t);
  }

  const framePaths = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(framesDir, "frame_" + String(i).padStart(3,"0") + ".jpg");
    try {
      await shell(
        '"' + ffmpeg + '" -ss ' + timestamps[i] + ' -i "' + videoPath + '" -vframes 1 -q:v 4 -vf "scale=854:-1" "' + outPath + '" -y 2>/dev/null',
        25000
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        framePaths.push({ path: outPath, timestamp: timestamps[i] });
        console.log("Frame OK at " + timestamps[i] + "s");
      }
    } catch(e) { console.log("Frame failed at " + timestamps[i] + "s:", e.message); }
  }
  console.log("Total frames:", framePaths.length);
  return framePaths;
}

async function transcribeWithWhisper(videoPath, audioPath, ffmpeg) {
  console.log("Extracting audio for Whisper...");
  await shell('"' + ffmpeg + '" -i "' + videoPath + '" -vn -acodec mp3 -ab 64k -ar 16000 "' + audioPath + '" -y 2>/dev/null', 60000);
  if (!fs.existsSync(audioPath)) throw new Error("Audio extraction failed");
  console.log("Audio size:", (fs.statSync(audioPath).size / 1024).toFixed(0) + "KB");
  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "text"
  });
  return result;
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function analyzeDelivery(transcript) {
  if (!transcript || transcript.length < 50) return null;

  const words = transcript.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const fillers = {
    "um": 0, "uh": 0, "like": 0, "you know": 0,
    "so": 0, "basically": 0, "literally": 0, "actually": 0,
    "right": 0, "okay": 0, "kind of": 0, "sort of": 0
  };

  for (const [filler] of Object.entries(fillers)) {
    const escaped = filler.replace(" ", "\\s+");
    const regex = new RegExp("\\b" + escaped + "\\b", "gi");
    const matches = transcript.match(regex);
    fillers[filler] = matches ? matches.length : 0;
  }

  const totalFillers = Object.values(fillers).reduce((a,b) => a+b, 0);
  const fillerRate = wordCount > 0 ? ((totalFillers / wordCount) * 100).toFixed(1) : 0;

  const topFillers = Object.entries(fillers)
    .filter(([_, count]) => count > 1)
    .sort((a,b) => b[1]-a[1])
    .slice(0,5)
    .map(([word, count]) => '"' + word + '" (' + count + 'x)')
    .join(", ");

  const estimatedMinutes = wordCount / 160;
  const wpm = wordCount > 0 ? Math.round(wordCount / Math.max(estimatedMinutes, 1)) : 0;

  const wordFreq = {};
  const skipWords = new Set(["the","a","an","and","or","but","in","on","at","to","for",
    "of","with","is","was","are","were","be","been","being","have","has","had",
    "do","does","did","will","would","could","should","may","might","that","this",
    "it","he","she","they","we","i","you","his","her","their","our","its","my"]);

  words.forEach(w => {
    const clean = w.replace(/[^a-z]/gi,"").toLowerCase();
    if (clean.length > 3 && !skipWords.has(clean)) {
      wordFreq[clean] = (wordFreq[clean] || 0) + 1;
    }
  });

  const repetitive = Object.entries(wordFreq)
    .filter(([_, count]) => count >= 4)
    .sort((a,b) => b[1]-a[1])
    .slice(0,5)
    .map(([word, count]) => '"' + word + '" (' + count + 'x)')
    .join(", ");

  const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const avgSentenceLength = sentences.length > 0
    ? Math.round(sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length)
    : 0;

  const questions = (transcript.match(/\?/g) || []).length;

  let paceAssessment = "";
  if (wordCount < 100) paceAssessment = "Too little dialogue to assess pace accurately";
  else if (wpm < 120) paceAssessment = "Potentially slow — may sound flat or lack energy on air";
  else if (wpm <= 180) paceAssessment = "Good broadcast pace range";
  else paceAssessment = "Potentially fast — risk of losing viewers";

  let fillerAssessment = "";
  const fillerRateNum = parseFloat(fillerRate);
  if (fillerRateNum < 1) fillerAssessment = "Excellent — very clean delivery";
  else if (fillerRateNum < 2.5) fillerAssessment = "Good — minor filler presence";
  else if (fillerRateNum < 5) fillerAssessment = "Noticeable — worth addressing";
  else fillerAssessment = "High filler rate — distracting on air";

  return {
    wordCount,
    totalFillers,
    fillerRate: fillerRate + "%",
    fillerAssessment,
    topFillers: topFillers || "None detected",
    paceAssessment,
    avgSentenceLength,
    repetitiveWords: repetitive || "None detected",
    questions
  };
}

function buildPrompt(submission, transcript, frames, delivery) {
  const { role, marketSize, experience, hasSlate, concern, focus } = submission;
  return `You are Josh Helmuth — 17-year TV news veteran, National Murrow Award winner, five-time Regional Murrow Award winner, five-time Regional Emmy Award winner. You give the honest reel feedback most journalists never get. You can SEE the video frames provided and you have the transcript.

JOSH HELMUTH REEL RUBRIC — APPLY WITHOUT EXCEPTION:

FIRST 10 SECONDS (MOST CRITICAL): Must open with clear close shot of journalist face. No VO, no turned back. ND asking: Do I want this person on my screen? Opening Slate = waste of 3-4 seconds (though Anzio Williams/NBCUniversal prefers one — note debate if relevant). Fail first 10 seconds = gone.

CRITICAL DEFINITIONS — KNOW THE DIFFERENCE:
- STANDUP: Reporter speaking directly to camera. Can be stationary, walking/talking, demonstrative with props, or creative. Walking/talking standups are especially valued in the opening montage.
- PACKAGE INTERVIEW: Reporter ON CAMERA interviewing a subject as part of a pkg — this is NOT a standup. Do not confuse a reporter seated interviewing someone with a standup.
- OPENING MONTAGE: Short clips (5-10 seconds each) showing range of skills. Target 60-80 seconds total. Each clip = different skill. No repeating.
- PACKAGE (PKG): A full produced story — typically 1:30-2:30 — with VO, SOTs, NAT sound, and usually a standup.

OPENING MONTAGE (60-80 seconds, NEVER past 80): Every clip = DIFFERENT skill. No repeating. Skills: walking/talking standup, studio anchor, breaking news live shot, social media/TikTok clip (HUGE bonus — flag explicitly), creative/demonstrative standup with props, live interview, improvising. Past 80s = deduct score.

PACKAGES (2-3, NEVER more): Breaking news #1. Remarkable under pressure, extra points if MMJd. MMJ = own skill, reward it. Scrappy ok if journalism exceptional. Feature ONLY at NPPA/Murrow/Boyd Huppert/Steve Hartman level. Investigative beats feature for general reporter. On-air supers preferred.

PACKAGE IDENTIFICATION: Use YouTube chapter markers to count packages and identify story types. Read total runtime from video metadata. Never say you cannot confirm package count or runtime if this information is available.

FIELD LIVE SHOTS: May appear anywhere in the reel. Do NOT assume something is absent just because you did not capture a frame from that moment. Be explicit that frame sampling may have missed moments.

TIMESTAMPS: Always express in minutes:seconds format (e.g. 3:12, not 192s).

ROLE-SPECIFIC STANDARDS:

GENERAL REPORTER: Breaking news #1 + investigative or truly exceptional feature. MMJ work = distinct skill, flag and reward.

ANCHOR / ANCHOR-REPORTER: Anchor desk presence leads. Toss quality critical. Mix of desk and field. Reading authority, warmth, command attention.

MMJ: Reward self-shooting, self-editing, solo live shots heavily. Flag every MMJ instance.

SPORTS ANCHOR / SPORTS REPORTER: Serious journalism not highlights. Versatility valued. Going outside the lines on hard sports news matters most.

PRODUCER — COMPLETELY DIFFERENT RUBRIC: Evaluate teases only — top of show, end of A-block, hard news, soft news. Gold standard: excellent tease on unremarkable news day. Writing quality = everything. Do NOT apply reporter/anchor standards.

PHOTOGRAPHER/VIDEOGRAPHER — COMPLETELY DIFFERENT RUBRIC: 4-5 complete stories, not clips. Judge in first 30 seconds. No montage needed. Live shots not a hiring factor — if included, brief highlights with great lighting only, no anchor tosses. Real journalism over shallow reporting. Visual storytelling: composition, nat sound, sequencing, lighting, editing rhythm. Can they close the deal? Do NOT apply reporter standup or anchor standards.

IT FACTOR: NDs want personality, warmth, connection. Hard news does not mean robotic. Authentic = hireable.

SUBMISSION:
- Role: ${role}
- Target market: ${marketSize}
- Experience: ${experience}
- Opening Slate: ${hasSlate === "yes" ? "YES — note industry debate" : "No — opens with footage"}
- Concern: ${concern || "Not specified"}
- Focus: ${focus || "General"}
- Total reel runtime: ${frames.length > 0 ? formatTimestamp(frames[frames.length-1].timestamp + 30) + " (approximate from last frame)" : "Unknown"}

AUDIO DELIVERY ANALYSIS (from transcript):
${delivery ? `- Total words spoken: ${delivery.wordCount}
- Filler words detected: ${delivery.totalFillers} (${delivery.fillerRate} of all words) — ${delivery.fillerAssessment}
- Top fillers used: ${delivery.topFillers}
- Speech pace: ${delivery.paceAssessment}
- Average sentence length: ${delivery.avgSentenceLength} words
- Repetitive words/phrases: ${delivery.repetitiveWords}
- Questions asked (engagement): ${delivery.questions}
Use this data to give SPECIFIC, QUANTIFIED delivery feedback. Reference actual numbers — "You used 'um' 14 times" or "Your average sentence length of 22 words is too long for broadcast — aim for 12-15."` : "Delivery analysis unavailable"}

TRANSCRIPT: ${transcript ? transcript.slice(0, 3000) : "Not available"}

FRAMES ANALYZED: ${frames.map(f => formatTimestamp(f.timestamp)).join(", ")}

Reference what you actually SEE in frames and READ in transcript. Call out the opening frame specifically. Real video analysis — not guesswork.

Respond ONLY with valid JSON, no markdown, no preamble:
{"marketReadinessScore":<int 1-100>,"scoreBreakdown":{"firstImpression":<int 0-100>,"delivery":<int 0-100>,"writing":<int 0-100>,"storytelling":<int 0-100>,"technical":<int 0-100>},"sections":[{"num":"01","title":"First Impression (0-10 Seconds)","content":"<3-5 sentences referencing what you SEE in the opening frame>","improve":"<one concrete improvement>"},{"num":"02","title":"Standup Quality","content":"<3-5 sentences referencing observed body language and presence>","improve":"<one concrete improvement>"},{"num":"03","title":"Writing and Storytelling","content":"<3-5 sentences referencing actual transcript language AND specific delivery metrics>","improve":"<one concrete improvement>"},{"num":"04","title":"Package Structure","content":"<3-5 sentences evaluating breaking news first>","improve":"<one concrete improvement>"},{"num":"05","title":"Live Shot Performance","content":"<3-5 sentences>","improve":"<one concrete improvement>"},{"num":"06","title":"Technical Presentation","content":"<3-5 sentences referencing observed lighting lower thirds graphics>","improve":"<one concrete improvement>"},{"num":"07","title":"Reel Architecture","content":"<3-5 sentences on montage length skill differentiation slate>","improve":"<one concrete improvement>"},{"num":"08","title":"The It Factor Assessment","content":"<3-5 sentences on presence personality warmth memorability>","improve":"<one concrete improvement or affirmation>"},{"num":"09","title":"Market Fit","content":"<3-5 sentences on what market tier RIGHT NOW>","improve":"<what changes to move up one market tier>"},{"num":"10","title":"Top 3 Action Items","content":"1. <most impactful>\\n2. <second>\\n3. <third>"}]}`;
}

app.post("/analyze", async (req, res) => {
  const tmpDir = "/tmp/reel-" + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });
  const videoPath = path.join(tmpDir, "reel.mp4");
  const audioPath = path.join(tmpDir, "audio.mp3");
  const framesDir = path.join(tmpDir, "frames");
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();

  try {
    const submission = req.body;
    if (!submission.reelUrl) return res.status(400).json({ error: "No reel URL provided" });

    console.log("\n=== ANALYSIS START ===");
    console.log("URL:", submission.reelUrl);

    const ytdlp = await ensureYtDlp();
    let transcript = await getYouTubeTranscript(submission.reelUrl, tmpDir, ytdlp);
    await downloadVideo(submission.reelUrl, videoPath, ytdlp);
    const frames = await extractFrames(videoPath, framesDir, ffmpeg, ffprobe);

    if (!transcript && OPENAI_API_KEY) {
      try {
        transcript = await transcribeWithWhisper(videoPath, audioPath, ffmpeg);
        console.log("Whisper transcript length:", transcript ? transcript.length : 0);
      } catch(e) { console.log("Whisper failed:", e.message); }
    }

    if (frames.length === 0) throw new Error("No frames extracted — cannot analyze reel");

    const imageMessages = frames.slice(0, 10).map(f => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(f.path).toString("base64") }
    }));

    const delivery = analyzeDelivery(transcript);
    if (delivery) console.log("Delivery analysis:", JSON.stringify(delivery));

    const prompt = buildPrompt(submission, transcript, frames, delivery);
    console.log("Calling Claude Vision with", imageMessages.length, "frames...");

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: [...imageMessages, { type: "text", text: prompt }] }]
      },
      {
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        timeout: 120000
      }
    );

    const responseText = claudeRes.data.content.map(b => b.text || "").join("");
    const result = JSON.parse(responseText.replace(/```json|```/g, "").trim());

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log("=== ANALYSIS COMPLETE. Score:", result.marketReadinessScore, "===\n");
    res.json({ success: true, result, deliveryMetrics: delivery });

  } catch(err) {
    console.error("=== ERROR:", err.message, "===\n");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  console.log("\nReel Ready server on port", PORT);
  console.log("ffmpeg:", ffmpeg);
  console.log("ffprobe:", ffprobe);
  console.log("Anthropic key:", ANTHROPIC_API_KEY ? "SET" : "MISSING");
  console.log("OpenAI key:", OPENAI_API_KEY ? "SET" : "MISSING\n");
});
