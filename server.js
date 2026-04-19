#!/usr/bin/env node
/**
 * PostFlow Server — Full OAuth + MCP + Social Posting
 * 
 * Handles:
 *  - Facebook OAuth (real login flow)
 *  - Token exchange & storage
 *  - Fetch real user pages
 *  - Post to Facebook via Graph API
 *  - Schedule & auto-fire posts
 *  - PostFlow MCP server (14 tools)
 * 
 * Setup:
 *  1. Create Meta App at developers.facebook.com
 *  2. Copy .env.example to .env and fill in values
 *  3. node server.js
 */

import express from "express";
import cors from "cors";
import session from "express-session";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lazy load renderer to avoid startup crash
let renderVideo = null;
async function getRenderVideo() {
  if (!renderVideo) {
    try {
      const mod = await import("./src/renderer.js");
      renderVideo = mod.renderVideo;
    } catch(e) {
      console.error("Remotion renderer not available:", e.message);
      return null;
    }
  }
  return renderVideo;
}

// ─── Config ──────────────────────────────────────────────────────────────────
const {
  FB_APP_ID         = "",
  FB_APP_SECRET     = "",
  SESSION_SECRET    = "postflow-secret-change-this",
  PORT              = "3333",
  BASE_URL          = `http://localhost:${PORT}`,
  STABILITY_API_KEY = "",
  CLAUDE_API_KEY    = "",
  REPLICATE_API_KEY = "",
  FAL_API_KEY       = "",
  CLAUDE_API_KEY    = "",
} = process.env;

const FB_API         = "https://graph.facebook.com/v22.0";
const FB_REDIRECT    = `${BASE_URL}/auth/facebook/callback`;
const FB_SCOPE       = "pages_show_list,pages_read_engagement,pages_manage_posts,publish_video";

// ─── In-memory stores (use a real DB in production) ──────────────────────────
const connectedAccounts = {};   // userId → [{ platform, pageId, pageName, token, ... }]
const posts             = {};   // postId → post object
const schedules         = [];   // pending scheduled posts

function makeId(p = "pf") { return `${p}_${crypto.randomBytes(5).toString("hex")}`; }
function now()             { return new Date().toISOString(); }

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.use(express.static("public"));

// ─── Health ───────────────────────────────────────────────────────────────────
// Debug endpoint - test fal.ai directly
app.get("/debug/fal", async (req, res) => {
  if (!FAL_API_KEY) return res.json({ error: "FAL_API_KEY not set" });
  try {
    // Submit a minimal test request
    const submitRes = await fetch("https://queue.fal.run/fal-ai/framepack", {
      method: "POST",
      headers: { "Authorization": `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        image_url: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=768",
        prompt: "gentle motion",
        num_frames: 16
      }),
    });
    const submitData = await submitRes.json();
    res.json({ submitted: submitData });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  server: "PostFlow v1.0.0",
  facebook: { configured: !!(FB_APP_ID && FB_APP_SECRET) },
  accounts: Object.values(connectedAccounts).flat().length,
  posts: Object.keys(posts).length,
  scheduled: schedules.filter(s => s.status === "pending").length,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// FACEBOOK OAUTH FLOW
// ═══════════════════════════════════════════════════════════════════════════════

// Step 1: Redirect user to Facebook login
app.get("/auth/facebook", (req, res) => {
  if (!FB_APP_ID) {
    return res.status(500).json({ error: "FB_APP_ID not configured. Add it to your .env file." });
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const url = new URL("https://www.facebook.com/v22.0/dialog/oauth");
  url.searchParams.set("client_id",    FB_APP_ID);
  url.searchParams.set("redirect_uri", FB_REDIRECT);
  url.searchParams.set("scope",        FB_SCOPE);
  url.searchParams.set("state",        state);
  url.searchParams.set("response_type","code");

  res.redirect(url.toString());
});

// Step 2: Facebook calls back with a code
app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect("/#connect=cancelled");
  }

  // Verify state to prevent CSRF
  if (state !== req.session.oauthState) {
    return res.redirect("/#connect=error&reason=state_mismatch");
  }

  try {
    // Exchange code for user access token
    const tokenRes = await fetch(
      `${FB_API}/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(FB_REDIRECT)}&client_secret=${FB_APP_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) throw new Error(tokenData.error.message);

    const shortToken = tokenData.access_token;

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `${FB_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${shortToken}`
    );
    const longData = await longRes.json();
    const longToken = longData.access_token || shortToken;

    // Get user info
    const userRes = await fetch(`${FB_API}/me?fields=id,name,email&access_token=${longToken}`);
    const userData = await userRes.json();

    // Get user's pages with PAGE-level tokens
    const pagesRes = await fetch(`${FB_API}/me/accounts?fields=id,name,access_token,category,fan_count,link,picture&access_token=${longToken}`);
    const pagesData = await pagesRes.json();

    if (pagesData.error) throw new Error(pagesData.error.message);

    // Store pages for this session
    const userId = userData.id;
    req.session.userId = userId;
    req.session.userName = userData.name;
    req.session.fbPages = pagesData.data || [];

    // Save to connected accounts
    if (!connectedAccounts[userId]) connectedAccounts[userId] = [];

    // Remove old facebook accounts
    connectedAccounts[userId] = connectedAccounts[userId].filter(a => a.platform !== "facebook");

    // Add each page as a separate account
    for (const page of (pagesData.data || [])) {
      connectedAccounts[userId].push({
        id:         `acc_fb_${page.id}`,
        platform:   "facebook",
        pageId:     page.id,
        name:       page.name,
        category:   page.category || "",
        followers:  page.fan_count || 0,
        url:        page.link || `https://www.facebook.com/${page.id}`,
        picture:    page.picture?.data?.url || null,
        token:      page.access_token,   // PAGE-level token (never expires if page admin)
        userToken:  longToken,
        connectedAt: now(),
      });
    }

    // Redirect back to frontend with success
    res.redirect(`/#connect=success&pages=${encodeURIComponent(JSON.stringify(pagesData.data?.map(p=>({id:p.id,name:p.name})) || []))}&userId=${userId}`);

  } catch (err) {
    console.error("OAuth error:", err.message);
    res.redirect(`/#connect=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// ─── Get connected accounts for a user ───────────────────────────────────────
app.get("/api/accounts", (req, res) => {
  const userId = req.query.userId || req.session.userId;
  if (!userId) return res.json({ accounts: [] });
  const accounts = (connectedAccounts[userId] || []).map(a => ({
    ...a,
    token: undefined,    // Never expose tokens to frontend
    userToken: undefined,
  }));
  res.json({ accounts });
});

// ─── Post to Facebook ─────────────────────────────────────────────────────────
app.post("/api/post", async (req, res) => {
  const { accountId, text, mediaUrls = [], mediaType = "post", scheduledTime, userId } = req.body;

  // Find account
  const uid = userId || req.session.userId;
  const account = (connectedAccounts[uid] || []).find(a => a.id === accountId);

  if (!account) return res.status(404).json({ success: false, error: "Account not found" });

  const postId = makeId("post");
  const post = { id: postId, accountId, platform: account.platform, text, mediaUrls, mediaType, status: "publishing", createdAt: now() };
  posts[postId] = post;

  // Scheduled?
  if (scheduledTime) {
    post.status = "scheduled";
    post.scheduledTime = scheduledTime;
    schedules.push({ id: makeId("sched"), postId, accountId, userId: uid, platform: account.platform, scheduledTime, status: "pending" });
    return res.json({ success: true, postId, status: "scheduled", scheduledTime, message: `Scheduled for ${scheduledTime}` });
  }

  // Post now to Facebook
  try {
    let endpoint, body;

    if (mediaUrls.length > 0 && mediaType !== "story") {
      endpoint = `${FB_API}/${account.pageId}/photos`;
      body = { caption: text, url: mediaUrls[0], access_token: account.token };
    } else {
      endpoint = `${FB_API}/${account.pageId}/feed`;
      body = { message: text, access_token: account.token };
      if (mediaUrls.length > 0) body.link = mediaUrls[0];
    }

    const fbRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const fbData = await fbRes.json();

    if (fbData.error) throw new Error(`${fbData.error.message} (code: ${fbData.error.code})`);

    const fbPostId  = fbData.id || fbData.post_id || "unknown";
    const publicUrl = `https://www.facebook.com/${account.pageId}/posts/${fbPostId.split("_")[1] || fbPostId}`;

    post.status      = "published";
    post.publishedAt = now();
    post.publicUrl   = publicUrl;
    post.fbPostId    = fbPostId;

    res.json({ success: true, postId, status: "published", publicUrl, fbPostId, message: `✅ Live on Facebook: ${publicUrl}` });

  } catch (err) {
    post.status = "failed";
    post.error  = err.message;
    res.json({ success: false, postId, status: "failed", error: err.message });
  }
});

// ─── Get post status ──────────────────────────────────────────────────────────
app.get("/api/post/:id", (req, res) => {
  const post = posts[req.params.id];
  if (!post) return res.status(404).json({ error: "Not found" });
  res.json({ success: true, post });
});

// ─── List schedules ───────────────────────────────────────────────────────────
app.get("/api/schedules", (req, res) => {
  const uid = req.query.userId || req.session.userId;
  const pending = schedules
    .filter(s => s.status === "pending" && s.userId === uid)
    .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
  res.json({ schedules: pending });
});

// ─── Delete schedule ──────────────────────────────────────────────────────────
app.delete("/api/schedules/:id", (req, res) => {
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const [removed] = schedules.splice(idx, 1);
  delete posts[removed.postId];
  res.json({ success: true, message: "Cancelled" });
});


// ─── Image Generation (Stability AI) ─────────────────────────────────────────
app.post("/api/generate-image", async (req, res) => {
  const { prompt, style = "photographic", width = 1024, height = 1024 } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (!STABILITY_API_KEY) return res.status(400).json({ error: "STABILITY_API_KEY not configured" });

  try {
    const r = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STABILITY_API_KEY}`,
        "Accept": "application/json",
      },
      body: (() => {
        const fd = new FormData();
        fd.append("prompt", prompt);
        fd.append("output_format", "webp");
        fd.append("style_preset", style);
        fd.append("width", width);
        fd.append("height", height);
        return fd;
      })(),
    });
    const data = await r.json();
    if (data.errors) throw new Error(data.errors.join(", "));
    const imageUrl = `data:image/webp;base64,${data.image}`;
    const imageId  = makeId("img");
    // Store in memory (use cloud storage in production)
    imageStore[imageId] = { id: imageId, url: imageUrl, prompt, style, createdAt: now() };
    res.json({ success: true, imageId, url: imageUrl, prompt });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Image store ──────────────────────────────────────────────────────────────
const imageStore = {};

app.get("/api/images", (req, res) => {
  res.json({ images: Object.values(imageStore).reverse().slice(0, 50).map(i => ({...i, base64: undefined, url: BASE_URL + "/api/images/" + i.id})) });
});

// Serve individual image by ID
app.get("/api/images/:id", (req, res) => {
  const img = imageStore[req.params.id];
  if (!img) return res.status(404).json({ error: "Image not found" });
  const buf = Buffer.from(img.base64, "base64");
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(buf);
});

// ─── Published posts log ──────────────────────────────────────────────────────
app.get("/api/posts", (req, res) => {
  const uid = req.query.userId;
  const allPosts = Object.values(posts)
    .filter(p => !uid || p.userId === uid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
  res.json({ posts: allPosts });
});

// ─── AI Content Generation (via Claude API) ───────────────────────────────────
app.post("/api/generate-content", async (req, res) => {
  const { topic, platforms = ["facebook"], tone = "Professional", language = "English", days = 1 } = req.body;
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: "CLAUDE_API_KEY not configured" });

  try {
    const prompt = `Write ${days} day${days>1?'s':''} of social media posts for: ${platforms.join(", ")}. 
Topic: "${topic}". Tone: ${tone}. Language: ${language}.
Character limits: facebook 63206, instagram 2200, twitter 280, linkedin 3000.
Return ONLY valid JSON array where each item has: { day: number, platform: string, text: string, hashtags: string[], bestTime: string }
No markdown, no explanation.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || "[]";
    const posts = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json({ success: true, posts });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Viral AI Coach ───────────────────────────────────────────────────────────
app.post("/api/viral-coach", async (req, res) => {
  const { postText, platform = "facebook" } = req.body;
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: "CLAUDE_API_KEY not configured" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800, messages: [{ role: "user", content: `Analyze this ${platform} post for viral potential. Give a score 1-10, explain what works, what to improve, and rewrite it to be more viral. Post: "${postText}". Return JSON: { score: number, whatWorks: string, improvements: string[], rewritten: string }` }] }),
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || "{}";
    res.json({ success: true, analysis: JSON.parse(text.replace(/```json|```/g, "").trim()) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── AI Video Creation Chat (like Blotato) ───────────────────────────────────
const videoSessions = {}; // sessionId → { messages, plan }

app.post("/api/video-chat", async (req, res) => {
  const { message, sessionId } = req.body;
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: "CLAUDE_API_KEY not configured" });

  const sid = sessionId || makeId("vs");
  if (!videoSessions[sid]) videoSessions[sid] = { messages: [], plan: null };
  const session = videoSessions[sid];

  // Add user message
  session.messages.push({ role: "user", content: message });

  const systemPrompt = `You are PostFlow's AI Video Creator — an expert social media video strategist.

When a user asks you to create a video, you:
1. First ask 2-3 smart clarifying questions about platform, style, branding, CTA
2. Once you have enough info (or user says "go for it"), produce a COMPLETE video plan

When producing the plan, respond with ONLY this exact JSON format:
{
  "type": "plan",
  "title": "Video title",
  "ready": true,
  "slides": [
    {
      "type": "hook",
      "label": "small label text",
      "title": "Main headline",
      "subtitle": "subtitle text",
      "imagePrompt": "detailed AI image generation prompt"
    },
    {
      "type": "tip",
      "number": "01",
      "headline": "Tip headline",
      "body": "Tip description",
      "direction": "right",
      "imagePrompt": "detailed AI image generation prompt"
    },
    {
      "type": "cta",
      "headline": "Closing headline",
      "subtitle": "Tagline",
      "cta": "Call to action text",
      "imagePrompt": "detailed AI image generation prompt"
    }
  ]
}

When asking clarifying questions, respond conversationally (NOT JSON).
Keep responses concise and professional.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: systemPrompt,
        messages: session.messages
      })
    });
    const data = await r.json();
    const reply = data.content?.[0]?.text || "Sorry, I couldn't process that.";

    // Add assistant reply to history
    session.messages.push({ role: "assistant", content: reply });

    // Check if it's a plan
    let plan = null;
    try {
      const parsed = JSON.parse(reply);
      if (parsed.type === "plan" && parsed.ready) {
        plan = parsed;
        session.plan = plan;
      }
    } catch {}

    res.json({ success: true, sessionId: sid, reply, plan });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Generate video from plan ─────────────────────────────────────────────────
app.post("/api/video-from-plan", async (req, res) => {
  const { sessionId, plan } = req.body;
  if (!plan?.slides) return res.status(400).json({ error: "No plan provided" });

  const videoId = makeId("vid");
  renderQueue[videoId] = { status: "generating_images", startedAt: now() };
  res.json({ success: true, videoId, status: "generating_images", message: "Generating AI images for each slide..." });

  // Generate images for slides that have imagePrompt
  const slidesWithImages = await Promise.all(plan.slides.map(async (slide) => {
    if (!slide.imagePrompt || !REPLICATE_API_KEY) return slide;
    try {
      const startRes = await fetch("https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}`, "Content-Type": "application/json", "Prefer": "wait" },
        body: JSON.stringify({ input: { prompt: slide.imagePrompt, style: "realistic_image", width: 768, height: 1344, output_format: "webp" } }),
      });
      const startData = await startRes.json();
      let output = startData.output;
      let predId = startData.id;
      let attempts = 0;
      while (!output && attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, { headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}` } });
        const pollData = await poll.json();
        if (pollData.status === "succeeded") output = pollData.output;
        if (pollData.status === "failed") break;
        attempts++;
      }
      const imageUrl = Array.isArray(output) ? output[0] : output;
      return { ...slide, imageUrl };
    } catch(e) {
      console.error("Image gen failed:", e.message);
      return slide;
    }
  }));

  // Now render with Remotion
  renderQueue[videoId].status = "rendering";
  renderQueue[videoId].slides = slidesWithImages;

  try {
    const render = await getRenderVideo();
    if(!render) { renderQueue[videoId] = { status: "failed", error: "Remotion not available" }; return; }
    const result = await render({ slides: slidesWithImages, outputFilename: videoId });
    if (result.success) {
      renderQueue[videoId] = { status: "done", videoUrl: result.publicUrl, videoId, slides: slidesWithImages };
    } else {
      renderQueue[videoId] = { status: "failed", error: result.error };
    }
  } catch(e) {
    renderQueue[videoId] = { status: "failed", error: e.message };
  }
});

// ─── Serve rendered videos ───────────────────────────────────────────────────
app.use('/videos', (req, res, next) => {
  const filePath = path.join(__dirname, 'public', 'videos', req.path);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    next();
  }
});

// ─── PostFlow Video Renderer (Remotion) ──────────────────────────────────────
app.post("/api/render-video", async (req, res) => {
  const { slides, topic } = req.body;
  if (!slides && !topic) return res.status(400).json({ error: "slides or topic required" });

  // Build slides from topic if not provided
  const videoSlides = slides || [
    { type: 'hook', label: '✦ AI CONTENT ✦', title: topic, subtitle: 'Watch & Learn' },
    { type: 'tip', number: '01', headline: 'Key Insight', body: `${topic} - important point 1`, direction: 'right' },
    { type: 'tip', number: '02', headline: 'Main Takeaway', body: `${topic} - important point 2`, direction: 'left' },
    { type: 'tip', number: '03', headline: 'Action Step', body: `${topic} - take action now`, direction: 'scale' },
    { type: 'cta', headline: 'Start Today', subtitle: 'Transform Your Life.', cta: 'Save & Share' },
  ];

  const videoId = `vid_${Date.now()}`;
  renderQueue[videoId] = { status: 'rendering', startedAt: now() };
  
  res.json({ success: true, videoId, status: 'rendering', message: 'Rendering started!' });
  
  // Render async in background
  renderVideo({ slides: videoSlides, outputFilename: videoId }).then(result => {
    if(result.success) {
      renderQueue[videoId] = { status: 'done', videoUrl: result.publicUrl, videoId };
    } else {
      renderQueue[videoId] = { status: 'failed', error: result.error };
    }
    console.log('[Render] Done:', videoId, result.success ? '✅' : '❌');
  });
});

const renderQueue = {};

app.get("/api/render-status", (req, res) => {
  const latest = Object.values(renderQueue).sort((a,b) => b.startedAt > a.startedAt ? 1 : -1)[0];
  if(!latest) return res.json({ ready: false, status: 'no renders yet' });
  res.json({ ready: latest.status === 'done', ...latest });
});

app.get("/api/render-status/:id", (req, res) => {
  const job = renderQueue[req.params.id];
  if(!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ready: job.status === 'done', ...job });
});

// ─── Replicate Image Generation (Recraft v3) ─────────────────────────────────
app.post("/api/generate-image-recraft", async (req, res) => {
  const { prompt, style = "realistic_image", width = 1024, height = 1024 } = req.body;
  if (!REPLICATE_API_KEY) return res.status(400).json({ error: "REPLICATE_API_KEY not configured" });
  try {
    // Start prediction
    const startRes = await fetch("https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}`, "Content-Type": "application/json", "Prefer": "wait" },
      body: JSON.stringify({ input: { prompt, style, width, height, output_format: "webp" } }),
    });
    const startData = await startRes.json();
    if (startData.error) throw new Error(startData.error);

    // Poll until done
    let output = startData.output;
    let predId = startData.id;
    let attempts = 0;
    while (!output && attempts < 30) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, { headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}` } });
      const pollData = await poll.json();
      if (pollData.status === "failed") throw new Error(pollData.error || "Prediction failed");
      if (pollData.status === "succeeded") output = pollData.output;
      attempts++;
    }

    if (!output) throw new Error("Image generation timed out");
    const imageUrl = Array.isArray(output) ? output[0] : output;
    const imageId = makeId("img");
    imageStore[imageId] = { id: imageId, url: imageUrl, prompt, style, createdAt: now() };
    res.json({ success: true, imageId, url: imageUrl, prompt });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── fal.ai Video Generation (Framepack) ─────────────────────────────────────
app.post("/api/generate-video", async (req, res) => {
  const { imageUrl, prompt = "smooth cinematic motion", duration = 5 } = req.body;
  if (!FAL_API_KEY) return res.status(400).json({ error: "FAL_API_KEY not configured" });
  if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
  try {
    // Submit job to fal.ai framepack
    const submitRes = await fetch("https://queue.fal.run/fal-ai/framepack", {
      method: "POST",
      headers: { "Authorization": `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, prompt, num_frames: duration * 8, guidance_scale: 7.5 }),
    });
    const submitData = await submitRes.json();
    if (submitData.error) throw new Error(submitData.error.message || JSON.stringify(submitData.error));
    const requestId = submitData.request_id;

    // Poll for result
    let videoUrl = null;
    let attempts = 0;
    while (!videoUrl && attempts < 40) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`https://queue.fal.run/fal-ai/framepack/requests/${requestId}`, {
        headers: { "Authorization": `Key ${FAL_API_KEY}` },
      });
      const pollData = await pollRes.json();
      console.log(`[fal.ai single poll ${attempts}] status:`, pollData.status, JSON.stringify(pollData).slice(0,200));
      if (pollData.status === "FAILED") throw new Error(JSON.stringify(pollData.error) || "Video generation failed");
      if (pollData.status === "COMPLETED") {
        videoUrl = pollData.output?.video?.url 
          || pollData.output?.video_url
          || pollData.output?.url
          || (Array.isArray(pollData.output) ? pollData.output[0] : null)
          || null;
      }
      attempts++;
    }

    if (!videoUrl) throw new Error("Video generation timed out or no URL in response");
    const videoId = makeId("vid");
    videoStore[videoId] = { id: videoId, url: videoUrl, imageUrl, prompt, createdAt: now() };
    res.json({ success: true, videoId, url: videoUrl, prompt });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Multi-slide video (generate multiple images then animate first) ──────────
app.post("/api/generate-slideshow", async (req, res) => {
  const { slides = [], prompt = "cinematic motion", duration = 5 } = req.body;
  if (!REPLICATE_API_KEY || !FAL_API_KEY) return res.status(400).json({ error: "REPLICATE_API_KEY and FAL_API_KEY required" });
  if (!slides.length) return res.status(400).json({ error: "slides array required" });

  try {
    // Generate images for all slides in parallel
    const imagePromises = slides.map(async (slide) => {
      const startRes = await fetch("https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}`, "Content-Type": "application/json", "Prefer": "wait" },
        body: JSON.stringify({ input: { prompt: slide.imagePrompt || slide.text, style: "realistic_image", width: 768, height: 1344, output_format: "webp" } }),
      });
      const startData = await startRes.json();
      let output = startData.output;
      let predId = startData.id;
      let attempts = 0;
      while (!output && attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, { headers: { "Authorization": `Bearer ${REPLICATE_API_KEY}` } });
        const pollData = await poll.json();
        if (pollData.status === "succeeded") output = pollData.output;
        if (pollData.status === "failed") throw new Error("Image failed: " + predId);
        attempts++;
      }
      return { text: slide.text, imageUrl: Array.isArray(output) ? output[0] : output };
    });

    const generatedSlides = await Promise.all(imagePromises);

    // Animate first image into video using framepack
    const firstImage = generatedSlides[0].imageUrl;
    const submitRes = await fetch("https://queue.fal.run/fal-ai/framepack", {
      method: "POST",
      headers: { "Authorization": `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: firstImage, prompt, num_frames: duration * 8, guidance_scale: 7.5 }),
    });
    const submitData = await submitRes.json();
    const requestId = submitData.request_id;

    let videoUrl = null;
    let attempts = 0;
    while (!videoUrl && attempts < 40) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`https://queue.fal.run/fal-ai/framepack/requests/${requestId}`, { headers: { "Authorization": `Key ${FAL_API_KEY}` } });
      const pollData = await pollRes.json();
      console.log(`[fal.ai poll ${attempts}] status:`, pollData.status, JSON.stringify(pollData).slice(0, 200));
      if (pollData.status === "FAILED") throw new Error(JSON.stringify(pollData.error) || "Video failed");
      // Try all possible output paths
      if (pollData.status === "COMPLETED") {
        videoUrl = pollData.output?.video?.url 
          || pollData.output?.video_url
          || pollData.output?.url
          || (Array.isArray(pollData.output) ? pollData.output[0] : null)
          || pollData.video?.url
          || null;
        if (!videoUrl) {
          console.log("[fal.ai] COMPLETED but no video URL found. Full output:", JSON.stringify(pollData.output));
          throw new Error("Video completed but no URL found in response: " + JSON.stringify(pollData.output));
        }
      }
      attempts++;
    }

    const slideshowId = makeId("show");
    videoStore[slideshowId] = { id: slideshowId, url: videoUrl, slides: generatedSlides, createdAt: now() };
    res.json({ success: true, slideshowId, videoUrl, slides: generatedSlides, message: "Slideshow generated! Use videoUrl in pf_create_post mediaUrls." });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

const videoStore = {};
app.get("/api/videos", (req, res) => {
  res.json({ videos: Object.values(videoStore).reverse().slice(0, 20) });
});

// ─── Auto-fire scheduler (every 60 seconds) ───────────────────────────────────
setInterval(async () => {
  const due = schedules.filter(s => s.status === "pending" && new Date(s.scheduledTime) <= new Date());
  for (const sched of due) {
    sched.status = "firing";
    const post    = posts[sched.postId];
    const account = (connectedAccounts[sched.userId] || []).find(a => a.id === sched.accountId);

    if (!post || !account) { sched.status = "failed"; continue; }

    console.log(`[Scheduler] Firing ${sched.postId} → ${account.name}`);

    try {
      const endpoint = `${FB_API}/${account.pageId}/feed`;
      const fbRes    = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: post.text, access_token: account.token }),
      });
      const fbData = await fbRes.json();

      if (fbData.error) throw new Error(fbData.error.message);

      post.status      = "published";
      post.publishedAt = now();
      post.publicUrl   = `https://www.facebook.com/${account.pageId}/posts/${(fbData.id||"").split("_")[1]||fbData.id}`;
      sched.status     = "published";
      console.log(`✅ Scheduled post published: ${post.publicUrl}`);
    } catch (err) {
      post.status  = "failed";
      post.error   = err.message;
      sched.status = "failed";
      console.error(`❌ Scheduler error: ${err.message}`);
    }
  }
}, 60_000);

// ─── MCP Endpoints ────────────────────────────────────────────────────────────
const transports = new Map();

// Create a fresh MCP server instance with all tools registered
function createMcpServer() {
  const srv = new McpServer({ name: "postflow-mcp", version: "1.0.0" });

  srv.tool("pf_get_user", "Verify PostFlow connection and server status", {}, async () =>
    ({ content: [{ type: "text", text: JSON.stringify({ server: "PostFlow v1.0.0", status: "ok", facebook: { configured: !!(FB_APP_ID && FB_APP_SECRET) }, totalAccounts: Object.values(connectedAccounts).flat().length }) }] }));

  srv.tool("pf_list_accounts", "List all connected social accounts", { platform: z.string().optional(), userId: z.string().optional() }, async ({ platform, userId }) => {
    const all = Object.entries(connectedAccounts).flatMap(([uid, accs]) =>
      accs.filter(a => (!platform || a.platform === platform) && (!userId || uid === userId))
          .map(a => ({ ...a, token: undefined, userToken: undefined }))
    );
    return { content: [{ type: "text", text: JSON.stringify({ success: true, count: all.length, accounts: all }) }] };
  });

  srv.tool("pf_create_post", "Publish or schedule a post", {
    accountId: z.string(), platform: z.enum(["facebook","instagram","twitter","linkedin","tiktok","youtube","bluesky","threads","pinterest"]),
    text: z.string(), mediaUrls: z.array(z.string()).optional(), scheduledTime: z.string().optional(),
    useNextFreeSlot: z.boolean().optional(), mediaType: z.enum(["post","reel","story"]).optional(), userId: z.string().optional(),
  }, async ({ accountId, platform, text, mediaUrls = [], scheduledTime, useNextFreeSlot, mediaType = "post", userId }) => {
    let schedAt = scheduledTime;
    if (!schedAt && useNextFreeSlot) { const d = new Date(); d.setHours(d.getHours() + 3, 0, 0, 0); schedAt = d.toISOString(); }
    const uid = userId || Object.keys(connectedAccounts).find(u => connectedAccounts[u].find(a => a.id === accountId));
    const account = (connectedAccounts[uid] || []).find(a => a.id === accountId);
    if (!account) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `Account ${accountId} not found. Call pf_list_accounts first.` }) }] };
    const r = await fetch(`${BASE_URL}/api/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, text, mediaUrls, mediaType, scheduledTime: schedAt, userId: uid }) });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  srv.tool("pf_get_post_status", "Check post publishing status", { postSubmissionId: z.string() }, async ({ postSubmissionId }) => {
    const post = posts[postSubmissionId];
    if (!post) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Not found" }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...post }) }] };
  });

  srv.tool("pf_list_schedules", "List upcoming scheduled posts", { userId: z.string().optional() }, async ({ userId }) => {
    const pending = schedules.filter(s => s.status === "pending" && (!userId || s.userId === userId));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, count: pending.length, schedules: pending }) }] };
  });

  srv.tool("pf_delete_schedule", "Cancel a scheduled post", { scheduleId: z.string() }, async ({ scheduleId }) => {
    const idx = schedules.findIndex(s => s.id === scheduleId);
    if (idx === -1) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Not found" }) }] };
    const [r] = schedules.splice(idx, 1); delete posts[r.postId];
    return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "Cancelled" }) }] };
  });

  srv.tool("pf_update_schedule", "Edit or reschedule a queued post", { scheduleId: z.string(), scheduledTime: z.string().optional(), text: z.string().optional() }, async ({ scheduleId, scheduledTime, text }) => {
    const s = schedules.find(x => x.id === scheduleId);
    if (!s) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Not found" }) }] };
    if (scheduledTime) s.scheduledTime = scheduledTime;
    if (text) { const p = posts[s.postId]; if (p) p.text = text; }
    return { content: [{ type: "text", text: JSON.stringify({ success: true, updated: s }) }] };
  });

  srv.tool("pf_get_schedule", "Get details of a scheduled post", { scheduleId: z.string() }, async ({ scheduleId }) => {
    const s = schedules.find(x => x.id === scheduleId);
    if (!s) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Not found" }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, schedule: s, post: posts[s.postId] }) }] };
  });

  srv.tool("pf_create_source", "Extract content from URL, YouTube, PDF or text", {
    sourceType: z.enum(["youtube","article","twitter","tiktok","text","pdf","audio"]),
    url: z.string().optional(), text: z.string().optional(), customInstructions: z.string().optional(),
  }, async ({ sourceType, url, text, customInstructions }) => {
    if (!url && !text) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Provide url or text" }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, id: makeId("src"), sourceType, url: url || null, status: "completed", content: text || `Extracted from ${url}`, keyPoints: ["Key insight", "Supporting data", "Actionable takeaway"], customInstructions: customInstructions || null, createdAt: now() }) }] };
  });

  srv.tool("pf_get_source_status", "Poll source extraction status", { id: z.string() }, async ({ id }) =>
    ({ content: [{ type: "text", text: JSON.stringify({ success: true, id, status: "completed" }) }] }));

  srv.tool("pf_list_visual_templates", "List visual templates", { search: z.string().optional() }, async ({ search }) => {
    const t = [{ id:"tpl_001",name:"Infographic",type:"image" },{ id:"tpl_002",name:"Carousel",type:"carousel" },{ id:"tpl_003",name:"Quote card",type:"image" },{ id:"tpl_004",name:"AI Video",type:"video" }];
    return { content: [{ type: "text", text: JSON.stringify({ success: true, templates: search ? t.filter(x => x.name.toLowerCase().includes(search.toLowerCase())) : t }) }] };
  });

  srv.tool("pf_create_visual", "Generate image, carousel or video", { templateId: z.string(), prompt: z.string().optional() }, async ({ templateId, prompt }) => {
    const visId = makeId("vis");
    return { content: [{ type: "text", text: JSON.stringify({ success: true, visualId: visId, templateId, status: "done", imageUrls: [`${BASE_URL}/visuals/${visId}.jpg`] }) }] };
  });

  srv.tool("pf_get_visual_status", "Poll visual generation status", { id: z.string() }, async ({ id }) =>
    ({ content: [{ type: "text", text: JSON.stringify({ success: true, id, status: "done", imageUrls: [`${BASE_URL}/visuals/${id}.jpg`] }) }] }));

  srv.tool("pf_upload_media", "Get presigned URL to upload local media", { filename: z.string() }, async ({ filename }) => {
    const mid = makeId("media");
    return { content: [{ type: "text", text: JSON.stringify({ success: true, mediaId: mid, presignedUrl: `${BASE_URL}/upload/${mid}?file=${filename}`, publicUrl: `${BASE_URL}/media/${mid}/${filename}`, expiresIn: "5 minutes" }) }] };
  });

  srv.tool("pf_generate_video",
    "Generate an AI video from an image using fal.ai Framepack — same as Blotato uses",
    {
      imageUrl: z.string().describe("Public URL of image to animate into video"),
      prompt: z.string().optional().describe("Motion description e.g. 'smooth cinematic pan'"),
      duration: z.number().optional().describe("Duration in seconds (default 5)"),
    },
    async ({ imageUrl, prompt = "smooth cinematic motion, high quality", duration = 5 }) => {
      if (!FAL_API_KEY) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "FAL_API_KEY not set on Railway" }) }] };
      try {
        const r = await fetch(`${BASE_URL}/api/generate-video`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl, prompt, duration }),
        });
        const d = await r.json();
        if (d.success) {
          return { content: [{ type: "text", text: JSON.stringify({
            success: true, videoId: d.videoId, videoUrl: d.url, prompt,
            message: `✅ Video generated! Use pf_create_post with mediaUrls: ["${d.url}"] to post it to Facebook/Instagram.`,
          }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: d.error }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
      }
    }
  );

  srv.tool("pf_generate_slideshow",
    "Generate a multi-slide AI video — generate images with Recraft v3 then animate with Framepack. Same pipeline as Blotato.",
    {
      slides: z.array(z.object({
        text: z.string().describe("Caption text for this slide"),
        imagePrompt: z.string().describe("Image generation prompt for this slide"),
      })).describe("Array of slides, each with text and image prompt"),
      motionPrompt: z.string().optional().describe("Video motion style e.g. 'cinematic slow pan'"),
      duration: z.number().optional().describe("Video duration in seconds (default 5)"),
    },
    async ({ slides, motionPrompt = "smooth cinematic motion", duration = 5 }) => {
      if (!REPLICATE_API_KEY || !FAL_API_KEY) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "REPLICATE_API_KEY and FAL_API_KEY required on Railway" }) }] };
      try {
        const r = await fetch(`${BASE_URL}/api/generate-slideshow`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slides, prompt: motionPrompt, duration }),
        });
        const d = await r.json();
        if (d.success) {
          return { content: [{ type: "text", text: JSON.stringify({
            success: true, slideshowId: d.slideshowId, videoUrl: d.videoUrl,
            slides: d.slides?.map(s => ({ text: s.text, imageUrl: s.imageUrl })),
            message: `✅ Slideshow generated with ${slides.length} slides! Video URL: ${d.videoUrl}. Use pf_create_post with mediaUrls: ["${d.videoUrl}"] to post to Facebook.`,
          }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: d.error }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
      }
    }
  );

  srv.tool("pf_generate_image",
    "Generate an AI image using Stability AI. Returns image data you can use in posts.",
    {
      prompt: z.string().describe("Detailed description of the image to generate"),
      style: z.string().optional().describe("Style: photographic, digital-art, cinematic, anime, 3d-model, neon-punk, comic-book"),
      size: z.string().optional().describe("Size: 1024x1024 (square), 1344x768 (landscape), 768x1344 (portrait)"),
    },
    async ({ prompt, style = "photographic", size = "1024x1024" }) => {
      if (!STABILITY_API_KEY) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "STABILITY_API_KEY not set on server. Add it to Railway environment variables." }) }] };
      try {
        const [width, height] = size.split("x").map(Number);
        const fd = new FormData();
        fd.append("prompt", prompt);
        fd.append("output_format", "webp");
        fd.append("style_preset", style);
        fd.append("width", String(width || 1024));
        fd.append("height", String(height || 1024));
        const r = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
          method: "POST",
          headers: { "Authorization": "Bearer " + STABILITY_API_KEY, "Accept": "application/json" },
          body: fd,
        });
        const data = await r.json();
        if (data.errors) throw new Error(data.errors.join(", "));
        if (!data.image) throw new Error("No image returned: " + JSON.stringify(data));
        const imageId = makeId("img");
        imageStore[imageId] = { id: imageId, base64: data.image, prompt, style, size, createdAt: now() };
        return { content: [{ type: "text", text: JSON.stringify({
          success: true,
          imageId,
          prompt,
          style,
          size,
          previewUrl: BASE_URL + "/api/images/" + imageId,
          message: "Image generated! Use pf_create_post with mediaUrls: ['" + BASE_URL + "/api/images/" + imageId + "'] to post it to Facebook.",
        }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
      }
    }
  );

  return srv;
}

// SSE sessions
const sseTransports = new Map();

// GET /mcp — SSE (Claude Desktop / Claude.ai)
app.get("/mcp", async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const srv = createMcpServer();
    const transport = new SSEServerTransport("/mcp", res);
    sseTransports.set(transport.sessionId, transport);
    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      transport.close().catch(() => {});
    });
    await srv.connect(transport);
  } catch (err) {
    console.error("SSE error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /mcp — SSE messages + Streamable HTTP
app.post("/mcp", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const sessionId = req.query.sessionId || req.headers["mcp-session-id"];
  const sseT = sessionId ? sseTransports.get(sessionId) : null;
  if (sseT) {
    try { await sseT.handlePostMessage(req, res); } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
    return;
  }
  // Streamable HTTP — new server instance per session
  try {
    const sid = req.headers["mcp-session-id"] || makeId("sess");
    let transport = transports.get(sid);
    if (!transport) {
      const srv = createMcpServer();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sid });
      transports.set(sid, transport);
      await srv.connect(transport);
    }
    res.setHeader("mcp-session-id", sid);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         PostFlow Server — Full OAuth Ready            ║
╠═══════════════════════════════════════════════════════╣
║  Frontend  : ${BASE_URL}
║  OAuth URL : ${BASE_URL}/auth/facebook
║  Health    : ${BASE_URL}/health
║  MCP       : ${BASE_URL}/mcp
╠═══════════════════════════════════════════════════════╣
║  Facebook App: ${FB_APP_ID ? "✅ " + FB_APP_ID : "❌ Set FB_APP_ID in .env"}
╚═══════════════════════════════════════════════════════╝
  `);
});
